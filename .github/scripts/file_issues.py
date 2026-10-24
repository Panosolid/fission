"""One GitHub issue per kind of problem random testing finds.

Called by collect-results.sh after a "Random testing" run is on the
test-results branch (with the golden models' golden/seed-golden-<seed>/
golden-report.txt: one kind per failing model, step 28b), and by collect-fuzz.sh after a "Fuzzing" run (its
fuzz-<target>/seed-<seed>/fuzz-report.txt: one kind per failure line). Every failure folder the run produced (endless.sh's
seed-<seed>/: the harness report and the OpenCascade disagreements) is
reduced to its kinds: a harness failure's kind is the operation and the
message with every number replaced by #, an oracle disagreement's kind is
the shape, whether its profile has arcs, and which check failed. So a
thousand rotations that drift by different amounts are one kind, and a
rotation that drifts and an extrusion with the wrong volume are two.

Each kind has one issue, labelled `random-testing` and found again by a
marker in its body (the kind's hash), so issues never pile up:
- a kind with no issue gets a new one, with an example and how to replay it;
- an open issue gets one comment per run listing the new seeds;
- an issue closed as fixed is reopened if the kind comes back on main (a
  branch may not have the fix yet, so there it only gets a comment);
- an issue closed as not planned (a known OpenCascade weakness, say) is
  left alone.

`kinds_of` and `plan` are pure (tested in test_file_issues.py); `run` does
the `gh` calls.

Usage: file_issues.py <incoming dir> [--dry-run]; needs RUN_URL, COMMIT,
BRANCH, and GH_TOKEN for `gh` (without it, it prints what it would do).
"""

import hashlib
import json
import os
import re
import subprocess
import sys

LABEL = "random-testing"
MARK = "<!-- random-testing-kind: {} -->"
MARK_RE = re.compile(r"<!-- random-testing-kind: ([0-9a-f]+) -->")
MAX_SEEDS = 10  # listed per comment; the rest are counted
NUMBER = re.compile(r"[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?|\binf\b|\bNaN\b")


def numbers_out(text):
    return NUMBER.sub("#", text)


def harness_kinds(report):
    """Kinds of the failures in a harness report.txt: one per failing seed,
    from lines like '  seed 0x..: step 3 (Rotate { .. }): message (minimal
    chain: 3 ops)'."""
    kinds = []
    for line in report.splitlines():
        m = re.match(r"\s*seed 0x[0-9a-f]+: step \d+ \((.*)$", line)
        if not m:
            continue
        rest = m.group(1)
        op, _, msg = rest.partition("): ")
        name = re.match(r"[A-Za-z ]*[A-Za-z]", op)
        name = name.group(0).strip() if name else "?"
        if name == "Add":
            shape = re.search(r"shape: (\w+)", op)
            name = f"Add {shape.group(1)}" if shape else name
        msg = re.sub(r"\s*\(minimal chain: \d+ ops?\)\s*$", "", msg)
        kinds.append((f"harness, {name}: {numbers_out(msg).strip()[:120]}", line.strip()))
    return kinds


def shape_name(shape):
    (kind, p), = shape.items()
    if kind != "Extrude":
        return kind
    rings = [p["outer"]] + p.get("holes", [])
    curved = any("Circle" in r or any(float(b) != 0.0 for b in r["Path"]["bulges"]) for r in rings)
    return "Extrude with arcs" if curved else "Extrude"


def oracle_kinds(disagreements):
    """Kinds in compare.py's disagreements file: blocks of 'line N: {shape}'
    followed by indented 'check: details' lines."""
    kinds = []
    shape = None
    for line in disagreements.splitlines():
        if line.startswith("line "):
            try:
                shape = shape_name(json.loads(line.split(": ", 1)[1]))
            except Exception:  # an older or broken line: still a disagreement
                shape = "?"
            first = line
        elif not line.startswith(" "):
            # "occ-rounding, line N": only OpenCascade was off the exact
            # value, which is not a SpindleLabs problem.
            shape = None
            if line.startswith("oracle crashed"):
                kinds.append(("OpenCascade oracle crashed", line))
        elif line.strip() and shape is not None:
            check = line.strip().split(":", 1)[0]
            # "bounds x" (older runs) or "bounds highest x": one check.
            check = re.sub(r"^bounds ((lowest|highest) )?[xyz]$", "bounds", check)
            kinds.append((f"OpenCascade disagrees, {shape}: {check}", f"{first[:300]}\n  {line.strip()}"))
    return kinds


