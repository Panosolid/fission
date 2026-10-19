"""Merge Claude's pull requests into main once they are proven safe.

Run by .github/workflows/auto-merge.yml. One rule makes this safe without a
merge queue: a pull request merges only when its branch already contains the
current main AND every check on its exact head commit passed. A merge commit
of such a branch has the same files as the branch head, so main ends up with
exactly the files CI just tested; nothing untested reaches main.

A pull request qualifies when it is open, not a draft, comes from a `claude/`
branch of this repository, targets main, and has no `hold` label. A green
branch that is behind main gets one comment per head and main asking its
thread to merge main in and push (`ask`), so two green pull requests can't
each pass alone and break main together. Auto-merge never pushes to a branch
itself: main's ruleset only counts CI runs started by a pull request's own
push, and a push with this workflow's token starts a run that waits for the
owner's approval instead (found 2026-10-18, PR #176). A stacked pull request
(one whose base is another `claude/` branch) waits until its base is in main,
then is retargeted to main and goes through the same rule, so stacks merge in
order. A pull request whose merge GitHub refuses is skipped for the rest of
the run, so one stuck pull request never holds up the others.

A pull request that has conflicted with main for 15 minutes gets one comment
per head commit naming the conflicted files, in case its thread missed
GitHub's notice (`needs_reminder`).

Once main's ruleset requires GitHub's merge queue, none of that waiting is
needed and auto-merge only steers the queue (`decide_queue`): it turns on
"merge when ready" for every qualifying pull request, and GitHub queues it
when its own (quick) checks pass, tests it with main and the pull requests
ahead of it in full (ci.yml's merge_group run, the checks the ruleset
counts) and merges it, with no thread having to merge main in. A draft, a
`hold` label or a stacked base turns it off again. A pull request the queue
removes (a failed check, a conflict, or by hand) gets one comment per head
naming why (`dequeued_text`) and isn't queued again until its thread pushes
a new head. A head whose own run was quick (ci.yml's `e2e (quick)` check)
never merges the old way, so turning the queue rule off again can't let a
quick-tested head into main.

`decide` and `decide_queue` hold every rule and are pure (tested in
test_automerge.py); `run` does the GitHub calls. Usage:
automerge.py [--dry-run | --dequeued]; needs GITHUB_TOKEN and
GITHUB_REPOSITORY (and DEQUEUED_PR, DEQUEUED_HEAD, DEQUEUED_REASON with
--dequeued).
"""

import calendar
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

MAIN = "main"
PREFIX = "claude/"
HOLD = "hold"
# The jobs of ci.yml that gate a merge; a head without all of them has not
# been tested. (ci.yml's coverage job only reports; e2e is the gate over
# its e2e (k/3) shares.)
REQUIRED_CHECKS = ("kernel", "app", "e2e", "mutants-in-diff", "baseline")
# ci.yml's matrix jobs whose shares ("e2e (2/3)", "mutants-shard (0)") a
# required job gathers (e2e, mutants-in-diff).
SHARDS = ("e2e", "mutants-shard")
PASSING = ("success", "skipped", "neutral")
# ci.yml's browser check in a quick run (only while main requires the merge
# queue): a head with it had only the quick checks.
QUICK = "e2e (quick)"
MAX_ACTIONS = 20


def counts(check):
    """Does this check decide whether a head may merge? CI's jobs and any other
    app's checks do; other workflows here (hours of random testing started on
    a branch, this workflow itself) don't, or they would hold up the queue.
    A share of a required job ("e2e (2/3)", "mutants-shard (0)") counts too:
    the job over the shares only appears once every share has finished, and
    until then the head is being tested, not untested (as "none" it would be
    sent to CI again, and the new run would cancel this one)."""
    return check.get("app", {}).get("slug") != "github-actions" or check["name"] in REQUIRED_CHECKS or (
        " (" in check["name"] and check["name"].split(" (")[0] in SHARDS)


def ci_state(check_runs):
    """'success', 'failure', 'pending', 'none' or 'quick' (tested only by a
    quick run, so not for merging without the queue) for a head's latest
    check runs."""
    # A full run lists the quick check too, as skipped: only one that ran counts.
    if any(c["name"] == QUICK and c.get("app", {}).get("slug") == "github-actions"
           and c.get("conclusion") != "skipped" for c in check_runs):
        return "quick"
    check_runs = [c for c in check_runs if counts(c)]
    if not check_runs:
        return "none"
    if any(c["status"] != "completed" for c in check_runs):
        return "pending"
    if any(c["conclusion"] not in PASSING for c in check_runs):
        return "failure"
    names = {c["name"] for c in check_runs}
    if not all(n in names for n in REQUIRED_CHECKS):
        return "none"
    return "success"


