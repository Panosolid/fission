"""OpenCascade oracle: rebuild every body the stateful harness produced and
compare it with what the Panosolid kernel reported.

Input: the JSONL file written by the harness with FISSION_ORACLE_OUT. Each
line has the primitive ("shape"), the 3x4 placement matrix the harness
tracked independently of the kernel, and the kernel's numbers (exact volume
and area from its B-rep, volume and area of its display mesh, bounds, face
count, and the mesh's largest deviation from the exact surface).

OpenCascade isn't always right either: disagreements are logged for review,
not treated as kernel failures. Every shape the harness makes also has an
exact volume and area (exact.py, 50 digits, needs mpmath), which referees:
Panosolid is compared with the exact value, and a case where only
OpenCascade is off is its own rounding, listed as "occ-rounding" at the end
of the file but not counted as a disagreement (without mpmath, OpenCascade
is the reference, as before).

Each line also carries the body's STEP file (step 29b), which OpenCascade
reads and checks as it is (step_check.py, `step_issues`), or why the
kernel's writer refused it.

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
import step_check

try:
    import exact
except ImportError:  # pip install mpmath
    exact = None

# Faces Panosolid uses per primitive vs OpenCascade. Panosolid splits a sphere
# into two hemispheres (one face with no edges can't satisfy Euler-Poincare
# in its data structure); OpenCascade uses one face with a seam.
FACES = {"Box": (6, 6), "Cylinder": (3, 3), "Sphere": (2, 1)}

REL = 1e-9  # OpenCascade's exact mass properties vs exact-in-theory values

# A STEP body with a radius under this that OpenCascade can't read in any
# exact copy is its limit, not a finding (`step_issues`): 1000 LINEAR, twice
# the largest radius seen failing (5 µm).
SMALL_FEATURE = 0.01
SMALL_LIMIT = "OpenCascade's small-feature limit"
# A STEP body OpenCascade's own rebuild of the same shape calls invalid
# too, though no two of its pieces meet (fuzz_shapes.py: its 1e-7 mm
# tubes round each edge, near a sharp corner or a nearly tangent piece):
# its checker's verdict on the file is its tolerance, not a finding
# (`step_issues`); the file's faces, volume and area still count.
OCC_TOLERANCE = "OpenCascade's tolerance (its own rebuild is invalid too)"
# A STEP volume OpenCascade misses on a body whose flat faces have holes
# nearly as big as their outlines, by no more than the loop area that
# cancels there times the harness's rounding per corner (`one_step_copy`;
# #282, owner's decision 2026-10-24, on condition that it stays in view):
# listed under this heading, never dropped, so the nightly results show
# every miss it excuses.
CANCELLED_LOOPS = "OpenCascade's cancelling loops"
# A STEP file whose only BRepCheck complaint is a loop crossing itself
# (`step_check.crossing_only`) when no two pieces of the profile meet at 50
# digits (crossings.py): OpenCascade's 1e-7 mm at a sharp corner (#293,
# owner's decision 2026-10-24; its verdict there flipped with one unit in
# the last place). Listed under this heading, never dropped, and only the
# checker's verdict: the file's faces, volume and area still count.
SHARP_CORNER = "OpenCascade's tolerance at a sharp corner (no crossing at 50 digits)"


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


def step_issues(case, rebuilt, ref, slack, occ_invalid=False):
    """The body as the kernel holds it, read from its STEP file (step 29b,
    kernel/src/step_write.rs, step_check.py): OpenCascade's checker must
    call it valid with every tolerance within LINEAR, it must have the
    kernel's faces (a sphere is two here, the kernel's two halves, though
    OpenCascade builds one), and its volume and area must be the exact
    referee's within the harness's slacks. A body the harness held valid
    that the writer refused is a finding too.

    The file is judged as written and, when that fails and the part is far
    out, as an exact copy of the same body moved home (`step_check.home`):
    OpenCascade loses digits far out, and a real fault (a face turned, a
    loop walked backwards, a gap over LINEAR) is in both alike, so the body
    passes when either passes every check; a miss as written is then listed
    with OpenCascade's rounding, not counted. When neither passes, the
    home copy's problems are the finding, except in a body with a radius
    under SMALL_FEATURE whose misses its small features can explain
    (`small_reach`, below).

    No copy is blown up to rescue a small feature: a 1 µm cylinder blown
    up 1024 times reads valid with its exact volume, but so did one with a
    cap planted flipped (29b2's planted-fault run in CI), so a pass there
    proves nothing.

    `rebuilt` is OpenCascade's own rebuild's (volume, area), the reference
    without mpmath; with it, a miss no bigger than the rebuild's own miss of
    the exact value (plus the slack) is OpenCascade's rounding, listed but
    not counted, like compare's own. `occ_invalid`: that rebuild is invalid
    too with no real crossing (OCC_TOLERANCE), so the checker's verdict on
    the file is listed, not counted, and the rest still is."""
    issues, occ_only = [], []
    if case.get("step_refused") is not None:
        issues.append(f"step write refused: {case['step_refused']}")
    text = case.get("step")
    if text is None:
        return issues, occ_only  # refused, or a line from before step 29b
    copies = [("as written", text)]
    moved, shift = step_check.home(text)
    if any(shift):
        copies.append((f"moved home by {shift}", moved))
    tried, simple = [], None
    for label, t in copies:
        r = step_check.check_text(t)
        found, rounding = one_step_copy(case, r, rebuilt, ref, slack)
        excused = []
        if occ_invalid:
            excused = [f"{OCC_TOLERANCE}: {note} ({label})" for note in found if note.startswith("step validity")]
            found = [note for note in found if not note.startswith("step validity")]
        elif r.crossing_only and any(n.startswith("step validity") for n in found):
            if simple is None:
                simple = never_crosses(case["shape"])
            if simple:
                excused = [f"{SHARP_CORNER}: {note} ({label})" for note in found if note.startswith("step validity")]
                found = [note for note in found if not note.startswith("step validity")]
        if not found:
            occ_only += [f"{note} (as written; passes {label})" for _, notes, _ in tried for note in notes if "validity" in note]
            return issues, occ_only + rounding + excused
        tried.append((label, found, r))
    label, found, r = tried[-1]
    occ_only += excused  # the last copy's, beside what is counted or limited
    reach = small_reach(text)
    if reach is not None:
        # OpenCascade's own limit (29b2's first runs: it lost the side of a
        # 1 µm cylinder whose top circle's centre sat 3e-9 mm off the axis,
        # 3,000 times inside LINEAR, and called it valid; every body it
        # couldn't read had a radius of 1-5 µm): listed under its own
        # heading, not counted, but only while its volume and area are
        # missed by no more than the small features could account for. A
        # radius alone once excused anything (29b3: a planted flipped cap
        # on a 441 mm part with a 7 µm hole, its area 6,095 read for
        # 580,809), so a fault in a part of ordinary size is still found
        # however small one of its features is. Kept in view in
        # docs/progress/booleans.md until something else checks such files.
        volume_bound, area_bound = reach
        for got, want, theirs, allowed, bound in ((r.volume, ref[0], rebuilt[0], slack[0], volume_bound),
                                                  (r.area, ref[1], rebuilt[1], slack[1], area_bound)):
            if not abs(got - float(want if want is not None else theirs)) <= allowed + bound:
                break
        else:
            return issues, occ_only + [f"{SMALL_LIMIT}: {note} ({label})" for note in found]
    return issues + [f"{note} ({label})" for note in found], occ_only


def planted_caught(total, found, small):
    """For a run whose every STEP file was written with a face planted
    flipped (FISSION_STEP_FAULT): whether the oracle caught it in every
    body, each a finding or under the small-feature limit, and in at least
    one (so a run that checked nothing can't pass). Prints the verdict."""
    caught = found > 0 and found + small == total
    print("the planted fault was caught in every body" if caught else
          f"the planted fault was NOT caught in every body: {total} bodies, {found} findings, {small} under the small-feature limit")
    return caught


def small_reach(text):
    """How much of a body's volume and area its small features (each circle,
    cylinder and sphere in the file with a radius under SMALL_FEATURE) could
    hold, or None when it has none: each counted as a cylinder of its radius
    r reaching right across the body (the diagonal L of its points' box),
    π r² L of volume and 2π r L + 2π r² of area, the most OpenCascade
    could lose or invent by misreading it (it lost a 1 µm cylinder's whole
    side, 29b2). A circle is counted for each cap edge and its side, so
    generously, but always in proportion to the small features alone."""
    small = [r for r in (float(m.group(2)) for m in step_check.RADIUS.finditer(text)) if r < SMALL_FEATURE]
    if not small:
        return None
    points = [[float(m.group(k)) for k in (2, 3, 4)] for m in step_check.POINT.finditer(text)]
    diagonal = math.dist([min(p[k] for p in points) for k in range(3)], [max(p[k] for p in points) for k in range(3)])
    return (sum(math.pi * r * r * diagonal for r in small),
            sum(2.0 * math.pi * r * diagonal + 2.0 * math.pi * r * r for r in small))


def never_crosses(shape):
    """Whether the shape is a profile none of whose pieces meet anywhere
    but the corners neighbours share, worked out at 50 digits
    (crossings.py); False for any other shape or without mpmath, so
    nothing is excused then."""
    if "Extrude" not in shape:
        return False
    try:
        import crossings
    except ImportError:
        return False
    return not crossings.crossings(shape)


def cancelled_room(case, r):
    """The extra room a STEP volume gets for loops that cancel on its flat
    faces (`step_check.cancelled_area`, #282): that area times the
    harness's rounding allowance per corner, delta. The harness's volume
    slack is the body's area times delta (kernel/tests/stateful.rs,
    "volume_slack"), which counts each face once; OpenCascade integrates a
    face with holes loop by loop, so each loop's area is moved by rounding
    of up to delta at its corners. A face with one loop adds nothing, and a
    hole walked the wrong way adds to the face's area instead of cancelling,
    so it gets nothing either."""
    if not case.get("area") or not r.cancelled:
        return 0.0
    return r.cancelled * case["volume_slack"] / case["area"]


def one_step_copy(case, r, rebuilt, ref, slack):
    """One copy's findings and OpenCascade-only misses (`step_issues`)."""
    found, rounding = [f"step validity: {p}" for p in r.problems], []
    if r.faces != case["faces"]:
        found.append(f"step faces: OpenCascade read {r.faces}, the kernel has {case['faces']}")
    for name, got, theirs, exact_value, allowed in (("step volume", r.volume, rebuilt[0], ref[0], slack[0]),
                                                    ("step area", r.area, rebuilt[1], ref[1], slack[1])):
        reference = theirs if exact_value is None else float(exact_value)
        if abs(got - reference) <= allowed:
            continue
        note = f"{name}: OpenCascade read {got!r} from the file, {'exact' if exact_value is not None else 'its rebuild'} {reference!r}, allowed {allowed:.3g}"
        # OpenCascade's rounding only when reading the file came out no
        # worse than its own rebuild of the shape (29b2's planted-fault run:
        # a rebuild a hair over the slack had excused a file that lost both
        # caps of a 1 µm cylinder, 1,300 times the slack).
        room = cancelled_room(case, r) if name == "step volume" else 0.0
        if exact_value is not None and abs(got - reference) <= abs(theirs - reference) + allowed:
            rounding.append(note + f" (its rebuild {theirs!r} is off too)")
        elif abs(got - reference) <= allowed + room:
            rounding.append(f"{CANCELLED_LOOPS}: {note}, with {room:.3g} for {r.cancelled:.6g} mm2 of loops cancelling")
        else:
            found.append(note)
    return found, rounding


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
    # value referees when Panosolid and OpenCascade differ.
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
    more, more_occ = step_issues(case, (vol, area), (ev, ea), (vslack, aslack))
    issues += more
    occ_only += more_occ
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
    total, bad, steps, per_kind, lines, occ_lines = 0, 0, 0, Counter(), [], []
    with open(path) as f:
        for n, line in enumerate(f, 1):
            case = json.loads(line)
            steps += case.get("step") is not None
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
    print(f"  {steps} of them also read from their STEP files and checked (step 29b)")
    if exact is None:
        print("  (mpmath not installed: no exact referee, OpenCascade is the reference)")
    small = sum(1 for l in occ_lines if SMALL_LIMIT in l)
    cancelling = sum(1 for l in occ_lines if CANCELLED_LOOPS in l)
    print(f"  {len(occ_lines) - small} more where only OpenCascade was off the exact value (its own rounding, not counted)")
    print(f"  {cancelling} of them a STEP volume missed on flat faces whose holes nearly fill them "
          f"(its cancelling loops, #282; listed, not counted)")
    sharp = sum(1 for l in occ_lines if SHARP_CORNER in l)
    print(f"  {sharp} of them a STEP file called crossed at a sharp corner that never crosses at 50 digits "
          f"(its tolerance, #293; listed, not counted)")
    print(f"  {small} more with a radius under {SMALL_FEATURE} mm that OpenCascade couldn't read from the STEP file "
          f"in any copy (its small-feature limit, not counted)")
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
