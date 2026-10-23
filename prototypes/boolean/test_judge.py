"""Tests for judge.py: python3 -m unittest discover -s prototypes/boolean -p 'test_*.py'.

Every expected answer below is worked out by hand in the comment beside
it, independently of the models. CI's kernel job also runs the judge on the
generator's own lines (kernel/tests/support/boolean_cases.rs), answering
from the models, checking each family's intent and catching every planted
wrong answer (`judge.py --planted`)."""

import io
import json
import os
import sys
import tempfile
import unittest
from fractions import Fraction
from unittest import mock

sys.path.insert(0, os.path.dirname(__file__))
import convex_model  # noqa: E402
import judge  # noqa: E402
from test_box_model_occ import HAVE_OCP  # noqa: E402
from box_model import LINEAR, MIN_FEATURE, SAME, ModelError  # noqa: E402

F = Fraction


def s(x):
    return repr(float(x))


def boxes(*bs, place=(0, 0, 0)):
    return {"boxes": [[s(x) for x in b] for b in bs], "place": [s(x) for x in place]}


def turn_matrix(turns):
    m = convex_model.compose(*[convex_model.turn(*t) for t in turns])
    return [[s(x) for x in row] for row in m]


def prism(outline, z, turns=(), place=(0, 0, 0)):
    return {"outline": [[s(x), s(y)] for x, y in outline], "z": [s(z[0]), s(z[1])], "turns": [list(t) for t in turns],
            "matrix": turn_matrix(turns), "place": [s(x) for x in place]}


def line(a, b, op, kind="boxes", intent=None):
    return {"kind": kind, "family": "hand", "place": "origin", "offset": None, "op": op, "intent": intent, "a": a, "b": b}


def square(lo, hi):
    return [(lo, lo), (hi, lo), (hi, hi), (lo, hi)]


def body(volume, area, faces, edges, vertices, shells, box, **more):
    return dict(volume=s(volume), area=s(area), faces=faces, edges=edges, vertices=vertices, shells=shells, box=[s(x) for x in box], **more)


A = (0, 0, 0, 10, 10, 10)
ON_TOP = (2, 2, 10, 4, 4, 12)

# B (2 x 2 x 2) standing on A's top (10 x 10 x 10), joined. Volume 1000 +
# 8 = 1008. Area: A's 600, less B's footprint 4 on A's top, plus B's four
# sides 4 x (2 x 2) = 16 and its top 4: 616. Faces: A's 6 (its top now with
# a hole where B stands: one ring) and B's 4 sides and top: 11. Edges: A's
# 12, the footprint's 4, B's 4 upright and 4 on top: 24. Vertices 8 + 8 =
# 16. One shell; V - E + F - R = 16 - 24 + 11 - 1 = 2 = 2(S - H), so H = 0.
SITTING = body(1008, 616, 11, 24, 16, 1, (0, 0, 0, 10, 10, 12), rings=1, genus=0)


def judged(ln, answer):
    return judge.compare(judge.want(ln), answer)


