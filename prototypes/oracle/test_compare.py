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


def frame_text():
    """regressions/frame-10mm-hole-8mm.step, what kernel/src/step_write.rs
    writes for a 10 x 10 mm square with an 8 x 8 mm hole in its middle
    (corners (1, 1) to (9, 9)), extruded 1 mm along z."""
    with open(os.path.join(os.path.dirname(__file__), "regressions", "frame-10mm-hole-8mm.step")) as f:
        return f.read()


def frame_case(step, volume_slack=0.0):
    """The oracle's line for `frame_text`'s body: by hand, V = (100 - 64)
    x 1 = 36 and S = two caps of 36, four outer sides of 10 x 1 and four
    inner of 8 x 1: 72 + 40 + 32 = 144, ten faces."""
    square = lambda x0, s: [[repr(x0), repr(x0)], [repr(x0 + s), repr(x0)], [repr(x0 + s), repr(x0 + s)], [repr(x0), repr(x0 + s)]]
    shape = {"Extrude": {"dist": "1.0", "expect": True, "outer": {"Path": {"bulges": [], "pts": square(0.0, 10.0)}},
                         "holes": [{"Path": {"bulges": [], "pts": square(1.0, 8.0)[::-1]}}]}}
    return {"shape": shape, "matrix": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0], "faces": 10,
            "lo": [0.0, 0.0, 0.0], "hi": [10.0, 10.0, 1.0], "max_deviation": 0.0,
            "volume_slack": volume_slack, "area_slack": 1.0, "curve_volume_slack": 0.0, "curve_area_slack": 0.0,
            "exact_volume": 36.0, "exact_area": 144.0, "volume": 36.0, "area": 144.0,
            "step": step, "step_refused": None}


@unittest.skipUnless(importlib.util.find_spec("OCP") is not None and importlib.util.find_spec("mpmath") is not None,
                     "needs cadquery-ocp and mpmath")
class CancellingLoops(unittest.TestCase):
    """Room for OpenCascade's rounding on flat faces whose holes nearly
    fill them (#282: `step_check.cancelled_area`, `compare.cancelled_room`),
    always listed under CANCELLED_LOOPS, never counted or dropped."""

    def test_a_frames_cancelled_area_by_hand(self):
        # Each cap: its outline 10 x 10 = 100 and its hole 8 x 8 = 64 add
        # up to 164; the face is 36; 164 - 36 = 128 cancels. Two caps: 256.
        # The eight sides have one loop each, so nothing; nor has the cube.
        import step_check
        self.assertEqual(step_check.check_text(frame_text()).cancelled, 256.0)
        self.assertEqual(step_check.check_text(cube_text()).cancelled, 0.0)

    def lifted(self, k):
        # The frame's top lifted by d (every z = 1 moved to 1 + d): a valid
        # frame 1 + d tall, volume 36 + 36 d, against the referee's 36.
        # With volume slack s the room is 256 x s / 144 (area 144), so s
        # is set to make slack + REL x 36 + room = (36 d) / k.
        import compare
        d = 1e-3 / 36.0
        miss = 36.0 * d
        s = (miss / k - compare.REL * 36.0) / (1.0 + 256.0 / 144.0)
        t = edit_points(frame_text(), lambda x, y, z: (x, y, 1.0 + d if z == 1.0 else z))
        return compare.compare(frame_case(t, s))[1:]

    def test_a_miss_of_09_of_the_room_is_listed_not_counted(self):
        import compare
        issues, occ = self.lifted(0.9)
        self.assertEqual(issues, [])
        self.assertTrue(any(compare.CANCELLED_LOOPS in o and "step volume" in o for o in occ), occ)

    def test_a_miss_of_11_of_the_room_is_a_finding(self):
        import compare
        issues, occ = self.lifted(1.1)
        self.assertEqual(kinds(issues), ["step volume"], issues)
        self.assertFalse(any(compare.CANCELLED_LOOPS in o for o in occ), occ)

    def test_a_hole_walked_the_wrong_way_gets_no_room(self):
        # The bottom cap's hole bound turned (.T. to .F.): its loops then
        # add up (100 + 64) instead of cancelling, so that face gives no
        # room (only the top cap's 128 is left), and OpenCascade reads the
        # face invalid, the volume 21.3 off and the area 272 for 144: all
        # found, however much room the slack would give.
        import compare
        import step_check
        bad = frame_text().replace("#182 = FACE_BOUND('',#181,.T.);", "#182 = FACE_BOUND('',#181,.F.);")
        self.assertNotEqual(bad, frame_text())
        self.assertEqual(step_check.check_text(bad).cancelled, 128.0)
        issues, occ = compare.compare(frame_case(bad, 1e-6))[1:]
        self.assertEqual(kinds(issues), ["step area", "step validity", "step volume"], issues)

    def test_issue_282_thin_frame_is_listed_not_counted(self):
        # Seed 101725249063004, line 3032 (nightly, 29b2's branch, and on
        # main 684b681): a 60 x 62 mm frame 0.0011 mm wide and 0.001091 mm
        # tall, turned and placed ~800 mm out. The kernel's volume is the
        # exact one (8.5e-16 apart); OpenCascade reads the file 4.8e-11
        # off, 3.7 times the slack of 1.3e-11. Its caps' loops (3,720 and
        # 3,719.73 mm2) cancel 14,879 mm2, room 1.8e-7.
        import json
        import compare
        here = os.path.join(os.path.dirname(__file__), "regressions", "thin-frame-60mm")
        with open(here + ".json") as f:
            case = json.load(f)
        with open(here + ".step") as f:
            case["step"] = f.read()
        issues, occ = compare.compare(case)[1:]
        self.assertEqual(issues, [])
        self.assertTrue(any(compare.CANCELLED_LOOPS in o for o in occ), occ)


