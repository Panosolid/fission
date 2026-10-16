# Testing

Contents of `packages/testing`; the rules are in packages/CLAUDE.md and the root CLAUDE.md. Keep this list current when you add or change a file here.

- the Workspace API boundary test, the "zero exports" journeys (`journeys/*.journey.ts`, on the real kernel through `src/node-kernel.ts`; `JOURNEYS`/`ROUND_TRIPS` list the ones waiting), the magic-moment journeys (`src/magic.ts`: `MAGIC_JOURNEYS` with click and time limits, `judge`, `reportLine`; walked in the browser by `apps/fission/e2e/journeys.mjs`; compared with `tests/baseline.json` "journeys" by `parseBaselines`, `compareToBaseline`, `baselineLine`), and DRAFT harness interfaces.
- `journeys/sketch-kernel.journey.ts`: the sketch ops on the real kernel (step 21a): hand-worked snaps and a 3-4-5 triangle, then 5 seeds × 40 snapped star polygons drawn as shuffled, reversed lines, each closing into the loop drawn with volume = shoelace area × height, and opening again when one end moves a grid step.
- `test/history-fuzz.test.ts`: seeded edit/undo/redo sessions on a real project against a two-stack model (step 20a).
