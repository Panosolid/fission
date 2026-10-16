# Fission

A free, open-source suite for making things: parametric CAD at its heart, with rendering, simulation, CNC, laser cutting and 3D printing as workspaces of the same app, sharing one project. Professional tools without the subscription. The owner is a student learning the maths behind every algorithm. Correctness beats speed: geometry bugs are silent (a face 0.0001 mm off looks fine until a boolean fails three operations later), so nothing is done until it is checked automatically.

End goal, a world-class free CAD suite anyone can use instead of a paid subscription:
- A kernel trusted like a commercial one: exact B-rep geometry, booleans, fillets, NURBS, STEP in and out, every result validated, crashes as rare as possible, tests that stay ahead of the features.
- Parametric Design good enough for real parts: constrained sketches, a feature timeline that survives edits (topological naming), assemblies and drawings.
- The best integration of any creative and making tools: ten workspaces (Design, Render, Simulate, Manufacture, Laser, Slice, Circuit, Vector, Image, Layout) sharing one project, live-linked, with lossless round trips and no exporting files between them.
- An optional AI assistant that costs us nothing to run (the user picks the provider), only issues the same commands a user could, previews everything, and never controls a machine.
- Free community sharing, no payments anywhere. A licence is chosen once the CAD is decent (the owner's call; not yet).

## Top rules

- No kernel operation may panic on any input; bad input returns `KernelError::InvalidInput`.
- Never weaken, skip or delete a test to make it pass.
- Never loosen a tolerance without asking the owner first.
- Every bug gets a regression test before the fix.
- Placeholders never pretend to work.

## Repository layout

Each folder with its own CLAUDE.md (kernel/, packages/, workspaces/, apps/) has the details; it loads when you work there.
- `kernel/`: Rust geometry kernel → WebAssembly. `src/tolerance.rs` is the only place epsilons live; every operation's result goes through `validate::checked()`; when a kernel operation lands, add it to the stateful harness (`tests/stateful.rs`: `Op`, `Scene::transitions`, `apply_op`, `replay_op`) the same day.
- `packages/`: shared TypeScript (core document model and kernel bridge, viewport, ui, testing, ai; storage and community are placeholders). `packages/core/src/kernel/kernel-client.ts` is the only way the app talks to the kernel.
- `workspaces/`: the ten workspaces (Design real, the rest placeholders). `apps/fission`: the app shell and browser tests.
- `docs/`: `roadmap.md` (the full roadmap), `integration.md`, `ai.md`, `project-format.md`, `community.md`.
- `prototypes/`: Python sketches of the maths, used to try algorithms before writing Rust (and `oracle/compare.py`, the OpenCascade oracle).
- `.github/workflows/`: `ci.yml` (kernel tests, app build), `pages.yml` (deploys `main` to GitHub Pages), `nightly.yml` ("Random testing", results on the `test-results` branch; see kernel/CLAUDE.md).
- Generated, never committed: `kernel/target/`, `kernel/endless-results/`, `kernel/mutants.out*/`, `packages/core/src/kernel/wasm/`, `apps/fission/dist/`, `node_modules/`.

## Current work

Keep this section current: update it whenever a step lands.

Done: steps 1–18 (step 15: the self-intersection check, mutation-tested; 16: the Design layout; 17: one selection of bodies, faces and edges, with placeholder ids until step 32; 18: view controls, Fit framed to the narrower field of view, and the view cube); the modelling range is 1 km / 10 nm (decided during step 15, measured and guarded by a test); integration I7 and the NOW parts of I8–I21, A1–A6 and A9 (each item in `docs/roadmap.md` says what remains), with the owner's three decisions: one generic Outline producer (the sketcher plugs into it at step 21); today's single shape is feature #1 of a one-step timeline using the exact intent, provenance and dependency structures step 32 will use; the overlay's real use is marking faces of a part too big for accurate STL (and, if cheap, the failure-dump viewer through the same overlay format; never show rejected parts in the app). Report back to the owner on these as the specs ask. Once PR #8 and the integration branch are merged into `main`, scheduled random testing and the Pages app run the latest work.

Next steps (the rest of the roadmap, in as much detail as it needs, is `docs/roadmap.md`; each item lives in one file only: move the next item here when one is ticked, and ticked ones back there):
- [ ] 19. Save/load JSON documents + autosave (with I1: the project file holds every workspace's data and round-trips it)
  - [x] 19a. Save and open a project file: `projectToJson` (sorted keys, refuses NaN/Infinity naming where) and `projectFromJson(text, readers)` in `packages/core/src/model/project.ts`; Design's `readDesignDocument` now checks down to the panel's numbers through `partOf` (the inverse of `partDocument`); Design's mount shows the project's document when it isn't the one the panel last made (an opened file), as loaded, and re-frames. Top bar: Save, Open, and `#file-status` for refusals. Verified: unit tests (hand-worked file text, a hand-written 50 × 30 × 20 file, version 1, each refusal), the `open-saved-file` journey on the real kernel (V = 30000), e2e Save → reload → Open (30,000 mm³, browser row, radius √3800/2) and refused files keep the open part.
  - [x] 19b. Projects kept in the browser: `packages/storage` has a real `localStore(readers)` (`projectStore` over a `KeyValue`; `memoryKeyValue` for tests, `indexedDbKeyValue` in the browser); list is newest first, open goes through `projectFromJson`, a missing id or a corrupt stored project is refused with a message, an unreadable summary still lists with a `problem`. Unit tests in `packages/storage/test/store.test.ts`; browser check `apps/fission/e2e/storage.mjs` (save, reload, list and open; corrupt refused; remove survives a reload).
  - [x] 19c. Autosave: `startAutosave(store, id, project, onStatus, {quietMs, timers})` in `packages/storage/src/autosave.ts` saves 1 s after the last change (one save in flight, the latest state wins, identical text skipped, a failure reported and retried on the next change). Workspaces call the new `ctx.projectChanged()` after writing `ctx.project` (Design does; the API test checks placeholders never do). The shell opens the newest stored project on start (else a new id), gives an opened file a new stored id, and shows `#save-status` ("Saving…", "Saved", "Not saved: …"; a ✓/…/! mark beside the name at phone width). Verified: 11 unit tests on a fake clock (burst of ten → one save of the last; a change during a save → exactly one more; 0.9×/1.1× of the quiet time; failing store), each guard broken once to see its test fail; e2e edit → Saved → reload brings back 50 × 30 × 20 (30,000 mm³, 6,200 mm²) under the same id, and breaking `projectChanged` fails it. The smoke test's main page forgets IndexedDB on each load so its other checks still start fresh.
  - [ ] 19d. Fit and check: a stored project that no longer opens starts an empty project with a visible message (never a blank app; `start()` in `apps/fission/src/main.ts` already does this through `#file-status`, untested: add an e2e that stores a corrupt project and reloads); storage full is reported; Save/Open and the status at phone width (no sideways scroll, focus order; at 375 px Save/Open squeeze the workspace tabs to one visible tab, so consider a menu); screenshots at 1280 and 375 px looked at; tick 19 and I1's save/load half.
## Definition of done for a roadmap item

1. Tier 1 is clean (kernel: kernel/CLAUDE.md; TypeScript: `npm test` and `npm run typecheck`, packages/CLAUDE.md): no lint warnings, and the tests for the changed modules pass.
2. Tier 2 property tests for the feature exist and pass, with nasty cases included (the kernel's Tier 2 list is in kernel/CLAUDE.md).
3. The test quality rules below are met (hand-worked test with the working shown, 0.9×/1.1× boundary tests).
4. If the feature is visible, it has been checked in a real browser (the e2e smoke test, or a Playwright screenshot).
5. The roadmap item is ticked (above, or in `docs/roadmap.md`), then committed and pushed with a message saying what was done and how it was verified.

## Testing rules (all code)

Nothing is "done" until it is checked automatically. The kernel's own rules (validation, tolerance, the three tiers, the oracle, mutation testing, visual debugging) are in kernel/CLAUDE.md.

### Deterministic and reproducible
- Every random test and simulated session uses a seed. Same seed + same code = same result.
- On failure, save the seed and the minimal failing input in `tests/regressions/` so it replays exactly.
- When proptest shrinks a failure to a minimal case, keep that case as a permanent test.

### Every bug gets a regression test
Reproduce it as a failing test first (shape files or timeline JSON), then fix it, then keep the test forever. Never fix a geometry bug without a test that would have caught it.

### Test quality rules for every new module
- At least one hand-worked test: an expected value worked out independently of the code (by hand, from geometry or algebra), with the working shown in a comment next to the assertion. Example: "closest point on a unit circle to (2,0): it lies on the ray from the centre through the point at distance r, so (1,0)".
- A module that compares against a tolerance needs boundary tests at 0.9× (must pass) and 1.1× (must fail) of that tolerance.
- Self-consistency tests (round trips like project(eval(uv)) == uv, finite differences vs analytic derivatives, two code paths agreeing) are allowed and useful, but don't count towards either requirement. They catch inconsistency, not a shared mistake.
- A test must be able to fail. When adding a check, also add a test that breaks a valid input in exactly that way and asserts the specific error.

### Metrics and baselines
- Known-good metrics live in `tests/baseline.json` (rebuild success rate, naming success rate, validation pass rate, performance).
- Flag anything worse by more than 2% (success rates) or 15% (performance).
- Only update the baseline when the owner confirms the change is intentional.

### Reporting
After a run, report briefly: PASS/FAIL per tier; any metric that moved from baseline (old vs new); new failing seeds/cases, where they were saved, and a one-line description of each shape; best guess at the cause and which recent change likely did it. Don't list everything that passed.

## Git workflow

- Develop on the branch named by the session. Commit after every completed step (each roadmap item separately) and after every bug fix together with its regression test; never leave more than one step uncommitted.
- Push after each commit, without asking first (owner's decision): pushes only touch the session's branch, never `main`, and random testing only runs on pushed work. After every kernel push, start a random-testing run (kernel/CLAUDE.md).
- Commit messages: a first line naming the step and feature (e.g. "Step 7: box primitive in the viewer"), then what changed and how it was verified.
- Commit as the owner's GitHub account (each new container: `git config user.name benpy28` and `git config user.email 333175357+benpy28@users.noreply.github.com`), and keep the Co-Authored-By: Claude line in every commit message.
- Never commit generated files (listed under Repository layout).

## Saving usage

- Split every step into substeps before starting it (15a, 15b, … under the step in Current work), each small enough for one short thread and one commit. Finish a substep, commit and push, tick it, and write the next one's starting point into its line (files, commands, what is already known), so a fresh thread can carry on without reading old threads. Start a new thread every substep or two: a long thread re-reads its whole history on every message.
- At the start of a session, read only `summary.txt` from the `test-results` branch. Open `failures/` only if the summary shows a new failure.
- Read only relevant files; search instead of reading whole files.
- Keep modules small with clear interfaces (curves, surfaces, topology, intersect, boolean, fillet, io, sketch, timeline).
- Don't rerun passing tests unless the code they cover changed.
- If a fix fails twice, stop and explain the problem instead of trying random changes.

## Owner preferences

- Answer the owner's message first, before carrying on with work. Explain things in chat in plain words, not in Markdown or PDF documents.
- Call roadmap items "steps", not days.
- Show evidence, not claims: when asked whether tests work, run them (including a deliberately broken case) and show the output.
