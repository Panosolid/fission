"""Tests for box_model.py: python3 -m unittest discover -s prototypes/boolean -p 'test_*.py'.

Every expected number in HAND is worked out by hand in the comment beside it.
The vertex rule is checked against the textbook definition on all 256
arrangements, the seeded tests check identities and an independent voxel count,
OpenCascade (when installed) checks the counts on the seeded results, and each
planted break below makes a test fail."""

import os
import random
import sys
import unittest
from fractions import Fraction
from itertools import product
from unittest import mock

sys.path.insert(0, os.path.dirname(__file__))
import box_model  # noqa: E402
from box_model import MIN_FEATURE, SAME, ModelError, OFFSETS, box, boolean, solid  # noqa: E402

UM = Fraction(1, 1000)  # 1 um in mm

# (name, op, A, B, expected outcome, expected bodies or None). Counts are per
# body: volume, area, faces, edges, vertices, rings, shells, genus.
HAND = [
    # Box 2 x 3 x 4: V = 24, S = 2(6 + 8 + 12) = 52; 6 faces, 12 edges, 8
    # corners; V - E + F = 2, genus 0. (A box with itself: A u A = A.)
    ("box", "union", [box(0, 0, 0, 2, 3, 4)], [box(0, 0, 0, 2, 3, 4)], "bodies",
     [dict(volume=24, area=52, faces=6, edges=12, vertices=8, rings=0, shells=1, genus=0)]),
    # An L by union of a 2 x 1 x 1 and a 1 x 2 x 1 box over one shared cell:
    # V = 2 + 2 - 1 = 3. The L outline has 6 sides and 6 corners: S = 2 x 3
    # (top, bottom) + 8 x 1 (perimeter 8, height 1) = 14; faces: top, bottom
    # and 6 sides = 8; corners 6 x 2 = 12; edges 6 + 6 + 6 = 18.
    ("L", "union", [box(0, 0, 0, 2, 1, 1)], [box(0, 0, 0, 1, 2, 1)], "bodies",
     [dict(volume=3, area=14, faces=8, edges=18, vertices=12, rings=0, shells=1, genus=0)]),
    # A corner notch: [0,2]^3 minus [1,3]^3 takes the unit cube at (1..2)^3:
    # V = 8 - 1 = 7. The faces at x, y, z = 0 stay squares, those at 2 become
    # L shapes, and the notch adds 3: F = 9. Area: the notch removes 3 unit
    # squares and adds 3: S = 24. Corners: the cube's 8 minus (2,2,2), plus
    # the notch's 7 others ((1,1,1), (1,1,2), (1,2,1), (2,1,1), (1,2,2),
    # (2,1,2), (2,2,1)): V = 14; E = V + F - 2 = 21.
    ("corner notch", "subtract", [box(0, 0, 0, 2, 2, 2)], [box(1, 1, 1, 3, 3, 3)], "bodies",
     [dict(volume=7, area=24, faces=9, edges=21, vertices=14, rings=0, shells=1, genus=0)]),
    # A hollow box (decision 3): [0,3]^3 minus [1,2]^3 wholly inside:
    # V = 27 - 1 = 26, S = 54 + 6 = 60, two shells (the outside and the void),
    # 12 faces, 24 edges, 16 corners; 16 - 24 + 12 - 0 = 4 = 2(2 - 0).
    ("hollow box", "subtract", [box(0, 0, 0, 3, 3, 3)], [box(1, 1, 1, 2, 2, 2)], "bodies",
     [dict(volume=26, area=60, faces=12, edges=24, vertices=16, rings=0, shells=2, genus=0)]),
    # A square hole through a 3 x 3 x 1 plate: V = 9 - 1 = 8;
    # S = 2 x 8 + 12 x 1 (outside) + 4 x 1 (hole walls) = 32. Top and bottom
    # are rings (R = 2), 4 sides and 4 walls: F = 10; corners 8 + 8 = 16;
    # edges 4 x 2 + 4 x 2 (the loops) + 4 + 4 (uprights) = 24;
    # 16 - 24 + 10 - 2 = 0 = 2(1 - H), so H = 1.
    ("through hole", "subtract", [box(0, 0, 0, 3, 3, 1)], [box(1, 1, -1, 2, 2, 2)], "bodies",
     [dict(volume=8, area=32, faces=10, edges=24, vertices=16, rings=2, shells=1, genus=1)]),
    # Two unit cubes 1 apart, joined: two bodies, each a unit cube (F2: no
    # warning), sorted by their boxes.
    ("apart", "union", [box(0, 0, 0, 1, 1, 1)], [box(2, 0, 0, 3, 1, 1)], "bodies",
     [dict(volume=1, area=6, faces=6, edges=12, vertices=8, rings=0, shells=1, genus=0)] * 2),
    # Two cubes sharing only a face: nothing in common (F3b, decision 2).
    ("touching intersect", "intersect", [box(0, 0, 0, 1, 1, 1)], [box(1, 0, 0, 2, 1, 1)], "empty", None),
    # A tool swallowing the target leaves nothing (F3).
    ("swallowed", "subtract", [box(0, 0, 0, 1, 1, 1)], [box(-1, -1, -1, 2, 2, 2)], "empty", None),
    # A tool only touching the target leaves it as it was (decision 2).
    ("touching tool", "subtract", [box(0, 0, 0, 2, 3, 4)], [box(2, 0, 0, 3, 3, 4)], "bodies",
     [dict(volume=24, area=52, faces=6, edges=12, vertices=8, rings=0, shells=1, genus=0)]),
    # A box in a box: intersect is the small one (B0r).
    ("inner intersect", "intersect", [box(0, 0, 0, 3, 3, 3)], [box(1, 1, 1, 2, 2, 2)], "bodies",
     [dict(volume=1, area=6, faces=6, edges=12, vertices=8, rings=0, shells=1, genus=0)]),
    # A 2 x 2 x 2 box on another's top, shifted 1 along x: [0,2]^2 x [0,2]
    # and [1,3] x [0,2] x [2,4]. V = 8 + 8 = 16; S = 2 x 24 - 2 x 2 (the
    # 1 x 2 contact) = 44. In y the outline is a Z with 8 corners, (0,0),
    # (2,0), (2,2), (3,2), (3,4), (1,4), (1,2), (0,2), so 8 faces round it
    # plus the two Z faces at y = 0 and 2: F = 10; V = 8 x 2 = 16;
    # E = 8 x 2 (the Zs) + 8 (across) = 24.
    ("offset stack", "union", [box(0, 0, 0, 2, 2, 2)], [box(1, 0, 2, 3, 2, 4)], "bodies",
     [dict(volume=16, area=44, faces=10, edges=24, vertices=16, rings=0, shells=1, genus=0)]),
    # A tripod: a centre cube (1..2, 0..1, 0..1) with arms along -x, +y and
    # +z. V = 4, S = 4 x 6 - 2 x 3 = 18. Faces: z = 0 an L (1), z = 1 two
    # squares touching at (1,1,1) (2, never merged: they share no side),
    # z = 2 (1), x = 0 (1), x = 1 two squares touching at (1,1,1) (2),
    # x = 2 an L (1), y = 0 an L (1), y = 1 two (2), y = 2 (1): F = 12.
    # Corners: the 12 arm-end corners, and of the centre cube's 8: (1,1,1)
    # (six faces meet), (2,0,0), (2,1,1), (1,0,1), (1,1,0); (2,1,0),
    # (2,0,1), (1,0,0) lie on straight creases: V = 17; E = 17 + 12 - 2 = 27.
    ("tripod", "union", [box(0, 0, 0, 2, 1, 1), box(1, 0, 0, 2, 2, 1)], [box(1, 0, 0, 2, 1, 2)], "bodies",
     [dict(volume=4, area=18, faces=12, edges=27, vertices=17, rings=0, shells=1, genus=0)]),
    # A pinched face: a 3 x 3 x 1 slab missing its (0,0) corner cell, with a
    # unit pillar on cell (1,1). The slab's top is a U of 7 squares whose two
    # ends touch at (1,1,1), where the pillar stands: one face, pinched.
    # V = 8 + 1 = 9; S = 2 x 8 + 12 (slab: area 8, perimeter 12) + 4 (the
    # pillar's sides; its top replaces the square it covers) = 32. Faces:
    # slab bottom, the U, 6 slab sides, pillar top and 4 sides: F = 13. Its
    # rings: 7 squares - 6 inner sides + 0 inner points = chi 1, a disc, so
    # 0 (R = 0). Corners: the slab outline's 6 corners twice (12, (1,1,1)
    # among them), the pillar top's 4, and its foot's other 3: V = 19;
    # E = 19 + 13 - 0 - 2 = 30 (slab 18, pillar 4 + 4 + 4 = 12).
    ("pinched face", "union",
     [box(1, 0, 0, 3, 3, 1), box(0, 1, 0, 3, 3, 1)], [box(1, 1, 0, 2, 2, 2)], "bodies",
     [dict(volume=9, area=32, faces=13, edges=30, vertices=19, rings=0, shells=1, genus=0)]),
    # Cubes sharing only an edge (x = y = 1, z 0..1): non-manifold there.
    ("edge touch", "union", [box(0, 0, 0, 1, 1, 1)], [box(1, 1, 0, 2, 2, 1)], "nonmanifold", None),
    # Cubes sharing only the corner (1,1,1): non-manifold there.
    ("corner touch", "union", [box(0, 0, 0, 1, 1, 1)], [box(1, 1, 1, 2, 2, 2)], "nonmanifold", None),
    # A cut leaving two pieces joined only along an edge: an L of three
    # cells (0,0), (1,0), (1,1) with (1,0) cut out by a pillar.
    ("cut to an edge", "subtract", [box(0, 0, 0, 2, 1, 1), box(1, 0, 0, 2, 2, 1)], [box(1, 0, -1, 2, 1, 2)],
     "nonmanifold", None),
]