FUZZ_TARGETS = {
    "STL reader fuzzing": "STL reader",
    "Project loader fuzzing": "project loader",
    "Sketch-extrude sessions": "sketch-extrude sessions",
    # packages/testing/fuzz/timeline.ts (step 25b3)
    "Timeline sessions": "timeline sessions",
    # kernel/fuzz/run.sh, the coverage-guided targets (kernel/fuzz/checks.rs)
    "Kernel extrude fuzzing": "kernel's extrude",
    "Kernel sketch fuzzing": "kernel's sketch outline",
    "Kernel placed fuzzing": "kernel's moves and turns",
}


def fuzz_kinds(report):
    """Kinds in a fuzzer's fuzz-report.txt (kernel/tests/fuzz_stl.rs,
    packages/testing/src/project-fuzz.ts, packages/testing/fuzz/sketch-extrude.ts,
    packages/testing/fuzz/timeline.ts): a first line naming the target,
    then one 'failure: <kind> | <case and input>' line per kind, each
    already one example; numbers are taken out as for the harness."""
    lines = report.splitlines()
    target = next((name for head, name in FUZZ_TARGETS.items() if lines and lines[0].startswith(head)), "?")
    kinds = []
    for line in lines[1:]:
        if line.startswith("failure: "):
            kind = line[len("failure: "):].split(" | ", 1)[0]
            kinds.append((f"fuzzing the {target}: {numbers_out(kind).strip()[:150]}", line))
    return kinds


def golden_kinds(report):
    """Kinds in the golden models' golden-report.txt (packages/testing/src/
    golden-night.ts, step 28b): one 'failure: <model>: <first problem> |
    <the rest>' line per failing model, numbers taken out as for the
    harness, so one wrong volume on many nights is one kind."""
    kinds = []
    for line in report.splitlines()[1:]:
        if line.startswith("failure: "):
            kind = line[len("failure: "):].split(" | ", 1)[0]
            kinds.append((f"golden model {numbers_out(kind).strip()[:150]}", line))
    return kinds


def kinds_of(folder_files):
    """{kind: example} for one failure folder, given {file name: text}."""
    found = []
    if "fuzz-report.txt" in folder_files:
        found += fuzz_kinds(folder_files["fuzz-report.txt"])
    if "golden-report.txt" in folder_files:
        found += golden_kinds(folder_files["golden-report.txt"])
    if "report.txt" in folder_files:
        found += harness_kinds(folder_files["report.txt"])
    if "oracle-disagreements.txt" in folder_files:
        found += oracle_kinds(folder_files["oracle-disagreements.txt"])
    if not found and "harness-output.txt" in folder_files:
        # The harness died before writing a report (a crash outside a case).
        tail = [l for l in folder_files["harness-output.txt"].splitlines() if l.strip()][-3:]
        found.append(("harness crashed without a report", "\n".join(tail)))
    out = {}
    for kind, example in found:
        out.setdefault(kind, example)
    return out


def key(kind):
    return hashlib.sha1(kind.encode()).hexdigest()[:12]


def plan(found, issues, branch):
    """What to do for this run. found: {kind: [(seed, example), ...]};
    issues: [{number, state, stateReason, body}] already labelled. Returns a
    list of ('create', kind, None) / ('comment', kind, number) /
    ('reopen', kind, number)."""
    by_key = {}
    for issue in issues:
        m = MARK_RE.search(issue.get("body") or "")
        # The newest issue of a kind wins if there are ever two.
        if m and (m.group(1) not in by_key or issue["number"] > by_key[m.group(1)]["number"]):
            by_key[m.group(1)] = issue
    actions = []
    for kind in sorted(found):
        issue = by_key.get(key(kind))
        if issue is None:
            actions.append(("create", kind, None))
        elif issue["state"] == "OPEN":
            actions.append(("comment", kind, issue["number"]))
        elif (issue.get("stateReason") or "").upper() == "NOT_PLANNED":
            continue
        elif branch == "main":
            actions.append(("reopen", kind, issue["number"]))
        else:
            actions.append(("comment", kind, issue["number"]))
    return actions