class HandWorked(unittest.TestCase):
    def test_sitting_on_top(self):
        ln = line(boxes(A), boxes(ON_TOP), "union")
        self.assertEqual(judged(ln, {"bodies": [SITTING]}), [])
        # The models agree with the hand.
        self.assertEqual(judge.model_answer(judge.want(ln).result), {"bodies": [SITTING]})
        # Rings and genus are optional; given, they must be right.
        bare = {k: v for k, v in SITTING.items() if k not in ("rings", "genus")}
        self.assertEqual(judged(ln, {"bodies": [bare]}), [])
        self.assertIn("rings 0 where the model has 1", judged(ln, {"bodies": [dict(SITTING, rings=0)]}))

    def test_each_wrong_answer_says_what(self):
        ln = line(boxes(A), boxes(ON_TOP), "union")
        cases = {
            "faces 12 where the model has 11": dict(SITTING, faces=12),
            "edges 23 where the model has 24": dict(SITTING, edges=23),
            "vertices 15 where the model has 16": dict(SITTING, vertices=15),
            "shells 2 where the model has 1": dict(SITTING, shells=2),
            "volume 1008.002 where the model has 1008.0": dict(SITTING, volume="1008.002"),
            "area 616.002 where the model has 616.0": dict(SITTING, area="616.002"),
        }
        for msg, b in cases.items():
            self.assertEqual(judged(ln, {"bodies": [b]}), [msg])
        self.assertEqual(judged(ln, {"bodies": [SITTING, SITTING]}), ["2 bodies where the model has 1"])
        self.assertIn("no body of the model has the box", judged(ln, {"bodies": [dict(SITTING, box=[s(x) for x in (0, 0, 0, 10, 10, 12.001)])]})[0])
        self.assertIn("the kernel says nonmanifold", judged(ln, {"error": "nonmanifold", "where": [{"vertex": ["0", "0", "0"]}]})[0])
        self.assertIn("the kernel says empty", judged(ln, {"error": "empty"})[0])

    def test_volume_and_area_at_mass_props_rel(self):
        # 1008 to MASS_PROPS_REL (1e-6) is 1.008e-3: 0.9 of that passes, 1.1 fails.
        ln = line(boxes(A), boxes(ON_TOP), "union")
        for k, want in ((F(9, 10), []), (F(11, 10), ["volume"])):
            v = 1008 + k * F(1008, 10**6)
            got = judged(ln, {"bodies": [dict(SITTING, volume=s(v))]})
            self.assertEqual([g.split()[0] for g in got], want, k)

    def test_empty(self):
        # B standing on A shares no volume with it: the intersect is empty,
        # said as an error or as no bodies (B0 decision 2); A is wrong.
        ln = line(boxes(A), boxes(ON_TOP), "intersect")
        self.assertEqual(judged(ln, {"error": "empty"}), [])
        self.assertEqual(judged(ln, {"bodies": []}), [])
        a = body(1000, 600, 6, 12, 8, 1, A)
        self.assertIn("bodies where the model says empty", judged(ln, {"bodies": [a]})[0])
        self.assertIn("the kernel says thin", judged(ln, {"error": "thin", "where": [{"vertex": ["0", "0", "0"]}]})[0])

    def test_void(self):
        # A small box wholly inside A, cut out: one body, two shells, volume
        # 1000 - 8 = 992, area 600 + 24 = 624, faces 12, edges 24, vertices
        # 16, V - E + F = 4 = 2(S - H), S = 2, H = 0.
        ln = line(boxes(A), boxes((4, 4, 4, 6, 6, 6)), "subtract")
        hollow = body(992, 624, 12, 24, 16, 2, A, rings=0, genus=0)
        self.assertEqual(judged(ln, {"bodies": [hollow]}), [])
        # The void lost (A returned): faces, edges, vertices, shells, volume
        # and area all wrong.
        lost = body(1000, 600, 6, 12, 8, 1, A)
        self.assertEqual(len(judged(ln, {"bodies": [lost]})), 6)