SHARP_SHAPE = {"Extrude": {"dist": "1.0", "holes": [], "outer": {"Path": {
    "bulges": ["40.01986857113923", "1.0555288956816682", "1.0", "1.0"],
    "pts": [["-231250.0", "-0.0"], ["-231251.0", "-62.5"], ["-62.5", "-625.0"], ["-6875.0", "0.0"]]}}}}


def sharp_text():
    """regressions/sharp-corner-arc.step: what the writer writes for
    SHARP_SHAPE (#293, nightly fuzzing at 684b681, sketch corpus line 803)."""
    with open(os.path.join(os.path.dirname(__file__), "regressions", "sharp-corner-arc.step")) as f:
        return f.read()


@unittest.skipUnless(importlib.util.find_spec("OCP") is not None and importlib.util.find_spec("mpmath") is not None,
                     "needs cadquery-ocp and mpmath")
class SharpCorners(unittest.TestCase):
    """OpenCascade calling a loop crossed at a sharp corner that never
    crosses (#293: `step_check.crossing_only`, `compare.never_crosses`),
    listed under SHARP_CORNER, never counted or dropped."""

    def judge(self, text, shape=SHARP_SHAPE):
        import compare
        import exact
        _, solid, _ = compare.build(shape)
        rebuilt = compare.measure(solid)[:2]
        ref = tuple(float(x) for x in exact.volume_area(shape))
        return compare.step_issues({"shape": shape, "faces": 6, "step": text, "step_refused": None},
                                   rebuilt, ref, (1e-6 * ref[0], 1e-6 * ref[1]))

    def test_issue_293_is_listed_not_counted(self):
        # The arcs of radius 625.78 and 115,763 leave their shared corner
        # (-231251, -62.5) 0.545 degrees apart. Their circles' other
        # meeting point is 11.8 mm away and on neither arc (worked at 50
        # digits in #293), and no other pieces meet: OpenCascade calls the
        # bottom cap's loop crossed, and that is all it calls wrong.
        import compare
        import step_check
        r = step_check.check_text(sharp_text())
        self.assertFalse(r.ok)
        self.assertTrue(r.crossing_only)
        self.assertTrue(compare.never_crosses(SHARP_SHAPE))
        issues, occ = self.judge(sharp_text())
        self.assertEqual(issues, [])
        self.assertTrue(occ and all(compare.SHARP_CORNER in o for o in occ), occ)

    def test_its_verdict_flips_with_one_unit_in_the_last_place(self):
        # Why it is OpenCascade's rounding: the big arc's radius two doubles
        # up reads valid, one double up invalid; both pass the oracle.
        import math
        import step_check
        r = 115763.43219960624
        up1, up2 = math.nextafter(r, math.inf), math.nextafter(math.nextafter(r, math.inf), math.inf)
        one = sharp_text().replace(repr(r), repr(up1))
        two = sharp_text().replace(repr(r), repr(up2))
        self.assertFalse(step_check.check_text(one).ok)
        self.assertTrue(step_check.check_text(two).ok)  # if this fails, OpenCascade's rounding moved
        self.assertEqual(self.judge(one)[0], [])
        self.assertEqual(self.judge(two)[0], [])

    def test_a_flipped_face_on_it_is_counted(self):
        # The planted fault (the first face's same_sense swapped): other
        # checks fail too, so it is not only a crossing.
        import step_check
        old = "#109 = ADVANCED_FACE('',(#108),#102,.T.);"
        bad = sharp_text().replace(old, old.replace(".T.);", ".F.);"))
        self.assertNotEqual(bad, sharp_text())
        self.assertFalse(step_check.check_text(bad).crossing_only)
        self.assertIn("step validity", kinds(self.judge(bad)[0]))

    def test_a_loop_walked_backwards_is_counted(self):
        import re
        import step_check
        bound = re.search(r"#\d+ = FACE_BOUND\('',#\d+,\.T\.\);", sharp_text()).group(0)
        bad = sharp_text().replace(bound, bound.replace(".T.", ".F."))
        self.assertFalse(step_check.check_text(bad).crossing_only)
        self.assertIn("step validity", kinds(self.judge(bad)[0]))

    def test_a_real_crossing_is_never_excused(self):
        # By hand: corners (0,0), (2,2), (2,0), (0,2) walk a bow tie whose
        # first and third sides cross at (1,1).
        import compare
        bow = {"Extrude": {"dist": "1.0", "holes": [], "outer": {"Path": {"bulges": [],
               "pts": [["0.0", "0.0"], ["2.0", "2.0"], ["2.0", "0.0"], ["0.0", "2.0"]]}}}}
        self.assertFalse(compare.never_crosses(bow))
        self.assertFalse(compare.never_crosses({"Box": {"w": "1.0", "d": "1.0", "h": "1.0"}}))
        # The same file judged as if its profile crossed: counted.
        saved = compare.never_crosses
        compare.never_crosses = lambda shape: False
        try:
            self.assertIn("step validity", kinds(self.judge(sharp_text())[0]))
        finally:
            compare.never_crosses = saved


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
    """Bodies with radii of a few µm, which OpenCascade misreads: its
    small-feature limit."""

    def test_a_1_um_cylinder_off_axis_by_rounding_is_opencascades_limit(self):
        # Found by 29b2's first run (seed 12345): a cylinder of radius 1 µm
        # whose top circle's centre sits 3e-9 mm off the axis, 3,000 times
        # inside LINEAR. OpenCascade calls it invalid (if this assertion
        # starts failing, OpenCascade got better at it), so compare lists it
        # under the small-feature limit rather than counting it.
        import compare
        import step_check
        t = cylinder_text(0.001, 35.5, 3e-9)
        self.assertFalse(step_check.check_text(t).ok)
        issues, occ = compare.compare(cylinder_case(0.001, 35.5, t))[1:]
        self.assertEqual(issues, [])
        self.assertTrue(occ and all(compare.SMALL_LIMIT in o for o in occ), occ)

    def test_a_blown_up_copy_would_have_passed_a_planted_fault(self):
        # Why no copy is blown up. 29b2's planted-fault run in CI (seed
        # 60150794052458, 40 cases, FISSION_STEP_FAULT): a 1 µm cylinder
        # 761.89 mm long, turned and placed 50 km out, its bottom cap planted
        # flipped; the oracle's line is kept in regressions/. Moved home and
        # blown up 1024 times (every length and the uncertainty; exact),
        # OpenCascade called it valid, losing both caps, whose area
        # (2 pi r^2 = 6.3e-6 mm^2) hides in the slack of a body that far out
        # (0.069 mm^2). Neither as written nor moved home does it pass, and
        # compare lists it under the small-feature limit.
        import json
        import compare
        import step_check
        here = os.path.join(os.path.dirname(__file__), "regressions", "flipped-cap-1um-cylinder")
        with open(here + ".step") as f:
            bad = f.read()
        with open(here + ".json") as f:
            case = {**json.load(f), "step": bad}
        P, k = step_check._part21, 1024.0
        moved, _ = step_check.home(bad)
        big = step_check.POINT.sub(lambda m: f"#{m.group(1)} = CARTESIAN_POINT('',(" + ",".join(
            P(float(m.group(j)) * k) for j in (2, 3, 4)) + "));", moved)
        big = step_check.RADIUS.sub(lambda m: f"{m.group(1)}{P(float(m.group(2)) * k)});", big)
        big = big.replace("LENGTH_MEASURE(1.E-5)", f"LENGTH_MEASURE({P(1e-5 * k)})")
        r = step_check.check_text(big)
        self.assertTrue(r.ok, r.problems)  # the false pass, kept in view
        self.assertFalse(step_check.check_text(bad).ok)
        self.assertFalse(step_check.check_text(moved).ok)
        issues, occ = compare.compare(case)[1:]
        self.assertEqual(issues, [])
        self.assertFalse(any("passes" in o for o in occ), occ)
        self.assertTrue(occ and all(compare.SMALL_LIMIT in o for o in occ), occ)

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


