"""Tier 3's simulated-user numbers in the nightly summary (step 30d).

The fuzzing workflow's timeline job (packages/testing/fuzz/timeline.ts)
writes one JSON line per round to numbers.jsonl: how many steps' rebuilds
the model agreed with, held references that resolved right, the kernel's
body_build answers that passed validate, and rebuild-from-scratch times by
feature count (src/sim-numbers.ts says exactly what each counts).
collect-fuzz.sh adds each run's lines to fuzz/numbers.jsonl on the
test-results branch (`--append`, with the run, commit and branch) and
writes this script's section into fuzz/summary.txt: the last run's
numbers, and all runs on main so far. A number that should be 100% and
isn't is marked WRONG (its sessions are failures too, in fuzz/failures/,
with an issue). Times on different runners compare through the
calibration workload each round timed (`calibrationMs`, the fixed
JavaScript workload of tests/baseline.json's relative_time).

`totals`, `fit`, `buckets` and `section` are pure (test_sim_numbers.py).

Usage:
  sim_numbers.py --append IN OUT   copy IN's lines into OUT with RUN_URL,
                                   COMMIT and BRANCH from the environment
  sim_numbers.py FILE [NOW]        print the summary section for FILE
"""

import json
import os
import sys

COUNTS = ("sessions", "failedSessions", "rebuilds", "wrongRebuilds", "withFailedFeature", "references", "wrongReferences",
          "builds", "invalidBuilds", "crashedBuilds", "refusedBuilds")
# Feature counts grouped for the table: 1-5, 6-10, 11-20, 21-40, 41-80, 81 and up.
BUCKETS = ((1, 5), (6, 10), (11, 20), (21, 40), (41, 80), (81, None))
# A bucket needs this many rebuilds before its time per feature is compared.
ENOUGH = 20


def totals(rows):
    """Counts summed over rows; timing per feature count as [rebuilds, fastest, total], in units of each
    round's calibration time (so rounds on different machines add up)."""
    t = {k: 0 for k in COUNTS}
    timing = {}
    for r in rows:
        for k in COUNTS:
            t[k] += r.get(k, 0)
        cal = r["calibrationMs"]
        for n, (count, fastest, total) in r.get("timing", {}).items():
            k0, f0, t0 = timing.get(int(n), (0, float("inf"), 0.0))
            timing[int(n)] = (k0 + count, min(f0, fastest / cal), t0 + total / cal)
    t["timing"] = timing
    return t


def fit(timing):
    """Least squares through the fastest time at each feature count: (per feature, intercept), or None
    with fewer than two counts (as timeFit in src/sim-numbers.ts)."""
    pts = [(n, f) for n, (_, f, _) in timing.items()]
    if len(pts) < 2:
        return None
    mx = sum(x for x, _ in pts) / len(pts)
    my = sum(y for _, y in pts) / len(pts)
    sxx = sum((x - mx) ** 2 for x, _ in pts)
    slope = sum((x - mx) * (y - my) for x, y in pts) / sxx
    return slope, my - slope * mx


def buckets(timing):
    """Per bucket with rebuilds: (label, rebuilds, mean time per rebuild, time per feature)."""
    out = []
    for lo, hi in BUCKETS:
        ns = [n for n in timing if n >= lo and (hi is None or n <= hi)]
        count = sum(timing[n][0] for n in ns)
        if count == 0:
            continue
        total = sum(timing[n][2] for n in ns)
        features = sum(n * timing[n][0] for n in ns)
        out.append((f"{lo}-{hi}" if hi else f"{lo}+", count, total / count, total / features))
    return out


def growth(bs):
    """Time per feature in the biggest bucket with ENOUGH rebuilds over the smallest such: about 1 or
    below when rebuild time grows in step with the timeline, above when each feature costs more in a
    bigger one. None with fewer than two such buckets."""
    full = [b for b in bs if b[1] >= ENOUGH]
    return full[-1][3] / full[0][3] if len(full) >= 2 else None


def pct(part, whole):
    return 100.0 * part / whole if whole else 0.0


