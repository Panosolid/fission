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
REL (1e-9) relative: Fission's, the session model's, and OpenCascade's; and
the face count against OpenCascade's. Fission or the model off is a
disagreement (exit 1); OpenCascade alone off is its own rounding, counted
but not a failure, as in compare.py.

Usage: python sketch_extrude.py oracle.jsonl [disagreements.txt]
Needs: pip install cadquery-ocp mpmath
"""

import json
import sys

import compare
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
    return issues, occ


def main():
    path = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 else None
    total, bad, occ_only, lines = 0, 0, 0, []
    with open(path) as f:
        for n, line in enumerate(f, 1):
            case = json.loads(line)
            try:
                issues, occ = check(case)
            except Exception as e:  # an oracle crash is itself worth a look
                issues, occ = [f"oracle error: {e!r} ({case.get('context')})"], []
            total += 1
            occ_only += bool(occ) and not issues
            if issues:
                bad += 1
                # compare.py's format, which file_issues.py reads: "line N: {shape}", then one indented "check: details" line each.
                lines.append(f"line {n}: {json.dumps(case['shape'])}\n  " + "\n  ".join(issues))
    print(f"Sketch-extrude oracle: {total} extrudes compared with the exact values and OpenCascade, {bad} disagreement(s)")
    print(f"  {occ_only} more where only OpenCascade was off the exact value (its own rounding, not counted)")
    for l in lines[:20]:
        print(l)
    if out:
        with open(out, "w") as f:
            f.write("\n".join(lines) + "\n")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
