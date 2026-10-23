"""OpenCascade reads the golden models' bodies from their STEP files (step
29b3).

Input: the golden-step.jsonl the golden models' nightly run writes
(packages/testing/golden/nightly.ts with FISSION_GOLDEN_OUT), one line per
body a model shows after its rebuild through Design on the real kernel:
the model, the body's row and item, its STEP file as the kernel wrote it
(`body_step`: "step", or "step_refused" with the kernel's words), and the
model's hand-worked volume, area and face count for it (tests/golden/
<model>.expect.json, worked out apart from the kernel).

Each file is judged as compare.py's `step_issues` judges the stateful
harness's bodies: OpenCascade's checker must call it valid with every
tolerance within LINEAR, read the hand-worked number of faces, and measure
the hand-worked volume and area to the golden models' own REL (a
billionth of their size, packages/testing/src/golden.ts). The hand-worked
answers are the reference and the rebuild both (OpenCascade doesn't
rebuild these models), so nothing is put down to its rounding.

Usage: python golden_step.py golden-step.jsonl [golden-report.txt] [--planted]
  golden-report.txt: where the findings go, in the format
  .github/scripts/file_issues.py reads (only written when there are some).
  --planted: the files were written with FISSION_STEP_FAULT (a face
  flipped in every one): passes only when every body is a finding or under
  compare.py's small-feature limit, and at least one is a finding.
Needs: pip install cadquery-ocp mpmath
"""

import json
import sys

REL = 1e-9  # packages/testing/src/golden.ts


def slack(x):
    return REL * max(1.0, abs(x))


def check(case, occ):
    """(issues, occ_only) for one body; `occ` is compare.py."""
    where = f"{case['model']}, {case['body']} ({case['item']})"
    if case.get("volume") is None:
        return [f"no hand-worked answers for this body, so its STEP file isn't judged ({where})"], []
    v, a = case["volume"], case["area"]
    issues, occ_only = occ.step_issues(case, (v, a), (v, a), (slack(v), slack(a)))
    return [f"{i} ({where})" for i in issues], occ_only


def main():
    import compare
    args = [a for a in sys.argv[1:] if a != "--planted"]
    planted = "--planted" in sys.argv[1:]
    path, out = args[0], args[1] if len(args) > 1 else None
    total, failures, small = 0, [], 0
    with open(path) as f:
        for line in f:
            case = json.loads(line)
            total += 1
            try:
                issues, occ_only = check(case, compare)
            except Exception as e:  # an oracle crash is itself worth a look
                issues, occ_only = [f"oracle error: {e!r} ({case.get('model')}, {case.get('body')})"], []
            small += not issues and any(compare.SMALL_LIMIT in o for o in occ_only)
            if issues:
                failures.append((case["model"], issues))
    print(f"Golden STEP files: {total} bodies read by OpenCascade, {len(failures)} disagreement(s)")
    print(f"  {small} more with a radius under {compare.SMALL_FEATURE} mm that OpenCascade couldn't read (its small-feature limit, not counted)")
    for model, issues in failures[:20]:
        print(f"{model}:\n  " + "\n  ".join(issues))
    if out and failures:
        # golden-report.txt's format (packages/testing/golden/night.ts): a
        # first line naming the run, then one "failure: <model>: <first> |
        # also: ..." line per failing body.
        lines = [f"Golden models' STEP files (prototypes/oracle/golden_step.py): {len(failures)} of {total} bodies failed"]
        for model, issues in failures:
            head, *rest = issues
            lines.append(f"failure: {model}: {head} | " + "".join(f"also: {r}; " for r in rest))
        with open(out, "w") as f:
            f.write("\n".join(lines) + "\n")
    if planted:
        sys.exit(0 if compare.planted_caught(total, len(failures), small) else 1)
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