def number_dict(d):
    return {k: d[k] for k in ("volume", "area", "faces", "edges", "vertices", "rings", "shells", "genus")}


def check_hand(case):
    """Raises AssertionError when the model's answer differs from the case."""
    name, op, a, b, outcome, bodies = case
    got = boolean(op, a, b)
    if got["outcome"] != outcome:
        raise AssertionError(f"{name}: outcome {got['outcome']}, expected {outcome}")
    if bodies is not None:
        have = [number_dict(x) for x in got["bodies"]]
        if have != bodies:
            raise AssertionError(f"{name}: {have} != {bodies}")


class HandWorked(unittest.TestCase):
    def test_every_hand_case(self):
        for case in HAND:
            with self.subTest(case[0]):
                check_hand(case)

    def test_where_edge_touch(self):
        # The shared edge runs from (1,1,0) to (1,1,1); nothing else.
        r = boolean("union", [box(0, 0, 0, 1, 1, 1)], [box(1, 1, 0, 2, 2, 1)])
        self.assertEqual(r["where"]["nonmanifold"], [("edge", (1, 1, 0), (1, 1, 1))])
        self.assertEqual(r["problems"], ["nonmanifold"])  # thin is not judged there
        self.assertEqual(r["bodies"], [])

    def test_where_corner_touch(self):
        r = boolean("union", [box(0, 0, 0, 1, 1, 1)], [box(1, 1, 1, 2, 2, 2)])
        self.assertEqual(r["where"]["nonmanifold"], [("vertex", (1, 1, 1))])

    def test_where_cut_to_an_edge(self):
        r = boolean("subtract", [box(0, 0, 0, 2, 1, 1), box(1, 0, 0, 2, 2, 1)], [box(1, 0, -1, 2, 1, 2)])
        self.assertEqual(r["where"]["nonmanifold"], [("edge", (1, 1, 0), (1, 1, 1))])

    def test_pinch_is_reported(self):
        r = boolean("union", [box(1, 0, 0, 3, 3, 1), box(0, 1, 0, 3, 3, 1)], [box(1, 1, 0, 2, 2, 2)])
        self.assertEqual(r["pinched"], [(1, 1, 1)])
        # The tripod's coplanar squares touching at (1,1,1) are separate
        # faces, so no pinch.
        self.assertEqual(solid([box(0, 0, 0, 2, 1, 1), box(1, 0, 0, 2, 2, 1), box(1, 0, 1, 2, 1, 2)])["pinched"], [])

    def test_box_far_out_and_tiny(self):
        # The same 2 x 3 x 4 box 1 km out (1e6 mm): the same answer, box moved.
        km = 10 ** 6
        r = solid([box(km, km, km, km + 2, km + 3, km + 4)])
        self.assertEqual(number_dict(r["bodies"][0]), HAND[0][5][0])
        self.assertEqual(r["bodies"][0]["box"], (km, km, km, km + 2, km + 3, km + 4))
        # A 2 x 3 x 4 um box: V = 24 um^3 = 24e-9 mm^3, S = 52e-6 mm^2.
        r = solid([box(0, 0, 0, 2 * UM, 3 * UM, 4 * UM)])
        self.assertEqual(r["bodies"][0]["volume"], 24 * UM ** 3)
        self.assertEqual(r["bodies"][0]["area"], 52 * UM ** 2)


