"""Tests for convex_model.py: python3 -m unittest discover -s prototypes/boolean -p 'test_*.py'.

Every expected number in HAND is worked out by hand in the comment beside it.
Seeded turned pairs are checked against an independent model below (vertex
enumeration and boundary walking, general position only, sharing no code
with convex_model), seeded boxes against box_model (an independent grid, on
every touching and coplanar arrangement small integers give), turned and
moved, OpenCascade in test_convex_model_occ.py, and each planted break below
makes a test fail."""

import os
import random
import sys
import unittest
from fractions import Fraction
from math import isqrt
from unittest import mock

sys.path.insert(0, os.path.dirname(__file__))
import box_model  # noqa: E402
import convex_model  # noqa: E402
from convex_model import MIN_FEATURE, SAME, ModelError, Prism, block, boolean, compose, solid, turn  # noqa: E402

F = Fraction
UM = F(1, 1000)
KEYS = ("volume", "area", "faces", "edges", "vertices", "rings", "shells", "genus")


def numbers(d):
    return {k: d[k] for k in KEYS}


def body(volume, area, faces, edges, vertices, rings=0, shells=1, genus=0):
    return dict(volume=F(volume), area=F(area), faces=faces, edges=edges, vertices=vertices, rings=rings, shells=shells, genus=genus)


# The 3-4-5 turn about z (cos 4/5, sin 3/5) of the unit square centred on
# the origin puts its corners (+-1/2, +-1/2) at (x cos - y sin, x sin + y cos):
# (1/10, 7/10), (-7/10, 1/10), (-1/10, -7/10), (7/10, -1/10).
Z345 = turn("z", 4, 3, 5)
TURNED_SQUARE = block(F(-1, 2), F(-1, 2), 0, F(1, 2), F(1, 2), 1, Z345)
HALF_PLANE = block(0, -1, 0, 1, 1, 1)
# A unit cube turned 3-4-5 about x, then 4,-3,5 about y: R = Ry Rx with
# Rx = [[1,0,0],[0,4/5,-3/5],[0,3/5,4/5]], Ry = [[4/5,0,-3/5],[0,1,0],[3/5,0,4/5]].
# R's bottom row is (3/5, 0, 4/5) Rx = (3/5, 12/25, 16/25), all positive, so
# the corner (0,0,0) is lowest (z = 0) and (1,1,1) highest, z = 43/25.
CUBE_R = compose(turn("x", 4, 3, 5), turn("y", 4, -3, 5))
TURNED_CUBE = block(0, 0, 0, 1, 1, 1, CUBE_R)
# Above z = 37/25 (6/25 below the top): the three edges down from the top
# corner fall 3/5, 12/25, 16/25 per unit, so the plane cuts them at
# s = (6/25)/(3/5) = 2/5, (6/25)/(12/25) = 1/2, (6/25)/(16/25) = 3/8 (all
# under 1; the next highest corners are at 43/25 - 12/25 = 31/25 < 37/25).
LID = block(-5, -5, F(37, 25), 5, 5, 5)

