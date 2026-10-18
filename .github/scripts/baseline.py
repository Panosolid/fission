"""Speed and memory against tests/baseline.json (test audit item 3).

Measures the kernel's key operations (kernel/examples/baseline.rs: peak
heap and allocations from a counting allocator, instructions from
callgrind) and the app's (packages/testing/baseline/app.ts: JavaScript heap
kept, the kernel's WebAssembly memory, time relative to a fixed workload, and
the kernel calls and bodies built by one edit of a 20-feature part),
compares each with the baseline and prints a table. Margins live in the
baseline file ("margins", one per kind of metric, the kind being the last
part of the metric's name):
- "fail": worse by more than this many percent fails the check (exit 1);
- "flag": worse by more than this only warns (noisy metrics: time, which
  also has a much wider "fail", so a gross slowdown still fails);
- "floor": changes smaller than this, in the metric's own unit, are noise;
- a metric better by more than its margin is pointed out, so the baseline
  can be lowered (with the owner's OK; root CLAUDE.md, Metrics and
  baselines); a metric the baseline has but the run doesn't fails, a new
  one is listed; a kind with no margin (the kernel's wall time, `nanos`)
  is only shown, and not kept in the baseline.

`compare` is pure (tested in test_baseline.py); `measure` runs things.

Usage: baseline.py [--update] [--measured FILE] [--save FILE]
  --measured FILE  compare metrics saved earlier instead of measuring
  --save FILE      also write what was measured to FILE
  --update         write what was measured into tests/baseline.json (only
                   when the owner has confirmed the change is intended)
Needs a release build of the example, valgrind, and the WASM build.
"""

import json
import os
import re
import subprocess
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
BASELINE = os.path.join(ROOT, "tests", "baseline.json")


def kind_of(metric):
    return metric.rsplit(".", 1)[-1]


def compare(baseline, measured):
    """Rows (metric, old, new, percent change or None, verdict); verdict is
    one of ok, fail, flag, better, new, missing, info."""
    margins = baseline["margins"]
    old_all = baseline["metrics"]
    rows = []
    for metric in sorted(set(old_all) | set(measured)):
        old, new = old_all.get(metric), measured.get(metric)
        rule = margins.get(kind_of(metric))
        if rule is None:  # no margin for this kind (wall time): shown, never judged
            rows.append((metric, old, new, None if not old or new is None else (new - old) / old * 100, "info"))
            continue
        if old is None:
            rows.append((metric, None, new, None, "new"))
            continue
        if new is None:
            rows.append((metric, old, None, None, "missing"))
            continue
        change = None if old == 0 else (new - old) / old * 100
        fail, flag = rule.get("fail"), rule.get("flag")
        if abs(new - old) <= rule.get("floor", 0):
            verdict = "ok"
        elif change is None:  # from zero: any growth past the floor is worse
            verdict = ("fail" if fail is not None else "flag") if new > old else "better"
        elif fail is not None and change > fail:
            verdict = "fail"
        elif flag is not None and change > flag:
            verdict = "flag"
        elif change < -min(x for x in (fail, flag) if x is not None):
            verdict = "better"
        else:
            verdict = "ok"
        rows.append((metric, old, new, change, verdict))
    return rows


def fmt(x):
    if x is None:
        return "-"
    return f"{x:,.4f}".rstrip("0").rstrip(".") if isinstance(x, float) and x < 100 else f"{x:,.0f}"


def table(rows):
    lines = ["| metric | baseline | now | change | |", "|---|---:|---:|---:|---|"]
    for metric, old, new, change, verdict in rows:
        mark = {"ok": "", "fail": "FAIL", "flag": "slower (flag)", "better": "better: lower the baseline?",
                "new": "new: add to the baseline", "missing": "MISSING", "info": "report only"}[verdict]
        lines.append(f"| {metric} | {fmt(old)} | {fmt(new)} | {'-' if change is None else f'{change:+.1f}%'} | {mark} |")
    return "\n".join(lines)


def run(cmd, **kw):
    return subprocess.run(cmd, check=True, capture_output=True, text=True, **kw)


def measure():
    kernel = os.path.join(ROOT, "kernel")
    run(["cargo", "build", "--release", "--example", "baseline"], cwd=kernel)
    exe = os.path.join(kernel, "target", "release", "examples", "baseline")
    metrics = {}
    for op, m in json.loads(run([exe]).stdout).items():
        for name, value in m.items():
            metrics[f"kernel.{op}.{name}"] = value
    for op in run([exe, "--list"]).stdout.split():
        err = run(["valgrind", "--tool=callgrind", "--callgrind-out-file=/dev/null", "--toggle-collect=*measured*", exe, "--one", op]).stderr
        collected = re.search(r"Collected : (\d+)", err)
        if not collected:
            raise RuntimeError(f"no instruction count from callgrind for {op}:\n{err[-2000:]}")
        metrics[f"kernel.{op}.instructions"] = int(collected.group(1))
    app = run(["node", "--expose-gc", "--experimental-strip-types", "--no-warnings", "packages/testing/baseline/app.ts"], cwd=ROOT).stdout
    for op, m in json.loads(app).items():
        for name, value in m.items():
            metrics[f"app.{op}.{name}"] = value
    return metrics


def main(argv):
    with open(BASELINE) as f:
        baseline = json.load(f)
    if "--measured" in argv:
        with open(argv[argv.index("--measured") + 1]) as f:
            measured = json.load(f)
    else:
        measured = measure()
    if "--save" in argv:
        with open(argv[argv.index("--save") + 1], "w") as f:
            json.dump(measured, f, indent=2, sort_keys=True)
    rows = compare(baseline, measured)
    text = table(rows)
    print(text)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as f:
            f.write("## Speed and memory against tests/baseline.json\n\n" + text + "\n")
    for metric, old, new, change, verdict in rows:
        if verdict == "fail":
            print(f"::error title=Baseline: {metric}::{metric} is {fmt(new)}, baseline {fmt(old)} ({change:+.1f}%), past the {baseline['margins'][kind_of(metric)]['fail']}% margin")
        elif verdict == "missing":
            print(f"::error title=Baseline: {metric}::{metric} is in tests/baseline.json but was not measured")
        elif verdict == "flag":
            print(f"::warning title=Baseline: {metric}::{metric} is {fmt(new)}, baseline {fmt(old)} ({change:+.1f}%), slower than the {baseline['margins'][kind_of(metric)]['flag']}% margin (time is noisy: check before acting)")
    print("\nMeasured (for --update or a new baseline):\n" + json.dumps(measured, indent=2, sort_keys=True))
    if "--update" in argv:
        baseline["metrics"] = {m: v for m, v in sorted(measured.items()) if kind_of(m) in baseline["margins"]}
        with open(BASELINE, "w") as f:
            json.dump(baseline, f, indent=2)
            f.write("\n")
        print(f"Wrote {BASELINE}")
        return 0
    failed = [r for r in rows if r[4] in ("fail", "missing")]
    print(f"\n{len(failed)} metric(s) failed, {sum(r[4] == 'flag' for r in rows)} flagged, {sum(r[4] == 'better' for r in rows)} better.")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
