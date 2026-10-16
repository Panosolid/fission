"""Tests for baseline.py: python3 -m unittest discover -s .github/scripts"""

import json
import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(__file__))
import baseline  # noqa: E402
from baseline import compare  # noqa: E402

MARGINS = {"instructions": {"fail": 15, "floor": 1000}, "relative_time": {"flag": 15, "fail": 100}, "x": {"flag": 15}}


def verdicts(old, new):
    return {m: v for m, _, _, _, v in compare({"margins": MARGINS, "metrics": old}, new)}


class Compare(unittest.TestCase):
    def test_boundaries_at_09_and_11_of_the_margin(self):
        # Margin 15%: 0.9 × 15 = 13.5% worse passes, 1.1 × 15 = 16.5% fails.
        # From 1,000,000 instructions: 1,135,000 and 1,165,000.
        old = {"k.op.instructions": 1_000_000}
        self.assertEqual(verdicts(old, {"k.op.instructions": 1_135_000}), {"k.op.instructions": "ok"})
        self.assertEqual(verdicts(old, {"k.op.instructions": 1_165_000}), {"k.op.instructions": "fail"})
        # Better by 13.5% is quiet; by 16.5% it is pointed out, never failed.
        self.assertEqual(verdicts(old, {"k.op.instructions": 865_000}), {"k.op.instructions": "ok"})
        self.assertEqual(verdicts(old, {"k.op.instructions": 835_000}), {"k.op.instructions": "better"})

    def test_a_noisy_metric_flags_first_and_fails_only_far_out(self):
        # flag 15%, fail 100%: from 2.0, 2.33 (+16.5%) and 3.8 (+90%, 0.9 × 100)
        # are flagged; 4.2 (+110%, 1.1 × 100) fails; 1.67 (-16.5%) is better.
        old = {"a.op.relative_time": 2.0}
        for new, want in ((2.27, "ok"), (2.33, "flag"), (3.8, "flag"), (4.2, "fail"), (1.67, "better")):
            self.assertEqual(verdicts(old, {"a.op.relative_time": new}), {"a.op.relative_time": want}, new)

    def test_flag_only_metrics_never_fail(self):
        old = {"a.op.x": 2.0}
        # 2.0 → 2.33 is +16.5%: past 15%, flagged; even 10× is only flagged.
        self.assertEqual(verdicts(old, {"a.op.x": 2.33}), {"a.op.x": "flag"})
        self.assertEqual(verdicts(old, {"a.op.x": 20.0}), {"a.op.x": "flag"})
        self.assertEqual(verdicts(old, {"a.op.x": 2.27}), {"a.op.x": "ok"})

    def test_the_floor_ignores_tiny_changes(self):
        # 2,000 → 2,900 is +45%, but only 900 instructions: under the 1,000 floor.
        old = {"k.op.instructions": 2000}
        self.assertEqual(verdicts(old, {"k.op.instructions": 2900}), {"k.op.instructions": "ok"})
        # 1,100 more is past the floor and +55%: fails.
        self.assertEqual(verdicts(old, {"k.op.instructions": 3100}), {"k.op.instructions": "fail"})
        # From zero, growth past the floor fails (no percentage to take).
        self.assertEqual(verdicts({"k.op.instructions": 0}, {"k.op.instructions": 5000}), {"k.op.instructions": "fail"})

    def test_missing_new_and_unruled_metrics(self):
        v = verdicts({"k.gone.instructions": 5, "k.op.nanos": 100}, {"k.new.instructions": 7, "k.op.nanos": 900, "k.new.nanos": 1})
        self.assertEqual(v, {"k.gone.instructions": "missing", "k.new.instructions": "new", "k.op.nanos": "info", "k.new.nanos": "info"})


class Main(unittest.TestCase):
    def run_main(self, base, measured, *args):
        with tempfile.TemporaryDirectory() as d:
            b, m = os.path.join(d, "baseline.json"), os.path.join(d, "measured.json")
            for path, data in ((b, base), (m, measured)):
                with open(path, "w") as f:
                    json.dump(data, f)
            with mock.patch.object(baseline, "BASELINE", b), mock.patch.dict(os.environ, {"GITHUB_STEP_SUMMARY": ""}), \
                    mock.patch("sys.stdout") as out:
                code = baseline.main(["--measured", m, *args])
                printed = "".join(c.args[0] for c in out.write.call_args_list)
            with open(b) as f:
                after = json.load(f)
        return code, printed, after

    def test_exit_code_and_annotations(self):
        base = {"margins": MARGINS, "metrics": {"k.op.instructions": 1_000_000, "a.op.relative_time": 2.0}}
        code, printed, _ = self.run_main(base, {"k.op.instructions": 1_000_000, "a.op.relative_time": 3.0})
        self.assertEqual(code, 0)  # a flag alone passes
        self.assertIn("::warning title=Baseline: a.op.relative_time::", printed)
        code, printed, _ = self.run_main(base, {"k.op.instructions": 1_200_000, "a.op.relative_time": 2.0})
        self.assertEqual(code, 1)
        self.assertIn("::error title=Baseline: k.op.instructions::k.op.instructions is 1,200,000, baseline 1,000,000 (+20.0%)", printed)
        code, printed, _ = self.run_main(base, {"a.op.relative_time": 2.0})
        self.assertEqual(code, 1)
        self.assertIn("was not measured", printed)

    def test_update_writes_the_measured_values_and_keeps_the_margins(self):
        base = {"about": "x", "margins": MARGINS, "metrics": {"k.op.instructions": 1}}
        code, _, after = self.run_main(base, {"k.op.instructions": 9_999_999, "k.op.nanos": 5}, "--update")
        self.assertEqual(code, 0)
        # Wall time (no margin) is not kept.
        self.assertEqual(after, {"about": "x", "margins": MARGINS, "metrics": {"k.op.instructions": 9_999_999}})


class TheRealBaseline(unittest.TestCase):
    def test_every_metric_kind_has_a_margin_and_values_are_numbers(self):
        with open(baseline.BASELINE) as f:
            b = json.load(f)
        kinds = {baseline.kind_of(m) for m in b["metrics"]}
        self.assertEqual(kinds - set(b["margins"]), set())
        self.assertGreaterEqual(len(b["metrics"]), 40)
        self.assertTrue(all(isinstance(v, (int, float)) for v in b["metrics"].values()))
        for rule in b["margins"].values():
            self.assertTrue(set(rule) <= {"fail", "flag", "floor", "why"} and ("fail" in rule or "flag" in rule))


if __name__ == "__main__":
    unittest.main()
