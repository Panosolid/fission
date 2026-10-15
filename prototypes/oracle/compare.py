"""OpenCascade oracle: rebuild every body the stateful harness produced and
compare it with what the Fission kernel reported.

Input: the JSONL file written by the harness with FISSION_ORACLE_OUT. Each
line has the primitive ("shape"), the 3x4 placement matrix the harness
tracked independently of the kernel, and the kernel's numbers (volume and
area of its display mesh, bounds, face count, and the mesh's largest
deviation from the exact surface).

OpenCascade isn't always right either: disagreements are logged for review,
not treated as kernel failures.

Usage: python compare.py cases.jsonl [disagreements.txt]
Needs: pip install cadquery-ocp
"""

import json
import sys
from collections import Counter

from OCP.BRepBndLib import BRepBndLib
from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeFace, BRepBuilderAPI_MakePolygon, BRepBuilderAPI_Transform
from OCP.BRepGProp import BRepGProp
from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox, BRepPrimAPI_MakeCylinder, BRepPrimAPI_MakePrism, BRepPrimAPI_MakeSphere
from OCP.Bnd import Bnd_Box
from OCP.GProp import GProp_GProps
from OCP.TopAbs import TopAbs_FACE
from OCP.TopExp import TopExp_Explorer
from OCP.gp import gp_Pnt, gp_Trsf, gp_Vec

# Faces Fission uses per primitive vs OpenCascade. Fission splits a sphere
# into two hemispheres (one face with no edges can't satisfy Euler-Poincare
# in its data structure); OpenCascade uses one face with a seam.
FACES = {"Box": (6, 6), "Cylinder": (3, 3), "Sphere": (2, 1)}

REL = 1e-9  # OpenCascade's exact mass properties vs exact-in-theory values


def wire(points, ccw):
    """Closed polygon at z = 0, wound counter-clockwise (outer loops) or
    clockwise (holes), as OpenCascade's face builder expects."""
    twice = sum(x0 * y1 - x1 * y0 for (x0, y0), (x1, y1) in zip(points, points[1:] + points[:1]))
    if (twice > 0) != ccw:
        points = points[::-1]
    poly = BRepBuilderAPI_MakePolygon()
    for x, y in points:
        poly.Add(gp_Pnt(x, y, 0.0))
    poly.Close()
    return poly.Wire()


def extrusion(p):
    pts = lambda loop: [(float(x), float(y)) for x, y in loop]
    face = BRepBuilderAPI_MakeFace(wire(pts(p["outer"]), True), True)
    for hole in p["holes"]:
        face.Add(wire(pts(hole), False))
    return BRepPrimAPI_MakePrism(face.Face(), gp_Vec(0.0, 0.0, float(p["dist"]))).Shape()


def build(shape):
    (kind, p), = shape.items()
    if kind == "Extrude":
        # Two caps plus one side face per profile edge, in both kernels.
        corners = len(p["outer"]) + sum(len(h) for h in p["holes"])
        FACES["Extrude"] = (2 + corners, 2 + corners)
        return kind, extrusion(p), float(p["dist"])
    num = {k: float(v) for k, v in p.items()}
    if kind == "Box":
        return kind, BRepPrimAPI_MakeBox(num["w"], num["d"], num["h"]).Shape(), min(num.values())
    if kind == "Cylinder":
        return kind, BRepPrimAPI_MakeCylinder(num["r"], num["h"]).Shape(), num["r"]
    if kind == "Sphere":
        return kind, BRepPrimAPI_MakeSphere(num["r"]).Shape(), num["r"]
    raise ValueError(kind)


def place(shape, m):
    t = gp_Trsf()
    t.SetValues(*m)
    return BRepBuilderAPI_Transform(shape, t, True).Shape()


def measure(shape):
    vp, sp = GProp_GProps(), GProp_GProps()
    BRepGProp.VolumeProperties_s(shape, vp)
    BRepGProp.SurfaceProperties_s(shape, sp)
    box = Bnd_Box()
    BRepBndLib.AddOptimal_s(shape, box, False, False)
    lo_p, hi_p = box.CornerMin(), box.CornerMax()
    lo_hi = (lo_p.X(), lo_p.Y(), lo_p.Z(), hi_p.X(), hi_p.Y(), hi_p.Z())
    faces, ex = 0, TopExp_Explorer(shape, TopAbs_FACE)
    while ex.More():
        faces += 1
        ex.Next()
    return vp.Mass(), sp.Mass(), lo_hi[:3], lo_hi[3:], faces


def compare(case):
    kind, shape, size = build(case["shape"])
    vol, area, lo, hi, faces = measure(place(shape, case["matrix"]))
    issues = []
    if (case["faces"], faces) != FACES[kind]:
        issues.append(f"faces: fission {case['faces']}, occ {faces}, expected {FACES[kind]}")
    reach = max(abs(x) for x in lo + hi) or 1.0
    for axis, ours, theirs in zip("xyz", case["lo"] + case["hi"], lo + hi):
        # OCC's optimal box is tight to ~1e-7; ours is exact for these shapes.
        if abs(ours - theirs) > 1e-6 + REL * reach:
            issues.append(f"bounds {axis}: fission {ours}, occ {theirs}")
    dev = case["max_deviation"]
    # Rounding allowances computed by the harness from how far the shape
    # sits from the origin (moving a vertex by d changes volume by at most
    # area x d and area by at most perimeters x d).
    vslack = case["volume_slack"] + REL * vol
    aslack = case["area_slack"] + REL * area
    # An inscribed mesh of a convex solid never has more volume or area
    # than the solid itself.
    if case["volume"] > vol + vslack:
        issues.append(f"volume above exact: fission {case['volume']}, occ {vol}, allowed {vslack:.3g}")
    if case["area"] > area + aslack:
        issues.append(f"area above exact: fission {case['area']}, occ {area}, allowed {aslack:.3g}")
    # And it can't fall short by more than (surface area) x (largest gap
    # between mesh and surface), plus rounding. Boxes are exact.
    if vol - case["volume"] > area * dev * 1.5 + vslack:
        issues.append(f"volume deficit too large: fission {case['volume']}, occ {vol}, deviation {dev}")
    # Boxes and extrusions are polyhedra: the mesh is exact, area too.
    if kind in ("Box", "Extrude") and abs(case["area"] - area) > aslack:
        issues.append(f"area: fission {case['area']}, occ {area}, allowed {aslack:.3g}")
    return kind, issues


def main():
    path = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 else None
    total, bad, per_kind, lines = 0, 0, Counter(), []
    with open(path) as f:
        for n, line in enumerate(f, 1):
            case = json.loads(line)
            try:
                kind, issues = compare(case)
            except Exception as e:  # an oracle crash is itself worth a look
                kind, issues = "?", [f"oracle error: {e!r}"]
            total += 1
            per_kind[kind] += 1
            if issues:
                bad += 1
                lines.append(f"line {n}: {json.dumps(case['shape'])}\n  " + "\n  ".join(issues))
    print(f"Oracle: {total} bodies compared with OpenCascade, {bad} disagreement(s)")
    for k, v in sorted(per_kind.items()):
        print(f"  {k:<9} {v}")
    for l in lines[:20]:
        print(l)
    if out:
        with open(out, "w") as f:
            f.write("\n".join(lines) + "\n")
        print(f"Disagreements written to {out}")


if __name__ == "__main__":
    main()
