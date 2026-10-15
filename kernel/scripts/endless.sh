#!/usr/bin/env bash
# Endless random testing: runs the stateful harness (and the OpenCascade
# oracle, if installed) round after round with a fresh random seed each time,
# until you press Ctrl+C. Nothing here talks to Claude; it only uses your
# computer's CPU.
#
# Usage (from the repo root or anywhere):
#   kernel/scripts/endless.sh [cases-per-round] [rounds] [python]
#     cases-per-round defaults to 2000 (a few minutes per round in release).
#     rounds defaults to 0, meaning endless; any other number stops after it.
#     python defaults to python3; the oracle runs only if it can `import OCP`
#     (pip install cadquery-ocp). Without it the harness still runs.
#
# FISSION_ENDLESS_MINUTES=<m> stops starting new rounds after m minutes (used
# by the GitHub workflow, whose jobs have a time limit).
#
# Results go to kernel/endless-results/ (gitignored):
#   log.csv           one line per round: when, seed, cases, harness result,
#                     bodies compared with OpenCascade, disagreements, seconds
#   summary.txt       running totals, rewritten after every round
#   seed-<seed>/      only for rounds that found something: the harness
#                     report, the minimal failing chain(s), failure dumps
#                     (open index.html in a browser) and oracle disagreements
# To replay a failure exactly: FISSION_SEED=<seed> FISSION_STATEFUL_CASES=<cases>
#   cargo test --release --test stateful stateful_random_chains -- --nocapture
set -uo pipefail
cd "$(dirname "$0")/.."
CASES="${1:-2000}"
MAX_ROUNDS="${2:-0}"
PYTHON="${3:-python3}"
OUT="endless-results"
KEEP_FOLDERS=200 # stop saving folders after this many (the log keeps going)
REG="tests/regressions/stateful"
SEEDS_FILE="tests/regressions/stateful-seeds.txt"
mkdir -p "$OUT" target
[ -f "$OUT/log.csv" ] || echo "finished,seed,cases,harness,oracle_bodies,disagreements,seconds" >"$OUT/log.csv"

if "$PYTHON" -c "import OCP" 2>/dev/null; then ORACLE=1; else
  ORACLE=0
  echo "Note: '$PYTHON' can't import OCP, so the OpenCascade oracle is skipped (pip install cadquery-ocp to enable it)."
fi

echo "Building the harness in release mode (first time takes a few minutes)..."
cargo test --release --test stateful --no-run -q || { echo "Build failed; fix that first."; exit 1; }

DEADLINE=0
[ -n "${FISSION_ENDLESS_MINUTES:-}" ] && DEADLINE=$(( $(date +%s) + FISSION_ENDLESS_MINUTES * 60 ))
rounds=0 fails=0 bodies_total=0 disagree_total=0 folders=0
stop=0
# Ctrl+C also reaches the harness and kills it mid-round, so an interrupted
# round is thrown away rather than logged as a failure.
trap 'stop=1' INT

summary() {
  cat >"$OUT/summary.txt" <<EOF
Endless testing summary (updated $(date '+%Y-%m-%d %H:%M:%S'))
rounds run:                 $rounds
cases run:                  $((rounds * CASES))
rounds with harness failure: $fails
bodies compared with OCC:   $bodies_total
oracle disagreements:       $disagree_total
oracle:                     $([ $ORACLE = 1 ] && echo on || echo "off (OCP not installed)")
Details: log.csv, and a seed-<seed> folder for each round that found something.
EOF
}

while [ $stop = 0 ]; do
  # A random 48-bit seed, so runs on different computers don't repeat each other.
  seed=$(( $(od -An -N4 -tu4 /dev/urandom) * 65536 + $(od -An -N2 -tu2 /dev/urandom) ))
  start=$(date +%s)
  jsonl="target/endless-oracle.jsonl" dis="target/endless-disagreements.txt"
  rm -f "$jsonl" "$dis" target/stateful-report.txt
  rm -rf target/failure-dumps
  before=$(ls "$REG" 2>/dev/null | sort)
  cp "$SEEDS_FILE" target/endless-seeds.bak 2>/dev/null

  # The harness runs as a child process: even a crash only ends this round.
  harness=pass
  FISSION_STATEFUL_CASES="$CASES" FISSION_SEED="$seed" FISSION_STATEFUL_SLOWEST=1 \
  FISSION_ORACLE_OUT="$PWD/$jsonl" \
    cargo test --release -q --test stateful stateful_random_chains -- --nocapture \
    >target/endless-harness.log 2>&1 || harness=FAIL

  if [ $stop = 1 ]; then
    for f in $(comm -13 <(echo "$before") <(ls "$REG" 2>/dev/null | sort)); do rm -f "$REG/$f"; done
    [ -f target/endless-seeds.bak ] && cp target/endless-seeds.bak "$SEEDS_FILE"
    echo; echo "Interrupted: the unfinished round was discarded."
    break
  fi

  bodies=0 disagreements=0
  if [ $ORACLE = 1 ] && [ -s "$jsonl" ]; then
    bodies=$(wc -l <"$jsonl" | tr -d ' ')
    "$PYTHON" ../prototypes/oracle/compare.py "$jsonl" "$dis" >target/endless-oracle.log 2>&1 \
      || echo "oracle crashed" >>"$dis"
    disagreements=$(grep -c '^line \|oracle crashed' "$dis" 2>/dev/null || true)
    disagreements=${disagreements:-0}
  fi

  # Anything found is moved out of the repo's test folders into the results
  # folder, so the working tree stays clean and the next round is unaffected.
  new=$(comm -13 <(echo "$before") <(ls "$REG" 2>/dev/null | sort))
  if [ $harness = FAIL ] || [ "$disagreements" -gt 0 ]; then
    if [ $folders -lt $KEEP_FOLDERS ]; then
      d="$OUT/seed-$seed"; mkdir -p "$d"
      cp target/endless-harness.log "$d/harness-output.txt"
      [ -f target/stateful-report.txt ] && cp target/stateful-report.txt "$d/report.txt"
      [ -d target/failure-dumps ] && cp -r target/failure-dumps "$d/"
      [ "$disagreements" -gt 0 ] && cp "$dis" "$d/oracle-disagreements.txt"
      for f in $new; do cp "$REG/$f" "$d/"; done
      echo "cases=$CASES seed=$seed" >"$d/replay.txt"
      folders=$((folders + 1))
    fi
  fi
  for f in $new; do rm -f "$REG/$f"; done
  [ -f target/endless-seeds.bak ] && cp target/endless-seeds.bak "$SEEDS_FILE"

  secs=$(( $(date +%s) - start ))
  rounds=$((rounds + 1))
  [ $harness = FAIL ] && fails=$((fails + 1))
  bodies_total=$((bodies_total + bodies)); disagree_total=$((disagree_total + disagreements))
  echo "$(date '+%Y-%m-%d %H:%M:%S'),$seed,$CASES,$harness,$bodies,$disagreements,$secs" >>"$OUT/log.csv"
  summary
  [ "$MAX_ROUNDS" -gt 0 ] && [ $rounds -ge "$MAX_ROUNDS" ] && stop=1
  [ $DEADLINE -gt 0 ] && [ "$(date +%s)" -ge $DEADLINE ] && stop=1
  echo "round $rounds: seed $seed, harness $harness, oracle $bodies bodies / $disagreements disagreements, ${secs}s"
done

echo "Stopped after $rounds rounds. See kernel/$OUT/summary.txt"