class Bands(unittest.TestCase):
    """0.9x and 1.1x of each threshold the judge applies."""

    def test_two_linear_is_one_place(self):
        # B's bottom 0.9 x 2·LINEAR = 18 nm above A's top: one place, so the
        # hand answer above. The kernel may keep B's corners where they were,
        # making B 18 nm shorter: 1008 - 4 x 1.8e-5 = 1007.999928, which the
        # snap allows (B's bottom, area 4, moved 1.8e-5: 7.2e-5 of volume,
        # on top of 1008 x 1e-6 = 1.008e-3); 1008.002 is past both.
        up = 10 + 0.9 * float(SAME)
        ln = line(boxes(A), boxes((2, 2, up, 4, 4, 12)), "union")
        w = judge.want(ln)
        self.assertAlmostEqual(float(w.slack[0]), 4 * 1.8e-5, delta=1e-12)
        self.assertEqual(judged(ln, {"bodies": [SITTING]}), [])
        self.assertEqual(judged(ln, {"bodies": [dict(SITTING, volume=s(1008 - 4 * 1.8e-5))]}), [])
        self.assertEqual(len(judged(ln, {"bodies": [dict(SITTING, volume="1008.002")]})), 1)
        # 1.1 x 2·LINEAR = 22 nm above: two bodies, 22 nm apart.
        up = 10 + 1.1 * float(SAME)
        ln = line(boxes(A), boxes((2, 2, up, 4, 4, 12)), "union")
        self.assertEqual(judged(ln, {"bodies": [SITTING]}), ["1 bodies where the model has 2"])
        b = F(4) * (12 - F(up))
        two = [body(1000, 600, 6, 12, 8, 1, A), body(b, 8 + 4 * 2 * (12 - F(up)), 6, 12, 8, 1, (2, 2, up, 4, 4, 12))]
        self.assertEqual(judged(ln, {"bodies": two}), [])

    def test_min_feature(self):
        # B sunk into A's top by d, cut from A: a pocket d deep, its walls d
        # tall. 0.9 µm: thin, and bodies are wrong; 1.1 µm: bodies, and thin
        # is wrong; exactly 1 µm (to the double): the band decides, so both.
        def ln(d):
            return line(boxes(A), boxes((2, 2, 10 - d, 4, 4, 12)), "subtract")

        w = judge.want(ln(0.9e-3))
        self.assertEqual(w.result["outcome"], "thin")
        thin = judge.model_answer(w.result)
        self.assertEqual(judged(ln(0.9e-3), thin), [])
        self.assertIn("bodies where the model says thin", judge.compare(w, {"bodies": [body(1000, 600, 6, 12, 8, 1, A)]})[0])
        w = judge.want(ln(1.1e-3))
        self.assertEqual(w.result["outcome"], "bodies")
        self.assertIn("the kernel says thin", judge.compare(w, dict(thin))[0])
        w = judge.want(ln(1e-3))
        self.assertTrue(w.thin_either)
        self.assertEqual(judge.compare(w, judge.model_answer(w.result)), [])
        self.assertEqual(judge.compare(w, {"error": "thin", "where": thin["where"][:0] + [judge.place_json(p) for p in w.thin_wide]}), [])

    def test_on_the_edge_of_two_linear(self):
        # 2·LINEAR to the double: either answer is right, so the judge says so.
        ln = line(boxes(A), boxes((2, 2, 10 + float(SAME), 4, 4, 12)), "union")
        with self.assertRaises(judge.OnEdge):
            judge.want(ln)

    def test_where(self):
        # B on A's top along its edge x = 10: they touch along the segment
        # (10, 2, 10) to (10, 6, 10) only: non-manifold there (decision 2).
        ln = line(boxes(A), boxes((10, 2, 10, 14, 6, 13)), "union")
        w = judge.want(ln)
        self.assertEqual(w.result["where"]["nonmanifold"], [("edge", (10, 2, 10), (10, 6, 10))])

        def edge(*ps):
            return {"error": "nonmanifold", "where": [{"edge": [[s(x) for x in p] for p in e]} for e in ps]}

        self.assertEqual(judge.compare(w, edge([(10, 2, 10), (10, 6, 10)])), [])
        self.assertEqual(judge.compare(w, edge([(10, 6, 10), (10, 4, 10)], [(10, 2, 10), (10, 4, 10)])), [])
        self.assertIn("is not named", judge.compare(w, edge([(10, 2, 10), (10, 4, 10)]))[0])
        self.assertEqual(judge.compare(w, {"error": "nonmanifold", "where": []}), ["nonmanifold without saying where"])
        # Within the cap on a vertex's tolerance (10·LINEAR), here with no
        # snap and rounding of 64 ulps of 14: 0.9 of it passes, 1.1 fails.
        tol = float(w.tol)
        self.assertAlmostEqual(tol, 1e-4, delta=1e-12)
        for k, ok in ((0.9, True), (1.1, False)):
            got = judge.compare(w, edge([(10, 2, 10 + k * tol), (10, 6, 10 + k * tol)]))
            self.assertEqual(got == [], ok, (k, got))


