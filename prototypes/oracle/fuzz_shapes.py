"""OpenCascade oracle for the kernel's coverage-guided fuzzers (nasty
inputs 2b).

Input: the JSONL file kernel/tests/fuzz_corpus.rs writes with
FISSION_ORACLE_OUT, one line per body a fuzz input built: which fuzzer
("target": extrude, sketch or placed), the input's name, the shape as
given (compare.py's format), and the kernel's exact volume and area (from
its B-rep, kernel/src/mass.rs), face count and bounds. A placed body was
moved and turned any number of times first, so its numbers come from the
baked body, where placement rounding shows; its bounds are not compared.

Each body is checked three ways:
- volume and area against the exact values (exact.py, 50 digits, from the
  very doubles the kernel was given, no shared code with the kernel), to
  the rounding the shape allows (`allowed`);
- face count against OpenCascade's rebuild (Panosolid's hemispheres: 2 faces
  where OpenCascade has 1);
- bounds against OpenCascade's for extrudes;
- validity: an extrude's profile, which the kernel accepted, must not cross
  itself (crossings.py, at 50 digits); OpenCascade's validity check
  (BRepCheck_Analyzer) runs on its rebuild too, and where it calls a shape
  invalid that has no real crossing, that is its 1e-7 mm tolerance (sharp
  corners, huge nearly-half circles), listed but not counted.
OpenCascade's own volume and area are compared with the exact values too;
where only it is off, that is its rounding: counted, not a finding.
- the body itself, as the kernel holds it (step 29b3): its STEP file
  ("step", or "step_refused" with the writer's words) read by OpenCascade
  and judged as compare.py's `step_issues` judges the stateful harness's
  bodies: valid with every tolerance within LINEAR, the kernel's faces,
  and the exact volume and area to the same allowance; a refusal is a
  finding; a body with a radius under compare.SMALL_FEATURE that
  OpenCascade can't read in any copy, missed by no more than its small
  features could hold, is listed under its small-feature limit, and where
  OpenCascade's own rebuild is invalid too (above), its checker's verdict
  on the file is listed under its tolerance; neither is counted. A line
  without "step" (from before 29b3) skips it.

Usage: python fuzz_shapes.py cases.jsonl [disagreements.txt] [--planted]
  --planted: the files were written with FISSION_STEP_FAULT (a face
  flipped in every one): passes only when every body is a disagreement or
  under compare.py's small-feature limit, and at least one is one.
Needs: pip install cadquery-ocp mpmath
"""

import json
import math
import sys
from collections import Counter

import crossings
import exact
from pieces import pieces

REL = 1e-9  # as compare.py and the fuzz checks (kernel/fuzz/checks.rs)
EPS = 2.0 ** -52


def reach(shape):
    """The largest coordinate an extrude's profile reaches (a circle its
    centre's plus its radius): the kernel works its volume and area about
    the body's own centre, and each coordinate taken from that centre
    rounds by up to EPS times this."""
    (_, p), = shape.items()
    most = 0.0
    for r in [p["outer"]] + p["holes"]:
        (k, q), = r.items()
        if k == "Circle":
            most = max(most, *(abs(float(v)) + abs(float(q["r"])) for v in q["c"]))
        else:
            most = max(most, *(abs(float(v)) for xy in q["pts"] for v in xy))
    return most


def size_perimeter(shape):
    """The extrude's profile measured as the fuzz check measures it: the
    absolute triangle and segment areas added up (a thin part's area is a
    difference of big ones, and rounds like them), the perimeter, and the
    number of pieces."""
    (kind, p), = shape.items()
    size, perimeter, n = 0.0, 0.0, 0
    for r in [p["outer"]] + p["holes"]:
        for q in pieces(r):
            n += 1
            if q[0] == "circle":
                size += math.pi * q[2] ** 2
                perimeter += 2.0 * math.pi * q[2]
                continue
            a = q[1]
            b = q[2] if q[0] == "line" else q[3]
            o = pieces(r)[0][1]
            size += abs((a[0] - o[0]) * (b[1] - o[1]) - (b[0] - o[0]) * (a[1] - o[1])) / 2.0
            if q[0] == "line":
                perimeter += math.dist(a, b)
            else:
                rad, phi = q[4], q[5]
                size += abs(rad * rad * (phi - math.sin(phi)) / 2.0)
                perimeter += rad * abs(phi)
    return size, perimeter, n


