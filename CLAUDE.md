# SpindleLabs

A free, open-source suite for making things: parametric CAD at its heart, with rendering, simulation, CNC, laser cutting and 3D printing as workspaces of the same app, sharing one project. Professional tools without the subscription. The owner is a student learning the maths behind every algorithm. Correctness beats speed: geometry bugs are silent (a face 0.0001 mm off looks fine until a boolean fails three operations later), so nothing is done until it is checked automatically.

End goal, a world-class free CAD suite anyone can use instead of a paid subscription:
- A kernel trusted like a commercial one: exact B-rep geometry, booleans, fillets, NURBS, STEP in and out, every result validated, crashes as rare as possible, tests that stay ahead of the features.
- Parametric Design good enough for real parts: constrained sketches, a feature timeline that survives edits (topological naming), assemblies and drawings.
- The best integration of any creative and making tools: ten workspaces (Design, Render, Simulate, Manufacture, Laser, Slice, Circuit, Vector, Image, Layout) sharing one project, live-linked, with lossless round trips and no exporting files between them. This is the flagship, so moving a design between workspaces should feel like one tool; it never comes at the cost of CAD reliability or slows the kernel roadmap (rules: packages/CLAUDE.md, "Ecosystem"; reasons: docs/integration.md).
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
- `docs/`: `progress/` (one progress file per workstream, see below), `roadmap.md` (the full roadmap), `integration.md`, `integration-map.md` (every link between workspaces), `ai.md`, `project-format.md`, `community.md`.
- `prototypes/`: Python sketches of the maths, used to try algorithms before writing Rust (and `oracle/compare.py`, the OpenCascade oracle).
- `.github/workflows/`: `ci.yml` (kernel tests, app build), `pages.yml` (deploys `main` to GitHub Pages), `nightly.yml` ("Random testing", results on the `test-results` branch; see kernel/CLAUDE.md), `fuzz.yml` ("Fuzzing" the STL reader, the project loader and the kernel's coverage-guided targets in `kernel/fuzz/` nightly at 23:10 UTC, after random testing; results in `fuzz/` on `test-results`, issues like random testing), `auto-merge.yml` (merges `claude/` pull requests into `main` once green and up to date with it; rules in `.github/scripts/automerge.py`).
- Generated, never committed: `kernel/target/`, `kernel/fuzz/{target,corpus,artifacts}/`, `kernel/endless-results/`, `kernel/mutants.out*/`, `packages/core/src/kernel/wasm/`, `apps/fission/dist/`, `node_modules/`.

## Workstreams and where progress lives

Several threads run at once, one per workstream. So they never edit the same lines, each workstream keeps its own progress file in `docs/progress/` (what is done, the next step and its substeps, the branch the next thread starts from):
- `cad.md`: the numbered CAD steps (1, 2, … 20 undo/redo onward) and the kernel.
- `integration.md`: the integration experience steps (X…) and the I, A and other cross-workspace items.
- `booleans.md`: the boolean design review B0 and the boolean steps.
- `image.md`: the Image workspace (G…).
- `ai.md`: the AI assistant (AI1…, and the A items in `docs/roadmap.md`).
- `video.md`: the Video workspace (F0–F14: design decisions and every substep's test plan).
- `slice.md`: the Slice workspace, 3D printing (P0–P14: design decisions and every substep's test plan).
- `ui.md`: the UI look and feel (U1–U8: top bar icons, light mode, settings, panels, phone, home screen).
- A new workstream (Render, Vector, Layout…) gets a new file here the day it starts, added to this list in its own small PR.

Rules:
- A thread updates only its own workstream's file, and in `docs/roadmap.md` only its own section. Never edit another workstream's file, even to tick something; if another workstream needs to know something, say so in the thread.
- Package and workspace details (which file does what) live in that folder's own CLAUDE.md (for example `packages/core/CLAUDE.md`, `workspaces/image/CLAUDE.md`), so each thread edits the folder it works in. Add a line there when you add a file.
- Shared rule files (this file, `packages/CLAUDE.md`, `kernel/CLAUDE.md`, `docs/integration*.md`) change only when a rule changes, in a small edit, never to record progress.
- Order (owner's decision): integration X1–X8 one per thread, then step 20 (undo/redo); step 20 never runs alongside an X step, since both touch the action and ownership code. Image and booleans run in parallel.

## Definition of done for a roadmap item

1. Tier 1 is clean (kernel: kernel/CLAUDE.md; TypeScript: `npm test` and `npm run typecheck`, packages/CLAUDE.md): no lint warnings, and the tests for the changed modules pass.
2. Tier 2 property tests for the feature exist and pass, with nasty cases included (the kernel's Tier 2 list is in kernel/CLAUDE.md).
3. The test quality rules below are met (hand-worked test with the working shown, 0.9×/1.1× boundary tests).
4. If the feature is visible, it has been checked in a real browser (the e2e smoke test, or a Playwright screenshot).
5. The roadmap item is ticked (in your workstream's `docs/progress/` file, or in `docs/roadmap.md`), then committed and pushed with a message saying what was done and how it was verified.

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
- Pull requests from `claude/` branches merge into `main` by themselves (`auto-merge.yml`, owner's decision) once every check on the head passed and the branch contains the current `main`; for a green branch that is behind it comments asking the thread to merge `main` in and push (it never pushes itself: main's ruleset only counts CI from the pull request's own push), and a merge GitHub refuses never holds up the others. Open a pull request as a draft, or add the `hold` label, while it is not ready to go live; a stacked pull request merges after the one under it.
- Keep pull requests mergeable without the owner: merge `main` into the branch (a merge commit, never a rebase) and rerun the affected tests right before marking a pull request ready, and again on every merge-conflict notice. Auto-merge brings a green branch up to date by itself when git can; a conflict is the thread's to resolve (a pull request still in conflict after 15 minutes gets a comment from auto-merge naming the files; treat it like a conflict notice).
- Avoid the files every feature edits: a feature's styles go in `src/styles/<feature>.css` (packages/ui or a workspace), every selector starting with `.<feature>`, loaded by the app without a list; never add a feature's styles to `packages/ui/src/theme.css`, which holds only the base layout (the Image workspace's styles still in it move to their own file the next time that workspace changes).

## Saving usage

- Split every step into substeps before starting it (15a, 15b, … under the step in your workstream's `docs/progress/` file), each small enough for one short thread and one commit. Finish a substep, commit and push, tick it, and write the next one's starting point into its line (files, commands, what is already known), so a fresh thread can carry on without reading old threads. Start a new thread every substep or two: a long thread re-reads its whole history on every message.
- At the start of a session, read only `summary.txt` from the `test-results` branch. Open `failures/` only if the summary shows a new failure.
- Read only relevant files; search instead of reading whole files.
- Keep modules small with clear interfaces (curves, surfaces, topology, intersect, boolean, fillet, io, sketch, timeline).
- Don't rerun passing tests unless the code they cover changed.
- If a fix fails twice, stop and explain the problem instead of trying random changes.

## Owner preferences

- Answer the owner's message first, before carrying on with work. Explain things in chat in plain words, not in Markdown or PDF documents.
- Call roadmap items "steps", not days.
- Show evidence, not claims: when asked whether tests work, run them (including a deliberately broken case) and show the output.
