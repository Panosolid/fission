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


STEP = os.path.join(os.path.dirname(__file__), "..", "..", "kernel", "tests", "step")


def cube_case(step):
    """The oracle's line for a 1 x 1 x 1 box at the origin with `step` as
    its file: V = 1, S = 6, six faces, a mesh exactly the box."""
    return {"shape": {"Box": {"w": "1.0", "d": "1.0", "h": "1.0"}}, "matrix": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0],
            "faces": 6, "lo": [0.0, 0.0, 0.0], "hi": [1.0, 1.0, 1.0], "max_deviation": 0.0,
            "volume_slack": 0.0, "area_slack": 0.0, "exact_volume": 1.0, "exact_area": 6.0, "volume": 1.0, "area": 6.0,
            "step": step, "step_refused": None}


def cube_text():
    # The hand-checked file (kernel/tests/step/unit_cube.step), which the
    # kernel's tests hold equal to what the writer writes for make_box(1, 1, 1).
    with open(os.path.join(STEP, "unit_cube.step")) as f:
        return f.read()


def edit_points(t, f):
    """`t` with every CARTESIAN_POINT's coordinates (x, y, z) -> f(x, y, z)."""
    import re
    import step_check
    def one(m):
        x, y, z = f(*(float(m.group(k)) for k in (2, 3, 4)))
        return f"#{m.group(1)} = CARTESIAN_POINT('',({step_check._part21(x)},{step_check._part21(y)},{step_check._part21(z)}));"
    out, n = step_check.POINT.subn(one, t)
    assert n > 0
    return out


def kinds(issues):
    return sorted({i.split(":")[0] for i in issues})


@unittest.skipUnless(importlib.util.find_spec("OCP") is not None and importlib.util.find_spec("mpmath") is not None,
                     "needs cadquery-ocp and mpmath")
class StepFiles(unittest.TestCase):
    """compare.py's checks of each body's STEP file (step 29b, `step_issues`)."""

    def test_the_unit_cube_file_agrees(self):
        # By hand: the file is the unit cube, so OpenCascade reads it valid,
        # with six faces, volume 1 and area 6, and the exact referee's
        # values are 1 and 6: nothing to report.
        import compare
        self.assertEqual(compare.compare(cube_case(cube_text()))[1:], ([], []))

    def test_a_flipped_face_is_reported(self):
        # The planted fault FISSION_STEP_FAULT makes: the first face's
        # same_sense swapped (kernel/tests/stateful.rs, flip_first_face).
        import compare
        t = cube_text()
        bad = t.replace("#101 = ADVANCED_FACE('',(#100),#94,.T.);", "#101 = ADVANCED_FACE('',(#100),#94,.F.);")
        self.assertNotEqual(bad, t)
        issues = compare.compare(cube_case(bad))[1]
        self.assertIn("step validity", kinds(issues), issues)
        self.assertTrue(any("BRepCheck" in i for i in issues), issues)

    def test_a_refusal_is_reported(self):
        import compare
        case = {**cube_case(None), "step_refused": "the body is invalid: face 0 ..."}
        self.assertEqual(kinds(compare.compare(case)[1]), ["step write refused"])

    def test_a_line_from_before_step_files_is_still_compared(self):
        import compare
        case = cube_case(None)
        del case["step"], case["step_refused"]
        self.assertEqual(compare.compare(case)[1:], ([], []))

    def test_faces_other_than_the_kernels_are_reported(self):
        # The kernel says seven faces; the file (and OpenCascade's rebuild)
        # has six. Both checks see it.
        import compare
        issues = compare.compare({**cube_case(cube_text()), "faces": 7})[1]
        self.assertEqual(kinds(issues), ["faces", "step faces"], issues)
        self.assertIn("step faces: OpenCascade read 6, the kernel has 7 (as written)", issues)

    def taller(self, d, volume_slack, area_slack):
        # The cube with its top lifted by d (every point at z = 1 moved to
        # z = 1 + d, the top face's plane among them): a valid 1 x 1 x (1+d)
        # box, volume 1 + d and area 6 + 4d, against the exact referee's
        # 1 and 6 for the unit cube. Only the file is changed, so only the
        # step checks can see it.
        import compare
        t = edit_points(cube_text(), lambda x, y, z: (x, y, 1 + d if z == 1.0 else z))
        case = {**cube_case(t), "volume_slack": volume_slack, "area_slack": area_slack}
        return compare.compare(case)[1:]

    def test_a_volume_off_by_09_of_the_slack_passes(self):
        # Off by d = 1e-3; allowed d / 0.9 (plus REL, 1e-9: far below the
        # margin of 1.1e-4). The area, 4d off, is given room to spare.
        self.assertEqual(self.taller(1e-3, 1e-3 / 0.9, 1.0), ([], []))

    def test_a_volume_off_by_11_of_the_slack_fails(self):
        issues, occ = self.taller(1e-3, 1e-3 / 1.1, 1.0)
        self.assertEqual(kinds(issues), ["step volume"], issues)
        self.assertEqual(occ, [])

    def test_an_area_off_by_09_of_the_slack_passes(self):
        self.assertEqual(self.taller(1e-3, 1.0, 4e-3 / 0.9), ([], []))

    def test_an_area_off_by_11_of_the_slack_fails(self):
        issues, _ = self.taller(1e-3, 1.0, 4e-3 / 1.1)
        self.assertEqual(kinds(issues), ["step area"], issues)

    def test_far_out_is_measured_moved_home(self):
        # The cube moved 100 km along x: corners at x = 100000 and 100001,
        # so the shift is their middle, 100000.5, farther out than the
        # cube's size (1); y and z span 0..1 with middles 0.5, not farther
        # out than 1, so they stay. Every x then becomes 100000 - 100000.5
        # = -0.5 or 100001 - 100000.5 = 0.5, exactly (Sterbenz), and the
        # representation's origin 0 becomes -100000.5, also exact.
        import compare
        import step_check
        t = edit_points(cube_text(), lambda x, y, z: (x + 100000.0, y, z))
        moved, shift = step_check.home(t)
        self.assertEqual(shift, (100000.5, 0.0, 0.0))
        self.assertIn("CARTESIAN_POINT('',(-0.5,0.0,0.0))", moved)
        self.assertIn("CARTESIAN_POINT('',(0.5,1.0,1.0))", moved)
        r = step_check.check_text(moved)
        self.assertTrue(r.ok, r.problems)
        self.assertLessEqual(abs(r.volume - 1.0), compare.REL)
        self.assertLessEqual(abs(r.area - 6.0), 6 * compare.REL)
        case = {**cube_case(t), "matrix": [1, 0, 0, 100000.0, 0, 1, 0, 0, 0, 0, 1, 0],
                "lo": [100000.0, 0.0, 0.0], "hi": [100001.0, 1.0, 1.0]}
        self.assertEqual(compare.compare(case)[1:], ([], []))

    def test_a_shift_that_would_round_is_not_made(self):
        # The same far cube with the representation's origin (not part of
        # the solid) at x = 0.1: 0.1 - 100000.5 isn't a double, so moving x
        # would round that point, and x is left alone.
        import step_check
        t = edit_points(cube_text(), lambda x, y, z: (x + 100000.0, y, z))
        origin = "#164 = CARTESIAN_POINT('',(100000.0,0.0,0.0));"
        self.assertIn(origin, t)
        _, shift = step_check.home(t.replace(origin, "#164 = CARTESIAN_POINT('',(0.1,0.0,0.0));"))
        self.assertEqual(shift, (0.0, 0.0, 0.0))

    def test_a_part_near_home_is_not_moved(self):
        # The unit cube spans 0..1 on every axis, middles 0.5, none farther
        # out than its size: nothing to win, so no shift.
        import step_check
        self.assertEqual(step_check.home(cube_text()), (cube_text(), (0.0, 0.0, 0.0)))