def is_claude_pr(pr):
    return pr["head_ref"].startswith(PREFIX) and pr["same_repo"]


def decide(prs, skip=()):
    """The single next action, or None when there is nothing to do now.

    Each pr is a dict: number, head_ref, base_ref, same_repo, draft, labels,
    mergeable (True, False or None while GitHub works it out), up_to_date
    (head contains main), ci ('success', 'failure', 'pending' or 'none', for
    the head commit), base_in_main (the base branch's head is in main),
    asked (its thread was already asked to merge this main into this head).
    Pull requests numbered in `skip` (refused earlier in this run) are left
    alone.

    Actions: ("retarget", n), ("merge", n), ("ask", n) (ask its thread to
    merge main in and push, which tests it again).
    """
    mine = sorted((p for p in prs if is_claude_pr(p) and p["number"] not in skip), key=lambda p: p["number"])
    for p in mine:
        if p["base_ref"] != MAIN and p["base_ref"].startswith(PREFIX) and p["base_in_main"]:
            return ("retarget", p["number"])
    ready = [
        p for p in mine
        if p["base_ref"] == MAIN and not p["draft"] and HOLD not in p["labels"]
        and p["mergeable"] is not False
    ]
    for p in ready:
        if p["up_to_date"] and p["ci"] == "success" and p["mergeable"] is True:
            return ("merge", p["number"])
    # Wait while an up-to-date branch is being tested: if it merges, main
    # moves again and a branch brought up to date now would be behind again.
    if any(p["up_to_date"] and p["ci"] == "pending" for p in ready):
        return None
    for p in ready:
        if not p["up_to_date"] and p["ci"] == "success" and p["mergeable"] is True and not p["asked"]:
            return ("ask", p["number"])
    return None


# A pull request in conflict this long gets one reminder per head commit,
# for when the thread missed GitHub's conflict notice (owner asleep).
CONFLICT_GRACE_S = 15 * 60
MARKER = "<!-- automerge-conflict:{} -->"
FOOTER = "\n\n---\n_Generated by [Claude Code](https://claude.ai/code)_"
DEQUEUED = "<!-- automerge-dequeued:{} -->"


def wanted_in_queue(pr):
    return pr["base_ref"] == MAIN and not pr["draft"] and HOLD not in pr["labels"] and not pr["dequeued"]


def decide_queue(prs, skip=()):
    """The single next action while main requires the merge queue, or None.

    Each pr is a dict as for `decide`, plus queued (merge when ready is on,
    or it is in the queue) and dequeued (the queue removed this head).
    Actions: ("retarget", n), ("enable", n) (merge when ready: GitHub queues
    it once its checks pass), ("disable", n) (leave the queue: drafted, held,
    stacked, or removed by the queue).
    """
    mine = sorted((p for p in prs if is_claude_pr(p) and p["number"] not in skip), key=lambda p: p["number"])
    for p in mine:
        if p["base_ref"] != MAIN and p["base_ref"].startswith(PREFIX) and p["base_in_main"]:
            return ("retarget", p["number"])
    for p in mine:
        if wanted_in_queue(p) and not p["queued"] and p["mergeable"] is not False:
            return ("enable", p["number"])
        if not wanted_in_queue(p) and p["queued"]:
            return ("disable", p["number"])
    return None


def dequeued_text(head_sha, reason, repo):
    why = f" (GitHub's reason: `{reason}`)" if reason else ""
    return (
        f"The merge queue removed this pull request{why}, so it won't merge as it is.\n\n"
        "To the thread that owns this branch: the queue's full test run is on the Actions tab "
        f"(https://github.com/{repo}/actions?query=event%3Amerge_group). Fix what failed, or merge `main` in "
        "if it now conflicts, rerun the affected tests and push. Auto-merge queues the new head by itself; "
        "it won't queue this head again.\n\n"
        + DEQUEUED.format(head_sha) + FOOTER
    )


