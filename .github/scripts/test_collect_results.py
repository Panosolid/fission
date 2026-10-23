"""Tests for collect-results.sh's golden models part (step 28b):
python3 -m unittest discover -s .github/scripts

The script runs for real, on a scratch clone whose origin is a local bare
repository, with no GH_TOKEN, so file_issues.py only prints what it would
file. A night with a failing model must put its folder in failures/, its
lines in summary.txt and file its kind; a clean night files nothing.
"""

import os
import shutil
import subprocess
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))

FAILING = """Golden models, seed 7: 20 rounds of 6 models (tests/golden), 1 failed
failure: l-bracket: Body 1 (feature-15): volume 48000.048 is not 48000 | first in round 3 (order: gear, l-bracket); replay: FISSION_SEED=7 FISSION_GOLDEN_ROUNDS=20 npm run golden -w @fission/testing
"""


def git(cwd, *args):
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True).stdout


class CollectGolden(unittest.TestCase):
    def collect(self, report, failing):
        """Runs collect-results.sh on one golden night; returns (stdout, the test-results branch's files)."""
        with tempfile.TemporaryDirectory() as d:
            origin, work, incoming = (os.path.join(d, x) for x in ("origin.git", "work", "in"))
            git(d, "init", "-q", "--bare", origin)
            git(d, "init", "-q", work)
            git(work, "remote", "add", "origin", origin)
            golden = os.path.join(incoming, "golden")
            os.makedirs(golden)
            with open(os.path.join(golden, "report.txt"), "w") as f:
                f.write(report)
            if failing:
                os.makedirs(os.path.join(golden, "seed-golden-7"))
                with open(os.path.join(golden, "seed-golden-7", "golden-report.txt"), "w") as f:
                    f.write(failing)
            env = {k: v for k, v in os.environ.items() if k not in ("GH_TOKEN", "GITHUB_STEP_SUMMARY")}
            env.update(IN=incoming, RUN_URL="https://example.invalid/runs/1", COMMIT="abcdef1234567", BRANCH="main",
                       GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@t", GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@t")
            # The workflow copies both scripts out first; so does this.
            for s in ("collect-results.sh", "file_issues.py"):
                shutil.copy(os.path.join(HERE, s), d)
            out = subprocess.run(["bash", os.path.join(d, "collect-results.sh")], cwd=work, env=env, capture_output=True, text=True)
            self.assertEqual(out.returncode, 0, out.stdout + out.stderr)
            check = os.path.join(d, "check")
            git(d, "clone", "-q", "-b", "test-results", origin, check)
            files = {}
            for root, _, names in os.walk(check):
                if ".git" in root.split(os.sep):
                    continue
                for n in names:
                    p = os.path.join(root, n)
                    with open(p) as f:
                        files[os.path.relpath(p, check)] = f.read()
            return out.stdout, files

    def test_a_failing_model_files_an_issue_and_is_kept_with_the_failures(self):
        stdout, files = self.collect("seed 7, 20 rounds of 6 models; 1 FAILED\nl-bracket: 20 rebuilds, FAILED\n", FAILING)
        self.assertEqual(files["failures/seed-golden-7/golden-report.txt"], FAILING)
        self.assertIn("tested commit abcdef1234567 on branch main", files["failures/seed-golden-7/commit.txt"])
        self.assertIn("Latest golden models run", files["summary.txt"])
        self.assertIn("  l-bracket: 20 rebuilds, FAILED", files["summary.txt"])
        self.assertRegex(files["golden/log.txt"], r"^\d{4}-\d\d-\d\d \d\d:\d\d,abcdef1,main,seed 7, 20 rounds of 6 models; 1 FAILED\n$")
        # No GH_TOKEN: file_issues.py says what it would file. "-15" goes with its sign, so "feature#".
        self.assertIn("create  golden model l-bracket: Body # (feature#): volume # is not #", stdout)

    def test_a_clean_night_files_nothing(self):
        stdout, files = self.collect("seed 8, 20 rounds of 6 models; every answer right and the same every round\n", None)
        self.assertNotIn("create", stdout)
        self.assertFalse(any(p.startswith("failures/") for p in files))
        self.assertIn("every answer right", files["golden/latest.txt"])


if __name__ == "__main__":
    unittest.main()
