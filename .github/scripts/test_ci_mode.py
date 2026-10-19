"""Tests for ci_mode.py and the rules ci.yml's jobs keep: python3 -m unittest discover -s .github/scripts"""

import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from ci_mode import decide, touches_ui  # noqa: E402

WORKFLOWS = os.path.join(os.path.dirname(HERE), "workflows")
QUEUE = [dict(type="deletion"), dict(type="required_status_checks"), dict(type="merge_queue")]
NO_QUEUE = QUEUE[:-1]


class Mode(unittest.TestCase):
    def test_worked_by_hand(self):
        # A pull request while main requires the queue, changing a sketch file:
        # quick (the queue runs it in full before merging), with Firefox and WebKit.
        self.assertEqual(decide("pull_request", QUEUE, ["workspaces/design/src/sketch.ts"]), (False, True))
        # The same without the queue rule: its own run is the last test before main, so full.
        self.assertEqual(decide("pull_request", NO_QUEUE, ["workspaces/design/src/sketch.ts"]), (True, True))
        # A kernel-only pull request: no Firefox and WebKit.
        self.assertEqual(decide("pull_request", QUEUE, ["kernel/src/boolean.rs", "docs/progress/cad.md"]), (False, False))
        # The queue's own run, main's daily run and a run by hand: always full.
        for event in ("merge_group", "schedule", "push", "workflow_dispatch"):
            self.assertEqual(decide(event, None, None), (True, True), event)
            self.assertEqual(decide(event, QUEUE, ["kernel/src/a.rs"]), (True, True), event)

    def test_doubt_means_more_testing(self):
        # Rules unreadable: full. Files unreadable: browsers run.
        self.assertEqual(decide("pull_request", None, ["kernel/src/a.rs"]), (True, False))
        self.assertEqual(decide("pull_request", QUEUE, None), (False, True))

    def test_ui_files(self):
        for f in ("apps/fission/src/main.ts", "packages/ui/src/styles/x.css", "workspaces/image/src/a.ts",
                  "package.json", "package-lock.json", ".github/workflows/ci.yml"):
            self.assertTrue(touches_ui([f]), f)
        for f in ("kernel/src/a.rs", "docs/roadmap.md", "prototypes/x.py", ".github/scripts/automerge.py",
                  "tests/baseline.json", "CLAUDE.md", "apps", "xapps/a.ts", ".github/workflows/nightly.yml"):
            self.assertFalse(touches_ui([f]), f)
        self.assertTrue(touches_ui(["kernel/src/a.rs", "apps/fission/index.html"]))
        self.assertFalse(touches_ui([]))


def jobs(path):
    """Each top-level job's name and its block of lines, read without a YAML library."""
    text = open(path).read()
    body = text.split("\njobs:\n", 1)[1]
    found = re.split(r"^  ([A-Za-z0-9_-]+):\n", body, flags=re.M)
    return dict(zip(found[1::2], found[2::2]))


class Workflows(unittest.TestCase):
    def test_every_job_has_a_timeout(self):
        # A hung job holds a runner for GitHub's six hours; every job says its own limit.
        names = sorted(f for f in os.listdir(WORKFLOWS) if f.endswith(".yml"))
        self.assertIn("ci.yml", names)
        for name in names:
            for job, block in jobs(os.path.join(WORKFLOWS, name)).items():
                with self.subTest(workflow=name, job=job):
                    self.assertRegex(block, r"(?m)^    timeout-minutes: \d+$")

    def test_the_timeout_check_can_fail(self):
        planted = "name: x\non: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    timeout-minutes: 5\n  b:\n    runs-on: ubuntu-latest\n"
        path = os.path.join(os.environ.get("TMPDIR", "/tmp"), "planted-workflow.yml")
        with open(path, "w") as f:
            f.write(planted)
        found = jobs(path)
        self.assertRegex(found["a"], r"(?m)^    timeout-minutes: \d+$")
        self.assertNotRegex(found["b"], r"(?m)^    timeout-minutes: \d+$")

    def test_required_checks_never_skip_on_a_failed_mode(self):
        # A skipped job counts as passed for main's ruleset, so a required job
        # that needs `mode` must still run when `mode` fails, and the steps it
        # drops in a quick run only drop on an explicit 'false'.
        ci = jobs(os.path.join(WORKFLOWS, "ci.yml"))
        self.assertIn("if: ${{ !cancelled() }}", ci["kernel"])
        self.assertNotIn("full == 'true'", ci["kernel"])
        self.assertIn("if: always()", ci["e2e"])
        self.assertIn('if [ "$FULL" = false ]', ci["e2e"])
        self.assertIn("needs.mode.outputs.full != 'false'", ci["e2e-shard"])
        self.assertIn("merge_group:", open(os.path.join(WORKFLOWS, "ci.yml")).read())


if __name__ == "__main__":
    unittest.main()