def needs_reminder(pr, main_time, now):
    """Remind when the PR is not a draft, has conflicted with main for at
    least CONFLICT_GRACE_S, and has no reminder for its head commit yet.

    How long it has conflicted: neither side has changed since the later of
    main's last commit and the head commit (times in seconds), so whatever
    conflict there is now has been there at least since then."""
    if pr["draft"] or pr["mergeable"] is not False or pr["reminded"]:
        return False
    return now - max(main_time, pr["head_time"]) >= CONFLICT_GRACE_S


BEHIND = "<!-- automerge-behind:{}:{} -->"


def behind_text(pr, main_sha):
    return (
        "This pull request passed CI, but `main` has moved on since, so auto-merge can't merge it "
        "until it is tested with the new `main`.\n\n"
        "To the thread that owns this branch: merge `main` into it (a merge commit, not a rebase), "
        "rerun the affected tests and push. Auto-merge merges it once CI passes on the new head.\n\n"
        + BEHIND.format(pr["head_sha"], main_sha) + FOOTER
    )


def reminder_text(pr, files):
    listed = "\n".join(f"- `{f}`" for f in files) or "- (git could not list them; merge `main` to see)"
    return (
        "This pull request has had merge conflicts with `main` for at least 15 minutes, "
        "so auto-merge can't merge it.\n\nConflicted files:\n" + listed + "\n\n"
        "To the thread that owns this branch: merge `main` into it (a merge commit, not a rebase), "
        "resolve these files, rerun the affected tests and push. Auto-merge takes it from there.\n\n"
        + MARKER.format(pr["head_sha"]) + FOOTER
    )


def conflicted_files(head_ref):
    """Files a merge of main and the branch leaves in conflict, from the
    workflow's full checkout; [] when git can't tell."""
    try:
        res = subprocess.run(
            ["git", "merge-tree", "--write-tree", "--name-only", "--no-messages",
             f"origin/{MAIN}", f"origin/{head_ref}"],
            capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.SubprocessError):
        return []
    if res.returncode != 1:
        return []
    # First line is the merged tree's id; the conflicted paths follow.
    return [line for line in res.stdout.splitlines()[1:] if line]


def iso_seconds(stamp):
    return calendar.timegm(time.strptime(stamp, "%Y-%m-%dT%H:%M:%SZ"))


class GitHub:
    def __init__(self, repo, token):
        self.repo = repo
        self.base = f"https://api.github.com/repos/{repo}"
        self.token = token

    def graphql(self, query, variables):
        """Merge when ready and the queue have no REST calls."""
        req = urllib.request.Request(
            "https://api.github.com/graphql",
            method="POST",
            data=json.dumps({"query": query, "variables": variables}).encode(),
            headers={"Authorization": f"Bearer {self.token}"} if self.token else {},
        )
        with urllib.request.urlopen(req) as res:
            out = json.loads(res.read())
        if out.get("errors"):
            raise RuntimeError(f"GraphQL: {out['errors']}")
        return out["data"]

    def call(self, method, path, body=None):
        req = urllib.request.Request(
            self.base + path,
            method=method,
            data=None if body is None else json.dumps(body).encode(),
            headers={
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
                **({"Authorization": f"Bearer {self.token}"} if self.token else {}),
            },
        )
        with urllib.request.urlopen(req) as res:
            text = res.read()
            return json.loads(text) if text else None


def contains(gh, head_sha, ref):
    """Does the commit head_sha already contain ref?"""
    cmp = gh.call("GET", f"/compare/{ref}...{head_sha}")
    return cmp["status"] in ("ahead", "identical")


def queue_required(gh):
    """Does main's ruleset require the merge queue? Any doubt means no: the
    old way then runs, which merges only fully tested heads (`QUICK`)."""
    try:
        return any(r.get("type") == "merge_queue" for r in gh.call("GET", f"/rules/branches/{MAIN}"))
    except (urllib.error.URLError, TypeError, ValueError) as e:
        print(f"couldn't read main's rules ({e}); merging the old way")
        return False


QUEUE_STATE = """query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { id isInMergeQueue autoMergeRequest { enabledAt } }
  }
}"""


def gather_queue(gh, prs):
    """Adds node_id, queued and dequeued to each pull request from gather."""
    owner, name = gh.repo.split("/")
    for p in prs:
        state = gh.graphql(QUEUE_STATE, {"owner": owner, "name": name, "number": p["number"]})["repository"]["pullRequest"]
        p["node_id"] = state["id"]
        p["in_queue"] = state["isInMergeQueue"]
        p["queued"] = state["isInMergeQueue"] or state["autoMergeRequest"] is not None
        comments = [c["body"] or "" for c in gh.call("GET", f"/issues/{p['number']}/comments?per_page=100")]
        p["dequeued"] = any(DEQUEUED.format(p["head_sha"]) in c for c in comments)
    return prs