HAND = [
    # The turned square (side 1, height 1) cut by the plane x = 0: the line
    # meets the sides (1/10,7/10)-(-7/10,1/10) and (-1/10,-7/10)-(7/10,-1/10)
    # an eighth of the way along (x goes 8/10 per side), at (0, 5/8) and
    # (0, -5/8). Half the square (a turn of 180 degrees about the centre
    # swaps the halves): area 1/2. Its outline (0,-5/8), (7/10,-1/10),
    # (1/10,7/10), (0,5/8): sides 7/8, 1, 1/8, 5/4, perimeter 13/4. A
    # prism 1 high: V = 1/2, S = 2 x 1/2 + 13/4 = 17/4, 6 faces, 12 edges, 8
    # corners. The block's top and bottom are coplanar with the square's.
    ("half intersect", "intersect", HALF_PLANE, TURNED_SQUARE, [body(F(1, 2), F(17, 4), 6, 12, 8)]),
    ("half subtract", "subtract", TURNED_SQUARE, HALF_PLANE, [body(F(1, 2), F(17, 4), 6, 12, 8)]),
    # The block [0,1] x [-1,1] x [0,1] with the other half of the square:
    # outline (0,-1), (1,-1), (1,1), (0,1), (0,5/8), (-7/10,1/10),
    # (-1/10,-7/10), (0,-5/8), area 2 + 1/2 = 5/2, perimeter 1 + 2 + 1 + 3/8
    # + 7/8 + 1 + 1/8 + 3/8 = 27/4. V = 5/2, S = 5 + 27/4 = 47/4; the tops
    # merge (decision 6): 8 sides + 2 = 10 faces, 16 corners, 24 edges.
    ("half union", "union", HALF_PLANE, TURNED_SQUARE, [body(F(5, 2), F(47, 4), 10, 24, 16)]),
    # The block less the right half: the notch's outline (0,-1), (1,-1),
    # (1,1), (0,1), (0,5/8), (1/10,7/10), (7/10,-1/10), (0,-5/8), area
    # 2 - 1/2 = 3/2, perimeter 4 + 3/8 + 1/8 + 1 + 7/8 + 3/8 = 27/4: V = 3/2,
    # S = 3 + 27/4 = 39/4, 10 faces (the face x = 0 is cut in two), 16
    # corners, 24 edges.
    ("half notch", "subtract", HALF_PLANE, TURNED_SQUARE, [body(F(3, 2), F(39, 4), 10, 24, 16)]),
    # The turned cube's top corner above z = 37/25: a corner tetrahedron with
    # square legs s = 2/5, 1/2, 3/8. V = s1 s2 s3 / 6 = (3/40)/6 = 1/80. Its
    # three right triangles: (1/5 + 3/16 + 3/20)/2 = 43/160; the slanted lid
    # by de Gua's theorem, sqrt((1/10)^2 + (3/32)^2 + (3/40)^2) =
    # sqrt(625/25600) = 25/160. S = 68/160 = 17/40; 4 faces, 6 edges, 4.
    ("corner cap", "intersect", LID, TURNED_CUBE, [body(F(1, 80), F(17, 40), 4, 6, 4)]),
    # The cube without its cap: V = 1 - 1/80 = 79/80, S = 6 - 43/160 +
    # 25/160 = 471/80; faces 6 + 1, corners 8 - 1 + 3 = 10, edges 12 + 3 = 15
    # (10 - 15 + 7 = 2).
    ("capped cube", "subtract", TURNED_CUBE, LID, [body(F(79, 80), F(471, 80), 7, 15, 10)]),
    # The lid (10 x 10 x 88/25: V = 352, S = 200 + 40 x 88/25 = 1704/5) with
    # the cube's lower part: V = 352 + 79/80 = 28239/80, S = 1704/5 - 25/160
    # + 6 - 43/160 = 55420/160 = 2771/8. The lid's bottom is a ring round the
    # triangle: faces 6 + 6, R = 1, corners 8 + 7 + 3 = 18, edges 12 + 12 + 3
    # = 27 (18 - 27 + 12 - 1 = 2, genus 0).
    ("lid on cube", "union", LID, TURNED_CUBE, [body(F(28239, 80), F(2771, 8), 12, 27, 18, rings=1)]),
    # The lid with a tetrahedral dent: V = 352 - 1/80 = 28159/80, S = 1704/5
    # - 25/160 + 43/160 = 54546/160 = 27273/80; faces 6 + 3 (the ring
    # round the dent, R = 1), corners 8 + 4, edges 12 + 6 = 18.
    ("dented lid", "subtract", LID, TURNED_CUBE, [body(F(28159, 80), F(27273, 80), 9, 18, 12, rings=1)]),
    # A turned cube with itself: itself (V 1, S 6, 6, 12, 8).
    ("self union", "union", TURNED_CUBE, TURNED_CUBE, [body(1, 6, 6, 12, 8)]),
    ("self intersect", "intersect", TURNED_CUBE, TURNED_CUBE, [body(1, 6, 6, 12, 8)]),
    # The turned cube inside a 10 mm cube: a void (decision 3). V = 1000 -
    # 1, S = 600 + 6, 12 faces, 24 edges, 16 corners, 2 shells,
    # 16 - 24 + 12 = 4 = 2(2 - 0).
    ("turned void", "subtract", block(-5, -5, -5, 5, 5, 5), TURNED_CUBE, [body(999, 606, 12, 24, 16, shells=2)]),
    # A 6 x 6 x 1 plate with the turned square run through it: V = 36 - 1,
    # S = 2 x 35 + 24 + 4 = 98; top and bottom rings (R = 2), 10 faces, 16
    # corners, 24 edges: 16 - 24 + 10 - 2 = 0 = 2(1 - H), genus 1.
    ("turned hole", "subtract", block(-3, -3, 0, 3, 3, 1), block(F(-1, 2), F(-1, 2), -1, F(1, 2), F(1, 2), 2, Z345),
     [body(35, 98, 10, 24, 16, rings=2, genus=1)]),
    # A cube with itself: nothing left (F3); a cube touching another only
    # at a corner has nothing in common (F3b).
    ("self subtract", "subtract", TURNED_CUBE, TURNED_CUBE, "empty"),
    ("corner on a face, intersect", "intersect", block(-2, -2, -1, 2, 2, 0), TURNED_CUBE, "empty"),
]

# Where things touch (decision 2). The turned cube's lowest corner is the
# origin, on the slab's top: joined, the two meet only there.
SLAB = block(-2, -2, -1, 2, 2, 0)
# Ry Rx multiplied out is R = [[4/5, -9/25, -12/25], [0, 4/5, -3/5],
# [3/5, 12/25, 16/25]], so the top corner R(1,1,1), its row sums, is
# (-1/25, 1/5, 43/25); the cube moved down 43/25 has it at (-1/25, 1/5, 0).
SUNK_CUBE = block(0, 0, 0, 1, 1, 1, CUBE_R, (0, 0, F(-43, 25)))
DEEP = block(-2, -2, -3, 2, 2, 0)
# A unit cube turned 3-4-5 about x: (x, y, z) goes to (x, 4y/5 - 3z/5,
# 3y/5 + 4z/5); its highest edge is y = z = 1, at y' = 1/5, z' = 7/5, x 0..1.
# Moved down 7/5 that edge lies in the slab's top from inside.
EDGE_IN = block(0, 0, 0, 1, 1, 1, turn("x", 4, 3, 5), (0, 0, F(-7, 5)))
# The turned square moved so its lowest corner (-1/10, -7/10) lands at
# (19/10, 0), on the side y = 0 of a 4 x 4 x 1 plate, run through it.
SIDE_HOLE = block(F(-1, 2), F(-1, 2), -1, F(1, 2), F(1, 2), 2, Z345, (2, F(7, 10), 0))
PLATE = block(0, 0, 0, 4, 4, 1)