def fmt_pct(v):
    """To 4 decimals, trailing zeros dropped: 99.975, 99.9, 100."""
    return f"{v:.4f}".rstrip("0").rstrip(".")


def right(label, wrong, whole, what, extra=""):
    mark = "" if wrong == 0 else "   <- WRONG (see fuzz/failures/ and the issues)"
    return f"    {label:<26}{fmt_pct(100 - pct(wrong, whole))}% ({wrong:,} {what} of {whole:,}){extra}{mark}"


def lines_for(t, unit):
    """The four numbers for one total; `unit` names the time unit ("ms", or "x calibration")."""
    answered = t["builds"] + t["invalidBuilds"] + t["crashedBuilds"]
    out = [
        right("rebuilds right:", t["wrongRebuilds"], t["rebuilds"], "wrong"),
        right("references right:", t["wrongReferences"], t["references"], "wrong"),
        right("bodies passing validate:", t["invalidBuilds"] + t["crashedBuilds"], answered, "failed or crashed",
              f"; {t['refusedBuilds']:,} inputs refused as the user's"),
        f"    rebuilds with a feature failed as the model says (the user's doing, shown in words): {pct(t['withFailedFeature'], t['rebuilds']):.3g}%",
    ]
    f = fit(t["timing"])
    if f is None:
        out.append("    rebuild time against features built: too few feature counts timed")
    else:
        bs = buckets(t["timing"])
        g = growth(bs)
        out.append(f"    rebuild from scratch against features built: {f[1]:.3g} {unit} + {f[0]:.3g} {unit} per feature "
                   f"(fastest at each of {len(t['timing'])} counts)")
        out.append("      by features built: " + "; ".join(f"{label}: {mean:.3g} {unit} a rebuild, {per:.3g} per feature ({count:,})"
                                                       for label, count, mean, per in bs))
        if g is not None:
            out.append(f"      per feature, biggest timelines over smallest: {g:.2f}x (above 1, each feature costs more in a bigger timeline)")
    return out


def section(rows, now):
    head = f"Simulated users (timeline sessions on the real kernel, Tier 3 item 4; fuzz/numbers.jsonl), updated {now}"
    if not rows:
        return [head, "  no rounds yet"]
    last_run = rows[-1].get("run", "")
    last = [r for r in rows if r.get("run", "") == last_run]
    main = [r for r in rows if r.get("branch") == "main"]
    lt = totals(last)
    out = [head, f"  last run ({last_run or 'local'}, commit {last[-1].get('commit', '?')} on {last[-1].get('branch', '?')}): "
                 f"{lt['sessions']:,} sessions in {len(last)} rounds"]
    # The last run's times in ms on its own runner: its rounds' calibrations, averaged, turn units back into ms.
    cal = sum(r["calibrationMs"] for r in last) / len(last)
    lt_ms = dict(lt, timing={n: (k, f * cal, s * cal) for n, (k, f, s) in lt["timing"].items()})
    out += lines_for(lt_ms, "ms")
    if main:
        mt = totals(main)
        out.append(f"  all runs on main so far: {mt['sessions']:,} sessions in {len(main)} rounds (times as multiples of the calibration workload)")
        out += lines_for(mt, "x")
    return out


def append(src, dst, run, commit, branch):
    with open(src) as f, open(dst, "a") as out:
        for line in f:
            if line.strip():
                out.write(json.dumps(dict(json.loads(line), run=run, commit=commit, branch=branch)) + "\n")


def load(path):
    if not os.path.exists(path):
        return []
    with open(path) as f:
        return [json.loads(line) for line in f if line.strip()]


def main(argv):
    if argv[:1] == ["--append"] and len(argv) == 3:
        append(argv[1], argv[2], os.environ["RUN_URL"], os.environ["COMMIT"], os.environ["BRANCH"])
        return 0
    if len(argv) in (1, 2) and not argv[0].startswith("-"):
        print("\n".join(section(load(argv[0]), argv[1] if len(argv) == 2 else "")))
        return 0
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
