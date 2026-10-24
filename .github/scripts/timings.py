"""How long things take: every workflow, job and long step, and pull requests.

Prints, from GitHub's own records of the last DAYS days, how long each
process usually takes (median), in a slow case (p90: nine runs in ten are
quicker) and at worst (max), so time estimates come from measurements:

- runs: each workflow by event, from the run starting to it finishing
  (CI on a pull request is the quick run, CI on merge_group is the full
  run the merge queue does before main).
- jobs: every job (kernel, e2e shards, browsers, coverage, mutants, the
  nightly random testing and fuzzing...), and how long it waited for a
  runner before starting.
- steps: with --steps, every step of every job whose median is at least
  --min-step seconds (cargo build, the oracle, each Playwright run...).
- prs: merged pull requests, first commit to merged (about a substep's
  thread from its first code to main), opened to merged, marked ready to merged
  (review and the merge queue), and the merge queue alone (added to the
  queue to merged).

Only successful jobs and runs count towards the times (a failure stops
early, a cancel is cut short); failures are counted beside them.

Usage: python3 .github/scripts/timings.py [--days 14] [--steps] [--only e2e] [--json]
Reads the API with GITHUB_TOKEN if set, otherwise through `gh api`.
Finished runs never change, so their jobs and PR timelines are cached in
--cache (default ~/.cache/panosolid-timings) and a second run is quick.

The maths (`percentile`, `median`, `summarize`, `pr_times`) is pure and
tested in test_timings.py.
"""

import argparse
import concurrent.futures
import datetime as dt
import json
import math
import os
import subprocess
import sys
import urllib.request

REPO = os.environ.get("GITHUB_REPOSITORY", "Panosolid/fission")


def parse_time(text):
    if not text:
        return None
    return dt.datetime.fromisoformat(text.replace("Z", "+00:00"))


def seconds(start, end):
    """Seconds from start to end (ISO strings), or None if either is missing or end is first."""
    a, b = parse_time(start), parse_time(end)
    if a is None or b is None or b < a:
        return None
    return (b - a).total_seconds()


def percentile(values, p):
    """Nearest-rank percentile: the smallest value with at least p% of values at or below it."""
    if not values:
        return None
    ordered = sorted(values)
    rank = max(1, math.ceil(p / 100 * len(ordered)))
    return ordered[rank - 1]


def median(values):
    if not values:
        return None
    ordered = sorted(values)
    mid = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[mid]
    return (ordered[mid - 1] + ordered[mid]) / 2


def summarize(samples):
    """samples: {key: [seconds]} -> {key: dict(n, median, p90, max)}."""
    out = {}
    for key, values in samples.items():
        values = [v for v in values if v is not None]
        if values:
            out[key] = dict(n=len(values), median=median(values), p90=percentile(values, 90), max=max(values))
    return out


def pr_times(pr, events, commits=()):
    """Seconds for one merged pull request: worked, opened, ready and queued, each to merged.

    events: its issue timeline. Ready is the last ready_for_review (a pull
    request opened ready counts from opening); queued is the last
    added_to_merge_queue, None if it never went through the queue.
    commits: its commits; worked starts at the earliest one's author date
    (about when its thread started writing code), None without commits.
    """
    merged = pr.get("merged_at")
    ready = pr.get("created_at")
    queued = None
    for e in events:
        if e.get("event") == "ready_for_review":
            ready = e.get("created_at")
        elif e.get("event") == "added_to_merge_queue":
            queued = e.get("created_at")
    dates = [c["commit"]["author"]["date"] for c in commits if (c.get("commit") or {}).get("author")]
    first = min(dates, key=parse_time) if dates else None
    return dict(
        worked=seconds(first, merged) if first else None,
        opened=seconds(pr.get("created_at"), merged),
        ready=seconds(ready, merged),
        queue=seconds(queued, merged) if queued else None,
    )


def fmt(s):
    if s is None:
        return "-"
    s = round(s)
    if s < 60:
        return f"{s}s"
    if s < 3600:
        return f"{s // 60}m{s % 60:02d}s"
    return f"{s // 3600}h{s % 3600 // 60:02d}m"


class Api:
    def __init__(self, cache):
        self.cache = cache
        self.token = os.environ.get("GITHUB_TOKEN")
        os.makedirs(cache, exist_ok=True)

    def get(self, path):
        if self.token:
            req = urllib.request.Request(
                f"https://api.github.com/{path}",
                headers={"Authorization": f"Bearer {self.token}", "Accept": "application/vnd.github+json"},
            )
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.load(r)
        out = subprocess.run(["gh", "api", path], check=True, capture_output=True, text=True).stdout
        return json.loads(out)

    def pages(self, path, key):
        """Every item, paging by number (some proxies break GitHub's next links)."""
        sep = "&" if "?" in path else "?"
        page, items = 1, []
        while True:
            data = self.get(f"{path}{sep}per_page=100&page={page}")
            batch = data[key] if key else data
            items += batch
            if len(batch) < 100:
                return items
            page += 1

    def cached(self, name, path, key):
        file = os.path.join(self.cache, name + ".json")
        if os.path.exists(file):
            with open(file) as f:
                return json.load(f)
        items = self.pages(path, key)
        with open(file + ".part", "w") as f:
            json.dump(items, f)
        os.replace(file + ".part", file)  # a run stopped halfway leaves no broken cache file
        return items