WHERE = [
    ("corner on a face", "union", SLAB, TURNED_CUBE, [("vertex", (0, 0, 0))], []),
    # The cube's top corner touching the slab's top from inside: the slab
    # less the cube is a half-space less a cone with its tip on the plane,
    # whose outside (above, and the cone) meets only at the tip.
    ("corner dent", "subtract", DEEP, SUNK_CUBE, [("vertex", (F(-1, 25), F(1, 5), 0))], []),
    # The edge lying in the top from inside: the slab less a wedge whose
    # ridge lies in its top is two wedges meeting along the ridge.
    ("edge dent", "subtract", DEEP, EDGE_IN, [("edge", (0, F(1, 5), 0), (1, F(1, 5), 0))], []),
    # The hole's corner edge lies along the plate's side from inside, from
    # z 0 to 1, and the top and bottom each touch themselves there (pinched).
    ("hole on the side", "subtract", PLATE, SIDE_HOLE, [("edge", (F(19, 10), 0, 0), (F(19, 10), 0, 1))],
     [(F(19, 10), 0, 0), (F(19, 10), 0, 1)]),
]


def check_hand(case):
    """Raises AssertionError when the model's answer differs from the case."""
    name, op, a, b, want = case
    got = boolean(op, a, b)
    if want == "empty":
        if got["outcome"] != "empty" or got["bodies"]:
            raise AssertionError(f"{name}: {got['outcome']}, expected empty")
        return
    if got["outcome"] != "bodies":
        raise AssertionError(f"{name}: outcome {got['outcome']} {got['where']}")
    have = [numbers(x) for x in got["bodies"]]
    if have != want:
        raise AssertionError(f"{name}: {have} != {want}")


def check_where(case):
    name, op, a, b, where, pinched = case
    got = boolean(op, a, b)
    want = sorted((w[0],) + tuple(tuple(F(c) for c in p) for p in w[1:]) for w in where)
    if got["outcome"] != "nonmanifold" or got["where"].get("nonmanifold") != want or got["bodies"]:
        raise AssertionError(f"{name}: {got['outcome']} {got['where']}")
    if got["pinched"] != sorted(tuple(F(c) for c in p) for p in pinched):
        raise AssertionError(f"{name}: pinched {got['pinched']}")


class HandWorked(unittest.TestCase):
    def test_every_hand_case(self):
        for case in HAND:
            with self.subTest(case[0]):
                check_hand(case)

    def test_where(self):
        for case in WHERE:
            with self.subTest(case[0]):
                check_where(case)

    def test_touching_tool_and_untouched_slab(self):
        # A tool touching only at a point takes nothing, and a tool inside
        # adds nothing: the cube stays the cube, the 4 x 4 x 3 block the
        # block (V 48, S 2 x 16 + 16 x 3 = 80).
        self.assertEqual([numbers(x) for x in boolean("subtract", TURNED_CUBE, SLAB)["bodies"]], [body(1, 6, 6, 12, 8)])
        self.assertEqual([numbers(x) for x in boolean("union", DEEP, SUNK_CUBE)["bodies"]], [body(48, 80, 6, 12, 8)])

    def test_rotations(self):
        # The 3-4-5 turn about z sends x to (4/5, 3/5, 0); the composed turn
        # is Ry Rx, multiplied out in the comment on SUNK_CUBE.
        self.assertEqual(Z345[0][0], F(4, 5))
        self.assertEqual(Z345[1][0], F(3, 5))
        self.assertEqual(CUBE_R, ((F(4, 5), F(-9, 25), F(-12, 25)), (0, F(4, 5), F(-3, 5)), (F(3, 5), F(12, 25), F(16, 25))))
        self.assertEqual(TURNED_CUBE.vertices[6], (F(-1, 25), F(1, 5), F(43, 25)))

    def test_an_edge_lying_in_a_plane_of_the_other_solid(self):
        # Regression (30c long run, seed 31006 case 74): a bar's edge lying
        # in the slab's top plane, so on each of the bar's sloping faces the
        # slab's top and the bar's other slope cut along one line. That line
        # split only the cells the slab could be in, so a bar face kept a
        # cell running past its own edge. The bar: the triangle (12, 1),
        # (15, 5), (9, 5) (sides 5, 5, 6, height 4) turned square to y and
        # run 10 along it, its bottom edge on z = 1 at x = 12, clear of the
        # slab 0..10 x 0..10 x 0..1. Union keeps both apart: slab V 100,
        # S 2 x 100 + 4 x 10 = 240; bar V 6 x 4 / 2 x 10 = 120, S two ends
        # 2 x 12 + two slopes 2 x 5 x 10 + top 6 x 10 = 184, 5 faces, 9
        # edges, 6 vertices.
        slab = block(0, 0, 0, 10, 10, 1)
        bar = Prism([(12, 1), (15, 5), (9, 5)], -10, 0, turn("x", 0, 1, 1))
        self.assertEqual(bar.vertices[3], (12, 0, 1))
        self.assertEqual([numbers(x) for x in boolean("union", slab, bar)["bodies"]],
                         [body(100, 240, 6, 12, 8), body(120, 184, 5, 9, 6)])
        self.assertEqual([numbers(x) for x in boolean("subtract", slab, bar)["bodies"]], [body(100, 240, 6, 12, 8)])
        self.assertEqual(boolean("intersect", slab, bar)["outcome"], "empty")

    def test_far_out_and_tiny(self):
        # The capped cube moved 1 km out (1e6 mm): the same numbers, the box
        # moved. Shrunk to micrometres (every length times 1/1000) it is
        # thin (rule 1).
        km = 10 ** 6
        r = boolean("subtract", block(0, 0, 0, 1, 1, 1, CUBE_R, (km, km, km)), block(-5, -5, F(37, 25), 5, 5, 5, move=(km, km, km)))
        self.assertEqual(numbers(r["bodies"][0]), body(F(79, 80), F(471, 80), 7, 15, 10))
        self.assertEqual(r["bodies"][0]["box"][:3], (km - F(21, 25), km - F(3, 5), km))
        tiny = boolean("subtract", Prism([(0, 0), (UM, 0), (UM, UM), (0, UM)], 0, UM, CUBE_R), block(-5, -5, F(37, 25) * UM, 5, 5, 5))
        self.assertEqual(tiny["outcome"], "thin")
        # The lid's three sides join the cut points on legs square to each
        # other, so their squared lengths are sums of two squared legs:
        # 4/25 + 1/4 = 41/100, 1/4 + 9/64 = 25/64, 4/25 + 9/64 = 481/1600
        # (square micrometres), each under 1 um^2.
        short = {w[3] for w in tiny["where"]["thin"] if w[0] == "edge"}
        self.assertLessEqual({F(41, 100) * UM ** 2, F(25, 64) * UM ** 2, F(481, 1600) * UM ** 2}, short)


