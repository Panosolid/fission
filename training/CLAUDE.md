# Training data

Contents of `training/`: the training data generator for Panosolid's own model (docs/ai.md, "Panosolid's own model"; roadmap A11, progress in docs/progress/ai.md). Nothing in the app imports it; it is kept apart so it can move to a repository of its own. Keep this list current when you add or change a file here.

- `src/recipe.ts`: the parts: a `CommandRule` per command (how it is built on the kernel, the reason when it is refused) and `Recipe`s (how people ask for it), making `Draft`s.
- `src/lengths.ts`: lengths as written ("4 cm", "1.5 inches", a bare number is mm) and the millimetres they mean, in one rounding.
- `src/design.ts`: Design's rules (`set_part` built as the viewer builds it, `export_stl` as a whole STL) and recipes (create, edit by, set, scale, change shape, export), with the conventions answers follow.
- `src/generate.ts`: `generate` (seeded; refuses to run when an offered command has no rule or recipe), `checkDraft` (parseCommand, held-out wordings, setup then answer on the kernel), `replay`, `wording`, `hash` (FNV-1a), `commandApiVersion`.
- `src/records.ts`: chat records with the app's own `systemPrompt` (describing the offered commands, AI4), the validation split by id, the manifest.
- `scripts/generate.ts`: `npm run generate -w @fission/training -- --count 5000 --seed 1 --out data` writes train.jsonl, validation.jsonl and manifest.json (after the WASM build; `data/` is not committed).
- Tests: `test/consistency.test.ts` (an independent reader of the words, `test/reader.ts`, agrees with every command; mislabellings put in on purpose are caught), `test/hand-worked.test.ts` (seed 1's first ten, checked by hand), `test/generate.test.ts` (each check refusing its break, determinism, coverage of every workspace's commands), `test/lengths.test.ts`; `journeys/kernel.journey.ts` on the real kernel (`npm run journeys`, after a build). `test/fakes.ts` is a stand-in kernel.
