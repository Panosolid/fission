"""Tests for golden_step.py (step 29b3): python3 -m unittest discover -s
prototypes/oracle -p 'test_*.py' (needs cadquery-ocp and mpmath).
Expected values are worked out by hand in the comments."""

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(__file__)
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "..", ".github", "scripts"))

with open(os.path.join(HERE, "..", "..", "kernel", "tests", "step", "unit_cube.step")) as f:
    CUBE = f.read()
FLIPPED = CUBE.replace("#101 = ADVANCED_FACE('',(#100),#94,.T.);", "#101 = ADVANCED_FACE('',(#100),#94,.F.);")


def line(step=CUBE, volume=1.0, area=6.0, faces=6, refused=None):
    # A model's 1 x 1 x 1 cube: V = 1, S = 6, six faces, by hand.
    return {"model": "cube", "body": "Body 1", "item": "feature-1", "step": step, "step_refused": refused,
            "volume": volume, "area": area, "faces": faces}


def run(lines, *extra):
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "golden-step.jsonl")
        report = os.path.join(d, "golden-report.txt")
        with open(path, "w") as f:
            f.write("".join(json.dumps(l) + "\n" for l in lines))
        p = subprocess.run([sys.executable, os.path.join(HERE, "golden_step.py"), path, report, *extra], capture_output=True, text=True)
        text = open(report).read() if os.path.exists(report) else None
        return p.returncode, p.stdout, text


@unittest.skipUnless(importlib.util.find_spec("OCP") is not None and importlib.util.find_spec("mpmath") is not None,
                     "needs cadquery-ocp and mpmath")
class GoldenStep(unittest.TestCase):
    def setUp(self):
        import compare
        import golden_step
        self.compare, self.g = compare, golden_step

    def test_the_cube_agrees_with_its_hand_worked_answers(self):
        self.assertEqual(self.g.check(line(), self.compare), ([], []))

    def test_the_hand_worked_answers_are_the_referee_at_rel(self):
        # The golden REL is a billionth of the size: the cube's area 6 read
        # against an answer 6 (1 + 0.9e-9) passes, 6 (1 + 1.1e-9) doesn't.
        self.assertEqual(self.g.check(line(area=6.0 * (1 + 0.9e-9)), self.compare)[0], [])
        issues = self.g.check(line(area=6.0 * (1 + 1.1e-9)), self.compare)[0]
        self.assertEqual([i.split(":")[0] for i in issues], ["step area"], issues)

    def test_a_flipped_face_a_refusal_or_a_wrong_face_count_is_a_finding(self):
        issues = self.g.check(line(FLIPPED), self.compare)[0]
        self.assertIn("step validity", [i.split(":")[0] for i in issues])
        self.assertTrue(all(i.endswith("(cube, Body 1 (feature-1))") for i in issues), issues)
        issues = self.g.check(line(None, refused="body 3 is not in the kernel"), self.compare)[0]
        self.assertEqual(issues, ["step write refused: body 3 is not in the kernel (cube, Body 1 (feature-1))"])
        issues = self.g.check(line(faces=7), self.compare)[0]
        self.assertEqual([i.split(":")[0] for i in issues], ["step faces"], issues)

    def test_a_body_without_answers_is_said_so(self):
        issues = self.g.check(line(volume=None, area=None, faces=None), self.compare)[0]
        self.assertEqual(issues, ["no hand-worked answers for this body, so its STEP file isn't judged (cube, Body 1 (feature-1))"])

    def test_the_report_is_what_file_issues_reads(self):
        code, out, report = run([line(), line(FLIPPED)])
        self.assertEqual(code, 1)
        self.assertIn("2 bodies read by OpenCascade, 1 disagreement(s)", out)
        from file_issues import golden_kinds
        kinds = [k for k, _ in golden_kinds(report)]
        self.assertEqual(len(kinds), 1, report)
        self.assertTrue(kinds[0].startswith("golden model cube: step validity: BRepCheck: invalid"), kinds)
        code, _, report = run([line()])
        self.assertEqual((code, report), (0, None))

    def test_planted_passes_only_when_every_body_is_caught(self):
        self.assertEqual(run([line(FLIPPED), line(FLIPPED)], "--planted")[0], 0)
        self.assertEqual(run([line(FLIPPED), line()], "--planted")[0], 1)  # one got through
        self.assertEqual(run([], "--planted")[0], 1)  # nothing checked


if __name__ == "__main__":
    unittest.main()
