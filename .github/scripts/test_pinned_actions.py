"""Every action a workflow uses is pinned to a full commit: python3 -m unittest discover -s .github/scripts

A tag (@v4) or a branch (@stable) can be moved by whoever controls the
action's repository, or by someone who has taken it over (in March 2025 the
tj-actions/changed-files tags were moved to a commit that printed every
secret of the workflows using it). Pages' build job runs these actions and
publishes what it builds, so a moved tag could change the app every visitor
runs (audit 2026-10-22, H1). A commit id can't be moved: the code at it is
fixed. The tag it was taken from is kept in a comment after it, so an update
is a deliberate edit of both.

Each action is pinned to the same commit in every workflow, so one copy
can't be updated and the others forgotten. The one exception is
dtolnay/rust-toolchain, whose branches are the toolchain it installs: one
commit for each branch used (stable, nightly)."""

import glob
import os
import re
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
WORKFLOWS = os.path.join(os.path.dirname(HERE), "workflows")

USES = re.compile(r"^\s*(?:-\s+)?uses:\s*(\S+)(.*)$")
PINNED = re.compile(r"^([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(?:/[^@\s]+)?)@([0-9a-f]{40})$")
COMMENT = re.compile(r"^\s+#\s+\S+")
BY_BRANCH = {"dtolnay/rust-toolchain"}


def problem(ref, rest):
    """Why a `uses:` value and the text after it are not a pinned action, or None when they are."""
    if ref.startswith("./"):
        return None  # an action in this repository, at the commit being run
    if not PINNED.match(ref):
        return f"{ref} is not pinned to a full 40-character commit id"
    if not COMMENT.match(rest):
        return f"{ref} has no comment naming the tag or branch its commit was taken from"
    return None


def uses_lines():
    """(file, line number, ref, rest of the line) for every `uses:` in the workflows."""
    for path in sorted(glob.glob(os.path.join(WORKFLOWS, "*.yml"))):
        with open(path) as f:
            lines = f.readlines()
        for number, line in enumerate(lines, 1):
            found = USES.match(line)
            if found:
                yield os.path.basename(path), number, found.group(1), found.group(2)


class CheckerTest(unittest.TestCase):
    """The checker itself, so a weakened pattern can't pass the workflows unnoticed."""

    SHA = "11d5960a326750d5838078e36cf38b85af677262"

    def test_a_full_commit_with_its_tag_passes(self):
        self.assertIsNone(problem(f"actions/checkout@{self.SHA}", " # v4.4.0"))
        self.assertIsNone(problem(f"actions/cache/restore@{self.SHA}", " # v4"))
        self.assertIsNone(problem("./.github/actions/local", ""))

    def test_a_tag_or_branch_fails(self):
        for ref in ["actions/checkout@v4", "dtolnay/rust-toolchain@stable", "actions/checkout@main", "actions/checkout"]:
            self.assertIn("not pinned", problem(ref, " # v4"), ref)

    def test_a_short_or_wrong_commit_id_fails(self):
        # 40 hex characters exactly: GitHub resolves a 7- or 39-character prefix, but a
        # prefix can come to match a second commit, and a tag could be named like one.
        for sha in [self.SHA[:7], self.SHA[:39], self.SHA + "0", self.SHA.upper(), self.SHA[:39] + "g"]:
            self.assertIn("not pinned", problem(f"actions/checkout@{sha}", " # v4"), sha)

    def test_a_commit_without_its_tag_fails(self):
        self.assertIn("no comment", problem(f"actions/checkout@{self.SHA}", ""))
        self.assertIn("no comment", problem(f"actions/checkout@{self.SHA}", " #"))


class WorkflowsTest(unittest.TestCase):
    def test_every_action_is_pinned(self):
        lines = list(uses_lines())
        self.assertGreater(len(lines), 50)  # the pattern still finds them all
        bad = [f"{f}:{n}: {why}" for f, n, ref, rest in lines if (why := problem(ref, rest))]
        self.assertEqual(bad, [])

    def test_each_action_has_one_commit(self):
        commits = {}
        for f, n, ref, rest in uses_lines():
            if "@" in ref:
                name, sha = ref.split("@", 1)
                # The toolchain action's commits are told apart by the branch named in the comment.
                key = (name, (rest.split("#", 1)[-1].split() or [""])[0]) if name in BY_BRANCH else name
                commits.setdefault(key, set()).add(sha)
        self.assertEqual({k: v for k, v in commits.items() if len(v) > 1}, {})
        self.assertEqual(sorted(k[1] for k in commits if isinstance(k, tuple)), ["nightly", "stable"])


if __name__ == "__main__":
    unittest.main()
