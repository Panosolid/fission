"""Tests for fuzz_shapes.py: python3 -m unittest discover -s prototypes/oracle -p 'test_*.py'
(needs mpmath; the OpenCascade half runs where cadquery-ocp is installed,
as in the nightly Fuzzing run). Expected values are worked out by hand in
the comments."""

import importlib.util
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))
import fuzz_shapes  # noqa: E402

HAVE_OCC = importlib.util.find_spec("OCP") is not None
EPS = 2.0 ** -52


def path(pts, bulges=()):
    return {"Path": {"pts": [[repr(x), repr(y)] for x, y in pts], "bulges": [repr(b) for b in bulges]}}


def case(shape, volume, area, faces, lo, hi, target="extrude"):
    return {"target": target, "input": "by hand", "shape": shape, "fission_volume": volume,
            "fission_area": area, "fission_faces": faces, "lo": lo, "hi": hi}


# A 2 x 3 rectangle extruded 4: V = 2*3*4 = 24, S = 2*6 + (2+3+2+3)*4 = 52,
# 2 caps + 4 sides = 6 faces.
RECT = {"Extrude": {"outer": path([(0.0, 0.0), (2.0, 0.0), (2.0, 3.0), (0.0, 3.0)]), "holes": [], "dist": "4.0"}}
RECT_CASE = case(RECT, 24.0, 52.0, 6, [0.0, 0.0, 0.0], [2.0, 3.0, 4.0])
# A box 1 x 2 x 3 moved so its far corner is at 3: V = 6, S = 2(2 + 3 + 6) = 22.
BOX = {"Box": {"w": "1.0", "d": "2.0", "h": "3.0"}}
BOX_CASE = case(BOX, 6.0, 22.0, 6, [0.0, 0.0, 0.0], [1.0, 2.0, 3.0], "placed")


class Allowed(unittest.TestCase):
    def test_how_far_it_reaches(self):
        # A 1 x 1 square centred on (1e7, 0) reaches x = 1e7 + 0.5; a
        # circle of radius 2 about (4e6, 1) reaches 4e6 + 2 (its centre
        # alone would say 4e6), and one about (-3, 0.5) reaches 5.
        sq = {"Extrude": {"outer": path([(1e7 - 0.5, -0.5), (1e7 + 0.5, -0.5), (1e7 + 0.5, 0.5), (1e7 - 0.5, 0.5)]), "holes": [], "dist": "1.0"}}
        self.assertEqual(fuzz_shapes.reach(sq), 1e7 + 0.5)
        ring = lambda c: {"Extrude": {"outer": {"Circle": {"c": [repr(c[0]), repr(c[1])], "r": "2.0"}}, "holes": [], "dist": "1.0"}}
        self.assertEqual(fuzz_shapes.reach(ring((4e6, 1.0))), 4e6 + 2)
        self.assertEqual(fuzz_shapes.reach(ring((-3.0, 0.5))), 5.0)

    def test_extrude_allowance_by_hand(self):
        # The rectangle reaches 3, so each coordinate's step is 64 EPS x 3.
        # Its two triangles from (0, 0) are 3 each (size 6), perimeter 10,
        # 4 pieces, d = 4. Volume: REL (24 + 6 x 4) + 10 x 4 x step.
        # Area: REL (52 + 2 x 6) + (2 x 10 + 2 x 4 x 4) step.
        step = 64 * EPS * 3
        v, a = fuzz_shapes.allowed(RECT_CASE, 24.0, 52.0)
        self.assertAlmostEqual(v / (48e-9 + 40 * step), 1.0, places=12)
        self.assertAlmostEqual(a / (64e-9 + 52 * step), 1.0, places=12)

    def test_moved_box_allowance_by_hand(self):
        # REL x 6 + 22 x 64 EPS x 3 (it reaches 3); area: REL x 22 plus its
        # twelve edges, 4 (1 + 2 + 3) = 24, x 64 EPS x 3.
        v, a = fuzz_shapes.allowed(BOX_CASE, 6.0, 22.0)
        self.assertAlmostEqual(v / (6e-9 + 22 * 64 * EPS * 3), 1.0, places=12)
        self.assertAlmostEqual(a / (22e-9 + 24 * 64 * EPS * 3), 1.0, places=12)


