"""Tests for ci.yml's concurrency group: python3 -m unittest discover -s .github/scripts

A run cancels the older run still going in its group, so the group decides
which runs may cancel which. The rules: a newer push to a pull request
cancels its older run; nothing else may cancel a pull request's own run,
because main's ruleset only counts that run's checks for merging (a run
started by hand, or a fork's pull request from a branch of the same name,
cancelling it left #174 with no checks the ruleset counts); main's runs are
never cancelled.

The group expression is read from ci.yml and worked out here for each
event, with the few pieces of GitHub's expression language it uses."""

import os
import re
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
CI = os.path.join(os.path.dirname(HERE), "workflows", "ci.yml")


def concurrency():
    """The group and cancel-in-progress text of ci.yml's top-level concurrency block."""
    text = open(CI).read()
    block = re.search(r"^concurrency:\n((?:  .*\n)+)", text, re.M)
    if not block:
        raise AssertionError("ci.yml has no top-level concurrency block")
    fields = dict(re.findall(r"^  ([a-z-]+): (.*)$", block.group(1), re.M))
    return fields["group"], fields["cancel-in-progress"]


def lookup(context, name):
    """A dotted name in the context, or "" when any part is missing (as GitHub gives null, which || skips)."""
    value = context
    for part in name.split("."):
        if not isinstance(value, dict) or part not in value:
            return ""
        value = value[part]
    return value


def evaluate(expr, context):
    """`a || b`, `a != 'x'`, quoted strings and dotted names: all ci.yml's group uses."""
    expr = expr.strip()
    if "||" in expr:
        for alternative in expr.split("||"):
            value = evaluate(alternative, context)
            if value:
                return value
        return value
    if "!=" in expr:
        left, right = expr.split("!=")
        return evaluate(left, context) != evaluate(right, context)
    if expr.startswith("'") and expr.endswith("'"):
        return expr[1:-1]
    if not re.fullmatch(r"[a-z_]+(\.[a-z_]+)*", expr):
        raise AssertionError(f"this test can't work out {expr!r}; teach evaluate() it")
    return lookup(context, expr)


def expand(template, context):
    """A workflow value with ${{ }} parts worked out."""

    def part(m):
        value = evaluate(m.group(1), context)
        return str(value).lower() if isinstance(value, bool) else str(value)

    return re.sub(r"\$\{\{(.*?)\}\}", part, template)


REPO = "Panosolid/fission"


def pull_request(number, branch, head_repo=REPO):
    return {"github": {"event_name": "pull_request", "repository": REPO, "ref": f"refs/pull/{number}/merge", "ref_name": f"{number}/merge", "head_ref": branch, "event": {"pull_request": {"head": {"repo": {"full_name": head_repo}}}}}}


def dispatch(branch):
    return {"github": {"event_name": "workflow_dispatch", "repository": REPO, "ref": f"refs/heads/{branch}", "ref_name": branch, "head_ref": "", "event": {}}}


def push(branch):
    return {"github": {"event_name": "push", "repository": REPO, "ref": f"refs/heads/{branch}", "ref_name": branch, "head_ref": "", "event": {}}}


class Groups(unittest.TestCase):
    def group(self, context):
        return expand(concurrency()[0], context)

    def cancels(self, context):
        return expand(concurrency()[1], context)

    def test_worked_by_hand(self):
        # A pull request from our own branch: event, its head repository and its branch.
        self.assertEqual(self.group(pull_request(174, "claude/project-thread-rl3ngu")), "ci-pull_request-Panosolid/fission-claude/project-thread-rl3ngu")
        # main's push: no pull request, so the repository and the ref's name.
        self.assertEqual(self.group(push("main")), "ci-push-Panosolid/fission-main")
        self.assertEqual(self.cancels(push("main")), "false")
        self.assertEqual(self.cancels(pull_request(174, "claude/x")), "true")

    def test_a_newer_push_to_a_pull_request_cancels_its_older_run(self):
        # Two pushes give the same event, head repository and branch.
        self.assertEqual(self.group(pull_request(174, "claude/x")), self.group(pull_request(174, "claude/x")))

    def test_a_run_started_by_hand_never_cancels_a_pull_requests_own_run(self):
        # #174, 15:13 UTC on 2026-10-18: auto-merge dispatched CI on the branch 15 s after
        # the push's own run began, the dispatch cancelled it, and the ruleset counted nothing.
        self.assertNotEqual(self.group(dispatch("claude/x")), self.group(pull_request(174, "claude/x")))

    def test_a_forks_pull_request_never_cancels_ours(self):
        for branch in ("main", "claude/x"):
            fork = self.group(pull_request(900, branch, head_repo="someone/fission"))
            self.assertNotEqual(fork, self.group(pull_request(174, branch)), branch)
            self.assertNotEqual(fork, self.group(push(branch)), branch)
            self.assertNotEqual(fork, self.group(dispatch(branch)), branch)

    def test_each_rule_can_fail(self):
        # The group as it was before each fix, worked out the same way: each breaks one rule.
        before = {
            "no head repository (a fork's main cancels ours)": "ci-${{ github.head_ref || github.ref_name }}",
            "no event (a dispatch cancels the pull request's run)": "ci-${{ github.event.pull_request.head.repo.full_name || github.repository }}-${{ github.head_ref || github.ref_name }}",
        }
        fork_main = pull_request(900, "main", head_repo="someone/fission")
        self.assertEqual(expand(before["no head repository (a fork's main cancels ours)"], fork_main), expand(before["no head repository (a fork's main cancels ours)"], push("main")))
        plant = before["no event (a dispatch cancels the pull request's run)"]
        self.assertEqual(expand(plant, dispatch("claude/x")), expand(plant, pull_request(174, "claude/x")))


if __name__ == "__main__":
    unittest.main()