class Bands(unittest.TestCase):
    """Rule 1: within 2 LINEAR the same (the model refuses to judge), up to
    MIN_FEATURE thin, from MIN_FEATURE fine; 0.9x and 1.1x of each."""

    def step(self, h):
        # A 10 mm cube joined to one beside it raised by h: the 1 x 1 side
        # steps at h, giving four edges h long (rule 1's 50 nm step).
        return boolean("union", [box(0, 0, 0, 10, 10, 10)], [box(10, 0, h, 20, 10, 10 + h)])

    def test_step_at_min_feature(self):
        thin = self.step(MIN_FEATURE * Fraction(9, 10))
        self.assertEqual(thin["outcome"], "thin")
        short = [w for w in thin["where"]["thin"] if w[0] == "edge"]
        self.assertEqual(len(short), 4)
        self.assertTrue(all(w[3] == MIN_FEATURE * Fraction(9, 10) for w in short))
        fine = self.step(MIN_FEATURE * Fraction(11, 10))
        self.assertEqual(fine["outcome"], "bodies")
        # The union: 2000 mm^3, and 2 x 600 minus twice the contact
        # 10 x (10 - h) on x = 10.
        h = MIN_FEATURE * Fraction(11, 10)
        self.assertEqual(fine["bodies"][0]["volume"], 2000)
        self.assertEqual(fine["bodies"][0]["area"], 1200 - 2 * 10 * (10 - h))

    def wall(self, w):
        # A 10 mm cube with a pocket 1 mm deep from the top, leaving a wall w
        # thick on the x = 0 side: the top face is a ring whose outer edge at
        # x = 0 and inner edge at x = w share no vertex and lie w apart.
        return boolean("subtract", [box(0, 0, 0, 10, 10, 10)], [box(w, 1, 9, 9, 9, 11)])

    def test_wall_at_min_feature(self):
        thin = self.wall(MIN_FEATURE * Fraction(9, 10))
        self.assertEqual(thin["problems"], ["thin"])
        gaps = [g for g in thin["where"]["thin"] if g[0] == "gap"]
        self.assertTrue(gaps)
        self.assertTrue(all(g[3] == (MIN_FEATURE * Fraction(9, 10)) ** 2 for g in gaps))
        self.assertEqual(self.wall(MIN_FEATURE * Fraction(11, 10))["outcome"], "bodies")

    def test_knife_edges_are_not_thin(self):
        # Edges sharing a corner may meet at any angle: a unit cube has no
        # thin places although its edges meet (decision 6, rule 1).
        self.assertEqual(solid([box(0, 0, 0, UM * 2, UM * 2, UM * 2)])["problems"], [])

    def test_tolerance(self):
        # Coordinates 0.9 x 2 LINEAR apart are one place to the kernel.
        with self.assertRaisesRegex(ModelError, "within tolerance"):
            self.step(SAME * Fraction(9, 10))
        # 1.1 x is two places, and the step it leaves is thin.
        self.assertEqual(self.step(SAME * Fraction(11, 10))["outcome"], "thin")

    def test_far_wall_outside_builds(self):
        # The golden model far-wall-outside: a cut whose far wall lies 0.5 um
        # past the block leaves nothing thin (judged on the result).
        r = boolean("subtract", [box(0, 0, 0, 10, 10, 10)], [box(3, 3, 5, 7, 7, 10 + UM / 2)])
        self.assertEqual(r["outcome"], "bodies")
        self.assertEqual(r["bodies"][0]["volume"], 1000 - 4 * 4 * 5)


