"""Tests for the sketch outline model and its check against the kernel
(testing hunt 3b): python3 -m unittest discover -s prototypes/oracle -p 'test_*.py'
(the kernel check runs `cargo run --example sketch_outline_json` in kernel/).

Every expected value in HandWorked is worked out by hand in the comment
next to it. KernelAgrees runs the 10,000 seeded sketches and needs every
one to agree; DeliberateBreaks plants a wrong model (or a wrong answer)
and needs the check to catch it."""

import math
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(__file__))
import sketch_outline as m  # noqa: E402
import sketch_outline_check as check  # noqa: E402

TRI = [((0.0, 0.0), (4.0, 0.0)), ((4.0, 0.0), (0.0, 3.0)), ((0.0, 3.0), (0.0, 0.0))]


class HandWorked(unittest.TestCase):
    def test_a_triangle_closes_in_drawing_order(self):
        # The 3-4-5 triangle drawn tip to tail: walked from line 0's start,
        # corners (0, 0), (4, 0), (0, 3), every piece forwards.
        got = m.outline(TRI)
        self.assertEqual(got["kind"], "closed")
        self.assertEqual(got["corners"], [(0.0, 0.0), (4.0, 0.0), (0.0, 3.0)])
        self.assertEqual(got["pieces"], [("line", 0, False), ("line", 1, False), ("line", 2, False)])

    def test_a_line_drawn_backwards_is_walked_backwards(self):
        # Line 1 drawn from (0, 3) to (4, 0): after line 0 ends at (4, 0)
        # the walk enters line 1 at its b, so it runs reversed; the corners
        # are unchanged.
        lines = [TRI[0], ((0.0, 3.0), (4.0, 0.0)), TRI[2]]
        got = m.outline(lines)
        self.assertEqual(got["corners"], [(0.0, 0.0), (4.0, 0.0), (0.0, 3.0)])
        self.assertEqual(got["pieces"], [("line", 0, False), ("line", 1, True), ("line", 2, False)])

    def test_loose_ends_branches_and_loops(self):
        # Without line 2, ends 0 ((0, 0), line 0's start) and 3 ((0, 3))
        # meet nothing; end 0 is the lowest numbered.
        self.assertEqual(m.outline(TRI[:2]), {"kind": "loose", "at": (0.0, 0.0)})
        # A fourth line from (0, 0): three ends meet there.
        self.assertEqual(m.outline(TRI + [((0.0, 0.0), (-2.0, -2.0))]), {"kind": "branch", "at": (0.0, 0.0), "ends": 3})
        # Two separate triangles; a triangle and a circle: two loops each.
        far = [((a[0] + 10, a[1]), (b[0] + 10, b[1])) for a, b in TRI]
        self.assertEqual(m.outline(TRI + far)["loops"], 2)
        self.assertEqual(m.outline(TRI, [((20.0, 0.0), 1.0)])["loops"], 2)
        # One circle is its own outline; two are two loops; nothing is empty.
        self.assertEqual(m.outline([], [((0.0, 0.0), 1.0)])["kind"], "circle")
        self.assertEqual(m.outline([], [((0.0, 0.0), 1.0), ((5.0, 0.0), 1.0)]), {"kind": "loops", "loops": 2})
        self.assertEqual(m.outline([]), {"kind": "empty"})

    def test_ends_join_within_linear(self):
        # Line 0 ends g short of (4, 0) along x. At 0.9 LINEAR it joins
        # line 1's start, and the corner is the end of the piece entered,
        # line 1's (4, 0); at 1.1 LINEAR line 0's end (end 1) is loose.
        def tri(g):
            return [((0.0, 0.0), (4.0 - g, 0.0))] + TRI[1:]
        self.assertEqual(m.outline(tri(0.9 * m.LINEAR))["corners"][1], (4.0, 0.0))
        self.assertEqual(m.outline(tri(1.1 * m.LINEAR)), {"kind": "loose", "at": (4.0 - 1.1 * m.LINEAR, 0.0)})

    def test_line_length_limit(self):
        # A line 0.9 MIN_FEATURE long breaks the sketch rules; 1.1 is a
        # line with two loose ends.
        self.assertEqual(m.outline([((0.0, 0.0), (0.9 * m.MIN_FEATURE, 0.0))]), {"kind": "error", "input": ("line", 0)})
        self.assertEqual(m.outline([((0.0, 0.0), (1.1 * m.MIN_FEATURE, 0.0))])["kind"], "loose")

    def test_a_corner_too_close_to_a_side(self):
        # Square (0,0) (10,0) (10,10) (5,d) (0,10): corner (5, d) is d above
        # side 0 ((0,0) -> (10,0)); the first pair in order that is too
        # close is side 0 with side 2 ((10,10) -> (5,d), which ends there).
        def notch(d):
            pts = [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (5.0, d), (0.0, 10.0)]
            return [(pts[i], pts[(i + 1) % 5]) for i in range(5)]
        self.assertEqual(m.outline(notch(0.9 * m.MIN_FEATURE)), {"kind": "not a profile", "curves": [("line", 0), ("line", 2)]})
        self.assertEqual(m.outline(notch(1.1 * m.MIN_FEATURE))["kind"], "closed")

    def test_a_cusp_names_both_sides(self):
        # (0,0) -> (10,0) -> (5,0) -> (5,5): at (10, 0) side 0 arrives along
        # +x and side 1 leaves along -x, a cusp naming sides 0 and 1.
        pts = [(0.0, 0.0), (10.0, 0.0), (5.0, 0.0), (5.0, 5.0)]
        self.assertEqual(m.outline([(pts[i], pts[(i + 1) % 4]) for i in range(4)]),
                         {"kind": "not a profile", "curves": [("line", 0), ("line", 1)]})

    def test_arc_bulges_and_rules(self):
        # A half circle turns pi: bulge tan(pi/4) = 1. A quarter turns
        # pi/2: tan(pi/8) = sqrt(2) - 1.
        self.assertAlmostEqual(m.arc_bulge((1.0, 0.0), (-1.0, 0.0), (0.0, 0.0)), 1.0, places=15)
        self.assertAlmostEqual(m.arc_bulge((1.0, 0.0), (0.0, 1.0), (0.0, 0.0)), math.sqrt(2) - 1, places=15)
        # The centre of the half circle from (1, 0) to (-1, 0) moved d along
        # the chord is d off the bisector x = 0: allowed at 0.9 LINEAR,
        # refused at 1.1.
        line = [((-1.0, 0.0), (1.0, 0.0))]
        self.assertEqual(m.outline(line, [], [((1.0, 0.0), (-1.0, 0.0), (0.9 * m.LINEAR, 0.0))])["kind"], "arcs")
        self.assertEqual(m.outline(line, [], [((1.0, 0.0), (-1.0, 0.0), (1.1 * m.LINEAR, 0.0))]), {"kind": "error", "input": ("arc", 0)})
        # The D walked from the line: (-1, 0) then (1, 0); the arc entered
        # at its start keeps bulge +1. Each corner is the arc's end (larger
        # |bulge|), here the same points.
        d = m.outline(line, [], [((1.0, 0.0), (-1.0, 0.0), (0.0, 0.0))])
        self.assertEqual((d["corners"], d["pieces"]), ([(-1.0, 0.0), (1.0, 0.0)], [("line", 0, False), ("arc", 0, False)]))
        self.assertEqual(d["bulges"][0], 0.0)
        self.assertAlmostEqual(d["bulges"][1], 1.0, places=15)

    def test_measuring_arcs(self):
        # Bulge 1 from (1, 0) to (-1, 0): centre (0, 0), radius 1, starting
        # at angle 0 and turning pi, through (0, 1).
        g = m.piece_geometry((1.0, 0.0), (-1.0, 0.0), 1.0)
        self.assertEqual(g[3:], ((0.0, 0.0), 1.0, 0.0, math.pi))
        # The line y = 2 over it is 1 away (top (0, 1) to (0, 2)); the line
        # y = -2 below it is sqrt(1 + 4) = sqrt(5) from either end.
        self.assertAlmostEqual(m.least_gap(g, ("line", (-2.0, 2.0), (2.0, 2.0))), 1.0, places=12)
        self.assertAlmostEqual(m.least_gap(g, ("line", (0.0, -2.0), (0.0, -2.0 + 1e-9))), math.sqrt(5), places=6)
        # A stadium: (0,0) -> (4,0), a half circle bowing out to (4,2)
        # (bulge 1, right of +y is +x), (4,2) -> (0,2), and a half circle
        # back to (0,0). Each arc leaves along the line it meets (no cusp)
        # and the lines are 2 apart: no fault.
        self.assertEqual(m.arc_loop_faults([(0.0, 0.0), (4.0, 0.0), (4.0, 2.0), (0.0, 2.0)], [0.0, 1.0, 0.0, 1.0], strict=True), [])
        # A 10 x 6 rectangle whose bottom (0,0) -> (10,0) bows up by 2.5
        # (to the left of +x, so bulge -2 s / c = -0.5) and whose top
        # (10,6) -> (0,6) bows down by s (left of -x, bulge -s / 5): their
        # middles (5, 2.5) and (5, 6 - s) are the nearest points, 3.5 - s
        # apart. s = 2.5: 1 apart, no fault; s = 3.5 - 0.9 MIN_FEATURE: too
        # close, pieces 0 and 2.
        def facing(s):
            return [(0.0, 0.0), (10.0, 0.0), (10.0, 6.0), (0.0, 6.0)], [-0.5, 0.0, -s / 5, 0.0]
        self.assertEqual(m.arc_loop_faults(*facing(2.5), strict=True), [])
        close = m.arc_loop_faults(*facing(3.5 - 0.9 * m.MIN_FEATURE), strict=True)
        self.assertEqual([f[:3] for f in close], [("close", 0, 2)])
        self.assertAlmostEqual(close[0][3], 0.9 * m.MIN_FEATURE, delta=1e-12)
        self.assertEqual(m.arc_loop_faults(*facing(3.5 - 1.1 * m.MIN_FEATURE), strict=True), [])

    def test_ambiguous_cases_are_not_guessed(self):
        # A join exactly LINEAR apart (line 0 starts at (LINEAR, 0), line 2
        # ends at (0, 0)): on the threshold the kernel's rounded distance
        # may land either side, so the model declines. (4 - LINEAR would
        # not do: that double is 9e-16 off, which both sides see exactly.)
        with self.assertRaises(m.Ambiguous):
            m.outline([((m.LINEAR, 0.0), (4.0, 0.0))] + TRI[1:])