class Bands(unittest.TestCase):
    """Rule 1 on turned prisms: within 2 LINEAR the same (refused), up to
    MIN_FEATURE thin, from MIN_FEATURE fine; 0.9x and 1.1x of each."""

    def cap(self, legs):
        # The cap whose shortest leg (on the edge falling 16/25 per unit) is
        # `legs`: the plane sits d = 16/25 legs below the top corner, and
        # the other legs are d/(3/5) = 16/15 legs and d/(12/25) = 4/3 legs.
        d = F(16, 25) * legs
        return boolean("intersect", block(-5, -5, F(43, 25) - d, 5, 5, 5), TURNED_CUBE)

    def test_short_legs(self):
        thin = self.cap(MIN_FEATURE * F(9, 10))
        self.assertEqual(thin["problems"], ["thin"])
        # Two legs under 1 um: 0.9 um and 16/15 x 0.9 = 0.96 um (the lid's
        # sides are longer, sqrt(0.9^2 + 0.96^2) and more), squared.
        self.assertEqual(sorted(w[3] for w in thin["where"]["thin"]), [(MIN_FEATURE * F(9, 10)) ** 2, (MIN_FEATURE * F(24, 25)) ** 2])
        self.assertTrue(all(w[0] == "edge" for w in thin["where"]["thin"]))
        fine = self.cap(MIN_FEATURE * F(11, 10))
        self.assertEqual(fine["outcome"], "bodies")
        # Legs 1.1, 1.1 x 16/15, 1.1 x 4/3 um: V = their product / 6.
        legs = [MIN_FEATURE * F(11, 10) * k for k in (1, F(16, 15), F(4, 3))]
        self.assertEqual(fine["bodies"][0]["volume"], legs[0] * legs[1] * legs[2] / 6)

    def wall(self, w):
        # A 10 mm cube with a turned-square pocket 1 mm deep whose lowest
        # corner (-1/10, -7/10, scaled by 4) stays w from the side y = 0:
        # the top ring's outer side y = 0 and the pocket's two sides from
        # that corner share no vertex and come within w.
        return boolean("subtract", block(0, 0, 0, 10, 10, 10),
                       block(-2, -2, 9, 2, 2, 11, Z345, (5, F(14, 5) + w, 0)))

    def test_wall(self):
        thin = self.wall(MIN_FEATURE * F(9, 10))
        self.assertEqual(thin["problems"], ["thin"])
        gaps = [g for g in thin["where"]["thin"] if g[0] == "gap"]
        self.assertEqual({g[3] for g in gaps}, {(MIN_FEATURE * F(9, 10)) ** 2})
        self.assertEqual(self.wall(MIN_FEATURE * F(11, 10))["outcome"], "bodies")

    def test_corner_within_tolerance(self):
        # The top corner 0.9 x 2 LINEAR from the lid's plane: one place.
        d = SAME * F(9, 10)
        with self.assertRaisesRegex(ModelError, "within tolerance of the plane"):
            boolean("intersect", block(-5, -5, F(43, 25) - d, 5, 5, 5), TURNED_CUBE)
        # 1.1 x: two places, and the sliver left is thin.
        d = SAME * F(11, 10)
        self.assertEqual(boolean("intersect", block(-5, -5, F(43, 25) - d, 5, 5, 5), TURNED_CUBE)["outcome"], "thin")

    def skew(self, gap):
        # The block [0,4]^3's top edge x = z = 4 and a unit prism's edge
        # along u = (4, 12, -3)/13 passing `gap` outside it, across it: both
        # lines lie in planes 3x + 4z = 5 x (28/5 + const) (w = (3,0,4)/5 is
        # square to both), so they pass exactly `gap` apart, at y = 2. The
        # prism's frame is w, v = u x w = (48, -25, -36)/65, u; its cross
        # section (0,0), (3/5,-4/5), (7/5,-1/5), (4/5,3/5) in (w, v) keeps it
        # on the far side, and every corner of either lies far (over 0.1 mm)
        # from the other's planes, so only the edges come close.
        w, v, u = (F(3, 5), 0, F(4, 5)), (F(48, 65), F(-25, 65), F(-36, 65)), (F(4, 13), F(12, 13), F(-3, 13))
        frame = tuple((w[i], v[i], u[i]) for i in range(3))
        start = (4 + gap * w[0], 2, 4 + gap * w[2])
        tool = Prism([(0, 0), (F(3, 5), F(-4, 5)), (F(7, 5), F(-1, 5)), (F(4, 5), F(3, 5))], F(-1, 2), F(1, 2), frame, start)
        return boolean("union", block(0, 0, 0, 4, 4, 4), tool)

    def test_edges_within_tolerance(self):
        with self.assertRaisesRegex(ModelError, "pass within tolerance"):
            self.skew(SAME * F(9, 10))
        r = self.skew(SAME * F(11, 10))
        self.assertEqual(r["outcome"], "bodies")
        self.assertEqual(sorted(x["volume"] for x in r["bodies"]), [1, 64])

    def test_knife_edges_are_not_thin(self):
        # Edges sharing a corner may meet at any angle (rule 1): a turned
        # 2 um cube is fine.
        self.assertEqual(solid(Prism([(0, 0), (2 * UM, 0), (2 * UM, 2 * UM), (0, 2 * UM)], 0, 2 * UM, CUBE_R))["problems"], [])


