#!/usr/bin/env bash
# TypeScript mutation testing (testing hunt 3a): StrykerJS changes the code
# one small way at a time and runs the tests; a change no test notices is a
# survivor. Each survivor must be killed by a test or explained (harmless:
# no caller can tell) in explained.json; check.mjs fails on any other.
#
#   packages/testing/stryker/run.sh [core] [design] [storage] [model] [svg] [viewport] [ai]   (all by default)
#
# Stryker stays out of the lockfile: it is installed once into
# node_modules/.cache/stryker (STRYKER_VERSION pins it). Takes ~2 min for
# core and ~5 min for design on 4 cores.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../.." && pwd)
tools="$root/node_modules/.cache/stryker"
version=${STRYKER_VERSION:-9.6.1}
if [ "$(node -p "try{require('$tools/node_modules/@stryker-mutator/core/package.json').version}catch{''}")" != "$version" ]; then
  mkdir -p "$tools" && echo '{"private": true}' > "$tools/package.json"
  npm install --prefix "$tools" --no-save --no-audit --no-fund --no-package-lock "@stryker-mutator/core@$version" >/dev/null
fi
declare -A dirs=([core]=packages/core [design]=workspaces/design [storage]=packages/storage [model]=packages/core [svg]=packages/core [viewport]=packages/viewport [ai]=packages/ai)
targets=("$@")
[ ${#targets[@]} -gt 0 ] || targets=(core design storage model svg viewport ai)
for t in "${targets[@]}"; do
  [ -n "${dirs[$t]:-}" ] || { echo "unknown target $t (core, design, storage, model, svg, viewport or ai)"; exit 2; }
  (cd "$root/${dirs[$t]}" && "$tools/node_modules/.bin/stryker" run "$here/$t.json" --concurrency "${STRYKER_CONCURRENCY:-4}" | grep -v '^\s*$' | tail -12)
done
node "$here/check.mjs" "${targets[@]}"
