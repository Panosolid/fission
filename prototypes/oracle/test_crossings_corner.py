"""crossings.py's allowance at a shared corner (issue #138): two neighbours
meeting within LINEAR (10 nm) of the corner they share are not a crossing;
meeting further out they are. python3 -m unittest discover -s
prototypes/oracle -p 'test_*.py' (needs mpmath)."""

import math
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))
from crossings import LINEAR, crossings  # noqa: E402
from test_crossings import extrude, path  # noqa: E402


def line_then_arc(d):
    """A loop whose first two pieces, neighbours at (0, 0), meet again at
    (0, d). Piece 0 runs down x = 0 from (0, 5) to (0, 0). Piece 1 is an
    arc of the circle through (0, 0) and (0, d) centred at (-1, d/2)
    (radius r = sqrt(1 + d^2/4)), counter-clockwise from (0, 0) (at angle
    atan2(-d/2, 1) round the centre) through its rightmost point, back
    across x = 0 at (0, d), to its top T = (-1, d/2 + r) (angle pi/2): a
    sweep of pi/2 - atan2(-d/2, 1), bulge tan(sweep / 4). The circle meets
    x = 0 only at y = 0 and y = d, so pieces 0 and 1 meet just there.
    Piece 2 runs from T up to (0, 5), above the circle's top tangent
    y = d/2 + r all the way, so it meets the arc only at T."""
    r = math.sqrt(1 + d * d / 4)
    sweep = math.pi / 2 - math.atan2(-d / 2, 1)
    return extrude(path([(0.0, 5.0), (0.0, 0.0), (-1.0, d / 2 + r)], [0.0, math.tan(sweep / 4), 0.0]))


class SharedCorner(unittest.TestCase):
    def test_neighbours_meeting_at_0_9_and_1_1_linear_from_their_corner(self):
        # At 0.9 x LINEAR (9 nm) from the corner they share: the corner, as
        # the kernel resolves it; at 1.1 x LINEAR (11 nm): a crossing at (0, d).
        self.assertEqual(float(LINEAR), 1e-5)
        self.assertEqual(crossings(line_then_arc(0.9e-5)), [])
        got = crossings(line_then_arc(1.1e-5))
        self.assertEqual([x[:4] for x in got], [(0, 0, 0, 1)])
        self.assertLess(abs(got[0][4][0]), 1e-12)
        self.assertLess(abs(got[0][4][1] - 1.1e-5), 1e-12)

    def test_issue_138(self):
        # The random-testing case: piece 2 (a line arriving at (7.5e-7,
        # 9.00000001e-7)) and piece 3 (the half circle leaving it) meet
        # again at (7.4996e-7, 1.3368e-6), 4.4e-7 mm (0.44 nm) from that
        # corner: well inside LINEAR, so not a crossing.
        shape = {"Extrude": {"dist": "59.0", "holes": [], "outer": {"Path": {
            "bulges": ["-6375.0", "0.0", "0.0", "1.0"],
            "pts": [["-0.00525", "9e-7"], ["1.8e-6", "63.125"], ["-0.005249991", "63.125001"], ["7.5e-7", "9.00000001e-7"]]}}}}
        self.assertEqual(crossings(shape), [])

    def test_non_neighbours_get_no_allowance(self):
        # A bow tie 10 nm across, (0,0) (s,s) (s,0) (0,s) with s = 1e-5:
        # pieces 0 and 2, not neighbours, cross at its centre (s/2, s/2),
        # 7.1 nm from every corner, and that is still a crossing.
        s = 1e-5
        got = crossings(extrude(path([(0.0, 0.0), (s, s), (s, 0.0), (0.0, s)])))
        self.assertEqual([x[:4] for x in got], [(0, 0, 0, 2)])


if __name__ == "__main__":
    unittest.main()
