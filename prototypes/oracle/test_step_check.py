"""Tests for step_check.py: python3 -m unittest discover -s prototypes/oracle -p 'test_*.py'
(needs cadquery-ocp; skipped without it).

The files are the kernel's hand-checked ones (kernel/tests/step/, which the
kernel's step_write tests hold equal to what the writer writes), read as
they are for the hand-worked answers, and with one planted fault each,
made by editing the text, for the checks that must catch them."""

import importlib.util
import math
import os
import re
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(__file__))

STEP = os.path.join(os.path.dirname(__file__), "..", "..", "kernel", "tests", "step")
LINEAR = 1e-5
REL = 1e-9  # OpenCascade's mass integration of exact shapes (as compare.py)


def text(name):
    with open(os.path.join(STEP, name)) as f:
        return f.read()


def edit(t, old, new):
    """`t` with the one line `old` replaced, so a planted fault can't miss."""
    assert t.count(old) == 1, old
    return t.replace(old, new)


@unittest.skipUnless(importlib.util.find_spec("OCP") is not None, "needs cadquery-ocp")
class StepCheck(unittest.TestCase):
    def check(self, t):
        import step_check
        with tempfile.NamedTemporaryFile("w", suffix=".step", delete=False) as f:
            f.write(t)
        try:
            return step_check.check(f.name)
        finally:
            os.unlink(f.name)

    def assertFails(self, t, words):
        r = self.check(t)
        self.assertFalse(r.ok)
        self.assertTrue(any(words in p for p in r.problems), r.problems)

    def assertMass(self, r, volume, area, faces):
        self.assertTrue(r.ok, r.problems)
        self.assertLessEqual(abs(r.volume - volume), REL * volume, r.volume)
        self.assertLessEqual(abs(r.area - area), REL * area, r.area)
        self.assertEqual(r.faces, faces)

    # Hand-worked: what OpenCascade must find in each file.

    def test_unit_cube(self):
        # A 1 x 1 x 1 cube: volume 1, area 6 unit squares, six faces.
        self.assertMass(self.check(text("unit_cube.step")), 1.0, 6.0, 6)

    def test_cylinder(self):
        # r = 2, h = 3: volume pi r^2 h = 12 pi; area two caps pi r^2 = 4 pi
        # each plus the side 2 pi r h = 12 pi, 20 pi; three faces (OpenCascade
        # adds a seam edge to the side, not a face).
        self.assertMass(self.check(text("cylinder_r2_h3.step")), 12 * math.pi, 20 * math.pi, 3)

    def test_sphere(self):
        # r = 2: volume 4/3 pi r^3 = 32 pi / 3, area 4 pi r^2 = 16 pi, two halves.
        self.assertMass(self.check(text("sphere_r2.step")), 32 * math.pi / 3, 16 * math.pi, 2)

    # Planted faults, each made by changing the hand-checked text. Each
    # passes the kernel's own writer only if the kernel's validator missed
    # it, which is what this oracle is for.

    def test_a_face_with_its_normal_flipped(self):
        # The bottom face says its normal is the plane's axis reversed (+Z,
        # into the cube) while its loop still runs for -Z.
        self.assertFails(edit(text("unit_cube.step"), "#101 = ADVANCED_FACE('',(#100),#94,.T.);",
                              "#101 = ADVANCED_FACE('',(#100),#94,.F.);"), "BRepCheck")

    def turned_loop(self, t):
        # The bottom face's loop walked the other way: v0 v1 v3 v2.
        for k in (95, 96, 97, 98):
            line = re.search(rf"^#{k} = .*$", t, re.M).group(0)
            t = edit(t, line, line.replace(".T.)", ".X.)").replace(".F.)", ".T.)").replace(".X.)", ".F.)"))
        return edit(t, "#99 = EDGE_LOOP('',(#95,#96,#97,#98));", "#99 = EDGE_LOOP('',(#98,#97,#96,#95));")

    def test_a_loop_walked_the_wrong_way(self):
        # Its edges then run the same way as their neighbours' in the shell.
        self.assertFails(self.turned_loop(text("unit_cube.step")), "BRepCheck")

    def test_a_face_turned_over(self):
        # Normal and loop both reversed: the face as seen from inside, a
        # consistent face on its own but facing into the solid.
        t = edit(self.turned_loop(text("unit_cube.step")), "#101 = ADVANCED_FACE('',(#100),#94,.T.);",
                 "#101 = ADVANCED_FACE('',(#100),#94,.F.);")
        self.assertFails(t, "BRepCheck")

    def test_a_loop_out_of_order_is_a_blind_spot(self):
        # Two of the bottom loop's edges swapped: v0 v2, then v3 v1 before
        # v2 v3, so the loop as listed breaks at every corner. OpenCascade's
        # wires have no order (it walks them by their vertices), so it can't
        # see this: the kernel's own validator and step_write's read-back
        # test (every loop's coedges in order) are what cover it. Kept as a
        # test so a change in OpenCascade shows up.
        r = self.check(edit(text("unit_cube.step"), "#99 = EDGE_LOOP('',(#95,#96,#97,#98));",
                            "#99 = EDGE_LOOP('',(#95,#97,#96,#98));"))
        self.assertTrue(r.ok, r.problems)

    def test_a_missing_face(self):
        # The top face left out of the shell: an open box.
        self.assertFails(edit(text("unit_cube.step"), "#162 = CLOSED_SHELL('',(#101,#113,#125,#137,#149,#161));",
                              "#162 = CLOSED_SHELL('',(#101,#125,#137,#149,#161));"), "BRepCheck")

    def moved_corner(self, d):
        # v7 = (1, 1, 1) lifted by d: still on its edge up the z axis (the
        # line x = y = 1), but d from the edges along x and y at z = 1 (and
        # from the top face's plane).
        return edit(text("unit_cube.step"), "#28 = CARTESIAN_POINT('',(1.0,1.0,1.0));",
                    f"#28 = CARTESIAN_POINT('',(1.0,1.0,{1 + d!r}));")

    def test_a_corner_off_its_edges_by_less_than_linear(self):
        # 0.9 LINEAR: within tolerance, as the kernel's validator allows.
        r = self.check(self.moved_corner(0.9 * LINEAR))
        self.assertTrue(r.ok, r.problems)
        self.assertGreater(r.vertex_tolerance, 0.85 * LINEAR)

    def test_a_corner_off_its_edges_by_more_than_linear(self):
        self.assertFails(self.moved_corner(1.1 * LINEAR), "a vertex needed tolerance")

    def wider_top(self, d):
        # The cylinder's top circle and its vertex moved out to radius 2 + d:
        # the vertex stays on its circle, the circle stays on the top cap's
        # plane, but both are d off the side's cylinder (radius 2).
        t = edit(text("cylinder_r2_h3.step"), "#16 = CARTESIAN_POINT('',(2.0,0.0,3.0));",
                 f"#16 = CARTESIAN_POINT('',({2 + d!r},0.0,3.0));")
        return edit(t, "#28 = CIRCLE('',#27,2.0);", f"#28 = CIRCLE('',#27,{2 + d!r});")

    def test_an_edge_off_its_face_by_less_than_linear(self):
        r = self.check(self.wider_top(0.9 * LINEAR))
        self.assertTrue(r.ok, r.problems)

    def test_an_edge_off_its_face_by_more_than_linear(self):
        r = self.check(self.wider_top(1.1 * LINEAR))
        self.assertFalse(r.ok)
        self.assertTrue(any("an edge needed tolerance" in p for p in r.problems), r.problems)
        # The vertex is on its circle but off the side's cylinder too, so
        # its tolerance grows with the edge's.
        self.assertTrue(any("a vertex needed tolerance" in p for p in r.problems), r.problems)

    def test_a_curved_face_with_its_normal_flipped(self):
        # The cylinder's side says its normal points in, towards the axis.
        self.assertFails(edit(text("cylinder_r2_h3.step"), "#59 = ADVANCED_FACE('',(#55,#58),#52,.T.);",
                              "#59 = ADVANCED_FACE('',(#55,#58),#52,.F.);"), "BRepCheck")

    def test_both_halves_of_a_sphere_walking_the_equator_one_way(self):
        # The lower half walks the equator forwards too, so the edge is used
        # the same way twice.
        self.assertFails(edit(text("sphere_r2.step"), "#36 = ORIENTED_EDGE('',*,*,#21,.F.);",
                              "#36 = ORIENTED_EDGE('',*,*,#21,.T.);"), "BRepCheck")

    def test_the_normal_reader_would_have_hidden_the_flipped_normal(self):
        # Why step_check translates without OpenCascade's repairs: read
        # through its normal STEP reader, the face with its normal flipped
        # comes back turned the right way, valid, with the cube's area.
        from OCP.BRepCheck import BRepCheck_Analyzer
        from OCP.BRepGProp import BRepGProp
        from OCP.GProp import GProp_GProps
        from OCP.STEPControl import STEPControl_Reader
        t = edit(text("unit_cube.step"), "#101 = ADVANCED_FACE('',(#100),#94,.T.);",
                 "#101 = ADVANCED_FACE('',(#100),#94,.F.);")
        with tempfile.NamedTemporaryFile("w", suffix=".step", delete=False) as f:
            f.write(t)
        try:
            reader = STEPControl_Reader()
            reader.ReadFile(f.name)
            reader.TransferRoots()
            shape = reader.OneShape()
        finally:
            os.unlink(f.name)
        area = GProp_GProps()
        BRepGProp.SurfaceProperties_s(shape, area)
        self.assertTrue(BRepCheck_Analyzer(shape).IsValid())
        self.assertAlmostEqual(area.Mass(), 6.0, places=12)

    def test_a_file_that_is_not_step(self):
        self.assertFails("not a STEP file\n", "couldn't read")


if __name__ == "__main__":
    unittest.main()