class Prisms(unittest.TestCase):
    TURN = ("x", 3, 4, 5)  # turns y to (0, 3/5, 4/5) and z to (0, -4/5, 3/5)

    def test_snap_along_a_turned_normal(self):
        # A 4 x 4 x 4 block and a 2 x 2 x 2 one on it, both turned the same
        # way about x, B 0.9 x 2·LINEAR above A's top in their own frame. The
        # judge moves B's bottom onto A's top along their shared normal
        # (0, -4/5, 3/5): B's z0 becomes 4 exactly, and the vertices on it
        # slide the gap over a right angle, so D is the gap. Then it is the
        # hand case turned: volume 64 + 8 = 72, area 96 - 4 + 4 x (2 x 2) + 4 = 112,
        # 11 faces, 24 edges, 16 vertices.
        up = 4 + 0.9 * float(SAME)
        ln = line(prism(square(0, 4), (0, 4), [self.TURN]), prism(square(1, 3), (up, 6), [self.TURN]), "union", "prisms")
        a, b = judge.Solid(ln["a"]).prism, judge.Solid(ln["b"]).prism
        moved, snap = judge.snap_prisms(a, b, judge.rounding(6))
        self.assertEqual(moved.z, (4, 6))
        self.assertEqual(snap.D, float(F(up) - 4))
        w = judge.want(ln)
        r = w.result["bodies"]
        self.assertEqual([(x["volume"], x["area"], x["faces"], x["edges"], x["vertices"]) for x in r], [(72, 112, 11, 24, 16)])

    def test_one_move_for_a_corner_a_hair_off(self):
        # B turned its own way, its corner put on A's corner but 1e-9 mm off
        # along each axis (as rounding far out does): the judge moves B by
        # exactly minus that, the only move that puts each corner on the
        # other's three planes again.
        e = (F(1, 10**9), F(-2, 10**9), F(1, 2 * 10**9))
        a = convex_model.block(0, 0, 0, 4, 4, 4)
        r = convex_model.compose(convex_model.turn("z", 3, 4, 5), convex_model.turn("x", 5, 12, 13))
        corner = (F(4), F(4), F(4))
        b = convex_model.Prism(square(0, 2), 0, 2, r, convex_model.plus(corner, e))
        moved, snap = judge.snap_prisms(a, b, judge.rounding(10))
        self.assertEqual(moved.move, corner)
        self.assertGreater(snap.D, 0)

    def test_beyond_the_judge(self):
        # B 0.5 x 2·LINEAR wider than A on both sides in x: one move cannot
        # put both sides on A's (they need opposite moves), and the judge
        # snaps only a prism's top and bottom plane by plane, so it says so.
        g = float(SAME) / 2
        ln = line(prism(square(0, 4), (0, 4)), prism([(-g, 1), (4 + g, 1), (4 + g, 3), (-g, 3)], (1, 3)), "union", "prisms")
        with self.assertRaises(judge.Beyond):
            judge.want(ln)
        # The same as boxes is judged: each of B's coordinates snaps alone.
        w = judge.want(line(boxes((0, 0, 0, 4, 4, 4)), boxes((-g, 1, 1, 4 + g, 3, 3)), "union"))
        self.assertEqual(w.result["outcome"], "bodies")