def allowed(case, volume, area):
    """How far Panosolid's exact volume and area may be from the exact ones:
    REL of the answer and of the profile's size (the kernel's volume of a
    thin part is a difference of bigger triangle and segment areas), plus
    every coordinate's rounding, 64 EPS of how far the body reaches (step):
    a corner moved by step changes the volume by at most the area it
    sweeps, perimeter x d x step for an extrude and area x step for a moved
    body, and the area by at most the edges' length times step (an
    extrude: each piece's length changes by 2 step, its side by 2 step d,
    and each cap by perimeter x step)."""
    (kind, p), = case["shape"].items()
    if kind == "Extrude":
        d, step = abs(float(p["dist"])), 64.0 * EPS * reach(case["shape"])
        size, perimeter, n = size_perimeter(case["shape"])
        return (REL * (abs(volume) + size * d) + perimeter * d * step,
                REL * (abs(area) + 2.0 * size) + (2.0 * perimeter + 2.0 * n * d) * step)
    most = max(abs(x) for x in case["lo"] + case["hi"])
    num = {k: abs(float(v)) for k, v in p.items()}
    edges = {"Box": lambda: 4.0 * (num["w"] + num["d"] + num["h"]),
             "Cylinder": lambda: 4.0 * math.pi * num["r"],
             "Sphere": lambda: 2.0 * math.pi * num["r"]}[kind]()
    step = 64.0 * EPS * most
    return REL * abs(volume) + area * step, REL * abs(area) + edges * step


# Faces per primitive (Panosolid, OpenCascade), as compare.py.
FACES = {"Box": (6, 6), "Cylinder": (3, 3), "Sphere": (2, 1)}


def check(case, occ=None):
    """(issues, occ_only) for one case. `occ` is compare.py's module, or
    None for the exact checks alone (tests without OpenCascade)."""
    shape = case["shape"]
    (kind, _), = shape.items()
    ev, ea = exact.volume_area(shape)
    vslack, aslack = allowed(case, float(ev), float(ea))
    where = f"({case['target']}: {case['input']})"
    issues, occ_only = [], []
    for name, ours, ref, slack in (("volume", case["fission_volume"], ev, vslack), ("area", case["fission_area"], ea, aslack)):
        if not abs(exact.mpf(ours) - ref) <= slack:
            issues.append(f"{name}: fission {ours!r}, exact {float(ref)!r}, allowed {slack:.3g} {where}")
    if occ is None:
        return issues, occ_only
    built_kind, solid, _ = occ.build(occ.centred(shape))
    vol, area, _, _, faces = occ.measure(solid)
    want = FACES.get(kind, (case["fission_faces"], case["fission_faces"]))
    if kind == "Extrude":
        n = 2 + sum(len(pieces(r)) for r in [shape["Extrude"]["outer"]] + shape["Extrude"]["holes"])
        want = (n, n)
    if (case["fission_faces"], faces) != want:
        issues.append(f"faces: fission {case['fission_faces']}, occ {faces}, expected {want} {where}")
    # Validity: the kernel accepted the profile, so it must be simple, at
    # 50 digits; OpenCascade calling it invalid with no real crossing is
    # its tolerance (1e-7 mm tubes round each edge meet near a sharp corner
    # or along a nearly tangent piece), not counted.
    met = crossings.crossings(shape) if kind == "Extrude" else []
    for k, i, kk, j, x in met[:3]:
        issues.append(f"validity: loop {k} piece {i} meets loop {kk} piece {j} at {x} {where}")
    occ_invalid = not met and not analyzer_valid(solid)
    if occ_invalid:
        occ_only.append("validity: occ calls it invalid, but no two pieces meet at 50 digits")
    if kind == "Extrude":
        _, placed, _ = occ.build(shape)
        lo, hi = occ.measure(placed)[2:4]
        reach = max(abs(x) for x in lo + hi) or 1.0
        names = ["lowest x", "lowest y", "lowest z", "highest x", "highest y", "highest z"]
        for axis, ours, theirs in zip(names, case["lo"] + case["hi"], lo + hi):
            # OpenCascade's optimal box is tight to ~1e-7 (compare.py).
            if abs(ours - theirs) > 1e-6 + REL * reach:
                issues.append(f"bounds {axis}: fission {ours!r}, occ {theirs!r} {where}")
    for name, theirs, ref, slack in (("volume", vol, ev, vslack), ("area", area, ea, aslack)):
        if not abs(exact.mpf(theirs) - ref) <= slack:
            occ_only.append(f"{name}: occ {theirs!r}, exact {float(ref)!r}")
    more, more_occ = occ.step_issues({**case, "faces": case["fission_faces"]}, (vol, area), (ev, ea), (vslack, aslack), occ_invalid)
    return issues + [f"{m} {where}" for m in more], occ_only + more_occ


