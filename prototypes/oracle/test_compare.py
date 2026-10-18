"""Tests for compare.py's checks: python3 -m unittest discover -s prototypes/oracle -p 'test_*.py'
(needs cadquery-ocp and mpmath, so they run where the oracle runs; skipped
elsewhere)."""

import importlib.util
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))


@unittest.skipUnless(importlib.util.find_spec("OCP") is not None, "needs cadquery-ocp")
class Bounds(unittest.TestCase):
    def test_all_six_bounds_are_compared(self):
        import compare
        # A 1 x 2 x 3 box at the origin, unmoved: bounds (0,0,0)-(1,2,3),
        # V = 6, S = 2(2 + 3 + 6) = 22, a mesh exactly the box.
        box = {"shape": {"Box": {"w": "1.0", "d": "2.0", "h": "3.0"}}, "matrix": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0],
               "faces": 6, "lo": [0.0, 0.0, 0.0], "hi": [1.0, 2.0, 3.0], "max_deviation": 0.0,
               "volume_slack": 0.0, "area_slack": 0.0, "exact_volume": 6.0, "exact_area": 22.0, "volume": 6.0, "area": 22.0}
        self.assertEqual(compare.compare(box)[1:], ([], []))
        names = ["lowest x", "lowest y", "lowest z", "highest x", "highest y", "highest z"]
        for k, name in enumerate(names):
            bounds = box["lo"] + box["hi"]
            bounds[k] += 0.01
            issues = compare.compare({**box, "lo": bounds[:3], "hi": bounds[3:]})[1]
            self.assertEqual([i.split(":")[0] for i in issues], [f"bounds {name}"], issues)


# Issue #92 (random testing, seed 255015376732589, before the #73 fix): a
# triangle 6 um across whose last side is a nearly whole circle (bulge
# 1.1e8). OpenCascade gave "GC_MakeArcOfCircle::Value() - no result" when the
# oracle built that arc through three points.
ISSUE_92 = {"Extrude": {"dist": "3.520450720126221", "expect": None, "holes": [], "outer": {"Path": {
    "bulges": ["0.0", "0.0714850556501117", "110000000.00000001"],
    "pts": [["635.7622874410404", "-16.497576940184853"], ["635.7615036988533", "-16.503332645044924"],
            ["635.7652071841055", "-16.5"]]}}}}


@unittest.skipUnless(importlib.util.find_spec("OCP") is not None and importlib.util.find_spec("mpmath") is not None,
                     "needs cadquery-ocp and mpmath")
class NearlyWholeArcs(unittest.TestCase):
    def test_issue_92_builds_and_measures_exactly(self):
        import compare
        from exact import volume_area
        from OCP.BRepCheck import BRepCheck_Analyzer
        _, shape, _ = compare.build(compare.centred(ISSUE_92))
        self.assertTrue(BRepCheck_Analyzer(shape).IsValid())
        volume, area, _, _, faces = compare.measure(shape)
        # By hand: the last side's chord runs from (635.76521, -16.5) to
        # (635.76229, -16.49758), dx = -0.0029197, dy = 0.0024231, so
        # c = sqrt(8.525e-6 + 5.871e-6) = 0.0037942 mm. Its radius is
        # c (1 + b^2) / (4 b) ~ c b / 4 = 0.0037942 x 1.1e8 / 4 = 104,341 mm,
        # and the arc goes nearly all the way round, so the profile is the
        # disc pi r^2 = 3.4203e10 mm^2 to within the 6 um triangle, and the
        # volume 3.4203e10 x 3.52045 = 1.2041e11 mm^3 (to 4 figures).
        self.assertAlmostEqual(volume / 1.2041e11, 1.0, delta=1e-4)
        self.assertEqual(faces, 5)  # two caps and three sides
        # And to OpenCascade's own accuracy against the 50-digit value: the
        # arc built through three points was 2.4e-8 low on these (#73).
        exact_v, exact_a = volume_area(ISSUE_92)
        self.assertLess(abs(volume - float(exact_v)), compare.REL * float(exact_v))
        self.assertLess(abs(area - float(exact_a)), compare.REL * float(exact_a))


if __name__ == "__main__":
    unittest.main()
