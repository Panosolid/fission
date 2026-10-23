"""OpenCascade oracle for the sketch-and-extrude sessions.

Input: the oracle.jsonl the long session run writes
(packages/testing/fuzz/sketch-extrude.ts with FISSION_FUZZ_OUT). Each line is
an extrude a simulated user drew with Design's tools: the outline the kernel
was given ("shape", in compare.py's format), the kernel's exact volume, area
and face count, and the session model's volume and area (worked out from the
clicks, apart from Design and the kernel).

Each extrude is rebuilt in OpenCascade (compare.py's builder, the profile
moved near the origin first) and given its 50-digit exact volume and area
(exact.py). Three numbers are checked against the exact ones, each to
REL (1e-9) relative: Panosolid's, the session model's, and OpenCascade's; and
the face count against OpenCascade's. Panosolid or the model off is a
disagreement (exit 1); OpenCascade alone off is its own rounding, counted
but not a failure, as in compare.py.

Each line also carries the built body's STEP file (step 29b3: "step", or
"step_refused" with the kernel's words), judged as compare.py's
`step_issues` judges the stateful harness's bodies, to the same REL:
valid, the kernel's faces, the exact volume and area; where OpenCascade's
own rebuild is invalid too though no two pieces meet (crossings.py), its
checker's verdict on the file is its tolerance, listed, not counted.

Usage: python sketch_extrude.py oracle.jsonl [disagreements.txt] [--planted]
  --planted: the files were written with FISSION_STEP_FAULT (a face
  flipped in every one): passes only when every extrude is a disagreement
  or under compare.py's small-feature limit, and at least one is one.
Needs: pip install cadquery-ocp mpmath
"""

import json
import sys

import compare
import crossings
import exact

REL = 1e-9


def off(got, ref):
    return abs(got - float(ref)) > REL * max(1.0, abs(float(ref)))


def check(case):
    shape = case["shape"]
    _, solid, _ = compare.build(compare.centred(shape))
    vol, area, _, _, faces = compare.measure(solid)
    ev, ea = exact.volume_area(shape)
    issues, occ = [], []
    for name, ref, fission, model, theirs in (("volume", ev, case["fission_volume"], case["model_volume"], vol),
                                              ("area", ea, case["fission_area"], case["model_area"], area)):
        if off(fission, ref):
            issues.append(f"{name}: fission {fission!r}, exact {float(ref)!r} ({case['context']})")
        if off(model, ref):
            issues.append(f"session model {name}: {model!r}, exact {float(ref)!r} ({case['context']})")
        if off(theirs, ref):
            occ.append(f"{name}: occ {theirs!r}, exact {float(ref)!r}")
    if faces != case["fission_faces"]:
        issues.append(f"faces: fission {case['fission_faces']}, occ {faces} ({case['context']})")
    from OCP.BRepCheck import BRepCheck_Analyzer
    occ_invalid = not BRepCheck_Analyzer(solid).IsValid() and not crossings.crossings(shape)
    slack = (REL * max(1.0, abs(float(ev))), REL * max(1.0, abs(float(ea))))
    more, more_occ = compare.step_issues({**case, "faces": case["fission_faces"]}, (vol, area), (ev, ea), slack, occ_invalid)
    return issues + [f"{m} ({case['context']})" for m in more], occ + more_occ


def main():
    args = [a for a in sys.argv[1:] if a != "--planted"]
    path = args[0]
    out = args[1] if len(args) > 1 else None
    total, bad, occ_only, small, steps, lines = 0, 0, 0, 0, 0, []
    with open(path) as f:
        for n, line in enumerate(f, 1):
            case = json.loads(line)
            try:
                issues, occ = check(case)
            except Exception as e:  # an oracle crash is itself worth a look
                issues, occ = [f"oracle error: {e!r} ({case.get('context')})"], []
            total += 1
            steps += case.get("step") is not None
            limited = not issues and any(compare.SMALL_LIMIT in o for o in occ)
            small += limited
            occ_only += bool(occ) and not issues and not limited
            if issues:
                bad += 1
                # compare.py's format, which file_issues.py reads: "line N: {shape}", then one indented "check: details" line each.
                lines.append(f"line {n}: {json.dumps(case['shape'])}\n  " + "\n  ".join(issues))
    print(f"Sketch-extrude oracle: {total} extrudes compared with the exact values and OpenCascade, {bad} disagreement(s)")
    print(f"  {steps} of them also read from their STEP files and checked (step 29b3)")
    print(f"  {occ_only} more where only OpenCascade was off the exact value (its own rounding, not counted)")
    print(f"  {small} more with a radius under {compare.SMALL_FEATURE} mm that OpenCascade couldn't read from the STEP file "
          f"(its small-feature limit, not counted)")
    for l in lines[:20]:
        print(l)
    if out:
        with open(out, "w") as f:
            f.write("\n".join(lines) + "\n")
    if "--planted" in sys.argv[1:]:
        sys.exit(0 if compare.planted_caught(total, bad, small) else 1)
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
