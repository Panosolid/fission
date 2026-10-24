"""Tests for sim_numbers.py and collect-fuzz.sh's simulated-user section (step 30d):
python3 -m unittest discover -s .github/scripts

Hand-worked totals, line fit, buckets and growth; the ENOUGH threshold at
0.9x and 1.1x; WRONG marks exactly where a number isn't 100%; and
collect-fuzz.sh run for real (as test_collect_results.py runs
collect-results.sh) on two fuzzing nights, so the lines land on the
test-results branch with their run and the section in summary.txt.
"""

import contextlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from sim_numbers import ENOUGH, buckets, fit, growth, main, section, totals  # noqa: E402


def row(**k):
    r = {"sessions": 5, "failedSessions": 0, "rebuilds": 1000, "wrongRebuilds": 0, "withFailedFeature": 120, "references": 400,
         "wrongReferences": 0, "builds": 900, "invalidBuilds": 0, "crashedBuilds": 0, "refusedBuilds": 30, "calibrationMs": 2.0,
         "timing": {"2": [10, 4.0, 50.0], "12": [30, 20.0, 900.0]}, "seed": "1", "steps": 500,
         "run": "https://example.invalid/runs/1", "commit": "abc1234", "branch": "main"}
    r.update(k)
    return r


class Maths(unittest.TestCase):
    def test_totals_by_hand_across_machines(self):
        # Two rounds, one on a machine twice as fast (calibration 2 ms against 4 ms): at 3 features the first
        # took fastest 4 ms (2 calibrations) and the second 4 ms (1 calibration), so the fastest is 1 calibration
        # and the total (4 + 8) / 2 + 4 / 4 = 6 + 1 = 7 calibrations over 3 rebuilds.
        a = row(calibrationMs=2.0, timing={"3": [2, 4.0, 12.0]}, rebuilds=10, wrongRebuilds=1)
        b = row(calibrationMs=4.0, timing={"3": [1, 4.0, 4.0], "5": [1, 8.0, 8.0]}, rebuilds=30)
        t = totals([a, b])
        self.assertEqual(t["timing"], {3: (3, 1.0, 7.0), 5: (1, 2.0, 2.0)})
        self.assertEqual((t["rebuilds"], t["wrongRebuilds"], t["sessions"]), (40, 1, 10))

    def test_fit_by_hand(self):
        # Fastest 3, 5, 7 at 1, 2, 3 features: 1 + 2n (as src/sim-numbers.ts's timeFit test).
        self.assertEqual(fit({1: (9, 3.0, 50.0), 2: (1, 5.0, 5.0), 3: (2, 7.0, 30.0)}), (2.0, 1.0))
        # (0, 0), (1, 1), (2, 1), (3, 2): Sxx 5, Sxy 3, so 0.6 per feature, intercept 1 - 0.6 x 1.5 = 0.1.
        slope, icpt = fit({0: (1, 0.0, 0.0), 1: (1, 1.0, 1.0), 2: (1, 1.0, 1.0), 3: (1, 2.0, 2.0)})
        self.assertAlmostEqual(slope, 0.6, places=12)
        self.assertAlmostEqual(icpt, 0.1, places=12)
        self.assertIsNone(fit({4: (3, 1.0, 3.0)}))

    def test_buckets_and_growth_by_hand(self):
        # 1-5: 4 rebuilds at 2 features (8 ms) and 1 at 5 (3 ms): 5 rebuilds, 11 ms, so 2.2 ms a rebuild, and
        # 2 x 4 + 5 = 13 features, 11/13 per feature. 21-40: 2 rebuilds at 30 (40 ms): 20 ms each, 40/60 per feature.
        bs = buckets({2: (4, 1.0, 8.0), 5: (1, 3.0, 3.0), 30: (2, 18.0, 40.0)})
        self.assertEqual([(b[0], b[1]) for b in bs], [("1-5", 5), ("21-40", 2)])
        self.assertAlmostEqual(bs[0][2], 2.2)
        self.assertAlmostEqual(bs[0][3], 11 / 13)
        self.assertAlmostEqual(bs[1][3], 40 / 60)
        self.assertIsNone(growth(bs))  # neither has ENOUGH rebuilds
        # 81 and up is one open bucket.
        self.assertEqual(buckets({200: (1, 5.0, 5.0)})[0][:2], ("81+", 1))
        # Per feature 1 in the small bucket and 3 in the big one: 3x, each feature costs more in a big timeline.
        g = growth(buckets({2: (ENOUGH, 1.0, 2.0 * ENOUGH), 50: (ENOUGH, 1.0, 150.0 * ENOUGH)}))
        self.assertAlmostEqual(g, 3.0)

    def test_enough_rebuilds_at_09_and_11(self):
        # A bucket counts towards growth from ENOUGH rebuilds (20): 18 (0.9x) leaves it out, 22 (1.1x) takes it.
        small = (2, (ENOUGH, 1.0, 2.0 * ENOUGH))
        self.assertIsNone(growth(buckets(dict([small, (50, (18, 1.0, 100.0 * 18))]))))
        self.assertAlmostEqual(growth(buckets(dict([small, (50, (22, 1.0, 100.0 * 22))]))), 2.0)