@unittest.skipUnless(importlib.util.find_spec("OCP") is not None and importlib.util.find_spec("mpmath") is not None,
                     "needs cadquery-ocp and mpmath")
class SmallReach(unittest.TestCase):
    """How much a body's small features could hold (`small_reach`), which
    bounds what the small-feature limit may excuse (step 29b3)."""

    def test_a_1_um_cylinders_reach_by_hand(self):
        # Radius r = 0.001, height h = 35.5: the file has two CIRCLEs and a
        # CYLINDRICAL_SURFACE of radius r (three small features), and its
        # points span x 0..r, y 0, z 0..h, a diagonal L = sqrt(r^2 + h^2).
        # Each holds pi r^2 L of volume and 2 pi r L + 2 pi r^2 of area.
        import math
        import compare
        r, h = 0.001, 35.5
        L = math.sqrt(r * r + h * h)
        v, a = compare.small_reach(cylinder_text(r, h))
        self.assertAlmostEqual(v, 3 * math.pi * r * r * L, delta=1e-15)
        self.assertAlmostEqual(a, 3 * (2 * math.pi * r * L + 2 * math.pi * r * r), delta=1e-12)

    def test_no_small_feature_no_reach(self):
        import compare
        self.assertIsNone(compare.small_reach(cube_text()))  # no radius at all
        self.assertIsNone(compare.small_reach(cylinder_text(1.1 * compare.SMALL_FEATURE, 3.0)))
        self.assertIsNotNone(compare.small_reach(cylinder_text(0.9 * compare.SMALL_FEATURE, 3.0)))

    def judge(self, which, k):
        """A 9 µm cylinder 3 long, its side flipped (every copy fails), with
        the referee's `which` (0 volume, 1 area) set k times its small
        reach away from what OpenCascade reads, the other exactly what it
        reads, no slack, and the rebuild agreeing with the referee (no
        rounding excuse)."""
        import compare
        import step_check
        r = 0.9 * compare.SMALL_FEATURE
        t = flipped_side(cylinder_text(r, 3.0))
        got = step_check.check_text(t)
        self.assertFalse(got.ok)
        ref = [got.volume, got.area]
        ref[which] -= k * compare.small_reach(t)[which]
        return compare.step_issues(cylinder_case(r, 3.0, t), tuple(ref), tuple(ref), (0.0, 0.0))

    def test_a_miss_of_09_of_the_reach_is_the_limit(self):
        import compare
        for which in (0, 1):
            issues, occ = self.judge(which, 0.9)
            self.assertEqual(issues, [])
            self.assertTrue(occ and all(compare.SMALL_LIMIT in o for o in occ), occ)

    def test_a_miss_of_11_of_the_reach_is_a_finding(self):
        import compare
        for which, name in ((0, "step volume"), (1, "step area")):
            issues, occ = self.judge(which, 1.1)
            self.assertIn(name, kinds(issues), issues)
            self.assertFalse(any(compare.SMALL_LIMIT in o for o in occ), occ)

    def test_occ_invalid_excuses_the_checkers_verdict_and_nothing_else(self):
        # The unit cube with a face flipped: OpenCascade's checker calls it
        # invalid, and reads its area as 4 (the flipped face's 1 counted
        # against the other five, 5 - 1), not 6. Told OpenCascade's own
        # rebuild is invalid too, the verdict is listed under its
        # tolerance, but the area is still counted. Only against a referee
        # that agrees with what it read does nothing count.
        import compare
        import step_check
        bad = flip_cube_face(cube_text())
        read = step_check.check_text(bad)
        self.assertEqual(read.area, 4.0)
        issues, occ = compare.step_issues(cube_case(bad), (1.0, 6.0), (1.0, 6.0), (1e-12, 0.0), occ_invalid=True)
        self.assertEqual(kinds(issues), ["step area"], issues)
        self.assertTrue(any(o.startswith(compare.OCC_TOLERANCE + ": step validity") for o in occ), occ)
        issues, occ = compare.step_issues(cube_case(bad), (read.volume, 4.0), (read.volume, 4.0), (0.0, 0.0), occ_invalid=True)
        self.assertEqual(issues, [])
        self.assertTrue(occ and all(o.startswith(compare.OCC_TOLERANCE + ": step validity") for o in occ), occ)
        issues = compare.step_issues(cube_case(bad), (read.volume, 4.0), (read.volume, 4.0), (0.0, 0.0))[0]
        self.assertEqual(kinds(issues), ["step validity"], issues)


def flip_cube_face(t):
    old = "#101 = ADVANCED_FACE('',(#100),#94,.T.);"
    assert t.count(old) == 1
    return t.replace(old, "#101 = ADVANCED_FACE('',(#100),#94,.F.);")


if __name__ == "__main__":
    unittest.main()
