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

    def test_only_judges_the_metrics_it_names(self):
        # The nightly golden run measures app.golden* alone: without --only the
        # kernel's line reads as missing and fails; with it, only the golden
        # lines are judged, and a golden line that went missing still fails.
        base = {"margins": MARGINS, "metrics": {"k.op.instructions": 1_000_000, "app.golden_a.instructions": 50_000}}
        code, printed, _ = self.run_main(base, {"app.golden_a.instructions": 50_000})
        self.assertEqual(code, 1)
        code, printed, _ = self.run_main(base, {"app.golden_a.instructions": 50_000, "k.other.instructions": 7}, "--only", "app.golden")
        self.assertEqual(code, 0, printed)
        # Neither the baseline's other lines nor other measured ones are in the table.
        table = printed.split("Measured")[0]
        self.assertNotIn("k.op.instructions", table)
        self.assertNotIn("k.other.instructions", table)
        self.assertIn("| app.golden_a.instructions | 50,000 | 50,000 |", table)
        code, printed, _ = self.run_main(base, {"app.golden_a.instructions": 60_000}, "--only", "app.golden")
        self.assertEqual(code, 1)
        code, printed, _ = self.run_main(base, {}, "--only", "app.golden")
        self.assertEqual(code, 1)
        self.assertIn("app.golden_a.instructions is in tests/baseline.json but was not measured", printed)
        # --update writes the whole baseline, so it refuses to go with --only.
        code, _, after = self.run_main(base, {"app.golden_a.instructions": 1}, "--only", "app.golden", "--update")
        self.assertEqual((code, after), (2, base))

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

    def test_the_rebuild_counts_fail_each_planted_bug(self):
        # The counts journeys/rebuild-baseline.journey.ts works out by hand for
        # one edit of "20 features with arcs, edit the first" (step 24d3c):
        # 43 kernel calls and 1 body built; with the cache emptied every edit,
        # 103 and 21; with every outline asked twice, 63 and 1.
        with open(baseline.BASELINE) as f:
            b = json.load(f)
        op = "app.rebuild_20_arcs_edit_first"
        ours = {m: v for m, v in b["metrics"].items() if m.startswith(op + ".") and baseline.kind_of(m) != "relative_time"}
        self.assertEqual(ours, {f"{op}.kernel_calls": 43, f"{op}.body_builds": 1})

        def judged(calls, builds):
            return {m: v for m, _, _, _, v in compare({"margins": b["margins"], "metrics": ours}, {f"{op}.kernel_calls": calls, f"{op}.body_builds": builds})}

        self.assertEqual(judged(43, 1), {f"{op}.kernel_calls": "ok", f"{op}.body_builds": "ok"})
        self.assertEqual(judged(103, 21), {f"{op}.kernel_calls": "fail", f"{op}.body_builds": "fail"})
        self.assertEqual(judged(63, 1), {f"{op}.kernel_calls": "fail", f"{op}.body_builds": "ok"})
        # One body more is a feature rebuilt that didn't change: fails.
        self.assertEqual(judged(43, 2)[f"{op}.body_builds"], "fail")
        # Calls at 0.9x and 1.1x of the 15% margin: 43 x 1.135 = 48.8, so 48
        # (+11.6%) passes; 43 x 1.165 = 50.1, so 51 (+18.6%) fails.
        self.assertEqual(judged(48, 1)[f"{op}.kernel_calls"], "ok")
        self.assertEqual(judged(51, 1)[f"{op}.kernel_calls"], "fail")


    def test_the_naming_success_rate_fails_on_any_miss(self):
        # Step 25b4: the naming sessions check 4,466 held references and miss
        # none, so miss_percent is 0 (a 100% success rate). One miss is
        # 1 / 4466 = 0.0224%, the smallest rise there can be: it fails, as
        # does losing every fifth reference (FISSION_BASELINE_FAULT=lose-refs
        # measured 14.8%). The count checked is shown, never judged.
        with open(baseline.BASELINE) as f:
            b = json.load(f)
        m = "app.naming_sessions.miss_percent"
        self.assertEqual(b["metrics"][m], 0)
        self.assertEqual(b["margins"]["miss_percent"]["fail"], 0)

        def judged(new):
            return {k: v for k, _, _, _, v in compare({"margins": b["margins"], "metrics": {m: 0}}, {m: new, "app.naming_sessions.references": 4466})}

        self.assertEqual(judged(0), {m: "ok", "app.naming_sessions.references": "info"})
        self.assertEqual(judged(round(1 / 4466 * 100, 4))[m], "fail")
        self.assertEqual(judged(14.8007)[m], "fail")

    def test_the_simulated_users_fail_each_planted_bug(self):
        # Step 30d: the naming baseline's 8 seeded sessions of 150 steps run 1,136 steps and the kernel answers
        # 14,478 body builds, every rebuild and body right, so wrong_percent and invalid_percent are 0. The smallest
        # rise is one wrong of all of them, 1 / 1136 = 0.088% and 1 / 14478 = 0.0069%: each fails. Measured with
        # FISSION_BASELINE_FAULT: invalid-bodies (every tenth build failing validate) 10% invalid, 15 of 150
        # answered before the sessions it broke stopped, and 9.7561% wrong; wrong-rebuild (Design's
        # cache-by-feature bug) 8.4211% wrong; slow-rebuild (every rebuild from scratch 2.5 times as long)
        # relative_time 0.0197 against 0.0078 to 0.0082 on the same machine, +140%, past the 100% that fails.
        with open(baseline.BASELINE) as f:
            b = json.load(f)
        names = {m: v for m, v in b["metrics"].items() if m.startswith("app.simulated_users.")}
        w, i, t = (f"app.simulated_users.{k}" for k in ("wrong_percent", "invalid_percent", "relative_time"))
        self.assertEqual(set(names), {w, i, t})
        self.assertEqual((names[w], names[i]), (0, 0))
        self.assertEqual((b["margins"]["wrong_percent"]["fail"], b["margins"]["invalid_percent"]["fail"]), (0, 0))

        def judged(new):
            return {k: v for k, _, _, _, v in compare({"margins": b["margins"], "metrics": names}, dict({w: 0, i: 0, t: names[t]}, **new))}

        self.assertEqual(judged({"app.simulated_users.rebuilds": 1136}), {w: "ok", i: "ok", t: "ok", "app.simulated_users.rebuilds": "info"})
        self.assertEqual(judged({w: round(1 / 1136 * 100, 4)})[w], "fail")
        self.assertEqual(judged({i: round(1 / 14478 * 100, 4)})[i], "fail")
        self.assertEqual(judged({i: 10, w: 9.7561}), {w: "fail", i: "fail", t: "ok"})
        self.assertEqual(judged({w: 8.4211})[w], "fail")
        # Time: 2.4 times the baseline fails; 1.9 times (0.9 of the 100% margin past it) only flags; 1.1 of the 15%
        # flag (+16.5%) flags; 0.9 of it (+13.5%) is ok.
        self.assertEqual(judged({t: names[t] * 2.4})[t], "fail")
        self.assertEqual(judged({t: names[t] * 1.9})[t], "flag")
        self.assertEqual(judged({t: names[t] * 1.165})[t], "flag")
        self.assertEqual(judged({t: names[t] * 1.135})[t], "ok")

    def test_the_golden_models_counts_and_success_rate(self):
        # Step 28b: one rebuild from nothing asks the kernel for each sketch's
        # outline once, and builds and views each body once (the frees after
        # are the runner's, not counted), so 2 x bodies + sketches, from each
        # model's expect.json and project file: bracket-two-holes 1 body (one
        # extrude of a profile the part holds itself, no sketch): 2; enclosure 5 bodies (the floor is
        # the starting box), 4 sketches: 14; gear 1 and 1: 3; l-bracket 1 and
        # 1: 3; stepped-boss 3 and 2: 8; thirty-features 16 and 15: 47.
        with open(baseline.BASELINE) as f:
            b = json.load(f)
        calls = {m[len("app.golden_"):-len(".kernel_calls")]: v for m, v in b["metrics"].items() if m.startswith("app.golden_") and m.endswith(".kernel_calls")}
        self.assertEqual(calls, {"bracket_two_holes": 2 * 1 + 0, "enclosure": 2 * 5 + 4, "gear": 2 * 1 + 1, "l_bracket": 2 * 1 + 1, "stepped_boss": 2 * 3 + 2, "thirty_features": 2 * 16 + 15})
        m = "app.golden_models.failed_percent"
        self.assertEqual(b["metrics"][m], 0)
        self.assertEqual(b["margins"]["failed_percent"]["fail"], 0)

        def judged(new):
            return {k: v for k, _, _, _, v in compare({"margins": b["margins"], "metrics": {m: 0}}, {m: new})}[m]

        # One of the six models wrong: 1 / 6 = 16.6667%, fails; none: ok.
        self.assertEqual(judged(0), "ok")
        self.assertEqual(judged(round(1 / 6 * 100, 4)), "fail")
        # One extra kernel call on the smallest model (3 to 4, +33%) fails the 15% margin.
        op = "app.golden_l_bracket.kernel_calls"
        self.assertEqual({k: v for k, _, _, _, v in compare({"margins": b["margins"], "metrics": {op: 3}}, {op: 4})}[op], "fail")


if __name__ == "__main__":
    unittest.main()
