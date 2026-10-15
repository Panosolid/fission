#!/usr/bin/env bash
# Overnight (Tier 3) run of the stateful kernel harness plus the OpenCascade
# oracle. Usage: kernel/scripts/overnight.sh [cases-per-seed] [seeds] [python]
#   python defaults to `python3`; it needs `pip install cadquery-ocp`.
set -euo pipefail
cd "$(dirname "$0")/.."
CASES="${1:-100000}"
SEEDS="${2:-4}"
PYTHON="${3:-python3}"
SEED="$(date +%Y%m%d)"
mkdir -p target
ORACLE="target/oracle-cases-$SEED.jsonl"
rm -f "$ORACLE"

echo "== Stateful harness: $CASES cases x $SEEDS seeds from base seed $SEED (release build)"
status=0
FISSION_STATEFUL_CASES="$CASES" FISSION_STATEFUL_SEEDS="$SEEDS" FISSION_SEED="$SEED" \
FISSION_ORACLE_OUT="$PWD/$ORACLE" FISSION_STATEFUL_SLOWEST=1 \
  cargo test --release --test stateful stateful_random_chains -- --nocapture || status=$?

echo
echo "== OpenCascade oracle"
"$PYTHON" ../prototypes/oracle/compare.py "$ORACLE" "target/oracle-disagreements-$SEED.txt" || status=$?

echo
echo "Report: target/stateful-report.txt; regressions (if any): tests/regressions/stateful/"
exit "$status"