def collect(api, days, with_steps):
    since = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=days)).strftime("%Y-%m-%d")
    runs = [r for r in api.pages(f"repos/{REPO}/actions/runs?created=%3E%3D{since}", "workflow_runs") if r["status"] == "completed"]
    run_s, run_fail, job_s, job_fail, wait_s, step_s = {}, {}, {}, {}, {}, {}
    with concurrent.futures.ThreadPoolExecutor(8) as pool:
        all_jobs = list(pool.map(lambda r: api.cached(f"jobs-{r['id']}-{r['run_attempt']}", f"repos/{REPO}/actions/runs/{r['id']}/jobs?filter=latest", "jobs"), runs))
    for r, jobs in zip(runs, all_jobs):
        group = f"{r['name']} [{r['event']}]"
        if r["conclusion"] == "success":
            run_s.setdefault(group, []).append(seconds(r["run_started_at"], r["updated_at"]))
        elif r["conclusion"] == "failure":
            run_fail[group] = run_fail.get(group, 0) + 1
        for j in jobs:
            key = f"{group} {j['name']}"
            if j["conclusion"] == "failure":
                job_fail[key] = job_fail.get(key, 0) + 1
            if j["conclusion"] != "success":
                continue
            job_s.setdefault(key, []).append(seconds(j["started_at"], j["completed_at"]))
            wait_s.setdefault(key, []).append(seconds(j.get("created_at"), j["started_at"]))
            if with_steps:
                for st in j.get("steps") or []:
                    if st.get("conclusion") == "success":
                        step_s.setdefault(f"{key} :: {st['name']}", []).append(seconds(st.get("started_at"), st.get("completed_at")))
    prs = [p for p in api.pages(f"repos/{REPO}/pulls?state=closed&sort=updated&direction=desc", None) if p.get("merged_at") and p["merged_at"][:10] >= since]
    pr_s = {"first commit -> merged": [], "opened -> merged": [], "ready -> merged": [], "in merge queue": []}
    with concurrent.futures.ThreadPoolExecutor(8) as pool:
        timelines = list(pool.map(lambda p: api.cached(f"timeline-{p['number']}", f"repos/{REPO}/issues/{p['number']}/timeline", None), prs))
        commits = list(pool.map(lambda p: api.cached(f"commits-{p['number']}", f"repos/{REPO}/pulls/{p['number']}/commits", None), prs))
    for p, events, cs in zip(prs, timelines, commits):
        t = pr_times(p, events, cs)
        pr_s["first commit -> merged"].append(t["worked"])
        pr_s["opened -> merged"].append(t["opened"])
        pr_s["ready -> merged"].append(t["ready"])
        pr_s["in merge queue"].append(t["queue"])
    return dict(
        since=since, runs=len(runs), prs=len(prs),
        run=summarize(run_s), run_failures=run_fail,
        job=summarize(job_s), job_failures=job_fail, job_wait=summarize(wait_s),
        step=summarize(step_s), pr=summarize(pr_s),
    )


def table(title, stats, failures=None, waits=None, min_median=0, only=None):
    rows = [(k[:110], v) for k, v in sorted(stats.items()) if v["median"] >= min_median and (not only or only.lower() in k.lower())]
    if not rows:
        return
    print(f"\n{title}")
    width = max(len(k) for k, _ in rows)
    head = f"  {'':{width}}  {'n':>4} {'median':>8} {'p90':>8} {'max':>8}"
    print(head + ("  fails" if failures is not None else "") + ("  wait p90" if waits else ""))
    for k, v in rows:
        line = f"  {k:{width}}  {v['n']:>4} {fmt(v['median']):>8} {fmt(v['p90']):>8} {fmt(v['max']):>8}"
        if failures is not None:
            line += f"  {failures.get(k, 0):>5}"
        if waits:
            line += f"  {fmt(waits.get(k, {}).get('p90')):>9}"
        print(line)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--days", type=int, default=14)
    ap.add_argument("--steps", action="store_true", help="also time the steps of the longer jobs")
    ap.add_argument("--min-step", type=float, default=60, help="seconds; shorter steps are left out")
    ap.add_argument("--only", help="print only the rows whose name holds this text (any case), e.g. e2e")
    ap.add_argument("--json", action="store_true", help="print the numbers as JSON instead")
    ap.add_argument("--cache", default=os.path.expanduser("~/.cache/panosolid-timings"))
    args = ap.parse_args(argv)
    data = collect(Api(args.cache), args.days, args.steps)
    if args.json:
        json.dump(data, sys.stdout, indent=1)
        print()
        return 0
    print(f"{REPO}: {data['runs']} finished runs and {data['prs']} merged pull requests since {data['since']} (successful ones timed)")
    table("Pull requests", data["pr"], only=args.only)
    table("Workflow runs, start to finish", data["run"], data["run_failures"], only=args.only)
    table("Jobs", data["job"], data["job_failures"], data["job_wait"], only=args.only)
    table(f"Steps taking {fmt(args.min_step)} or more (median)", data["step"], min_median=args.min_step, only=args.only)
    return 0


if __name__ == "__main__":
    sys.exit(main())