class Refusals(unittest.TestCase):
    def test_inputs(self):
        with self.assertRaisesRegex(ModelError, "no volume"):
            box(0, 0, 0, 0, 1, 1)
        with self.assertRaisesRegex(ModelError, "unknown operation"):
            boolean("xor", [box(0, 0, 0, 1, 1, 1)], [box(0, 0, 0, 1, 1, 1)])
        with self.assertRaisesRegex(ModelError, "at least one box"):
            boolean("union", [], [box(0, 0, 0, 1, 1, 1)])
        with self.assertRaisesRegex(ModelError, "input A is 2 bodies"):
            boolean("union", [box(0, 0, 0, 1, 1, 1), box(2, 0, 0, 3, 1, 1)], [box(0, 0, 0, 1, 1, 1)])
        with self.assertRaisesRegex(ModelError, "input B is not manifold"):
            boolean("union", [box(0, 0, 0, 1, 1, 1)], [box(0, 0, 0, 1, 1, 1), box(1, 1, 0, 2, 2, 1)])
        with self.assertRaisesRegex(ModelError, "input A is thin"):
            boolean("union", [box(0, 0, 0, 1, 1, Fraction(1, 2000))], [box(0, 0, 0, 1, 1, 1)])


def link_kind(config):
    """The textbook rule for a grid point, written independently of
    box_model: the boundary squares round the point (cell faces between an
    in and an out cell of the eight) each join two of the six spokes (half
    axes) from it; the surface there is a disc when every spoke is used by 0
    or 2 squares and the used ones form one cycle. A disc is a vertex unless
    its cycle has 4 squares (a plane, or a straight crease: two half-planes
    on one line)."""
    ins = [o for o in OFFSETS if config[o]]
    if len(ins) in (0, 8):
        return "none"
    links = []
    for axis in range(3):
        u, v = [a for a in range(3) if a != axis]
        for su, sv in product((0, 1), repeat=2):
            lo = [0, 0, 0]
            lo[u], lo[v] = su, sv
            hi = list(lo)
            hi[axis] = 1
            if config[tuple(lo)] != config[tuple(hi)]:
                links.append(((u, su), (v, sv)))
    degree = {}
    for a, b in links:
        degree[a] = degree.get(a, 0) + 1
        degree[b] = degree.get(b, 0) + 1
    if any(d != 2 for d in degree.values()):
        return "nonmanifold"
    # One cycle: walk from one spoke.
    start = links[0][0]
    seen, here, used = {start}, start, set()
    while True:
        nxt = [(i, a if b == here else b) for i, (a, b) in enumerate(links) if i not in used and here in (a, b)]
        if not nxt:
            break
        i, here = nxt[0]
        used.add(i)
        seen.add(here)
    if len(used) != len(links):
        return "nonmanifold"
    return "flat" if len(links) == 4 else "vertex"


