"""OpenCascade checks box_model.py (needs cadquery-ocp; skipped without it):
python3 -m unittest discover -s prototypes/boolean -p 'test_*.py'.

OpenCascade's own booleans on the same boxes, with its coplanar faces and
collinear edges merged (ShapeUpgrade_UnifySameDomain, decision 6), must give
the model's bodies: per solid its volume and area (to MASS_PROPS_REL; the
coordinates are small integers, exact in doubles) and its face, edge, vertex,
shell and ring counts exactly. An independent kernel, so this counts towards
nothing being a shared mistake."""

import importlib.util
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))
import box_model  # noqa: E402
from test_box_model import HAND, SEED, seeded_pairs  # noqa: E402

HAVE_OCP = importlib.util.find_spec("OCP") is not None
MASS_PROPS_REL = 1e-6  # kernel/src/tolerance.rs


def shapes(shape, kind):
    from OCP.TopExp import TopExp_Explorer
    out = []
    ex = TopExp_Explorer(shape, kind)
    while ex.More():
        s = ex.Current()
        if not any(s.IsSame(t) for t in out):
            out.append(s)
        ex.Next()
    return out


def occ_solid(boxes):
    from OCP.BRepAlgoAPI import BRepAlgoAPI_Fuse
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
    from OCP.gp import gp_Pnt
    shape = None
    for b in boxes:
        f = [float(c) for c in b]
        one = BRepPrimAPI_MakeBox(gp_Pnt(*f[:3]), gp_Pnt(*f[3:])).Shape()
        shape = one if shape is None else BRepAlgoAPI_Fuse(shape, one).Shape()
    return shape


def occ_bodies(op, a, b):
    from OCP.BRepAlgoAPI import BRepAlgoAPI_Common, BRepAlgoAPI_Cut, BRepAlgoAPI_Fuse
    from OCP.BRepGProp import BRepGProp
    from OCP.GProp import GProp_GProps
    from OCP.ShapeUpgrade import ShapeUpgrade_UnifySameDomain
    from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE, TopAbs_SHELL, TopAbs_SOLID, TopAbs_VERTEX, TopAbs_WIRE
    algo = {"union": BRepAlgoAPI_Fuse, "subtract": BRepAlgoAPI_Cut, "intersect": BRepAlgoAPI_Common}[op]
    shape = algo(occ_solid(a), occ_solid(b)).Shape()
    unify = ShapeUpgrade_UnifySameDomain(shape, True, True, False)
    unify.Build()
    shape = unify.Shape()
    out = []
    for s in shapes(shape, TopAbs_SOLID):
        v, area = GProp_GProps(), GProp_GProps()
        BRepGProp.VolumeProperties_s(s, v)
        BRepGProp.SurfaceProperties_s(s, area)
        faces = shapes(s, TopAbs_FACE)
        out.append({
            "volume": v.Mass(),
            "area": area.Mass(),
            "faces": len(faces),
            "edges": len(shapes(s, TopAbs_EDGE)),
            "vertices": len(shapes(s, TopAbs_VERTEX)),
            "shells": len(shapes(s, TopAbs_SHELL)),
            "rings": sum(len(shapes(f, TopAbs_WIRE)) - 1 for f in faces),
        })
    return out


COUNTS = ("faces", "edges", "vertices", "shells", "rings")


def key(d):
    return tuple(d[k] for k in COUNTS) + (round(float(d["volume"]), 6),)


@unittest.skipUnless(HAVE_OCP, "needs cadquery-ocp")
class OpenCascadeAgrees(unittest.TestCase):
    def agree(self, op, a, b, label):
        want = box_model.boolean(op, a, b)
        if want["outcome"] not in ("bodies", "thin") or want["pinched"]:
            return False
        # Paired in order of counts, volume and area (two bodies can share
        # counts and volume).
        got = sorted(occ_bodies(op, a, b), key=lambda d: key(d) + (d["area"],))
        bodies = sorted(want["bodies"], key=lambda d: key(d) + (float(d["area"]),))
        self.assertEqual(list(map(key, got)), list(map(key, bodies)), (label, op, a, b))
        for g, w in zip(got, bodies):
            for k in ("volume", "area"):
                self.assertLessEqual(abs(g[k] - float(w[k])), MASS_PROPS_REL * float(w[k]), (label, k, op, a, b))
        return True

    def test_hand_cases(self):
        for name, op, a, b, *_ in HAND:
            with self.subTest(name):
                self.agree(op, a, b, name)

    def test_seeded(self):
        compared = 0
        for a, b in seeded_pairs(SEED + 3, 80):
            for op in box_model.OPS:
                compared += self.agree(op, a, b, "seeded")
        # Most seeded results are ordinary bodies; make sure this really ran.
        self.assertGreater(compared, 100)

    def test_pinched_face(self):
        # The one known difference: OpenCascade writes the pinched U (HAND,
        # "pinched face") as an outer and an inner wire touching at (1,1,1),
        # so 1 ring, where the model counts the disc it is, 0 rings. Theirs
        # breaks Euler-Poincare (19 - 30 + 13 - 1 = 1, odd), the model's
        # holds (19 - 30 + 13 - 0 = 2): kept in view for 35 (decision 6
        # tidying and validate's Euler check must agree with the model).
        name, op, a, b, _, bodies = [h for h in HAND if h[0] == "pinched face"][0]
        got = occ_bodies(op, a, b)[0]
        self.assertEqual({k: got[k] for k in COUNTS if k != "rings"}, {k: bodies[0][k] for k in COUNTS if k != "rings"})
        self.assertEqual((got["rings"], bodies[0]["rings"]), (1, 0))

    def test_a_wrong_count_is_seen(self):
        # Planted: the model's L with one face too many must not agree.
        a, b = [box_model.box(0, 0, 0, 2, 1, 1)], [box_model.box(0, 0, 0, 1, 2, 1)]
        want = box_model.boolean("union", a, b)["bodies"][0]
        wrong = dict(want, faces=want["faces"] + 1)
        self.assertNotEqual(key(occ_bodies("union", a, b)[0]), key(wrong))


if __name__ == "__main__":
    unittest.main()
