"""OpenCascade oracle: rebuild every body the stateful harness produced and
compare it with what the Fission kernel reported.

Input: the JSONL file written by the harness with FISSION_ORACLE_OUT. Each
line has the primitive ("shape"), the 3x4 placement matrix the harness
tracked independently of the kernel, and the kernel's numbers (exact volume
and area from its B-rep, volume and area of its display mesh, bounds, face
count, and the mesh's largest deviation from the exact surface).

OpenCascade isn't always right either: disagreements are logged for review,
not treated as kernel failures. Every shape the harness makes also has an
exact volume and area (exact.py, 50 digits, needs mpmath), which referees:
Fission is compared with the exact value, and a case where only
OpenCascade is off is its own rounding, listed as "occ-rounding" at the end
of the file but not counted as a disagreement (without mpmath, OpenCascade
is the reference, as before).

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

from pieces import pieces, signed_area

try:
    import exact
except ImportError:  # pip install mpmath
    exact = None

# Faces Fission uses per primitive vs OpenCascade. Fission splits a sphere
# into two hemispheres (one face with no edges can't satisfy Euler-Poincare
# in its data structure); OpenCascade uses one face with a seam.
FACES = {"Box": (6, 6), "Cylinder": (3, 3), "Sphere": (2, 1)}

REL = 1e-9  # OpenCascade's exact mass properties vs exact-in-theory values


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
        ps = [(q[0], q[2], q[1]) if q[0] == "line" else (q[0], q[3], q[2], q[1], q[4], -q[5]) for q in reversed(ps)]
    pnt = lambda xy: gp_Pnt(xy[0], xy[1], 0.0)
    w = BRepBuilderAPI_MakeWire()
    for q in ps:
        if q[0] == "line":
            w.Add(BRepBuilderAPI_MakeEdge(pnt(q[1]), pnt(q[2])).Edge())
        else:
            # From its centre and radius, not through three points: for a
            # nearly whole circle the two ends are close together, and the
            # circle through them and a far point is ill-conditioned (its
            # centre slid 0.5 um along the chord for a 60 m arc, issue #73).
            _, a, (cx, cy), b, r, phi = q
            circ = gp_Circ(gp_Ax2(gp_Pnt(cx, cy, 0.0), gp_Dir(0.0, 0.0, math.copysign(1.0, phi))), r)
            w.Add(BRepBuilderAPI_MakeEdge(GC_MakeArcOfCircle(circ, pnt(a), pnt(b), True).Value()).Edge())
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


def centred(shape):
    """The same extrusion with its profile moved to around the origin when
    it was drawn farther out than its own size: volume and area don't
    change with a move, but OpenCascade integrates them in the coordinates
    it is given, and a profile drawn 50-100 km out lost up to 3x of its
    volume there (seed 110640103211452: 6.26 for an exact 2.09). Each
    coordinate minus a centre within a factor of two of it is exact
    (Sterbenz), so this is the same shape, not a rounded copy."""
    (kind, p), = shape.items()
    if kind != "Extrude":
        return shape
    rings = [p["outer"]] + p["holes"]
    xs, ys = [], []
    for r in rings:
        (k, q), = r.items()
        pts = [q["c"]] if k == "Circle" else q["pts"]
        xs += [float(x) for x, _ in pts]
        ys += [float(y) for _, y in pts]
    c = ((min(xs) + max(xs)) / 2.0, (min(ys) + max(ys)) / 2.0)
    if max(abs(c[0]), abs(c[1])) <= max(max(xs) - min(xs), max(ys) - min(ys)):
        return shape
    move = lambda xy: [repr(float(xy[0]) - c[0]), repr(float(xy[1]) - c[1])]
    def ring(r):
        (k, q), = r.items()
        if k == "Circle":
            return {k: {**q, "c": move(q["c"])}}
        return {k: {**q, "pts": [move(xy) for xy in q["pts"]]}}
    return {kind: {**p, "outer": ring(p["outer"]), "holes": [ring(h) for h in p["holes"]]}}


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
    _, lo, hi, faces = measure(place(shape, case["matrix"]))[1:]
    # Volume and area from the unplaced shape, around its own centre: a
    # rigid motion changes neither, and OpenCascade's integration loses
    # digits on a big thin part turned and moved far out (a 32 m frame
    # 0.0011 mm wide: 3.5e-4 of its volume placed, 4.6e-10 unplaced, with
    # the exact value worked out in fractions). The kernel's own placement
    # rounding is still covered: its mesh numbers are from the placed body.
    vol, area = measure(build(centred(case["shape"]))[1])[:2]
    issues, occ_only = [], []
    if (case["faces"], faces) != FACES[kind]:
        issues.append(f"faces: fission {case['faces']}, occ {faces}, expected {FACES[kind]}")
    reach = max(abs(x) for x in lo + hi) or 1.0
    # All six: zipping with "xyz" alone stopped after the lowest three, so
    # the highest bounds went unchecked until nasty inputs 2b.
    names = ["lowest x", "lowest y", "lowest z", "highest x", "highest y", "highest z"]
    for axis, ours, theirs in zip(names, case["lo"] + case["hi"], lo + hi):
        # OCC's optimal box is tight to ~1e-7; ours is exact for these shapes.
        if abs(ours - theirs) > 1e-6 + REL * reach:
            issues.append(f"bounds {axis}: fission {ours}, occ {theirs}")
    dev = case["max_deviation"]
    # Rounding allowances computed by the harness from how far the shape
    # sits from the origin (moving a vertex by d changes volume by at most
    # area x d and area by at most perimeters x d).
    vslack = case["volume_slack"] + REL * vol
    aslack = case["area_slack"] + REL * area
    # The kernel's exact volume and area (from its B-rep, not its mesh)
    # have no chords to allow for: they must match to rounding. The exact
    # value referees when Fission and OpenCascade differ.
    ev, ea = (exact.volume_area(case["shape"]) if exact else None) or (None, None)
    for name, ours, theirs, ref, slack in (("exact volume", case["exact_volume"], vol, ev, vslack),
                                           ("exact area", case["exact_area"], area, ea, aslack)):
        if exact:
            verdict = exact.judge(ours, theirs, ref, slack)
        else:
            verdict = "agree" if abs(ours - theirs) <= slack else "fission"
        note = f"{name}: fission {ours}, occ {theirs}" + (f", exact {float(ref)!r}" if ref is not None else "")
        if verdict == "fission":
            issues.append(f"{note}, allowed {slack:.3g}")
        elif verdict == "occ":
            occ_only.append(f"{note}, allowed {slack:.3g}")
    # The mesh checks below measure against the exact value when there is
    # one, so OpenCascade's rounding can't hide or fake a mesh error.
    who = "occ"
    if ev is not None:
        vol, area, who = float(ev), float(ea), "exact"
    if kind == "Extrude" and curved(case["shape"]["Extrude"]):
        # Arcs bulge either way (concave walls too), so the mesh can be on
        # either side of the exact solid, by at most the harness's chord
        # allowance (arc length x chord sag, see Piece::curve).
        if abs(case["volume"] - vol) > case["curve_volume_slack"] + vslack:
            issues.append(f"volume: fission {case['volume']}, {who} {vol}, allowed {case['curve_volume_slack'] + vslack:.3g}")
        if abs(case["area"] - area) > case["curve_area_slack"] + aslack:
            issues.append(f"area: fission {case['area']}, {who} {area}, allowed {case['curve_area_slack'] + aslack:.3g}")
        return kind, issues, occ_only
    # An inscribed mesh of a convex solid never has more volume or area
    # than the solid itself.
    if case["volume"] > vol + vslack:
        issues.append(f"volume above exact: fission {case['volume']}, {who} {vol}, allowed {vslack:.3g}")
    if case["area"] > area + aslack:
        issues.append(f"area above exact: fission {case['area']}, {who} {area}, allowed {aslack:.3g}")
    # And it can't fall short by more than (surface area) x (largest gap
    # between mesh and surface), plus rounding. Boxes are exact.
    if vol - case["volume"] > area * dev * 1.5 + vslack:
        issues.append(f"volume deficit too large: fission {case['volume']}, {who} {vol}, deviation {dev}")
    # Boxes and extrusions are polyhedra: the mesh is exact, area too.
    if kind in ("Box", "Extrude") and abs(case["area"] - area) > aslack:
        issues.append(f"area: fission {case['area']}, {who} {area}, allowed {aslack:.3g}")
    return kind, issues, occ_only


def main():
    path = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 else None
    total, bad, per_kind, lines, occ_lines = 0, 0, Counter(), [], []
    with open(path) as f:
        for n, line in enumerate(f, 1):
            case = json.loads(line)
            try:
                kind, issues, occ_only = compare(case)
            except Exception as e:  # an oracle crash is itself worth a look
                kind, issues, occ_only = "?", [f"oracle error: {e!r}"], []
            total += 1
            per_kind[kind] += 1
            if issues:
                bad += 1
                lines.append(f"line {n}: {json.dumps(case['shape'])}\n  " + "\n  ".join(issues))
            if occ_only:
                occ_lines.append(f"occ-rounding, line {n}: {json.dumps(case['shape'])}\n  " + "\n  ".join(occ_only))
    print(f"Oracle: {total} bodies compared with OpenCascade, {bad} disagreement(s)")
    if exact is None:
        print("  (mpmath not installed: no exact referee, OpenCascade is the reference)")
    print(f"  {len(occ_lines)} more where only OpenCascade was off the exact value (its own rounding, not counted)")
    for k, v in sorted(per_kind.items()):
        print(f"  {k:<9} {v}")
    for l in lines[:20]:
        print(l)
    if out:
        with open(out, "w") as f:
            f.write("\n".join(lines + occ_lines) + "\n")
        print(f"Disagreements written to {out}")


if __name__ == "__main__":
    main()