def seed_list(seeds, where="failures"):
    shown = [f"- `{s}` ({where}/seed-{s}/)" for s in seeds[:MAX_SEEDS]]
    if len(seeds) > MAX_SEEDS:
        shown.append(f"- and {len(seeds) - MAX_SEEDS} more")
    return "\n".join(shown)


MAX_EXAMPLE = 4000  # characters of the example shown in an issue


def fenced(text):
    """text as a Markdown code block it can't break out of: the fence is
    longer than any run of backticks inside (the text comes from the code
    under test, so it could otherwise close the block and add Markdown or
    @mentions to the issue). Long text is cut to MAX_EXAMPLE characters."""
    if len(text) > MAX_EXAMPLE:
        text = text[:MAX_EXAMPLE] + "\n(cut; the whole report is on the test-results branch)"
    longest = max((len(m) for m in re.findall(r"`+", text)), default=0)
    fence = "`" * max(3, longest + 1)
    return f"{fence}\n{text}\n{fence}"


def texts(action, kind, hits, run_url, commit, branch):
    """(title, body) for a create; body for a comment or reopen."""
    seeds = [s for s, _ in hits]
    seed, example = hits[0]
    where = f"run {run_url}, commit {commit} on {branch}"
    if action == "create" and kind.startswith("fuzzing the "):
        body = (
            f"{MARK.format(key(kind))}\n"
            f"Fuzzing found a new kind of problem ({where}).\n\n"
            f"**Kind:** {kind}\n\n"
            f"Example (seed `{seed}`):\n{fenced(example)}\n\n"
            f"Seen in {len(seeds)} round(s):\n{seed_list(seeds, 'fuzz/failures')}\n\n"
            "Each folder is on the test-results branch: fuzz-report.txt lists every kind the round found, "
            "and input-<case> is the failing input, shrunk. Make the input a regression test first "
            "(kernel/tests/regressions/fuzz-stl/*.stl or packages/testing/test/regressions/project-fuzz/*.json "
            "are replayed by every test run), then fix it. Replay a whole round: in kernel/, "
            "`FISSION_SEED=<seed> FISSION_FUZZ_SECONDS=1 cargo test --test fuzz_stl fuzz_stl_random -- --nocapture`; "
            "for the project loader, `FISSION_SEED=<seed> FISSION_FUZZ_SECONDS=1 npm run fuzz -w @fission/testing`. "
            "For the kernel's coverage-guided targets, copy the input into kernel/tests/regressions/libfuzzer/<target>/ "
            "(`cargo test --test fuzz_corpus` replays it on stable Rust) or run it alone with "
            "`cargo +nightly fuzz run -a <target> <input>` in kernel/.\n\n"
            "Close this issue as completed once it is fixed (with a regression test), or as not planned "
            "if it is not a bug (say why in a comment): a kind closed as fixed that comes back on main reopens it; "
            "one closed as not planned is not reported again."
        )
        return f"Fuzzing: {kind[len('fuzzing the '):]}"[:250], body
    if action == "create" and kind.startswith("golden model "):
        body = (
            f"{MARK.format(key(kind))}\n"
            f"The nightly golden models run found a model that no longer rebuilds to its hand-worked answers ({where}).\n\n"
            f"**Kind:** {kind}\n\n"
            f"Example (seed `{seed}`):\n{fenced(example)}\n\n"
            f"Seen in {len(seeds)} run(s):\n{seed_list(seeds)}\n\n"
            "The model is tests/golden/<model>.panosolid.json and its answers, with the working, are in "
            "<model>.expect.json. `npm run journeys -w @fission/testing` (after `npm run kernel -w @fission/app`) "
            "rebuilds every model once; the replay command in the example runs the night again, in the same order. "
            "\"rebuilt differently\" means the same model gave two answers on one night (the kernel or Design depends on "
            "what ran before). Work out by hand whether the answer or the code is wrong: an expectation changes only with "
            "its working, and a code bug gets a regression test first.\n\n"
            "Close this issue as completed once it is fixed, or as not planned "
            "if it is not a bug (say why in a comment): a kind closed as fixed that comes back on main reopens it; "
            "one closed as not planned is not reported again."
        )
        return f"Golden models: {kind[len('golden model '):]}"[:250], body
    if action == "create":
        body = (
            f"{MARK.format(key(kind))}\n"
            f"Random testing found a new kind of problem ({where}).\n\n"
            f"**Kind:** {kind}\n\n"
            f"Example (seed `{seed}`):\n{fenced(example)}\n\n"
            f"Seen in {len(seeds)} round(s):\n{seed_list(seeds)}\n\n"
            "Each folder is on the test-results branch: report.txt says what went wrong, "
            "the .json file is the shortest failing chain, failure-dumps/*/index.html shows it in 3D, "
            "oracle-disagreements.txt lists what OpenCascade measured differently. Replay a round with "
            "`FISSION_SEED=<seed> FISSION_STATEFUL_CASES=2000 cargo test --release --test stateful "
            "stateful_random_chains -- --nocapture` in kernel/.\n\n"
            "Close this issue as completed once it is fixed (with a regression test), or as not planned "
            "if it is not a SpindleLabs bug (say why in a comment): a kind closed as fixed that comes back on "
            "main reopens it; one closed as not planned is not reported again."
        )
        return f"Random testing: {kind}"[:250], body
    head = "Seen again after this issue was closed" if action == "reopen" else "Seen again"
    folder = "fuzz/failures" if kind.startswith("fuzzing the ") else "failures"
    return None, f"{head} ({where}), in {len(seeds)} round(s):\n{seed_list(seeds, folder)}"


