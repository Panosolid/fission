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

`decide` is pure (tested in test_ci_mode.py); `main` reads the API and
writes GITHUB_OUTPUT. Needs GITHUB_TOKEN, GITHUB_REPOSITORY, EVENT, BASE
(the branch the pull request targets) and PR (its number) for pull requests.
"""

import json
import os
import sys
import urllib.request

UI_PREFIXES = ("apps/", "packages/", "workspaces/")
UI_FILES = ("package.json", "package-lock.json", ".github/workflows/ci.yml")


def touches_ui(files):
    return any(f.startswith(UI_PREFIXES) or f in UI_FILES for f in files)


def queue_required(rules):
    return any(r.get("type") == "merge_queue" for r in rules)


def decide(event, rules, files):
    """(full, ui). rules: main's active ruleset rules, or None when they
    couldn't be read; files: the pull request's changed paths, or None."""
    if event != "pull_request":
        return True, True
    full = rules is None or not queue_required(rules)
    ui = files is None or touches_ui(files)
    return full, ui


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
            files += [f["filename"] for f in batch]
            if len(batch) < 100:
                return files
    except Exception as e:  # noqa: BLE001 - any failure means run the browsers
        print(f"couldn't list the changed files ({e}); running the browsers")
    return None


def main():
    event = os.environ["EVENT"]
    rules = files = None
    if event == "pull_request":
        rules = read_rules(os.environ["BASE"])
        files = read_files(os.environ["PR"])
    full, ui = decide(event, rules, files)
    why = ("not a pull request" if event != "pull_request" else
           "main doesn't require the merge queue (or its rules couldn't be read)" if full else
           "main requires the merge queue, which runs the whole suite before merging")
    summary = f"Mode: {'full' if full else 'quick'} ({why}); Firefox and WebKit: {'yes' if ui else 'no, no app files changed'}."
    print(summary)
    with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as f:
        print(summary, file=f)
    with open(os.environ["GITHUB_OUTPUT"], "a") as f:
        print(f"full={str(full).lower()}", file=f)
        print(f"ui={str(ui).lower()}", file=f)


if __name__ == "__main__":
    sys.exit(main())
