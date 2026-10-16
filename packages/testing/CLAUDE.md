# Testing

Contents of `packages/testing`; the rules are in packages/CLAUDE.md and the root CLAUDE.md. Keep this list current when you add or change a file here.

- the Workspace API boundary test, the "zero exports" journeys (`journeys/*.journey.ts`, on the real kernel through `src/node-kernel.ts`; `JOURNEYS`/`ROUND_TRIPS` list the ones waiting), and DRAFT harness interfaces.
- `test/history-fuzz.test.ts`: seeded edit/undo/redo sessions on a real project against a two-stack model (step 20a).
- `src/project-fuzz.ts`: fuzzing the project loader (`projectFromJson` with every workspace's reader) against a model of the outer layout plus open/show/save/reopen checks, with shrinking; `test/project-fuzz.test.ts` runs it quickly (3 seeds × 1,500 cases), replays `test/regressions/project-fuzz/*.json` and shows each check failing; `fuzz/project-loader.ts` (`npm run fuzz -w @fission/testing`, env `FISSION_FUZZ_SECONDS`, `FISSION_SEED` decimal, `FISSION_FUZZ_OUT`) is the long run the nightly `fuzz.yml` uses.
- `baseline/app.ts`: the app's speed and memory for `tests/baseline.json` (opening and saving a big project, 200 edits undone, kernel calls through the WASM build): JavaScript heap kept after GC, the kernel's WebAssembly memory, time relative to a fixed workload; run by `.github/scripts/baseline.py` (CI job `baseline`).