def cylinder_text(r, h, off=0.0):
    """kernel/tests/step/cylinder_r2_h3.step (radius 2, height 3, axis z
    from the origin) made radius r and height h, its top circle's centre
    (and its vertex) moved off the axis by `off` along y, at right angles
    to the line from the centre to the vertex."""
    import step_check
    P = step_check._part21
    with open(os.path.join(STEP, "cylinder_r2_h3.step")) as f:
        t = f.read()
    for old, new in (("#14 = CARTESIAN_POINT('',(2.0,0.0,0.0));", f"#14 = CARTESIAN_POINT('',({P(r)},0.0,0.0));"),
                     ("#16 = CARTESIAN_POINT('',(2.0,0.0,3.0));", f"#16 = CARTESIAN_POINT('',({P(r)},{P(off)},{P(h)}));"),
                     ("#24 = CARTESIAN_POINT('',(0.0,0.0,3.0));", f"#24 = CARTESIAN_POINT('',(0.0,{P(off)},{P(h)}));"),
                     ("#39 = CARTESIAN_POINT('',(0.0,0.0,3.0));", f"#39 = CARTESIAN_POINT('',(0.0,0.0,{P(h)}));"),
                     ("#22 = CIRCLE('',#21,2.0);", f"#22 = CIRCLE('',#21,{P(r)});"),
                     ("#28 = CIRCLE('',#27,2.0);", f"#28 = CIRCLE('',#27,{P(r)});"),
                     ("#52 = CYLINDRICAL_SURFACE('',#51,2.0);", f"#52 = CYLINDRICAL_SURFACE('',#51,{P(r)});")):
        assert t.count(old) == 1, old
        t = t.replace(old, new)
    return t


def cylinder_case(r, h, step):
    """The oracle's line for that cylinder: V = pi r^2 h, S = 2 pi r (r + h),
    three faces, a mesh given the exact numbers (the step checks are under
    test, not the mesh)."""
    import math
    v, a = math.pi * r * r * h, 2 * math.pi * r * (r + h)
    return {"shape": {"Cylinder": {"r": repr(r), "h": repr(h)}}, "matrix": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0],
            "faces": 3, "lo": [-r, -r, 0.0], "hi": [r, r, h], "max_deviation": 0.0,
            "volume_slack": 0.0, "area_slack": 0.0, "exact_volume": v, "exact_area": a, "volume": v, "area": a,
            "step": step, "step_refused": None}