class Refusals(unittest.TestCase):
    def test_inputs(self):
        with self.assertRaisesRegex(ModelError, "not a Pythagorean triple"):
            turn("z", 1, 1, 2)
        with self.assertRaisesRegex(ModelError, "not strictly convex"):
            Prism([(0, 0), (0, 1), (1, 1), (1, 0)], 0, 1)  # clockwise
        with self.assertRaisesRegex(ModelError, "not strictly convex"):
            Prism([(0, 0), (1, 0), (2, 0), (1, 1)], 0, 1)  # three in a line
        with self.assertRaisesRegex(ModelError, "no rational length"):
            Prism([(0, 0), (1, 0), (0, 1)], 0, 1)  # the side (1,0)-(0,1) is sqrt 2
        with self.assertRaisesRegex(ModelError, "no volume"):
            Prism([(0, 0), (1, 0), (0, 1)], 1, 1)
        with self.assertRaisesRegex(ModelError, "not a rotation"):
            Prism([(0, 0), (1, 0), (1, 1), (0, 1)], 0, 1, ((1, 0, 0), (0, 1, 0), (0, 0, -1)))  # a mirror
        with self.assertRaisesRegex(ModelError, "unknown operation"):
            boolean("xor", TURNED_CUBE, TURNED_CUBE)
        with self.assertRaisesRegex(ModelError, "input B is thin"):
            boolean("union", TURNED_CUBE, block(0, 0, 0, 1, 1, MIN_FEATURE / 2))


# The independent model: general position only (no corner on the other's
# planes, no edges meeting), from the corners alone.

def faces_of(p):
    """Each face of a prism as (normal, offset, corners in order), worked
    from its corners: sides from three corners, top and bottom likewise."""
    n = len(p.outline)
    v = p.vertices
    out = []
    for i in range(n):
        j = (i + 1) % n
        out.append((v[i], v[j], v[n + j], v[n + i]))
    out.append(tuple(v[n:]))
    out.append(tuple(reversed(v[:n])))
    return [(nrm(c), dt(nrm(c), c[0]), c) for c in out]