def gather(gh):
    prs = []
    main_sha = None
    for raw in gh.call("GET", "/pulls?state=open&per_page=100"):
        head = raw["head"]
        pr = {
            "number": raw["number"],
            "head_ref": head["ref"],
            "head_sha": head["sha"],
            "base_ref": raw["base"]["ref"],
            "same_repo": (head.get("repo") or {}).get("full_name") == raw["base"]["repo"]["full_name"],
            "draft": raw["draft"],
            "labels": [l["name"] for l in raw["labels"]],
        }
        if not is_claude_pr(pr):
            continue
        # The list endpoint leaves out mergeable; the single one computes it.
        pr["mergeable"] = gh.call("GET", f"/pulls/{pr['number']}")["mergeable"]
        pr["up_to_date"] = contains(gh, pr["head_sha"], MAIN)
        runs = gh.call("GET", f"/commits/{pr['head_sha']}/check-runs?filter=latest&per_page=100")
        pr["ci"] = ci_state(runs["check_runs"])
        pr["base_in_main"] = False
        if pr["base_ref"] != MAIN and pr["base_ref"].startswith(PREFIX):
            try:
                base_sha = gh.call("GET", f"/branches/{pr['base_ref']}")["commit"]["sha"]
                pr["base_in_main"] = contains(gh, MAIN, base_sha)
            except urllib.error.HTTPError as e:
                if e.code != 404:
                    raise
        pr["head_time"], pr["reminded"], pr["asked"], pr["main_sha"] = 0, False, False, None
        conflicted = pr["mergeable"] is False and not pr["draft"]
        if conflicted:
            commit = gh.call("GET", f"/commits/{pr['head_sha']}")
            pr["head_time"] = iso_seconds(commit["commit"]["committer"]["date"])
        if conflicted or not pr["up_to_date"]:
            comments = [c["body"] or "" for c in gh.call("GET", f"/issues/{pr['number']}/comments?per_page=100")]
            pr["reminded"] = any(MARKER.format(pr["head_sha"]) in c for c in comments)
            if not pr["up_to_date"]:
                main_sha = main_sha or gh.call("GET", f"/commits/{MAIN}")["sha"]
                pr["main_sha"] = main_sha
                pr["asked"] = any(BEHIND.format(pr["head_sha"], main_sha) in c for c in comments)
        prs.append(pr)
    return prs


def remind_conflicts(gh, prs, now, files_for, dry_run, log):
    if not any(p["mergeable"] is False and not p["draft"] for p in prs):
        return 0
    main_time = iso_seconds(gh.call("GET", f"/commits/{MAIN}")["commit"]["committer"]["date"])
    sent = 0
    for p in prs:
        if needs_reminder(p, main_time, now):
            log(f"#{p['number']}: conflicted, reminding its thread")
            if not dry_run:
                gh.call("POST", f"/issues/{p['number']}/comments",
                        {"body": reminder_text(p, files_for(p["head_ref"]))})
            sent += 1
    return sent


def act(gh, action, prs):
    kind, number = action
    pr = next(p for p in prs if p["number"] == number)
    if kind == "retarget":
        gh.call("PATCH", f"/pulls/{number}", {"base": MAIN})
    elif kind == "merge":
        gh.call("PUT", f"/pulls/{number}/merge", {"merge_method": "merge", "sha": pr["head_sha"]})
    elif kind == "ask":
        gh.call("POST", f"/issues/{number}/comments", {"body": behind_text(pr, pr["main_sha"])})


ENABLE = "mutation($id: ID!) { enablePullRequestAutoMerge(input: {pullRequestId: $id}) { clientMutationId } }"
DISABLE = "mutation($id: ID!) { disablePullRequestAutoMerge(input: {pullRequestId: $id}) { clientMutationId } }"
DEQUEUE = "mutation($id: ID!) { dequeuePullRequest(input: {id: $id}) { clientMutationId } }"


def act_queue(gh, action, prs):
    kind, number = action
    pr = next(p for p in prs if p["number"] == number)
    if kind == "retarget":
        gh.call("PATCH", f"/pulls/{number}", {"base": MAIN})
    elif kind == "enable":
        gh.graphql(ENABLE, {"id": pr["node_id"]})
    elif kind == "disable":
        gh.graphql(DEQUEUE if pr["in_queue"] else DISABLE, {"id": pr["node_id"]})


