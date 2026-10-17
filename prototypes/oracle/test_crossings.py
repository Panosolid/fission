"""Tests for crossings.py: python3 -m unittest discover -s prototypes/oracle -p 'test_*.py'
(needs mpmath). Every expected point is worked out by hand in the comment."""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))
from crossings import crossings  # noqa: E402


def path(pts, bulges=()):
    return {"Path": {"pts": [[repr(x), repr(y)] for x, y in pts], "bulges": [repr(b) for b in bulges]}}


def circle(c, r):
    return {"Circle": {"c": [repr(c[0]), repr(c[1])], "r": repr(r)}}


def extrude(outer, holes=()):
    return {"Extrude": {"outer": outer, "holes": list(holes), "dist": "1.0"}}


SQRT3 = 3.0 ** 0.5


class HandWorked(unittest.TestCase):
    def points(self, shape):
        return sorted((round(x[4][0], 9), round(x[4][1], 9)) for x in crossings(shape))

    def test_simple_loops_meet_only_at_their_corners(self):
        # A square, and a 2 x 1 rectangle whose top bulges up into a half
        # circle (bulge 1 from (2, 1) to (0, 1), centre (1, 1)): each piece
        # meets its neighbours only at the corners they share.
        self.assertEqual(crossings(extrude(path([(0.0, 0.0), (2.0, 0.0), (2.0, 2.0), (0.0, 2.0)]))), [])
        self.assertEqual(crossings(extrude(path([(0.0, 0.0), (2.0, 0.0), (2.0, 1.0), (0.0, 1.0)], [0.0, 0.0, 1.0, 0.0]))), [])

    def test_a_tangent_corner_is_not_a_crossing(self):
        # A line along y = 0 to (2, 0), then a quarter circle about (2, 1)
        # to (3, 1) (bulge tan(pi/8)), which leaves (2, 0) along +x: the
        # line's circle-line equation has a double root at the shared
        # corner, and nothing else.
        t = 0.41421356237309503
        shape = extrude(path([(0.0, 0.0), (2.0, 0.0), (3.0, 1.0), (0.0, 1.0)], [0.0, t, 0.0, 0.0]))
        self.assertEqual(crossings(shape), [])

    def test_a_bow_tie_crosses_in_the_middle(self):
        # (0,0) -> (2,2) and (2,0) -> (0,2) are the diagonals of the 2 x 2
        # square: they cross at its centre (1, 1).
        shape = extrude(path([(0.0, 0.0), (2.0, 2.0), (2.0, 0.0), (0.0, 2.0)]))
        self.assertEqual(self.points(shape), [(1.0, 1.0)])
        self.assertEqual([x[:4] for x in crossings(shape)], [(0, 0, 0, 2)])

    def test_an_arc_bulging_through_the_far_side(self):
        # A 4 x 1 rectangle whose top, (4, 1) -> (0, 1), bulges down
        # (bulge -1): a half circle of radius 2 about (2, 1) reaching
        # y = -1, so it crosses the bottom y = 0 where (x - 2)^2 + 1 = 4,
        # x = 2 -+ sqrt 3.
        shape = extrude(path([(0.0, 0.0), (4.0, 0.0), (4.0, 1.0), (0.0, 1.0)], [0.0, 0.0, -1.0, 0.0]))
        self.assertEqual(self.points(shape), [(round(2 - SQRT3, 9), 0.0), (round(2 + SQRT3, 9), 0.0)])

    def test_two_holes_overlapping(self):
        # Circles of radius 2 about (3, 5) and (6, 5) meet on the line
        # x = 4.5 halfway between, at y = 5 -+ sqrt(4 - 1.5^2) = 5 -+ sqrt 1.75.
        shape = extrude(path([(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)]), [circle((3.0, 5.0), 2.0), circle((6.0, 5.0), 2.0)])
        r = 1.75 ** 0.5
        self.assertEqual(self.points(shape), [(4.5, round(5 - r, 9)), (4.5, round(5 + r, 9))])
        self.assertEqual({x[:4] for x in crossings(shape)}, {(1, 0, 2, 0)})

    def test_a_hole_through_the_outer_loop(self):
        # A circle of radius 1 about (0, 1) crosses the square's left side
        # x = 0 at (0, 0) and (0, 2); (0, 0) is a corner of the outer loop,
        # but not one the circle shares, so it still counts.
        shape = extrude(path([(0.0, 0.0), (4.0, 0.0), (4.0, 4.0), (0.0, 4.0)]), [circle((0.0, 1.0), 1.0)])
        self.assertIn((0.0, 2.0), self.points(shape))

    def test_a_tiny_bow_tie_far_out(self):
        # The bow tie scaled to 2 um and moved 10 km out: o + s rounds by at
        # most half a step of doubles there (2^-30, ~1e-9), so the corners
        # still make a bow tie and its crossing is the centre to ~1e-9.
        o, s = 1e7, 2e-3
        shape = extrude(path([(o, o), (o + s, o + s), (o + s, o), (o, o + s)]))
        got = crossings(shape)
        self.assertEqual(len(got), 1)
        self.assertLess(abs(got[0][4][0] - (o + s / 2)), 1e-9)

    def test_just_short_and_just_past(self):
        # A notch dipping to a corner at (2, e): corners (0,0) (4,0) (4,2)
        # (2,2) (2,e) (1,2). With e = 1e-12 it stops just above the bottom
        # y = 0 and meets nothing (the kernel's 1 um clearance rule would
        # refuse it; that is not this check's); with e = -1e-12 both sides
        # into that corner cut y = 0, (2,2) -> (2,e) at (2, 0) and
        # (2,e) -> (1,2) at x = 2 - 1e-12 / (2 + 1e-12), about 2 - 5e-13: two points,
        # both (2, 0) to 9 places. Doubles keep 1e-12 at 2, so no tolerance
        # is involved either way.
        def notch(e):
            return extrude(path([(0.0, 0.0), (4.0, 0.0), (4.0, 2.0), (2.0, 2.0), (2.0, e), (1.0, 2.0)]))
        self.assertEqual(crossings(notch(1e-12)), [])
        self.assertEqual(self.points(notch(-1e-12)), [(2.0, 0.0), (2.0, 0.0)])
        self.assertEqual({x[:4] for x in crossings(notch(-1e-12))}, {(0, 0, 0, 3), (0, 0, 0, 4)})


class OpenCascadeFalseAlarms(unittest.TestCase):
    def test_kept_cases_are_simple(self):
        # Fuzz seeds (sketch.seeds 414, 468) OpenCascade's validity check
        # calls self-intersecting: three half circles, and a 0.02 degree
        # corner between a 14 m half circle and a 93 mm one. No two pieces
        # meet but at their shared corners.
        for outer in (path([(75625.0, 75625.0), (0.0, 0.0), (75625.011, 75625.0)], [1.0, 1.0, 1.0]),
                      path([(28750.0, -10.0), (187.5, 0.0), (1.1, 0.0)], [1.0000000000001157, 1.0, 1.0])):
            self.assertEqual(crossings(extrude(outer)), [])


if __name__ == "__main__":
    unittest.main()
