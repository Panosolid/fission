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


if __name__ == "__main__":
    unittest.main()