def ensure_pages(gh, dry_run, log):
    """Deploy main if its head has no Pages run yet. A merge made by the
    queue may start no workflows when this workflow's token turned on merge
    when ready, so this looks rather than assumes."""
    main_sha = gh.call("GET", f"/commits/{MAIN}")["sha"]
    runs = gh.call("GET", "/actions/workflows/pages.yml/runs?branch=main&per_page=5")["workflow_runs"]
    if any(r["head_sha"] == main_sha for r in runs):
        return False
    log(f"main {main_sha[:7]} has no Pages deploy yet; starting one")
    if not dry_run:
        gh.call("POST", "/actions/workflows/pages.yml/dispatches", {"ref": MAIN})
    return True


def run_queue(gh, dry_run=False, log=print, now=None, files_for=conflicted_files):
    skip = set()
    for step in range(MAX_ACTIONS):
        prs = gather_queue(gh, gather(gh))
        if step == 0:
            remind_conflicts(gh, prs, time.time() if now is None else now, files_for, dry_run, log)
        for p in prs:
            log(f"#{p['number']} {p['head_ref']} -> {p['base_ref']}: draft={p['draft']} "
                f"mergeable={p['mergeable']} queued={p['queued']} dequeued={p['dequeued']} ci={p['ci']}")
        action = decide_queue(prs, skip)
        log(f"next: {action}")
        if action is None or dry_run:
            break
        try:
            act_queue(gh, action, prs)
        except (urllib.error.HTTPError, RuntimeError) as e:
            detail = e.read().decode(errors="replace")[:300] if isinstance(e, urllib.error.HTTPError) else str(e)[:300]
            log(f"{action} refused: {detail}")
            skip.add(action[1])
    ensure_pages(gh, dry_run, log)


def note_dequeued(gh, number, head_sha, reason, dry_run=False, log=print):
    """One comment per head when the queue removes a pull request."""
    comments = [c["body"] or "" for c in gh.call("GET", f"/issues/{number}/comments?per_page=100")]
    if any(DEQUEUED.format(head_sha) in c for c in comments):
        return False
    log(f"#{number}: removed from the merge queue ({reason or 'no reason given'}); telling its thread")
    if not dry_run:
        gh.call("POST", f"/issues/{number}/comments", {"body": dequeued_text(head_sha, reason, gh.repo)})
    return True


def run(gh, dry_run=False, log=print, now=None, files_for=conflicted_files):
    if queue_required(gh):
        log("main requires the merge queue: steering the queue")
        return run_queue(gh, dry_run, log, now, files_for)
    merged = 0
    skip = set()
    for step in range(MAX_ACTIONS):
        prs = gather(gh)
        if step == 0:
            remind_conflicts(gh, prs, time.time() if now is None else now, files_for, dry_run, log)
        for p in prs:
            log(f"#{p['number']} {p['head_ref']} -> {p['base_ref']}: draft={p['draft']} "
                f"mergeable={p['mergeable']} up_to_date={p['up_to_date']} ci={p['ci']}")
        action = decide(prs, skip)
        log(f"next: {action}")
        if action is None or dry_run:
            break
        try:
            act(gh, action, prs)
        except urllib.error.HTTPError as e:
            # Someone pushed, a conflict appeared, or a rule refused it: the
            # others go on, and the next run (CI finishing, or the
            # half-hourly one) looks at this one again.
            log(f"{action} refused: {e.code} {e.read().decode(errors='replace')[:300]}")
            skip.add(action[1])
            continue
        if action[0] == "merge":
            merged += 1
    if merged:
        # Same reason: the merge push starts no workflows, so deploy by hand.
        gh.call("POST", "/actions/workflows/pages.yml/dispatches", {"ref": MAIN})
        log(f"merged {merged}; Pages deploy started")
    return merged


if __name__ == "__main__":
    gh = GitHub(os.environ["GITHUB_REPOSITORY"], os.environ.get("GITHUB_TOKEN"))
    if "--dequeued" in sys.argv:
        # A pull request the queue just removed (auto-merge.yml's dequeued job).
        note_dequeued(gh, int(os.environ["DEQUEUED_PR"]), os.environ["DEQUEUED_HEAD"],
                      os.environ.get("DEQUEUED_REASON", ""))
    else:
        run(gh, dry_run="--dry-run" in sys.argv)