class Lines(unittest.TestCase):
    def test_bad_lines(self):
        ln = line(prism(square(0, 4), (0, 4), [("x", 3, 4, 5)]), prism(square(1, 3), (4, 6)), "union", "prisms")
        ln["a"]["matrix"][1][1] = "0.61"
        with self.assertRaisesRegex(ModelError, "not its turns"):
            judge.want(ln)
        ln = line(boxes(A), boxes(ON_TOP), "union")
        ln["a"]["boxes"][0][0] = 0.0
        with self.assertRaisesRegex(ModelError, "not written as a string"):
            judge.want(ln)
        with self.assertRaisesRegex(ModelError, "unknown op"):
            judge.want(line(boxes(A), boxes(ON_TOP), "xor"))

    def test_every_plant_caught_on_hand_lines(self):
        lines = [
            line(boxes(A), boxes(ON_TOP), "union", intent="bodies:1"),
            line(boxes(A), boxes(ON_TOP), "intersect", intent="empty"),
            line(boxes(A), boxes((4, 4, 4, 6, 6, 6)), "subtract", intent="bodies:1:shells:2"),
            line(boxes(A), boxes((10, 2, 10, 14, 6, 13)), "union", intent="nonmanifold"),
            line(boxes(A), boxes((10, 10, 10, 12, 12, 12)), "union", intent="nonmanifold"),
            line(boxes(A), boxes((2, 2, 10 - 0.9e-3, 4, 4, 12)), "subtract", intent="thin"),
        ]
        out = io.StringIO()
        self.assertTrue(judge.run(lines, planted=True, out=out), out.getvalue())
        summary = out.getvalue().splitlines()[2]
        for kind in judge.PLANTS:
            self.assertRegex(summary, kind + r" (\d+)/\1\b")
        # A wrong intent is reported.
        out = io.StringIO()
        self.assertFalse(judge.run([dict(lines[0], intent="bodies:2")], model_answers=True, out=out))
        self.assertIn("meant bodies:2, the model says bodies:1", out.getvalue())

    def test_a_model_failing_its_own_check_fails_the_run(self):
        # The 30c long run stopped dead on such a line; now it is listed
        # and the run fails, and the other lines are still judged.
        lines = [line(boxes(A), boxes(ON_TOP), "union"), line(boxes(A), boxes(ON_TOP), "intersect")]
        real, calls = judge.box_model.judge_cells, []

        def first_fails(*args):
            calls.append(1)
            if len(calls) == 1:
                raise AssertionError("a crease has 3 faces")
            return real(*args)

        with mock.patch.object(judge.box_model, "judge_cells", first_fails):
            out = io.StringIO()
            self.assertFalse(judge.run(lines, model_answers=True, out=out))
        self.assertIn("1 agree, 0 disagree, 0 beyond the judge, 0 on a band's edge, 1 a model failed", out.getvalue())
        self.assertIn("line 1 (boxes", out.getvalue())
        self.assertIn("a model failed its own check: a crease has 3 faces", out.getvalue())

    def test_command_line(self):
        ln = line(boxes(A), boxes(ON_TOP), "union")
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "lines.jsonl")
            for answer, code in (({"bodies": [SITTING]}, 0), ({"bodies": [dict(SITTING, faces=10)]}, 1)):
                with open(path, "w") as f:
                    f.write(json.dumps(dict(ln, answer=answer)) + "\n")
                out = io.StringIO()
                sys.stdout, old = out, sys.stdout
                try:
                    self.assertEqual(judge.main([path]), code)
                finally:
                    sys.stdout = old
                self.assertIn(f"{1 - code} agree, {code} disagree", out.getvalue())