def sb(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def cr(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def dt(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def nrm(c):
    return cr(sb(c[1], c[0]), sb(c[2], c[0]))


def length(x):
    x = F(x)
    r = F(isqrt(x.numerator), isqrt(x.denominator))
    assert r * r == x, "irrational length"
    return r


def polygon_area(normal, pts):
    s = (0, 0, 0)
    for i in range(len(pts)):
        c = cr(pts[i - 1], pts[i])
        s = (s[0] + c[0], s[1] + c[1], s[2] + c[2])
    return abs(dt(normal, s)) / length(dt(normal, normal)) / 2


def simple(a, b):
    """V, E, F, R, volume and area of a n b, a u b and a - b by vertex
    enumeration (a n b) and walking face boundaries (the others)."""
    fa, fb = faces_of(a), faces_of(b)
    planes = [(n, d) for n, d, _ in fa + fb]

    def side(n, d, x):
        return dt(n, x) - d

    def strictly_in(x, faces):
        return all(side(n, d, x) < 0 for n, d, _ in faces)

    for x in a.vertices:
        assert all(side(n, d, x) != 0 for n, d, _ in fb), "not general position"
    for x in b.vertices:
        assert all(side(n, d, x) != 0 for n, d, _ in fa), "not general position"
    verts = {}
    for i in range(len(planes)):
        for j in range(i + 1, len(planes)):
            for k in range(j + 1, len(planes)):
                rows = [planes[i][0], planes[j][0], planes[k][0]]
                det = dt(rows[0], cr(rows[1], rows[2]))
                if det == 0:
                    continue
                rhs = [planes[i][1], planes[j][1], planes[k][1]]
                x = tuple(dt([rhs[0], rhs[1], rhs[2]], [cr(rows[1], rows[2])[c], cr(rows[2], rows[0])[c], cr(rows[0], rows[1])[c]]) / det for c in range(3))
                if all(side(n, d, x) <= 0 for n, d in planes):
                    verts[x] = {m for m in range(len(planes)) if side(*planes[m], x) == 0}
    assert all(len(s) == 3 for s in verts.values()), "not general position"
    on = {m: [x for x, s in verts.items() if m in s] for m in range(len(planes))}
    i_faces = [m for m in on if len(on[m]) >= 3]
    i_area_on = {}
    for m in i_faces:
        n = planes[m][0]
        pts = on[m]
        c = tuple(sum(p[t] for p in pts) / len(pts) for t in range(3))
        u = sb(pts[0], c)
        w = cr(n, u)
        pts = sorted(pts, key=lambda p: angle_key(dt(sb(p, c), u), dt(sb(p, c), w)))
        i_area_on[m] = polygon_area(n, pts)
    i_edges = sum(1 for m1 in range(len(planes)) for m2 in range(m1 + 1, len(planes)) if sum(1 for s in verts.values() if {m1, m2} <= s) == 2)
    i_vol = sum(planes[m][1] / length(dt(planes[m][0], planes[m][0])) * i_area_on[m] / 3 for m in i_faces)
    i_area = sum(i_area_on.values())

    def pieces(face, other):
        # Walk the face's boundary, cut where the other's planes cross it,
        # and count the runs outside the other (a convex other leaves one
        # piece per run).
        _, _, c = face
        states = []
        for i in range(len(c)):
            p, r = c[i], c[(i + 1) % len(c)]
            ts = sorted({F(0), F(1)} | {side(n, d, p) / (side(n, d, p) - side(n, d, r)) for n, d, _ in other
                                        if (side(n, d, p) < 0) != (side(n, d, r) < 0)})
            for t0, t1 in zip(ts, ts[1:]):
                t = (t0 + t1) / 2
                x = tuple(p[k] + t * (r[k] - p[k]) for k in range(3))
                states.append(strictly_in(x, other))
        if all(states):
            return 0, 0
        runs = sum(1 for i in range(len(states)) if not states[i] and states[i - 1])
        if runs == 0:  # the boundary is all outside: whole, or a ring round the other's footprint
            plane = planes.index((face[0], face[1]))
            return 1, (1 if plane in i_faces else 0)
        return runs, 0

    va_in = sum(1 for x in a.vertices if strictly_in(x, fb))
    vb_in = sum(1 for x in b.vertices if strictly_in(x, fa))
    crossings = len(verts) - va_in - vb_in
    na = len(fa)
    pa = [pieces(f, fb) for f in fa]
    pb = [pieces(g, fa) for g in fb]
    vol_a = sum(d / length(dt(n, n)) * polygon_area(n, c) / 3 for n, d, c in fa)
    vol_b = sum(d / length(dt(n, n)) * polygon_area(n, c) / 3 for n, d, c in fb)
    area_a = sum(polygon_area(n, c) for n, _, c in fa)
    area_b = sum(polygon_area(n, c) for n, _, c in fb)
    out = {}
    out["intersect"] = (len(verts), i_edges, len(i_faces), 0, i_vol, i_area)
    v_u = len(a.vertices) - va_in + len(b.vertices) - vb_in + crossings
    out["union"] = (v_u, 3 * v_u // 2, sum(x for x, _ in pa + pb), sum(r for _, r in pa + pb), vol_a + vol_b - i_vol, area_a + area_b - i_area)
    v_d = len(a.vertices) - va_in + vb_in + crossings
    on_a = sum(area for m, area in i_area_on.items() if m < na)
    out["subtract"] = (v_d, 3 * v_d // 2, sum(x for x, _ in pa) + sum(1 for m in i_faces if m >= na), sum(r for _, r in pa),
                       vol_a - i_vol, area_a - on_a + (i_area - on_a))
    return out


def angle_key(x, y):
    # Exact order of directions by angle: half-plane, then slope.
    if y > 0 or (y == 0 and x > 0):
        return (0, -x / (abs(x) + abs(y)))
    return (1, x / (abs(x) + abs(y)))


def totals(r):
    bs = r["bodies"]
    return (sum(x["vertices"] for x in bs), sum(x["edges"] for x in bs), sum(x["faces"] for x in bs),
            sum(x["rings"] for x in bs), sum(x["volume"] for x in bs), sum(x["area"] for x in bs))


# Seeded turned prisms: outlines whose sides run along Pythagorean
# directions (so their lengths are rational), turned by one to three
# Pythagorean turns, moved near each other.
TRIPLES = [(3, 4, 5), (5, 12, 13), (8, 15, 17), (7, 24, 25), (20, 21, 29)]
DIRECTIONS = sorted({(F(sx * a, c), F(sy * b, c)) for a, b, c in TRIPLES for a, b in ((a, b), (b, a)) for sx in (1, -1) for sy in (1, -1)}
                    | {(F(1), F(0)), (F(0), F(1)), (F(-1), F(0)), (F(0), F(-1))}, key=lambda d: angle_key(d[0], d[1]))


def random_outline(rng):
    while True:
        k = rng.choice((3, 4, 4, 5, 6))
        dirs = sorted(rng.sample(DIRECTIONS, k), key=lambda d: angle_key(d[0], d[1]))
        lengths = [F(rng.randint(5, 40), 10) for _ in range(k - 2)]
        sx = sum(l * d[0] for l, d in zip(lengths, dirs))
        sy = sum(l * d[1] for l, d in zip(lengths, dirs))
        (ax, ay), (bx, by) = dirs[-2], dirs[-1]
        det = ax * by - ay * bx
        if det == 0:
            continue
        la = (-sx * by + sy * bx) / det
        lb = (-ax * sy + ay * sx) / det
        if la <= F(1, 5) or lb <= F(1, 5) or max(la, lb) > 6:
            continue
        pts, p = [], (F(0), F(0))
        for l, d in zip(lengths + [la, lb], dirs):
            pts.append(p)
            p = (p[0] + l * d[0], p[1] + l * d[1])
        cx, cy = sum(x for x, _ in pts) / k, sum(y for _, y in pts) / k
        try:
            return Prism([(x - cx, y - cy) for x, y in pts], 0, 1).outline
        except ModelError:
            continue


def random_turn(rng):
    turns = []
    for _ in range(rng.randint(1, 3)):
        a, b, c = rng.choice(TRIPLES)
        turns.append(turn(rng.choice("xyz"), rng.choice((a, -a)), rng.choice((b, -b)), c))
    return compose(*turns)


def random_prism(rng):
    z0 = F(rng.randint(-150, 0), 97)
    return Prism(random_outline(rng), z0, z0 + F(rng.randint(50, 250), 97), random_turn(rng),
                 tuple(F(rng.randint(-80, 80), 101) for _ in range(3)))


def turned_pairs(seed, n):
    rng = random.Random(seed)
    out = []
    while len(out) < n:
        a, b = random_prism(rng), random_prism(rng)
        try:
            boolean("intersect", a, b)
        except ModelError:
            continue
        out.append((a, b))
    return out


def random_box(rng):
    lo = [rng.randint(0, 3) for _ in range(3)]
    hi = [x + rng.randint(1, 3) for x in lo]
    return lo + hi


SEED = 30002  # FISSION_SEED style: decimal, recorded here so a failure replays


class Seeded(unittest.TestCase):
    def test_against_the_independent_model(self):
        checked = 0
        for a, b in turned_pairs(SEED, 20):
            want = simple(a, b)
            for op in ("union", "subtract", "intersect"):
                r = boolean(op, a, b)
                if r["outcome"] == "empty":
                    self.assertEqual(want[op][4], 0, op)
                    continue
                self.assertIn(r["outcome"], ("bodies", "thin"), (op, r["where"]))
                self.assertEqual(totals(r), want[op], op)
                checked += 1
            # A - B and B - A between them have every face of A and B:
            # area(A - B) + area(B - A) = area A + area B, in general position.
            back = boolean("subtract", b, a)
            if back["bodies"]:
                self.assertEqual(totals(back)[5] + want["subtract"][5], sum(x["area"] for x in solid(a)["bodies"] + solid(b)["bodies"]))
        self.assertGreater(checked, 40)

    def test_order_moving_and_turning(self):
        shift = (F(7), F(-3), F(11, 2))
        spin = compose(turn("z", 5, 12, 13), turn("x", 8, -15, 17))
        for a, b in turned_pairs(SEED + 1, 5):
            moved = [Prism(p.outline, *p.z, compose(p.rotation, spin), tuple(c + s for c, s in zip(convex_model.apply(spin, p.move), shift)))
                     for p in (a, b)]
            for op in convex_model.OPS:
                r = boolean(op, a, b)
                m = boolean(op, *moved)
                self.assertEqual(m["outcome"], r["outcome"])
                # Bodies are listed by box, which turning reorders.
                self.assertEqual(sorted(sorted(numbers(x).items()) for x in m["bodies"]), sorted(sorted(numbers(x).items()) for x in r["bodies"]))
                if op != "subtract":
                    self.assertEqual(boolean(op, b, a), r)


def as_box(b, rotation=convex_model.IDENTITY, move=(0, 0, 0)):
    return block(*b, rotation, move)


def canonical(where, rotation=convex_model.IDENTITY, move=(0, 0, 0)):
    """A result's `where`, its points turned and moved, in one order (the
    two models list a place's ends and a gap's edges each their own way)."""
    def m(p):
        return convex_model.plus(convex_model.apply(rotation, p), move)

    def place(w):
        if w[0] == "vertex":
            return ("vertex", m(w[1]))
        if w[0] == "gap":
            return ("gap",) + tuple(sorted(tuple(sorted(m(p) for p in e)) for e in w[1:3])) + (w[3],)
        return ("edge",) + tuple(sorted(m(p) for p in w[1:3])) + w[3:]
    return {k: sorted((place(w) for w in ws), key=repr) for k, ws in where.items()}


def same(got, want):
    """Two results as equal answers."""
    return dict(got, where=canonical(got["where"])) == dict(want, where=canonical(want["where"]))


class AgreesWithBoxModel(unittest.TestCase):
    """box_model is an independent implementation (a grid of cells); small
    integer boxes give every touching, coplanar and nested arrangement."""

    def test_boxes(self):
        rng = random.Random(SEED + 2)
        kinds = set()
        for _ in range(50):
            a, b = random_box(rng), random_box(rng)
            for op in convex_model.OPS:
                want = box_model.boolean(op, [box_model.box(*a)], [box_model.box(*b)])
                got = boolean(op, as_box(a), as_box(b))
                kinds.add(got["outcome"])
                self.assertTrue(same(got, want), (op, a, b, got, want))
        self.assertEqual(kinds, {"bodies", "empty", "nonmanifold"})

    def test_turned_boxes(self):
        # The same pairs turned and moved together: the same numbers and
        # outcome, the where turned and moved.
        rng = random.Random(SEED + 3)
        spin = compose(turn("x", 3, 4, 5), turn("z", 12, -5, 13))
        shift = (F(1, 3), F(-2, 7), F(5))
        for _ in range(15):
            a, b = random_box(rng), random_box(rng)
            for op in convex_model.OPS:
                want = box_model.boolean(op, [box_model.box(*a)], [box_model.box(*b)])
                got = boolean(op, as_box(a, spin, shift), as_box(b, spin, shift))
                self.assertEqual(got["outcome"], want["outcome"], (op, a, b))
                # Bodies are listed by box, which turning reorders.
                self.assertEqual(sorted(sorted(numbers(x).items()) for x in got["bodies"]), sorted(sorted(numbers(x).items()) for x in want["bodies"]))
                self.assertEqual(canonical(got["where"]), canonical(want["where"], spin, shift), (op, a, b))

    def test_thin_and_tolerance_bands_agree(self):
        # box_model's step and wall cases (its Bands), as single boxes.
        for h in (MIN_FEATURE * F(9, 10), MIN_FEATURE * F(11, 10), SAME * F(11, 10)):
            a, b = [0, 0, 0, 10, 10, 10], [10, 0, h, 20, 10, 10 + h]
            self.assertTrue(same(boolean("union", as_box(a), as_box(b)), box_model.boolean("union", [box_model.box(*a)], [box_model.box(*b)])))
        for w in (MIN_FEATURE * F(9, 10), MIN_FEATURE * F(11, 10)):
            a, b = [0, 0, 0, 10, 10, 10], [w, 1, 9, 9, 9, 11]
            self.assertTrue(same(boolean("subtract", as_box(a), as_box(b)), box_model.boolean("subtract", [box_model.box(*a)], [box_model.box(*b)])))
        a, b = [0, 0, 0, 10, 10, 10], [10, 0, SAME * F(9, 10), 20, 10, 10]
        for model, args in ((box_model, ([box_model.box(*a)], [box_model.box(*b)])), (convex_model, (as_box(a), as_box(b)))):
            with self.assertRaisesRegex(ModelError, "within tolerance"):
                model.boolean("union", *args)


class Planted(unittest.TestCase):
    """Each planted break in the model makes a test above fail."""

    def failing(self):
        bad = []
        for case in HAND:
            try:
                check_hand(case)
            except Exception as e:  # a wrong answer, or the model's own checks tripping
                bad.append((case[0], str(e)[:80]))
        for case in WHERE:
            try:
                check_where(case)
            except Exception as e:
                bad.append((case[0], str(e)[:80]))
        return [n for n, _ in bad]

    def test_faces_never_merged(self):
        class Apart(box_model.Union):
            def join(self, a, b):
                pass
        with mock.patch.object(convex_model, "Union", Apart):
            self.assertIn("half union", self.failing())

    def test_planes_not_shared(self):
        # Each prism's planes kept apart: the coplanar tops are never one face.
        real = convex_model.Measured._planes

        def apart(self):
            real(self)
            earlier = set()
            for hs in self.spaces:
                for idx, (j, sign) in enumerate(hs):
                    if j in earlier:
                        self.planes.append(self.planes[j])
                        hs[idx] = (len(self.planes) - 1, sign)
                earlier |= {j for j, _ in hs}
        with mock.patch.object(convex_model.Measured, "_planes", apart):
            self.assertIn("half union", self.failing())

    def test_cones_never_empty(self):
        with mock.patch.object(convex_model, "open_cone", lambda rows: True):
            self.assertTrue(self.failing())

    def test_outside_connection_skipped(self):
        # Only the result's cones checked for connection: a tool's corner
        # touching a face from inside goes unseen.
        real = convex_model.disconnected
        with mock.patch.object(convex_model, "disconnected", lambda cells, flips, want: want and real(cells, flips, want)):
            self.assertIn("corner dent", self.failing())

    def test_vertices_on_straight_creases_counted(self):
        real = convex_model.rank
        with mock.patch.object(convex_model, "rank", lambda vs: 3 if real(vs) == 2 else real(vs)):
            self.assertTrue(self.failing())

    def test_rings_forgotten(self):
        real = convex_model.Measured._plane_faces

        def no_inner(self, i):
            before = len(self.faces)
            real(self, i)
            for f in self.faces[before:]:
                f["chi"] = 1
        with mock.patch.object(convex_model.Measured, "_plane_faces", no_inner):
            names = self.failing()
        self.assertIn("turned hole", names)
        self.assertNotIn("corner cap", names)

    def test_voids_forgotten(self):
        with mock.patch.object(convex_model.Measured, "_owners", staticmethod(lambda shells: {s: s for s in shells})):
            self.assertIn("turned void", self.failing())

    def test_thin_rule_off(self):
        with mock.patch.object(convex_model, "MIN_FEATURE", F(0)):
            self.assertNotEqual(Bands().cap(MIN_FEATURE * F(9, 10))["outcome"], "thin")
            self.assertNotEqual(Bands().wall(MIN_FEATURE * F(9, 10))["outcome"], "thin")

    def test_tolerance_rule_off(self):
        # Without the refusal, both of Bands' refused cases are answered.
        with mock.patch.object(convex_model, "SAME", F(0)):
            self.assertEqual(Bands().skew(SAME * F(9, 10))["outcome"], "bodies")
            self.assertEqual(boolean("intersect", block(-5, -5, F(43, 25) - SAME * F(9, 10), 5, 5, 5), TURNED_CUBE)["outcome"], "thin")

    def test_independent_model_sees_a_wrong_count(self):
        # The seeded check fails when the model is off by one face.
        a, b = turned_pairs(SEED, 1)[0]
        r = boolean("union", a, b)
        r["bodies"][0]["faces"] += 1
        self.assertNotEqual(totals(r), simple(a, b)["union"])


if __name__ == "__main__":
    unittest.main()
