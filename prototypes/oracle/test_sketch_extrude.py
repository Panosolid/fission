"""Tests for sketch_extrude.py's STEP check (step 29b3): python3 -m
unittest discover -s prototypes/oracle -p 'test_*.py' (needs cadquery-ocp
and mpmath). Expected values are worked out by hand in the comments."""

import importlib.util
import os
import sys
import unittest

HERE = os.path.dirname(__file__)
sys.path.insert(0, HERE)

with open(os.path.join(HERE, "..", "..", "kernel", "tests", "step", "unit_cube.step")) as f:
    CUBE = f.read()


def square(step, refused=None):
    # A unit square drawn in a session and extruded 1: the unit cube, V = 1,
    # S = 6, six faces, by the kernel and the session's model alike.
    pts = [["0.0", "0.0"], ["1.0", "0.0"], ["1.0", "1.0"], ["0.0", "1.0"]]
    return {"shape": {"Extrude": {"outer": {"Path": {"pts": pts, "bulges": ["0.0"] * 4}}, "holes": [], "dist": 1.0}},
            "fission_volume": 1.0, "fission_area": 6.0, "fission_faces": 6, "model_volume": 1.0, "model_area": 6.0,
            "context": "seed 1 step 2", "step": step, "step_refused": refused}


@unittest.skipUnless(importlib.util.find_spec("OCP") is not None and importlib.util.find_spec("mpmath") is not None,
                     "needs cadquery-ocp and mpmath")
class SessionSteps(unittest.TestCase):
    def test_the_cubes_file_agrees(self):
        import sketch_extrude
        self.assertEqual(sketch_extrude.check(square(CUBE)), ([], []))

    def test_a_flipped_face_or_a_refusal_is_a_disagreement(self):
        import sketch_extrude
        flipped = CUBE.replace("#101 = ADVANCED_FACE('',(#100),#94,.T.);", "#101 = ADVANCED_FACE('',(#100),#94,.F.);")
        issues = sketch_extrude.check(square(flipped))[0]
        self.assertIn("step validity", [i.split(":")[0] for i in issues])
        self.assertTrue(all(i.endswith("(seed 1 step 2)") for i in issues), issues)
        issues = sketch_extrude.check(square(None, "too many bodies"))[0]
        self.assertEqual(issues, ["step write refused: too many bodies (seed 1 step 2)"])


if __name__ == "__main__":
    unittest.main()