class ExactChecks(unittest.TestCase):
    """Panosolid against the exact values, OpenCascade left out."""

    def test_the_right_numbers_pass(self):
        self.assertEqual(fuzz_shapes.check(RECT_CASE), ([], []))
        self.assertEqual(fuzz_shapes.check(BOX_CASE), ([], []))

    def test_at_the_edge_of_the_allowance(self):
        # 0.9x the allowance off passes, 1.1x fails, either way off.
        for c, v, a in ((RECT_CASE, 24.0, 52.0), (BOX_CASE, 6.0, 22.0)):
            vs, as_ = fuzz_shapes.allowed(c, v, a)
            for k, ok in ((0.9, True), (1.1, False)):
                for sign in (1, -1):
                    issues = fuzz_shapes.check({**c, "fission_volume": v + sign * k * vs})[0]
                    self.assertEqual(issues == [], ok, (c["target"], k, sign, issues))
                    issues = fuzz_shapes.check({**c, "fission_area": a + sign * k * as_})[0]
                    self.assertEqual(issues == [], ok, (c["target"], k, sign, issues))

    def test_a_planted_volume_error_is_named(self):
        issues = fuzz_shapes.check({**RECT_CASE, "fission_volume": 24.000024})[0]
        self.assertEqual(len(issues), 1)
        self.assertTrue(issues[0].startswith("volume: fission 24.000024"), issues)

    def test_nan_is_never_close(self):
        self.assertTrue(fuzz_shapes.check({**RECT_CASE, "fission_area": float("nan")})[0])


@unittest.skipUnless(HAVE_OCC, "needs cadquery-ocp")
class WithOpenCascade(unittest.TestCase):
    def setUp(self):
        import compare
        self.occ = compare

    def test_the_rectangle_agrees(self):
        self.assertEqual(fuzz_shapes.check(RECT_CASE, self.occ), ([], []))
        self.assertEqual(fuzz_shapes.check(BOX_CASE, self.occ), ([], []))

    def test_a_wrong_face_count_or_bounds_is_named(self):
        issues = fuzz_shapes.check({**RECT_CASE, "fission_faces": 5}, self.occ)[0]
        self.assertTrue(any(i.startswith("faces: fission 5, occ 6") for i in issues), issues)
        # Each of the six bounds is compared, the highest ones too.
        for k, name in enumerate(["lowest x", "lowest y", "lowest z", "highest x", "highest y", "highest z"]):
            box = RECT_CASE["lo"] + RECT_CASE["hi"]
            box[k] += 0.01
            issues = fuzz_shapes.check({**RECT_CASE, "lo": box[:3], "hi": box[3:]}, self.occ)[0]
            self.assertEqual([i.split(":")[0] for i in issues], [f"bounds {name}"], issues)

    def test_a_crossing_the_kernel_accepted_is_a_finding(self):
        # A bow tie, as though the kernel had built it: the diagonals cross
        # at (1, 1). V and S here are its exact ones (two triangles of area
        # 1 each, so 2 x 1; sides 2 + 2 + 2 sqrt 2 times 1), so only
        # validity is wrong.
        tie = {"Extrude": {"outer": path([(0.0, 0.0), (2.0, 2.0), (2.0, 0.0), (0.0, 2.0)]), "holes": [], "dist": "1.0"}}
        issues = fuzz_shapes.check(case(tie, 0.0, 0.0, 6, [0.0] * 3, [2.0, 2.0, 1.0]), self.occ)[0]
        self.assertTrue(any(i.startswith("validity: loop 0 piece 0 meets loop 0 piece 2 at (1.0, 1.0)") for i in issues), issues)

    def test_an_occ_false_alarm_is_not_counted(self):
        # Sketch seed 468: a 0.02 degree corner between half circles of
        # 14 m and 93 mm. OpenCascade's check calls it self-intersecting;
        # crossings.py finds no point where two pieces meet.
        shape = {"Extrude": {"outer": path([(28750.0, -10.0), (187.5, 0.0), (1.1, 0.0)], [1.0000000000001157, 1.0, 1.0]), "holes": [], "dist": "1.0"}}
        import exact
        v, a = exact.volume_area(shape)
        issues, occ_only = fuzz_shapes.check(case(shape, float(v), float(a), 5, [0.0] * 3, [0.0] * 3, "sketch"), self.occ)
        self.assertEqual([i for i in issues if not i.startswith("bounds")], [])
        self.assertIn("validity: occ calls it invalid, but no two pieces meet at 50 digits", occ_only)


HERE = os.path.dirname(__file__)


