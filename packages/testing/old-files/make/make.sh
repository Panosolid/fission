#!/bin/bash
# Makes old-file corpus files by running an older SpindleLabs's own code:
#   ./make.sh <commit> <script.ts>   (from packages/testing/old-files/make)
# A worktree of <commit> borrows this checkout's node_modules (its @fission
# packages pointing into the worktree), builds that commit's WASM kernel
# (the scripts that drive its Design app or ask its kernel need it), copies
# save.ts and the script in, and runs it, writing into ../ (the corpus).
# Needs `npm ci` here first, wasm-pack and the wasm32 target.
set -e
commit=$1; script=$2
here=$(cd "$(dirname "$0")" && pwd); root=$(git -C "$here" rev-parse --show-toplevel)
wt=${TMPDIR:-/tmp}/panosolid-old-$commit
if [ ! -d "$wt" ]; then
  git -C "$root" worktree add -q --detach "$wt" "$commit"
  mkdir -p "$wt/node_modules/@fission"
  for e in "$root"/node_modules/* "$root"/node_modules/.bin; do n=$(basename "$e"); [ "$n" = "@fission" ] || ln -s "$e" "$wt/node_modules/$n"; done
  for p in "$root"/node_modules/@fission/*; do ln -s "$(readlink "$p")" "$wt/node_modules/@fission/$(basename "$p")"; done
fi
[ -f "$wt/packages/core/src/kernel/wasm/fission_kernel_bg.wasm" ] || (cd "$wt/apps/fission" && npm run kernel)
cp "$here/save.ts" "$here/$script" "$wt/"
(cd "$wt" && node --experimental-strip-types --no-warnings "$script" "$here/..")