SEEDS = 10000


class KernelAgrees(unittest.TestCase):
    def test_ten_thousand_seeded_sketches(self):
        counts, bad = check.run(SEEDS)
        self.assertEqual(bad[:3], [], f"{len(bad)} disagreements")
        self.assertNotIn("too close to call", counts)
        # Every kind of answer was reached, and every boundary family on
        # both sides of its threshold.
        for kind in ("error", "empty", "loose", "branch", "loops", "not a profile", "closed", "circle", "arcs, accepted", "arcs, refused"):
            self.assertGreater(counts.get(kind, 0), 50, kind)
        for kind in ("closed", "not a profile", "loose", "error", "circle"):
            self.assertGreater(counts.get("boundary: " + kind, 0), 50, kind)


class DeliberateBreaks(unittest.TestCase):
    """Each plants one mistake and needs the check to find it in 1,000 sketches."""

    def caught(self, plant=None):
        _, bad = check.run(1000, plant=plant)
        return len(bad)

    def test_a_wider_join_is_caught(self):
        with mock.patch.object(m, "LINEAR", 1.2 * m.LINEAR):
            self.assertGreater(self.caught(), 0)

    def test_a_larger_feature_size_is_caught(self):
        with mock.patch.object(m, "MIN_FEATURE", 1.2 * m.MIN_FEATURE):
            self.assertGreater(self.caught(), 0)

    def test_the_other_corner_pick_is_caught(self):
        # Choosing the end of the piece left instead of the piece entered
        # differs only where ends are nudged apart.
        with mock.patch.object(m, "PICK_ENTERED", False):
            self.assertGreater(self.caught(), 0)

    def test_a_walk_from_the_wrong_corner_is_caught(self):
        def turned(want):
            if want["kind"] == "closed":
                want = dict(want, corners=want["corners"][1:] + want["corners"][:1])
            return want
        self.assertGreater(self.caught(turned), 0)

    def test_a_wrong_direction_is_caught(self):
        def flip(want):
            if want["kind"] in ("closed", "arcs"):
                want = dict(want, pieces=[(c, i, not r) for c, i, r in want["pieces"]])
            return want
        self.assertGreater(self.caught(flip), 0)

    def test_a_wrong_bulge_is_caught(self):
        def bend(want):
            if want["kind"] == "arcs":
                want = dict(want, bulges=[b * (1 + 1e-8) for b in want["bulges"]])
            return want
        self.assertGreater(self.caught(bend), 0)

    def test_a_refusal_the_measuring_cannot_explain_is_caught(self):
        # With measuring that finds nothing, every arc loop the kernel
        # refuses becomes a disagreement.
        with mock.patch.object(m, "arc_loop_faults", lambda *a, **k: []):
            self.assertGreater(self.caught(), 0)

    def test_a_kernel_acceptance_with_a_fault_is_caught(self):
        # Measuring that always finds a fault turns each accepted arc loop
        # into a disagreement.
        with mock.patch.object(m, "arc_loop_faults", lambda *a, **k: [("close", 0, 2, 0.0)]):
            self.assertGreater(self.caught(), 0)


if __name__ == "__main__":
    unittest.main()
