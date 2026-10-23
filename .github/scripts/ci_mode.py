"""How much of ci.yml a run does: the `mode` job's outputs `full` and `ui`.

full: the whole suite (every Chromium browser check, the kernel's
same-answer and oracle checks). A pull request's own run is quick (one
browser smoke test, the kernel's clippy and tests) only while main's ruleset
requires the merge queue: then every pull request is tested again, in full,
on the exact commit that lands on main (the queue's merge_group run), so
nothing reaches main without the whole suite. Without the queue rule
(auto-merge merges the pull request's head itself), its own run is the last
test before main and stays full. Any doubt (the API can't be read) means full.

ui: whether a pull request touches the app (apps/, packages/, workspaces/,
the npm files or ci.yml itself), so the Firefox and WebKit checks are worth
running on it. Any doubt means yes.

docs: whether every changed file is writing no code or test reads (DOCS
below: docs/, CHANGELOG.md, README.md, VERSION and any CLAUDE.md), in a pull
request's own run or a merge queue group's (its files: the group's commit
against main's, so every pull request queued ahead of it counts too). Then
only the kernel job runs, with just the CI scripts' tests (which check
VERSION against CHANGELOG.md); every other required job reports skipped,
which main's ruleset counts as passed. Any other file, a rename out of
anywhere else, no files, or any doubt (the files can't be listed) means no.

`decide` is pure (tested in test_ci_mode.py); `main` reads the API and git
and writes GITHUB_OUTPUT. Needs GITHUB_TOKEN, GITHUB_REPOSITORY, EVENT, BASE
(the branch the pull request targets) and PR (its number) for pull requests,
GROUP_BASE and GROUP_HEAD (the group's two commits) for merge queue groups.
"""

import json
import os
import subprocess
import sys
import urllib.request

UI_PREFIXES = ("apps/", "packages/", "workspaces/")
UI_FILES = ("package.json", "package-lock.json", ".github/workflows/ci.yml")


def touches_ui(files):
    return any(f.startswith(UI_PREFIXES) or f in UI_FILES for f in files)


# Read by no code, build or test (checked with grep when this list was made;
# a new reader of one of these means taking it off the list). VERSION and
# CHANGELOG.md are read by check_version.py, which the kernel job's script
# tests run in a docs-only run too.
DOCS_PREFIXES = ("docs/",)
DOCS_FILES = ("CHANGELOG.md", "README.md", "VERSION")
DOCS_NAME = "CLAUDE.md"


def is_docs(path):
    if path.startswith("/") or ".." in path.split("/"):
        return False
    return path.startswith(DOCS_PREFIXES) or path in DOCS_FILES or path.split("/")[-1] == DOCS_NAME


def docs_only(files):
    """files: every path changed, or None when they couldn't be listed."""
    return bool(files) and all(is_docs(f) for f in files)


def queue_required(rules):
    return any(r.get("type") == "merge_queue" for r in rules)


def decide(event, rules, files):
    """(full, ui, docs). rules: main's active ruleset rules, or None when they
    couldn't be read; files: the pull request's or merge queue group's
    changed paths (a rename's old path too), or None."""
    if event == "merge_group":
        return True, True, docs_only(files)
    if event != "pull_request":
        return True, True, False
    full = rules is None or not queue_required(rules)
    ui = files is None or touches_ui(files)
    return full, ui, docs_only(files)


def get(path):
    req = urllib.request.Request(
        f"https://api.github.com/repos/{os.environ['GITHUB_REPOSITORY']}{path}",
        headers={
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "Authorization": f"Bearer {os.environ['GITHUB_TOKEN']}",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as res:
        return json.loads(res.read())


def read_rules(base):
    try:
        return get(f"/rules/branches/{base}")
    except Exception as e:  # noqa: BLE001 - any failure means a full run
        print(f"couldn't read the rules for {base} ({e}); running in full")
        return None


def read_files(number):
    files = []
    try:
        # GitHub lists at most 3,000 files, 100 a page.
        for page in range(1, 31):
            batch = get(f"/pulls/{number}/files?per_page=100&page={page}")
            # A rename lists its old path too: moving kernel code into docs/
            # changes the kernel.
            files += [p for f in batch for p in (f["filename"], f.get("previous_filename")) if p]
            if len(batch) < 100:
                return files
    except Exception as e:  # noqa: BLE001 - any failure means run the browsers
        print(f"couldn't list the changed files ({e}); running the browsers")
    return None


def read_group_files(base, head):
    """The paths a merge queue group changes on main: its commit against
    main's, renames as a deletion and an addition. Only the two commits'
    trees are fetched (no history, no file contents)."""
    try:
        def git(*args):
            return subprocess.run(["git", *args], check=True, capture_output=True, timeout=120).stdout
        git("fetch", "--no-tags", "--depth=1", "--filter=blob:none", "origin", base, head)
        out = git("diff", "--name-only", "--no-renames", "-z", base, head)
        return [p for p in out.decode("utf-8").split("\0") if p]
    except Exception as e:  # noqa: BLE001 - any failure means not docs-only
        print(f"couldn't list the group's changed files ({e}); testing it in full")
        return None


def main():
    event = os.environ["EVENT"]
    rules = files = None
    if event == "pull_request":
        rules = read_rules(os.environ["BASE"])
        files = read_files(os.environ["PR"])
    elif event == "merge_group":
        files = read_group_files(os.environ["GROUP_BASE"], os.environ["GROUP_HEAD"])
    full, ui, docs = decide(event, rules, files)
    why = ("not a pull request" if event != "pull_request" else
           "main doesn't require the merge queue (or its rules couldn't be read)" if full else
           "main requires the merge queue, which runs the whole suite before merging")
    summary = f"Mode: {'full' if full else 'quick'} ({why}); Firefox and WebKit: {'yes' if ui else 'no, no app files changed'}."
    if docs:
        summary = "Mode: docs only (every changed file is under docs/, CHANGELOG.md, README.md, VERSION or a CLAUDE.md): only the CI scripts' tests run."
    print(summary)
    with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as f:
        print(summary, file=f)
    with open(os.environ["GITHUB_OUTPUT"], "a") as f:
        print(f"full={str(full).lower()}", file=f)
        print(f"ui={str(ui).lower()}", file=f)
        print(f"docs={str(docs).lower()}", file=f)


if __name__ == "__main__":
    sys.exit(main())
