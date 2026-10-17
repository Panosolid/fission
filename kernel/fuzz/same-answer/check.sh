#!/usr/bin/env bash
# Same answer everywhere: the kernel's exact answer for every saved fuzz
# input (../seeds/*.seeds and ../../tests/regressions/libfuzzer/), from
#   native release   (what `cargo run --release` and the benchmarks run),
#   native test      (the dev profile `cargo test` checks, debug assertions on),
#   WebAssembly      (built as the app builds it, run in Node),
# must match to the last bit: volume, area, counts, validation, every mesh
# and STL byte, and every refusal message (../answers.rs). Fails, printing
# the first differences, if any line differs or too few inputs ran.
#
#   fuzz/same-answer/check.sh [out-dir]
#
# SAME_ANSWER_BREAK=1 builds the WebAssembly with a planted one-bit change to
# every extrude volume (answers.rs); the check must then fail. CI runs both.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
kernel=$(cd "$here/../.." && pwd)
out=${1:-$here/target/answers}
mkdir -p "$out"
cd "$here"
# The kernel's own pinned dependency versions, as the app's build uses.
cp "$kernel/Cargo.lock" Cargo.lock
wasm_flags=""
[ "${SAME_ANSWER_BREAK:-}" = 1 ] && wasm_flags="--cfg same_answer_break"
cargo build --quiet --release
cargo build --quiet
RUSTFLAGS="$wasm_flags" cargo build --quiet --release --lib --target wasm32-unknown-unknown
target/release/fission-same-answer "$kernel" >"$out/native-release.txt"
target/debug/fission-same-answer "$kernel" >"$out/native-test.txt"
node wasm.mjs target/wasm32-unknown-unknown/release/fission_same_answer.wasm "$kernel" >"$out/wasm.txt"
node compare.mjs "$out/native-release.txt" "$out/native-test.txt" "$out/wasm.txt"