class VertexRule(unittest.TestCase):
    def test_all_256_arrangements(self):
        kinds = {}
        for bits in range(256):
            config = {o: bool(bits >> i & 1) for i, o in enumerate(OFFSETS)}
            want = link_kind(config)
            self.assertEqual(box_model.point_kind(config), want, bits)
            kinds[want] = kinds.get(want, 0) + 1
        # Counted by hand from the classes: 2 empty or full; flat = 6 half
        # spaces (planes) + 12 x 2 quarter/three-quarter spaces (creases) =
        # 30. The rest split between vertices and non-manifold points; both
        # must occur, and the critical ones include the 6 x 2 x 2 = 24 with
        # two cells sharing only an edge alone (plus their inverses) and the
        # 4 x 2 antipodal pairs.
        self.assertEqual(kinds["none"], 2)
        self.assertEqual(kinds["flat"], 30)
        self.assertGreater(kinds["vertex"], 0)
        self.assertGreaterEqual(kinds["nonmanifold"], 2 * 12 + 2 * 4)


def random_solid(rng, span=6):
    """One to three integer boxes in [0, span]^3, touching or overlapping
    each other so they are usually one body (refused inputs are skipped)."""
    boxes = []
    for _ in range(rng.randint(1, 3)):
        lo = [rng.randint(0, span - 1) for _ in range(3)]
        hi = [rng.randint(l + 1, span) for l in lo]
        boxes.append(box(*lo, *hi))
    return boxes