class Section(unittest.TestCase):
    def test_a_clean_night_says_100_percent_and_no_wrong(self):
        text = "\n".join(section([row()], "now"))
        self.assertIn("rebuilds right:           100% (0 wrong of 1,000)", text)
        self.assertIn("references right:         100% (0 wrong of 400)", text)
        self.assertIn("bodies passing validate:  100% (0 failed or crashed of 900); 30 inputs refused as the user's", text)
        # 120 of 1000 rebuilds had a feature failed as the model says.
        self.assertIn("(the user's doing, shown in words): 12%", text)
        self.assertNotIn("WRONG", text)
        # The last run's times in its own ms: fastest 4 and 20 ms at 2 and 12 features, so (20 - 4) / 10 = 1.6 ms a
        # feature and 4 - 3.2 = 0.8 ms; the same over main in calibrations (2 ms): 0.4 and 0.8 per feature.
        self.assertIn("0.8 ms + 1.6 ms per feature (fastest at each of 2 counts)", text)
        self.assertIn("0.4 x + 0.8 x per feature", text)

    def test_each_wrong_number_is_marked_and_only_it(self):
        # 1 of 1,000 is 0.1%; 2 of 400 is 0.5%; 9 failed of 900 + 9 = 909 answered is 0.990099%, so 99.0099% pass;
        # 1 of 901 is 0.110988%, so 99.889% (to 4 decimals, 99.8890 with its zero dropped).
        cases = [("wrongRebuilds", 1, "rebuilds right:           99.9% (1 wrong of 1,000)"),
                 ("wrongReferences", 2, "references right:         99.5% (2 wrong of 400)"),
                 ("invalidBuilds", 9, "bodies passing validate:  99.0099% (9 failed or crashed of 909)"),
                 ("crashedBuilds", 1, "bodies passing validate:  99.889% (1 failed or crashed of 901)")]
        for key, n, line in cases:
            lines = section([row(**{key: n})], "now")
            marked = [x for x in lines if "WRONG" in x]
            # Wrong in the last run and in the total over main: two lines, both this number's.
            self.assertEqual(len(marked), 2, key)
            self.assertTrue(all(line.split(":")[0].strip() in x for x in marked), (key, marked))
            self.assertTrue(any(x.strip().startswith(line) for x in lines), (key, lines))

    def test_last_run_and_main_are_kept_apart(self):
        rows = [row(), row(run="https://example.invalid/runs/2", branch="claude/x", wrongRebuilds=3)]
        lines = section(rows, "now")
        self.assertIn("last run (https://example.invalid/runs/2, commit abc1234 on claude/x): 5 sessions in 1 rounds", lines[1])
        # The branch's wrong rebuilds show in the last run, not in main's total.
        self.assertEqual(sum("WRONG" in x for x in lines), 1)
        self.assertEqual(section([], "now")[1], "  no rounds yet")


def git(cwd, *args):
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True).stdout