def flipped_side(t):
    # The side's normal flipped, pointing in to the axis (test_step_check.py's
    # test_a_curved_face_with_its_normal_flipped).
    old = "#59 = ADVANCED_FACE('',(#55,#58),#52,.T.);"
    assert t.count(old) == 1
    return t.replace(old, "#59 = ADVANCED_FACE('',(#55,#58),#52,.F.);")


@unittest.skipUnless(importlib.util.find_spec("OCP") is not None and importlib.util.find_spec("mpmath") is not None,
                     "needs cadquery-ocp and mpmath")
class SmallFeatures(unittest.TestCase):
    """Bodies with radii of a few µm, which OpenCascade misreads unless blown
    up (`step_check.scaled`), and its limit beyond that."""

    def test_blown_up_by_hand(self):
        # Radius 0.001: 0.001 x 512 = 0.512 is under 1 mm, 0.001 x 1024 =
        # 1.024 isn't, so the factor is 1024. The vertex (0.001, 0, 0) becomes
        # (1.024, 0, 0), the height 3 becomes 3072, the uncertainty 1e-5
        # becomes 0.01024. Volume pi r^2 h = 3e-6 pi and area
        # 2 pi r (r + h) = 2 pi 0.001 x 3.001 = 0.006002 pi, given back in
        # the body's own units.
        import math
        import compare
        import step_check
        t, f = step_check.scaled(cylinder_text(0.001, 3.0))
        self.assertEqual(f, 1024.0)
        self.assertIn("#14 = CARTESIAN_POINT('',(1.024,0.0,0.0));", t)
        self.assertIn("#16 = CARTESIAN_POINT('',(1.024,0.0,3072.0));", t)
        self.assertIn("#52 = CYLINDRICAL_SURFACE('',#51,1.024);", t)
        self.assertIn("LENGTH_MEASURE(0.01024)", t)
        r = step_check.check_text(t, f)
        self.assertTrue(r.ok, r.problems)
        self.assertLessEqual(abs(r.volume - 3e-6 * math.pi), compare.REL * 3e-6 * math.pi)
        self.assertLessEqual(abs(r.area - 0.006002 * math.pi), compare.REL * 0.006002 * math.pi)

    def test_nothing_to_blow_up(self):
        # Smallest radius 2 mm (and a box has none): the file as it is.
        import step_check
        t = cylinder_text(2.0, 3.0)
        self.assertEqual(step_check.scaled(t), (t, 1.0))
        self.assertEqual(step_check.scaled(cube_text()), (cube_text(), 1.0))

    def test_a_1_um_cylinder_off_axis_by_rounding_is_read_blown_up(self):
        # Found by 29b2's first run (seed 12345): a cylinder of radius 1 µm
        # whose top circle's centre sits 3e-9 mm off the axis, 3,000 times
        # inside LINEAR. As written OpenCascade calls it invalid (if this
        # assertion starts failing, OpenCascade got better at it); blown up
        # 1024 times it is valid with the exact volume, so compare passes
        # it and lists the as-written miss with OpenCascade's rounding.
        import compare
        import step_check
        t = cylinder_text(0.001, 35.5, 3e-9)
        self.assertFalse(step_check.check_text(t).ok)
        issues, occ = compare.compare(cylinder_case(0.001, 35.5, t))[1:]
        self.assertEqual(issues, [])
        self.assertTrue(any("passes blown up 1024 times" in o for o in occ), occ)

    def test_a_fault_under_the_small_feature_limit_is_listed_not_counted(self):
        # Radius 0.9 x SMALL_FEATURE (0.009 mm) with its side flipped: every
        # copy fails, and with a radius that small that is OpenCascade's
        # limit as far as the oracle can tell (the kernel's own validator
        # is what covers such a body).
        import compare
        r = 0.9 * compare.SMALL_FEATURE
        issues, occ = compare.compare(cylinder_case(r, 3.0, flipped_side(cylinder_text(r, 3.0))))[1:]
        self.assertEqual(issues, [])
        self.assertTrue(occ and all(compare.SMALL_LIMIT in o for o in occ), occ)

    def test_a_fault_over_the_small_feature_limit_is_counted(self):
        # Radius 1.1 x SMALL_FEATURE (0.011 mm), side flipped: a finding.
        import compare
        r = 1.1 * compare.SMALL_FEATURE
        issues, occ = compare.compare(cylinder_case(r, 3.0, flipped_side(cylinder_text(r, 3.0))))[1:]
        self.assertIn("step validity", kinds(issues), issues)
        self.assertFalse(any(compare.SMALL_LIMIT in o for o in occ), occ)


if __name__ == "__main__":
    unittest.main()