def voxels(boxes):
    """Unit voxels covered by integer boxes: an independent rasterisation."""
    out = set()
    for b in boxes:
        out.update(product(*(range(int(b[a]), int(b[a + 3])) for a in range(3))))
    return out


def voxel_answer(op, a, b):
    va, vb = voxels(a), voxels(b)
    cells = {"union": va | vb, "subtract": va - vb, "intersect": va & vb}[op]
    area = sum(1 for c in cells for d in product((-1, 1), range(3))
               if tuple(c[i] + (d[0] if i == d[1] else 0) for i in range(3)) not in cells)
    return len(cells), area


def holed_pair(rng, span=6):
    """A box A and a tool B inside it (a void when subtracted) or through it
    along one axis (a hole, genus 1), so voids and holes come up often."""
    a = box(0, 0, 0, span, span, span)
    lo = [rng.randint(1, span - 2) for _ in range(3)]
    hi = [rng.randint(l + 1, span - 1) for l in lo]
    if rng.random() < 0.5:
        axis = rng.randrange(3)
        lo[axis], hi[axis] = -1, span + 1
    return [a], [box(*lo, *hi)]


def seeded_pairs(seed, n):
    rng = random.Random(seed)
    pairs = []
    while len(pairs) < n:
        a, b = holed_pair(rng) if rng.random() < 0.2 else (random_solid(rng), random_solid(rng))
        try:
            box_model.check_input("A", box_model.Grid([a, b]), box_model.Grid([a, b]).cells(a))
            box_model.check_input("B", box_model.Grid([a, b]), box_model.Grid([a, b]).cells(b))
        except ModelError:
            continue
        pairs.append((a, b))
    return pairs


SEED = 30001  # FISSION_SEED style: decimal, recorded here so a failure replays


class Seeded(unittest.TestCase):
    def test_identities_and_voxels(self):
        for a, b in seeded_pairs(SEED, 150):
            r = {op: boolean(op, a, b) for op in box_model.OPS}

            def vol(x):
                return sum(body["volume"] for body in x["bodies"]) if x["outcome"] != "nonmanifold" else None

            # Volume and area against unit voxels, for every result with
            # bodies (non-manifold results have none to measure).
            for op, x in r.items():
                v, s = voxel_answer(op, a, b)
                if x["outcome"] in ("bodies", "thin"):
                    self.assertEqual(sum(body["volume"] for body in x["bodies"]), v, (op, a, b))
                    self.assertEqual(sum(body["area"] for body in x["bodies"]), s, (op, a, b))
                elif x["outcome"] == "empty":
                    self.assertEqual(v, 0)
            # vol(A u B) + vol(A n B) = vol A + vol B, by voxels when either
            # side is non-manifold.
            va, vb = len(voxels(a)), len(voxels(b))
            vu = vol(r["union"]) if vol(r["union"]) is not None else voxel_answer("union", a, b)[0]
            vi = vol(r["intersect"]) if vol(r["intersect"]) is not None else voxel_answer("intersect", a, b)[0]
            self.assertEqual(vu + vi, va + vb)
            # Union and intersect don't care about order.
            self.assertEqual(boolean("union", b, a), r["union"])
            self.assertEqual(boolean("intersect", b, a), r["intersect"])

    def test_moving_and_scaling(self):
        shift = (Fraction(7), Fraction(-3), Fraction(11, 2))
        k = Fraction(1, 1000)  # millimetres to micrometres
        for a, b in seeded_pairs(SEED + 1, 60):
            moved = lambda s: [tuple(c + shift[i % 3] for i, c in enumerate(x)) for x in s]  # noqa: E731
            scaled = lambda s: [tuple(c * k for c in x) for x in s]  # noqa: E731
            for op in box_model.OPS:
                r = boolean(op, a, b)
                m = boolean(op, moved(a), moved(b))
                self.assertEqual(m["outcome"], r["outcome"])
                self.assertEqual([number_dict(x) for x in m["bodies"]], [number_dict(x) for x in r["bodies"]])
                self.assertEqual([x["box"] for x in m["bodies"]], [tuple(c + shift[i % 3] for i, c in enumerate(x["box"])) for x in r["bodies"]])
                s = boolean(op, scaled(a), scaled(b))
                if r["outcome"] == "bodies" and s["outcome"] == "bodies":
                    for x, y in zip(s["bodies"], r["bodies"]):
                        self.assertEqual(x["volume"], y["volume"] * k ** 3)
                        self.assertEqual(x["area"], y["area"] * k ** 2)
                        self.assertEqual(x["faces"], y["faces"])
                # Shrunk to micrometres every side is at least 1 um, exactly
                # MIN_FEATURE, which builds (rule 1: at least MIN_FEATURE is
                # fine), so nothing becomes thin.
                if r["outcome"] == "bodies":
                    self.assertEqual(s["outcome"], "bodies")

    def test_feeding_back(self):
        # (A - B) u (A n B) = A, through the model's own result as boxes,
        # whenever both pieces are single valid bodies.
        checked = 0
        for a, b in seeded_pairs(SEED + 2, 80):
            grid = box_model.Grid([a, b])
            ca, cb = grid.cells(a), grid.cells(b)
            d, i = box_model.boxes_of(grid, ca - cb), box_model.boxes_of(grid, ca & cb)
            try:
                back = boolean("union", d, i)
            except ModelError:
                continue
            self.assertEqual([number_dict(x) for x in back["bodies"]], [number_dict(x) for x in solid(a)["bodies"]])
            checked += 1
        self.assertGreater(checked, 10)