@unittest.skipUnless(HAVE_OCP, "needs cadquery-ocp")
class OpenCascade(unittest.TestCase):
    """judge.py --occ: OpenCascade's own boolean of the snapped pair."""

    def test_agrees_and_sees_a_wrong_answer(self):
        up = 4 + 0.9 * float(SAME)
        turned = line(prism(square(0, 4), (0, 4), [Prisms.TURN]), prism(square(1, 3), (up, 6), [Prisms.TURN]), "union", "prisms")
        far = line(boxes(A, place=(1e8 - 100, -1e8 + 100, 1e6)), boxes((2, 2, 10 + 0.9 * float(SAME), 4, 4, 12), place=(1e8 - 100, -1e8 + 100, 1e6)), "union")
        for ln in (line(boxes(A), boxes(ON_TOP), "union"), line(boxes(A), boxes((4, 4, 4, 6, 6, 6)), "subtract"), turned, far):
            w = judge.want(ln)
            self.assertEqual(judge.occ_disagreements(w, ln["op"]), [], ln)
        # Planted: the model a face out, or 1% out in volume.
        w = judge.want(turned)
        w.result["bodies"][0]["faces"] += 1
        self.assertIn("OpenCascade's counts", judge.occ_disagreements(w, "union")[0])
        w = judge.want(turned)
        w.result["bodies"][0]["volume"] *= F(101, 100)
        self.assertIn("OpenCascade's volume", judge.occ_disagreements(w, "union")[0])
        # No say on a non-manifold result.
        self.assertIsNone(judge.occ_disagreements(judge.want(line(boxes(A), boxes((10, 10, 10, 12, 12, 12)), "union")), "union"))


def failing():
    """The tests above that fail (as they stand, none)."""
    suite = unittest.TestSuite(unittest.TestLoader().loadTestsFromTestCase(c) for c in (HandWorked, Bands, Prisms, Lines))
    result = unittest.TestResult()
    with mock.patch.object(sys, "stdout", io.StringIO()):
        suite.run(result)
    return {t.id().split(".")[-1] for t, _ in result.failures + result.errors}


class Planted(unittest.TestCase):
    """Each planted break in the judge makes a test above fail."""

    def test_none_fail_as_they_stand(self):
        self.assertEqual(failing(), set())

    def test_no_snap(self):
        with mock.patch.object(judge, "snap_boxes", lambda a, b, margin: (b, judge.Snap())):
            self.assertIn("test_two_linear_is_one_place", failing())

    def test_snap_allows_nothing(self):
        def plane(self, move, sin, area, perimeter):
            self.D += move / sin
        with mock.patch.object(judge.Snap, "plane", plane):
            self.assertIn("test_two_linear_is_one_place", failing())

    def test_volume_and_area_never_compared(self):
        with mock.patch.object(judge, "close", lambda got, want, slack: True):
            self.assertIn("test_each_wrong_answer_says_what", failing())

    def test_any_piece_covers_an_edge(self):
        with mock.patch.object(judge, "covered", lambda seg, pieces, tol: True):
            self.assertIn("test_where", failing())

    def test_where_without_the_cap(self):
        with mock.patch.object(judge, "CAP", F(0)):
            self.assertIn("test_where", failing())

    def test_min_feature_band_off(self):
        class Same:
            def __init__(self, value):
                pass

            def __enter__(self):
                return None

            def __exit__(self, *e):
                return False
        with mock.patch.object(judge, "min_feature", Same):
            self.assertIn("test_min_feature", failing())

    def test_caps_never_snapped(self):
        with mock.patch.object(judge, "snap_caps", lambda a, b, margin: (b, judge.Snap())):
            self.assertIn("test_snap_along_a_turned_normal", failing())

    def test_one_move_never_found(self):
        with mock.patch.object(judge, "solve_rows", lambda rows: (F(0),) * 3):
            self.assertIn("test_one_move_for_a_corner_a_hair_off", failing())

    def test_band_edge_unseen(self):
        with mock.patch.object(judge, "rounding", lambda reach: F(0)):
            self.assertIn("test_on_the_edge_of_two_linear", failing())

    def test_every_answer_agreed(self):
        with mock.patch.object(judge, "compare", lambda w, answer: []):
            names = failing()
        for name in ("test_each_wrong_answer_says_what", "test_every_plant_caught_on_hand_lines", "test_command_line"):
            self.assertIn(name, names)


if __name__ == "__main__":
    unittest.main()
