"""Tests for pieces.py (and, where OpenCascade is installed, the arcs
compare.py builds from it): python3 -m unittest discover -s prototypes/oracle -p 'test_*.py'
(needs mpmath). Every expected value is worked out by hand in the comment."""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))
from mpmath import mp, mpf, sqrt  # noqa: E402
from pieces import pieces  # noqa: E402

mp.dps = 50

try:
    import compare
except ImportError:  # pip install cadquery-ocp
    compare = None


def path(pts, bulges):
    return {"Path": {"pts": [[repr(x), repr(y)] for x, y in pts], "bulges": [repr(b) for b in bulges]}}


# Issue #73 (random testing, seed 188403222933631): a 129 m strip 2.2 um
# wide, its right end a half circle, its left end a nearly whole circle of
# 60.5 m (bulge 1.1e8).
STRIP = [(-11.500011, -7.5), (128886.9017536431, -7.5), (128886.9017536431, -7.4978), (-11.500011, -7.4978)]
STRIP_BULGES = [0.0, 1.0, 0.0, 110000000.00000001]


def exact_arc(a, b, bulge):
    """Radius and centre in 50 digits, from the sagitta: the arc's middle
    is bulge * |ab| / 2 from the chord's midpoint (to the right of a->b for
    a positive bulge), and a circle through both ends and that point has
    r = (h^2 + (c/2)^2) / (2h) for sagitta h, its centre r - h back from
    the middle towards the chord."""
    ax, ay, bx, by, bl = (mpf(v) for v in (a[0], a[1], b[0], b[1], bulge))
    c = sqrt((bx - ax) ** 2 + (by - ay) ** 2)
    ux, uy = (bx - ax) / c, (by - ay) / c  # along the chord
    h = bl * c / 2  # signed sagitta, to the right
    r = (h * h + c * c / 4) / (2 * abs(h))
    mx, my = (ax + bx) / 2 + uy * h, (ay + by) / 2 - ux * h  # the arc's middle
    back = (r - abs(h)) / abs(h)  # from the middle, past the chord, per unit of h
    return r, (mx - uy * h * (1 + back), my + ux * h * (1 + back))


class HandWorked(unittest.TestCase):
    def arc(self, a, b, bulge):
        (piece,) = [q for q in pieces(path([a, b], [bulge, 0.0])) if q[0] == "arc"]
        return piece

    def test_half_circle(self):
        # Bulge 1 on (0,0)->(2,0): phi = 4 atan 1 = pi, r = 2 * 2 / 4 = 1,
        # centre at the midpoint (1,0) since 1 - b^2 = 0.
        _, _, centre, _, r, _ = self.arc((0.0, 0.0), (2.0, 0.0), 1.0)
        self.assertEqual((r, centre), (1.0, (1.0, 0.0)))

    def test_bowed_in(self):
        # Bulge -0.4 on (10,10)->(0,10): r = 10 * 1.16 / 1.6 = 7.25; the
        # centre is (1 - 0.16) / (4 * 0.4) * 10 = 5.25 to the right of the
        # chord (heading -x, right is +y): (5, 15.25).
        _, _, centre, _, r, _ = self.arc((10.0, 10.0), (0.0, 10.0), -0.4)
        self.assertAlmostEqual(r, 7.25, places=12)
        self.assertAlmostEqual(centre[0], 5.0, places=12)
        self.assertAlmostEqual(centre[1], 15.25, places=12)

    def test_nearly_whole_circle_keeps_its_digits(self):
        # Issue #73: from phi = 4 atan b, sin(phi/2) is the difference of
        # two numbers near pi and kept half its digits, giving r 0.7 mm
        # (1.2e-8) short. Against the sagitta construction in 50 digits it
        # must agree to rounding.
        _, a, centre, b, r, _ = pieces(path(STRIP, STRIP_BULGES))[3]
        want_r, want_c = exact_arc(a, b, STRIP_BULGES[3])
        self.assertLess(abs(r - want_r) / want_r, 1e-15, (r, want_r))
        for got, want in zip(centre, want_c):
            self.assertLess(abs(got - want), 1e-15 * want_r, (got, want))


@unittest.skipIf(compare is None, "needs OpenCascade (pip install cadquery-ocp)")
class OpenCascadeArcs(unittest.TestCase):
    def test_bounds_of_a_nearly_whole_circle(self):
        # The strip extruded 74.5. Its left end turns counter-clockwise from
        # (-11.5, -7.4978) round to (-11.5, -7.5), all but 0.08 urad of a
        # circle whose missing bit is at angle 0, so its leftmost, lowest
        # and highest points are the circle's: x = cx - r, y = cy -/+ r.
        # Its right end is a half circle of r = 0.0011 out to x =
        # 128886.9017536431 + 0.0011. Heights 0 and 74.5.
        r, (cx, cy) = exact_arc(STRIP[3], STRIP[0], STRIP_BULGES[3])
        want_lo = (cx - r, cy - r, 0)
        want_hi = (mpf(STRIP[1][0]) + mpf("0.0011"), cy + r, mpf("74.5"))
        shape = {"Extrude": {"outer": path(STRIP, STRIP_BULGES), "holes": [], "dist": "74.5", "expect": None}}
        _, _, lo, hi, _ = compare.measure(compare.build(shape)[1])
        reach = 128886.9
        for got, want in zip(lo + hi, want_lo + want_hi):
            # compare.py's own allowance for OpenCascade's optimal box.
            self.assertLess(abs(got - want), 1e-6 + compare.REL * reach, (got, float(want)))


if __name__ == "__main__":
    unittest.main()
