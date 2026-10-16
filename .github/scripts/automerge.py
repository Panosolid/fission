"""Merge Claude's pull requests into main once they are proven safe.

Run by .github/workflows/auto-merge.yml. One rule makes this safe without a
merge queue: a pull request merges only when its branch already contains the
current main AND every check on its exact head commit passed. A merge commit
of such a branch has the same files as the branch head, so main ends up with
exactly the files CI just tested; nothing untested reaches main.

A pull request qualifies when it is open, not a draft, comes from a `claude/`
branch of this repository, targets main, and has no `hold` label. A branch
that is behind main is brought up to date (main merged in) and tested again,
one pull request at a time, oldest first, so two green pull requests can't
each pass alone and break main together. A stacked pull request (one whose
base is another `claude/` branch) waits until its base is in main, then is
retargeted to main and goes through the same rule, so stacks merge in order.

`decide` holds every rule and is pure (tested in test_automerge.py); `run`
does the GitHub calls. Usage: automerge.py [--dry-run]; needs GITHUB_TOKEN
and GITHUB_REPOSITORY.
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request

MAIN = "main"
PREFIX = "claude/"
HOLD = "hold"
# The jobs of ci.yml that gate a merge; a head without all of them has not
# been tested. (ci.yml's coverage job only reports.)
REQUIRED_CHECKS = ("kernel", "app", "mutants-in-diff")
PASSING = ("success", "skipped", "neutral")
MAX_ACTIONS = 20


def counts(check):
    """Does this check decide whether a head may merge? CI's jobs and any other
    app's checks do; other workflows here (hours of random testing started on
    a branch, this workflow itself) don't, or they would hold up the queue."""
    return check.get("app", {}).get("slug") != "github-actions" or check["name"] in REQUIRED_CHECKS


def ci_state(check_runs):
    """'success', 'failure', 'pending' or 'none' for a head's latest check runs."""
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


def decide(prs):
    """The single next action, or None when there is nothing to do now.

    Each pr is a dict: number, head_ref, base_ref, same_repo, draft, labels,
    mergeable (True, False or None while GitHub works it out), up_to_date
    (head contains main), ci ('success', 'failure', 'pending' or 'none', for
    the head commit), base_in_main (the base branch's head is in main).

    Actions: ("retarget", n), ("merge", n), ("test", n) (run CI on the head),
    ("update", n) (merge main into the branch, then test).
    """
    mine = sorted((p for p in prs if is_claude_pr(p)), key=lambda p: p["number"])
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
    # One branch in the queue at a time: wait while an up-to-date branch is
    # being tested.
    if any(p["up_to_date"] and p["ci"] == "pending" for p in ready):
        return None
    for p in ready:
        if p["up_to_date"] and p["ci"] == "none":
            return ("test", p["number"])
    for p in ready:
        if not p["up_to_date"] and p["ci"] == "success" and p["mergeable"] is True:
            return ("update", p["number"])
    return None


class GitHub:
    def __init__(self, repo, token):
        self.base = f"https://api.github.com/repos/{repo}"
        self.token = token

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


def gather(gh):
    prs = []
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
        prs.append(pr)
    return prs


def wait_for_new_head(gh, number, old_sha):
    for _ in range(30):
        sha = gh.call("GET", f"/pulls/{number}")["head"]["sha"]
        if sha != old_sha:
            return sha
        time.sleep(2)
    raise RuntimeError(f"#{number}: branch update did not land")


def act(gh, action, prs):
    kind, number = action
    pr = next(p for p in prs if p["number"] == number)
    if kind == "retarget":
        gh.call("PATCH", f"/pulls/{number}", {"base": MAIN})
    elif kind == "merge":
        gh.call("PUT", f"/pulls/{number}/merge", {"merge_method": "merge", "sha": pr["head_sha"]})
    elif kind == "update":
        gh.call("PUT", f"/pulls/{number}/update-branch", {"expected_head_sha": pr["head_sha"]})
        wait_for_new_head(gh, number, pr["head_sha"])
    if kind in ("update", "test"):
        # A push made with the workflow's token starts no workflows, so CI is
        # started by hand; its finish wakes auto-merge again.
        gh.call("POST", "/actions/workflows/ci.yml/dispatches", {"ref": pr["head_ref"]})


def run(gh, dry_run=False, log=print):
    merged = 0
    for _ in range(MAX_ACTIONS):
        prs = gather(gh)
        for p in prs:
            log(f"#{p['number']} {p['head_ref']} -> {p['base_ref']}: draft={p['draft']} "
                f"mergeable={p['mergeable']} up_to_date={p['up_to_date']} ci={p['ci']}")
        action = decide(prs)
        log(f"next: {action}")
        if action is None or dry_run:
            break
        try:
            act(gh, action, prs)
        except urllib.error.HTTPError as e:
            # Someone pushed or a conflict appeared meanwhile; the next run
            # (CI finishing, or the half-hourly one) looks again.
            log(f"{action} refused: {e.code} {e.read().decode(errors='replace')[:300]}")
            break
        if action[0] == "merge":
            merged += 1
        if action[0] in ("update", "test"):
            break
    if merged:
        # Same reason: the merge push starts no workflows, so deploy by hand.
        gh.call("POST", "/actions/workflows/pages.yml/dispatches", {"ref": MAIN})
        log(f"merged {merged}; Pages deploy started")
    return merged


if __name__ == "__main__":
    gh = GitHub(os.environ["GITHUB_REPOSITORY"], os.environ.get("GITHUB_TOKEN"))
    run(gh, dry_run="--dry-run" in sys.argv)
