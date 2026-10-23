"""OpenCascade checks convex_model.py (needs cadquery-ocp; skipped without it):
python3 -m unittest discover -s prototypes/boolean -p 'test_*.py'.

OpenCascade's own booleans on the same turned prisms, built from their
corners alone, with its coplanar faces and collinear edges merged
(ShapeUpgrade_UnifySameDomain, decision 6), must give the model's bodies: per
solid its volume and area (to MASS_PROPS_REL; the corners are rounded to
doubles, a relative change near 1e-16) and its face, edge, vertex, shell and
ring counts exactly. An independent kernel, so this counts towards nothing
being a shared mistake."""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))
import convex_model  # noqa: E402
from test_box_model_occ import COUNTS, HAVE_OCP, MASS_PROPS_REL, key, measure  # noqa: E402
from test_convex_model import HAND, SEED, turned_pairs  # noqa: E402


def occ_prism(p):
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeFace, BRepBuilderAPI_MakePolygon
    from OCP.BRepPrimAPI import BRepPrimAPI_MakePrism
    from OCP.gp import gp_Pnt, gp_Vec
    n = len(p.outline)
    poly = BRepBuilderAPI_MakePolygon()
    for v in p.vertices[:n]:
        poly.Add(gp_Pnt(*map(float, v)))
    poly.Close()
    face = BRepBuilderAPI_MakeFace(poly.Wire()).Face()
    up = [float(t - b) for t, b in zip(p.vertices[n], p.vertices[0])]
    return BRepPrimAPI_MakePrism(face, gp_Vec(*up)).Shape()


def occ_bodies(op, a, b):
    from OCP.BRepAlgoAPI import BRepAlgoAPI_Common, BRepAlgoAPI_Cut, BRepAlgoAPI_Fuse
    algo = {"union": BRepAlgoAPI_Fuse, "subtract": BRepAlgoAPI_Cut, "intersect": BRepAlgoAPI_Common}[op]
    return measure(algo(occ_prism(a), occ_prism(b)).Shape())


@unittest.skipUnless(HAVE_OCP, "needs cadquery-ocp")
class OpenCascadeAgrees(unittest.TestCase):
    def agree(self, op, a, b, label):
        want = convex_model.boolean(op, a, b)
        if want["outcome"] not in ("bodies", "thin") or want["pinched"]:
            return False
        got = sorted(occ_bodies(op, a, b), key=lambda d: key(d) + (d["area"],))
        bodies = sorted(want["bodies"], key=lambda d: key(d) + (float(d["area"]),))
        self.assertEqual(list(map(key, got)), list(map(key, bodies)), (label, op))
        for g, w in zip(got, bodies):
            for k in ("volume", "area"):
                self.assertLessEqual(abs(g[k] - float(w[k])), MASS_PROPS_REL * float(w[k]), (label, k, op))
        return True

    def test_hand_cases(self):
        compared = 0
        for name, op, a, b, _ in HAND:
            with self.subTest(name):
                compared += self.agree(op, a, b, name)
        self.assertGreater(compared, 10)

    def test_seeded(self):
        compared = 0
        for a, b in turned_pairs(SEED + 4, 30):
            for op in convex_model.OPS:
                compared += self.agree(op, a, b, "seeded")
            compared += self.agree("subtract", b, a, "seeded")
        self.assertGreater(compared, 80)

    def test_a_wrong_count_is_seen(self):
        # Planted: the model's half union with one edge too many must not agree.
        _, op, a, b, _ = [h for h in HAND if h[0] == "half union"][0]
        want = convex_model.boolean(op, a, b)["bodies"][0]
        wrong = dict(want, edges=want["edges"] + 1)
        self.assertNotEqual(key(occ_bodies(op, a, b)[0]), key(wrong))
        self.assertIn("edges", COUNTS)


if __name__ == "__main__":
    unittest.main()