class Planted(unittest.TestCase):
    """Each planted break in the model makes a test above fail."""

    def failing_hand_cases(self):
        bad = []
        for case in HAND:
            try:
                check_hand(case)
            except (AssertionError, ModelError) as e:
                bad.append((case[0], str(e)[:80]))
        return bad

    def test_manifold_rule_without_the_other_cells(self):
        # Checking only the result cells' connection misses inverse cases.
        real = box_model.connected
        with mock.patch.object(box_model, "point_kind", side_effect=lambda c: (
                "none" if sum(c.values()) in (0, 8) else
                "nonmanifold" if not real([o for o in OFFSETS if c[o]]) else
                "vertex")):
            mismatches = 0
            for bits in range(256):
                config = {o: bool(bits >> i & 1) for i, o in enumerate(OFFSETS)}
                if box_model.point_kind(config) != link_kind(config):
                    mismatches += 1
            self.assertGreater(mismatches, 0)

    def test_faces_never_merged(self):
        with mock.patch.object(box_model.Union, "join", lambda self, a, b: None):
            self.assertTrue(self.failing_hand_cases())

    def test_voids_forgotten(self):
        orig = box_model.Measured._bodies

        def no_voids(self):
            orig(self)
            for b in self.region_of:
                self.region_of[b] = {box_model.OUTSIDE}
        with mock.patch.object(box_model.Measured, "_bodies", no_voids):
            names = [n for n, _ in self.failing_hand_cases()]
        self.assertIn("hollow box", names)

    def test_rings_forgotten(self):
        with mock.patch.object(box_model.Measured, "_rings", lambda self: {f: 0 for f in set(self.face_of.values())}):
            names = [n for n, _ in self.failing_hand_cases()]
        self.assertIn("through hole", names)

    def test_vertices_on_straight_creases_counted(self):
        real = box_model.point_kind
        with mock.patch.object(box_model, "point_kind", lambda c: "vertex" if real(c) == "flat" else real(c)):
            self.assertTrue(self.failing_hand_cases())

    def test_thin_rule_off(self):
        with mock.patch.object(box_model, "MIN_FEATURE", Fraction(0)):
            self.assertNotEqual(Bands().step(MIN_FEATURE * Fraction(9, 10))["outcome"], "thin")
            self.assertNotEqual(Bands().wall(MIN_FEATURE * Fraction(9, 10))["outcome"], "thin")


if __name__ == "__main__":
    unittest.main()