def read(*parts):
    with open(os.path.join(HERE, *parts)) as f:
        return f.read()


def flip_first_face(text):
    """The planted fault FISSION_STEP_FAULT makes (kernel/tests/support/step_file.rs):
    the first ADVANCED_FACE's same_sense swapped."""
    lines = text.split("\n")
    k = next(i for i, l in enumerate(lines) if "= ADVANCED_FACE(" in l)
    head, sense = lines[k][:-len(".T.);")], lines[k][-len(".T.);"):]
    lines[k] = head + (".F.);" if sense == ".T.);" else ".T.);")
    return "\n".join(lines)


def regression(name):
    import json
    return {**json.loads(read("regressions", name + ".json")), "step": read("regressions", name + ".step")}


@unittest.skipUnless(HAVE_OCC, "needs cadquery-ocp")
class StepFiles(unittest.TestCase):
    """Step 29b3: each fuzz body's STEP file, judged as compare.py judges
    the stateful harness's (`step_issues`)."""

    def setUp(self):
        import compare
        self.occ = compare
        # A unit square extruded 1 is the unit cube: V = 1, S = 6, six
        # faces, and its file the hand-checked kernel/tests/step/unit_cube.step.
        square = {"Extrude": {"outer": path([(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)]), "holes": [], "dist": "1.0"}}
        self.cube = {**case(square, 1.0, 6.0, 6, [0.0] * 3, [1.0] * 3), "step": read("..", "..", "kernel", "tests", "step", "unit_cube.step"),
                     "step_refused": None}

    def test_the_unit_cubes_file_agrees(self):
        self.assertEqual(fuzz_shapes.check(self.cube, self.occ), ([], []))

    def test_a_flipped_face_or_a_refusal_is_a_finding(self):
        issues = fuzz_shapes.check({**self.cube, "step": flip_first_face(self.cube["step"])}, self.occ)[0]
        self.assertTrue(issues and all(i.startswith("step ") and i.endswith("(extrude: by hand)") for i in issues), issues)
        self.assertTrue(any(i.startswith("step validity: BRepCheck") for i in issues), issues)
        issues = fuzz_shapes.check({**self.cube, "step": None, "step_refused": "a body of 2 shells"}, self.occ)[0]
        self.assertEqual(issues, ["step write refused: a body of 2 shells (extrude: by hand)"])

    def test_a_planted_fault_in_an_ordinary_part_with_a_tiny_hole_is_found(self):
        # Extrude seed 74: a 441 mm part, 3.125 thick, with a 7 µm hole.
        # Its file reads valid; with its first cap planted flipped,
        # OpenCascade's area is 6,095 for the exact 580,809, which a hole of
        # radius 0.007 could account for at most 3 x (2 pi 0.007 L + 2 pi
        # 0.007^2), about 63 mm^2 with L the 445 mm diagonal: a finding,
        # where a radius under SMALL_FEATURE once excused anything.
        good = regression("small-hole-441mm-part")
        self.assertEqual(fuzz_shapes.check(good, self.occ)[0], [])
        issues, occ_only = fuzz_shapes.check({**good, "step": flip_first_face(good["step"])}, self.occ)
        self.assertTrue(any(i.startswith("step area:") for i in issues), issues)
        self.assertFalse(any(self.occ.SMALL_LIMIT in o for o in occ_only), occ_only)

    def test_opencascades_own_invalid_rebuild_excuses_its_verdict_on_the_file_only(self):
        # Sketch seed 720: a near-full arc of radius 110 m beside two half
        # circles, nearly tangent. OpenCascade calls its own rebuild invalid
        # though no two pieces meet at 50 digits, and calls the file's cap
        # invalid too: its tolerance, listed. Planted flipped, the file's
        # area is still wrong (692,548 for 7.6e10), so the fault is found.
        good = regression("near-tangent-110m-arc")
        issues, occ_only = fuzz_shapes.check(good, self.occ)
        self.assertEqual(issues, [])
        self.assertTrue(any(o.startswith(self.occ.OCC_TOLERANCE + ": step validity") for o in occ_only), occ_only)
        issues = fuzz_shapes.check({**good, "step": flip_first_face(good["step"])}, self.occ)[0]
        self.assertTrue(any(i.startswith("step area:") for i in issues), issues)
        self.assertFalse(any(i.startswith("step validity") for i in issues), issues)


if __name__ == "__main__":
    unittest.main()
