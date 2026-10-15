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
import math

from OCP.BRepBuilderAPI import (
    BRepBuilderAPI_MakeEdge,
    BRepBuilderAPI_MakeFace,
    BRepBuilderAPI_MakeWire,
    BRepBuilderAPI_Transform,
)
from OCP.GC import GC_MakeArcOfCircle
from OCP.BRepGProp import BRepGProp
from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox, BRepPrimAPI_MakeCylinder, BRepPrimAPI_MakePrism, BRepPrimAPI_MakeSphere
from OCP.Bnd import Bnd_Box
from OCP.GProp import GProp_GProps
from OCP.TopAbs import TopAbs_FACE
from OCP.TopExp import TopExp_Explorer
from OCP.gp import gp_Ax2, gp_Circ, gp_Dir, gp_Pnt, gp_Trsf, gp_Vec

# Faces Fission uses per primitive vs OpenCascade. Fission splits a sphere
# into two hemispheres (one face with no edges can't satisfy Euler-Poincare
# in its data structure); OpenCascade uses one face with a seam.
FACES = {"Box": (6, 6), "Cylinder": (3, 3), "Sphere": (2, 1)}

REL = 1e-9  # OpenCascade's exact mass properties vs exact-in-theory values


def pieces(ring):
    """A profile loop as pieces, worked out here independently of both
    kernels: ("line", a, b), ("arc", a, mid, b) or ("circle", centre, r).
    An arc of bulge b over chord a->b turns phi = 4 atan b; its radius is
    |ab| / (2 |sin(phi/2)|) and its centre sits on the chord's perpendicular
    bisector, r cos(phi/2) to the left when phi > 0 (right when phi < 0)."""
    (kind, p), = ring.items()
    if kind == "Circle":
        return [("circle", tuple(float(v) for v in p["c"]), float(p["r"]))]
    pts = [(float(x), float(y)) for x, y in p["pts"]]
    bulges = [float(b) for b in p["bulges"]] or [0.0] * len(pts)
    out = []
    for i, a in enumerate(pts):
        b, bulge = pts[(i + 1) % len(pts)], bulges[i]
        if bulge == 0.0:
            out.append(("line", a, b))
            continue
        phi = 4.0 * math.atan(bulge)
        dx, dy = b[0] - a[0], b[1] - a[1]
        chord = math.hypot(dx, dy)
        r = chord / (2.0 * abs(math.sin(phi / 2.0)))
        k = r * math.cos(phi / 2.0) * math.copysign(1.0, phi) / chord
        cx, cy = (a[0] + b[0]) / 2.0 - dy * k, (a[1] + b[1]) / 2.0 + dx * k
        t = math.atan2(a[1] - cy, a[0] - cx) + phi / 2.0
        out.append(("arc", a, (cx + r * math.cos(t), cy + r * math.sin(t)), b, r, phi))
    return out


def signed_area(ps):
    """Twice the signed area: shoelace plus each arc's circular segment."""
    twice = 0.0
    for piece in ps:
        if piece[0] == "circle":
            return 2.0 * math.pi * piece[2] ** 2
        a, b = piece[1], piece[-1] if piece[0] == "line" else piece[3]
        twice += a[0] * b[1] - b[0] * a[1]
        if piece[0] == "arc":
            r, phi = piece[4], piece[5]
            twice += r * r * (phi - math.sin(phi))
    return twice


def wire(ps, ccw):
    """Closed wire at z = 0 from pieces, wound counter-clockwise (outer
    loops) or clockwise (holes), as OpenCascade's face builder expects."""
    if ps[0][0] == "circle":
        (cx, cy), r = ps[0][1], ps[0][2]
        axis = gp_Dir(0.0, 0.0, 1.0 if ccw else -1.0)
        edge = BRepBuilderAPI_MakeEdge(gp_Circ(gp_Ax2(gp_Pnt(cx, cy, 0.0), axis), r)).Edge()
        return BRepBuilderAPI_MakeWire(edge).Wire()
    if (signed_area(ps) > 0) != ccw:
        # Run it backwards: pieces in reverse order, each from its end.
        ps = [(q[0], q[2], q[1]) if q[0] == "line" else (q[0], q[3], q[2], q[1]) for q in reversed(ps)]
    pnt = lambda xy: gp_Pnt(xy[0], xy[1], 0.0)
    w = BRepBuilderAPI_MakeWire()
    for q in ps:
        if q[0] == "line":
            w.Add(BRepBuilderAPI_MakeEdge(pnt(q[1]), pnt(q[2])).Edge())
        else:
            arc = GC_MakeArcOfCircle(pnt(q[1]), pnt(q[2]), pnt(q[3])).Value()
            w.Add(BRepBuilderAPI_MakeEdge(arc).Edge())
    return w.Wire()


def extrusion(p):
    face = BRepBuilderAPI_MakeFace(wire(pieces(p["outer"]), True), True)
    for hole in p["holes"]:
        face.Add(wire(pieces(hole), False))
    return BRepPrimAPI_MakePrism(face.Face(), gp_Vec(0.0, 0.0, float(p["dist"]))).Shape()


def curved(p):
    rings = [p["outer"]] + p["holes"]
    return any("Circle" in r or any(float(b) != 0.0 for b in r["Path"]["bulges"]) for r in rings)


def build(shape):
    (kind, p), = shape.items()
    if kind == "Extrude":
        # Two caps plus one side face per profile piece (one per circle),
        # in both kernels.
        count = sum(len(pieces(r)) for r in [p["outer"]] + p["holes"])
        FACES["Extrude"] = (2 + count, 2 + count)
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
    if kind == "Extrude" and curved(case["shape"]["Extrude"]):
        # Arcs bulge either way (concave walls too), so the mesh can be on
        # either side of the exact solid, by at most the harness's chord
        # allowance (arc length x chord sag, see Piece::curve).
        if abs(case["volume"] - vol) > case["curve_volume_slack"] + vslack:
            issues.append(f"volume: fission {case['volume']}, occ {vol}, allowed {case['curve_volume_slack'] + vslack:.3g}")
        if abs(case["area"] - area) > case["curve_area_slack"] + aslack:
            issues.append(f"area: fission {case['area']}, occ {area}, allowed {case['curve_area_slack'] + aslack:.3g}")
        return kind, issues
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
