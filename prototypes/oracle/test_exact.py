"""Tests for exact.py: python3 -m unittest discover -s prototypes/oracle -p 'test_*.py'
(needs mpmath). Every expected value is worked out by hand in the comment."""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))
from exact import judge, volume_area  # noqa: E402
from mpmath import mpf, pi  # noqa: E402


def path(pts, bulges=()):
    return {"Path": {"pts": [[repr(x), repr(y)] for x, y in pts], "bulges": [repr(b) for b in bulges]}}


def extrude(outer, holes=(), dist=1.0):
    return {"Extrude": {"outer": outer, "holes": list(holes), "dist": repr(dist), "expect": None}}


SQUARE2 = [(0.0, 0.0), (2.0, 0.0), (2.0, 2.0), (0.0, 2.0)]


class HandWorked(unittest.TestCase):
    def close(self, got, want):
        self.assertLess(abs(got - want), mpf(10) ** -40 * max(1, abs(want)), (got, want))

    def check(self, shape, v, s):
        got_v, got_s = volume_area(shape)
        self.close(got_v, v)
        self.close(got_s, s)

    def test_primitives(self):
        # Box 1 x 2 x 3: V = 6, S = 2(1*2 + 1*3 + 2*3) = 22.
        self.check({"Box": {"w": "1.0", "d": "2.0", "h": "3.0"}}, 6, 22)
        # Cylinder r 1, h 2: V = pi * 1 * 2 = 2 pi; S = 2 pi (caps) + 2 pi * 2 (side) = 6 pi.
        self.check({"Cylinder": {"r": "1.0", "h": "2.0"}}, 2 * pi, 6 * pi)
        # Sphere r 3: V = 4/3 pi 27 = 36 pi; S = 4 pi 9 = 36 pi.
        self.check({"Sphere": {"r": "3.0"}}, 36 * pi, 36 * pi)

    def test_square_with_a_hole(self):
        # 2 x 2 square minus a 1 x 1 hole: A = 3, P = 8 + 4 = 12; d = 3:
        # V = 9, S = 2 * 3 + 12 * 3 = 42.
        hole = path([(0.5, 0.5), (0.5, 1.5), (1.5, 1.5), (1.5, 0.5)])
        self.check(extrude(path(SQUARE2), [hole], 3.0), 9, 42)

    def test_bulging_and_concave_arcs(self):
        # Bulge 1 is a half circle (phi = 4 atan 1 = pi) on a chord of 2, so
        # r = 2 / (2 sin(pi/2)) = 1. Both vertical sides bulging out (a
        # stadium): A = 4 + 2 (pi/2) = 4 + pi, P = 2 + 2 + pi + pi; d = 1:
        # S = 2(4 + pi) + 4 + 2 pi = 12 + 4 pi.
        self.check(extrude(path(SQUARE2, [0, 1, 0, 1])), 4 + pi, 12 + 4 * pi)
        # Bulge -1 on the right side cuts a half disc in: A = 4 - pi/2,
        # P = 2 + 2 + 2 + pi; S = 2(4 - pi/2) + 6 + pi = 14.
        self.check(extrude(path(SQUARE2, [0, -1, 0, 0])), 4 - pi / 2, 14)

    def test_winding_does_not_matter(self):
        # The same stadium drawn clockwise has the same size (each bulge
        # flips sign with its edge's direction, so the arcs still bulge out).
        cw = path(list(reversed(SQUARE2)), [-1, 0, -1, 0])
        self.check(extrude(cw), 4 + pi, 12 + 4 * pi)

    def test_circles(self):
        # Ring: circle r 2 minus circle r 1, d 1: A = 4 pi - pi = 3 pi;
        # P = 4 pi + 2 pi = 6 pi; S = 6 pi + 6 pi = 12 pi.
        ring = lambda r: {"Circle": {"c": ["5.0", "-7.0"], "r": repr(r)}}
        self.check(extrude(ring(2.0), [ring(1.0)]), 3 * pi, 12 * pi)

    def test_far_from_the_origin(self):
        # 0.5 x 2 rectangle drawn at x = 1e8 (100 km out; 1e8 + 0.5 is a
        # double exactly), d = 3: V = 0.5 * 2 * 3 = 3 and S = 2 * 1 + 5 * 3
        # = 17 exactly, where OpenCascade measuring in place rounds.
        far = [(1e8, 0.0), (1e8 + 0.5, 0.0), (1e8 + 0.5, 2.0), (1e8, 2.0)]
        self.check(extrude(path(far), dist=3.0), 3, 17)

    def test_unknown_kind(self):
        self.assertIsNone(volume_area({"Torus": {}}))


class Judge(unittest.TestCase):
    def test_boundaries(self):
        # Allowed 1e-6 around an exact 1: 0.9x of it agrees, 1.1x is off.
        e, a = mpf(1), 1e-6
        self.assertEqual(judge(1 + 0.9e-6, 1.0, e, a), "agree")
        self.assertEqual(judge(1 + 1.1e-6, 1.0, e, a), "fission")
        self.assertEqual(judge(1 - 1.1e-6, 1.0, e, a), "fission")
        # Panosolid right, OpenCascade 1.1x out: OpenCascade's rounding.
        self.assertEqual(judge(1.0, 1 + 1.1e-6, e, a), "occ")
        self.assertEqual(judge(1.0, 1 + 0.9e-6, e, a), "agree")
        # Both off: Panosolid's finding, whatever OpenCascade says.
        self.assertEqual(judge(1 + 2e-6, 1 + 2e-6, e, a), "fission")

    def test_without_an_exact_value_opencascade_is_the_reference(self):
        self.assertEqual(judge(1 + 0.9e-6, 1.0, None, 1e-6), "agree")
        self.assertEqual(judge(1 + 1.1e-6, 1.0, None, 1e-6), "fission")


if __name__ == "__main__":
    unittest.main()