def analyzer_valid(solid):
    from OCP.BRepCheck import BRepCheck_Analyzer
    return BRepCheck_Analyzer(solid).IsValid()


def main():
    import compare
    args = [a for a in sys.argv[1:] if a != "--planted"]
    path = args[0]
    out = args[1] if len(args) > 1 else None
    total, bad, steps, per, lines, occ_lines = 0, 0, 0, Counter(), [], []
    with open(path) as f:
        for n, line in enumerate(f, 1):
            case = json.loads(line)
            steps += case.get("step") is not None
            try:
                issues, occ_only = check(case, compare)
            except Exception as e:  # an oracle crash is itself worth a look
                issues, occ_only = [f"oracle error: {e!r} ({case.get('target')}: {case.get('input')})"], []
            total += 1
            per[case.get("target")] += 1
            if issues:
                bad += 1
                # compare.py's format, which file_issues.py reads.
                lines.append(f"line {n}: {json.dumps(case['shape'])}\n  " + "\n  ".join(issues))
            elif occ_only:
                occ_lines.append(f"occ-rounding, line {n}: {json.dumps(case['shape'])}\n  " + "\n  ".join(occ_only))
    print(f"Fuzz oracle: {total} fuzz bodies compared with the exact values and OpenCascade, {bad} disagreement(s)")
    print(f"  {steps} of them also read from their STEP files and checked (step 29b3)")
    small = sum(1 for l in occ_lines if compare.SMALL_LIMIT in l)
    print(f"  {len(occ_lines) - small} more where only OpenCascade disagreed with the exact values (its own rounding or tolerance, not counted)")
    print(f"  {small} more with a radius under {compare.SMALL_FEATURE} mm that OpenCascade couldn't read from the STEP file "
          f"in any copy (its small-feature limit, not counted)")
    sharp = sum(1 for l in occ_lines if compare.SHARP_CORNER in l)
    print(f"  {sharp} of them a STEP file called crossed at a sharp corner that never crosses at 50 digits "
          f"(its tolerance, #293; listed, not counted)")
    for k, v in sorted(per.items()):
        print(f"  {k:<8} {v}")
    if out:
        with open(out, "w") as f:
            f.write("\n".join(lines + occ_lines) + "\n")
    for l in lines[:20]:
        print(l)
    if "--planted" in sys.argv[1:]:
        sys.exit(0 if compare.planted_caught(total, bad, small) else 1)
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
