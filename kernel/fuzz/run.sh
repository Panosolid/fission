#!/usr/bin/env bash
# One nightly round of coverage-guided fuzzing for one kernel target
# (fuzz/checks.rs), for .github/workflows/fuzz.yml. Fuzzes until the time
# is up; after a crash it shrinks the input, saves it and carries on with
# the time left (at most 5 crashes a round). Needs the nightly toolchain and
# cargo-fuzz.
#
#   fuzz/run.sh <target> <seconds> <out-dir>
#
# Writes, like the STL fuzzer (tests/fuzz_stl.rs), for collect-fuzz.sh:
#   <out>/log.csv                       target,seed,cases,failures,seconds
#   <out>/seed-<seed>/fuzz-report.txt   one "failure: <kind> | <input>" line each
#   <out>/seed-<seed>/<input>           each failing input, shrunk
# A saved input becomes a regression test by copying it into
# tests/regressions/libfuzzer/<target>/ (tests/fuzz_corpus.rs replays it).
set -uo pipefail
target=$1 seconds=$2 out=$3
cd "$(dirname "$0")/.." || exit 1
seed=${FISSION_SEED:-$(( $(date +%s%N) % 4000000000 ))}
seed0=$seed dir="$out/seed-$seed"
mkdir -p "$out" "fuzz/corpus/$target"
# The committed seeds (fuzz/seeds/<target>.seeds) as a read-only corpus.
seeds=$(mktemp -d)
python3 fuzz/seeds.py unpack "fuzz/seeds/$target.seeds" "$seeds" || exit 1
log=$(mktemp)
cases=0 failures=0 report="" start=$(date +%s)
# -a: debug assertions on, so an invalid kernel result panics as in tests.
# -s none: no AddressSanitizer. The kernel is safe Rust, so it would find
# nothing, and it is slower; worse, nightly's ASAN build answered one
# profile check differently from every other build (the input is kept in
# tests/regressions/libfuzzer/extrude/line-crossing-a-shallow-arc).
cargo +nightly fuzz build -a -s none "$target" || exit 1
while :; do
  left=$(( seconds - ($(date +%s) - start) ))
  [ "$left" -gt 30 ] && [ "$failures" -lt 5 ] || break
  rm -rf "fuzz/artifacts/$target"
  # -timeout: one input taking 20 s is a hang; -rss_limit_mb: runaway memory.
  cargo +nightly fuzz run -a -s none "$target" "fuzz/corpus/$target" "$seeds" -- \
    -max_total_time="$left" -timeout=20 -rss_limit_mb=2048 -max_len=600 -seed="$seed" \
    -print_final_stats=1 >"$log" 2>&1
  runs=$(grep -o 'stat::number_of_executed_units: *[0-9]*' "$log" | grep -o '[0-9]*$' | tail -1)
  cases=$(( cases + ${runs:-0} ))
  crash=$(ls "fuzz/artifacts/$target"/* 2>/dev/null | head -1)
  [ -n "$crash" ] || break
  failures=$(( failures + 1 ))
  # The panic's message: its first line, and the second when the first
  # only introduces a list ("kernel produced an invalid body:").
  kind=$(grep -A1 'panicked at' "$log" | sed -n 2p)
  case $kind in *:) kind="$kind $(grep -A2 'panicked at' "$log" | sed -n 3p | sed 's/^ *//')" ;; esac
  [ -n "$kind" ] || kind=$(grep -o 'ERROR: libFuzzer: [a-z -]*\|ERROR: AddressSanitizer: [a-z -]*' "$log" | head -1)
  mkdir -p "$dir"
  name="input-$failures-$(basename "$crash")"
  # Shrink it (bounded), keeping the original when that fails.
  timeout 300 cargo +nightly fuzz tmin -a -s none "$target" "$crash" -- -runs=2000 >/dev/null 2>&1
  small=$(ls -S "fuzz/artifacts/$target"/minimized-* 2>/dev/null | tail -1)
  cp "${small:-$crash}" "$dir/$name"
  report+="failure: ${kind:-crash} | input $name ($(stat -c %s "$dir/$name") bytes)"$'\n'
  tail -n 60 "$log" >"$dir/$name.log"
  # A new seed, so the next stretch doesn't walk straight back into it.
  seed=$(( seed + 1 ))
done
elapsed=$(( $(date +%s) - start ))
if [ -n "$report" ]; then
  printf 'Kernel %s fuzzing, seed %s, %d inputs: %d failure(s)\n%s' "$target" "$seed0" "$cases" "$failures" "$report" >"$dir/fuzz-report.txt"
fi
echo "target,seed,cases,failures,seconds" >"$out/log.csv"
echo "$target,$seed0,$cases,$failures,$elapsed" >>"$out/log.csv"
echo "$target: $cases inputs in $elapsed s, $failures failure(s)"
[ "$failures" -eq 0 ]