class CollectFuzz(unittest.TestCase):
    def test_two_nights_land_on_test_results_with_their_run_and_the_section(self):
        with tempfile.TemporaryDirectory() as d:
            origin, work = os.path.join(d, "origin.git"), os.path.join(d, "work")
            git(d, "init", "-q", "--bare", origin)
            git(d, "init", "-q", work)
            git(work, "remote", "add", "origin", origin)
            for s in ("collect-fuzz.sh", "file_issues.py", "sim_numbers.py"):
                shutil.copy(os.path.join(HERE, s), d)
            for night, wrong in ((1, 0), (2, 1)):
                incoming = os.path.join(d, f"in{night}")
                tl = os.path.join(incoming, "fuzz-timeline")
                os.makedirs(tl)
                with open(os.path.join(tl, "log.csv"), "w") as f:
                    f.write(f"target,seed,cases,failures,seconds\ntimeline,{night},2500,0,600.0\n")
                with open(os.path.join(tl, "numbers.jsonl"), "w") as f:
                    for k in range(2):
                        r = {key: v for key, v in row(seed=str(night * 10 + k), wrongRebuilds=wrong if k else 0).items() if key not in ("run", "commit", "branch")}
                        f.write(json.dumps(r) + "\n")
                env = {k: v for k, v in os.environ.items() if k not in ("GH_TOKEN", "GITHUB_STEP_SUMMARY")}
                env.update(IN=incoming, RUN_URL=f"https://example.invalid/runs/{night}", COMMIT="abcdef1234567", BRANCH="main",
                           GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@t", GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@t")
                out = subprocess.run(["bash", os.path.join(d, "collect-fuzz.sh")], cwd=work, env=env, capture_output=True, text=True)
                self.assertEqual(out.returncode, 0, out.stdout + out.stderr)
            check = os.path.join(d, "check")
            git(d, "clone", "-q", "-b", "test-results", origin, check)
            with open(os.path.join(check, "fuzz", "numbers.jsonl")) as f:
                lines = [json.loads(x) for x in f]
            self.assertEqual([(x["seed"], x["run"][-1], x["commit"], x["branch"]) for x in lines],
                             [("10", "1", "abcdef1", "main"), ("11", "1", "abcdef1", "main"), ("20", "2", "abcdef1", "main"), ("21", "2", "abcdef1", "main")])
            with open(os.path.join(check, "summary.txt")) as f:
                summary = f.read()
            # One fuzzing section and one simulated-users section, the second night's: 1 wrong of its 2,000 rebuilds
            # (99.95%), and over main 1 of 4,000 (99.975%).
            self.assertEqual(summary.count("Fuzzing (the STL reader"), 1)
            self.assertEqual(summary.count("Simulated users ("), 1)
            self.assertIn("last run (https://example.invalid/runs/2, commit abcdef1 on main): 10 sessions in 2 rounds", summary)
            self.assertIn("rebuilds right:           99.95% (1 wrong of 2,000)   <- WRONG", summary)
            self.assertIn("all runs on main so far: 20 sessions in 4 rounds", summary)
            self.assertIn("rebuilds right:           99.975% (1 wrong of 4,000)   <- WRONG", summary)

    def test_the_command_line(self):
        with tempfile.TemporaryDirectory() as d:
            src, dst = os.path.join(d, "in.jsonl"), os.path.join(d, "out.jsonl")
            with open(src, "w") as f:
                f.write(json.dumps({"seed": "1"}) + "\n\n")
            os.environ.update(RUN_URL="u", COMMIT="c", BRANCH="b")
            try:
                self.assertEqual(main(["--append", src, dst]), 0)
                self.assertEqual(main(["--append", src, dst]), 0)
            finally:
                for k in ("RUN_URL", "COMMIT", "BRANCH"):
                    del os.environ[k]
            with open(dst) as f:
                self.assertEqual([json.loads(x) for x in f], [{"seed": "1", "run": "u", "commit": "c", "branch": "b"}] * 2)
            with contextlib.redirect_stderr(io.StringIO()) as err:
                self.assertEqual(main([]), 2)
                self.assertEqual(main(["--nope"]), 2)
            self.assertIn("Usage:", err.getvalue())


if __name__ == "__main__":
    unittest.main()