def read_folders(incoming):
    """{seed: {file name: text}} for every endless-*/seed-*/,
    fuzz-*/seed-*/ and golden/seed-golden-*/ folder."""
    folders = {}
    for run in sorted(os.listdir(incoming)):
        if not run.startswith(("endless-", "fuzz-")) and run != "golden":
            continue
        for name in sorted(os.listdir(os.path.join(incoming, run))):
            path = os.path.join(incoming, run, name)
            if not (name.startswith("seed-") and os.path.isdir(path)):
                continue
            files = {}
            for f in ("report.txt", "oracle-disagreements.txt", "harness-output.txt", "fuzz-report.txt", "golden-report.txt"):
                p = os.path.join(path, f)
                if os.path.isfile(p):
                    with open(p, errors="replace") as fh:
                        files[f] = fh.read()
            folders[name[len("seed-"):]] = files
    return folders


def gather(folders):
    found = {}
    for seed, files in sorted(folders.items()):
        for kind, example in kinds_of(files).items():
            found.setdefault(kind, []).append((seed, example))
    return found


def gh(*args, stdin=None):
    return subprocess.run(["gh", *args], input=stdin, capture_output=True, text=True, check=True).stdout


def run(incoming, dry_run=False, log=print):
    run_url, commit, branch = os.environ["RUN_URL"], os.environ["COMMIT"], os.environ["BRANCH"]
    found = gather(read_folders(incoming))
    if not found:
        log("No problems found in this run.")
        return []
    live = not dry_run and bool(os.environ.get("GH_TOKEN"))
    issues = []
    if live:
        try:
            gh("label", "create", LABEL, "--force", "--color", "d93f0b",
               "--description", "Found by the nightly random testing; one issue per kind")
        except subprocess.CalledProcessError as e:
            log(f"Could not create the {LABEL} label (it may exist already): {e.stderr.strip()}")
        issues = json.loads(gh("issue", "list", "--label", LABEL, "--state", "all", "--limit", "1000",
                               "--json", "number,state,stateReason,body"))
    actions = plan(found, issues, branch)
    for action, kind, number in actions:
        title, body = texts(action, kind, found[kind], run_url, commit, branch)
        log(f"{action} {number or ''} {kind}")
        if not live:
            continue
        if action == "create":
            gh("issue", "create", "--title", title, "--label", LABEL, "--body-file", "-", stdin=body)
        else:
            if action == "reopen":
                gh("issue", "reopen", str(number))
            gh("issue", "comment", str(number), "--body-file", "-", stdin=body)
    return actions


if __name__ == "__main__":
    run(sys.argv[1], dry_run="--dry-run" in sys.argv)
