# Testing

Contents of `packages/testing`; the rules are in packages/CLAUDE.md and the root CLAUDE.md. Keep this list current when you add or change a file here.

- the Workspace API boundary test, the "zero exports" journeys (`journeys/*.journey.ts`, on the real kernel through `src/node-kernel.ts`; `JOURNEYS`/`ROUND_TRIPS` list the ones waiting), the magic-moment journeys (`src/magic.ts`: `MAGIC_JOURNEYS` with click and time limits, `judge`, `reportLine`; walked in the browser by `apps/fission/e2e/journeys.mjs`), and DRAFT harness interfaces.
