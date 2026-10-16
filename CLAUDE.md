# Fission

A free, open-source suite for making things: parametric CAD at its heart, with rendering, simulation, CNC, laser cutting and 3D printing as workspaces of the same app, sharing one project. Professional tools without the subscription.

The owner is a student learning the maths behind every algorithm. Correctness beats speed: geometry bugs are silent, so nothing is done until it is checked automatically.

## End goal

A world-class, free CAD suite that anyone can use instead of a paid subscription:
- A kernel trusted like a commercial one: exact B-rep geometry, booleans, fillets, NURBS, STEP in and out, every result validated, crashes as rare as possible, tests that stay ahead of the features.
- Parametric Design good enough for real parts: sketches with constraints, a feature timeline that survives edits (topological naming), assemblies and drawings.
- The best integration of any creative and making tools: nine workspaces (Design, Render, Simulate, Manufacture, Laser, Slice, Circuit, Vector, Image) sharing one project, live-linked, with lossless round trips and no exporting files between them.
- An optional AI assistant that costs us nothing to run (the user picks the provider), only issues the same commands a user could, previews everything, and never controls a machine.
- Free community sharing, no payments anywhere. A licence is chosen once the CAD is decent (the owner's call; not yet).

## Where things stand and what comes next

Keep this section current: update it whenever a step lands.

Done: steps 1–14; step 15's self-intersection check works and is pushed; the modelling range is 1 km / 10 nm (decided after 15, measured and guarded by a test); integration I7 (Circuit, Vector, Image placeholders); the NOW parts of I8–I21 (see each item for what remains). PR #8 (to `main`) was green and mergeable when last checked; after it merges, scheduled random testing and the Pages app run the latest work.

Next, in this order:
1. Done: integration foundations, the NOW parts of I8–I21 (see the roadmap), with the owner's three decisions: one generic Outline producer (the sketcher plugs into it at step 21); today's single shape is feature #1 of a one-step timeline using the exact intent, provenance and dependency structures step 32 will use; the overlay's real use is marking faces of a part too big for accurate STL (and, if cheap, the failure-dump viewer through the same overlay format; never show rejected parts in the app). Then report back to the owner as the spec asks.
2. Done: AI architecture, the NOW parts of A1–A6 and A9 (see each item for what remains).
3. Finish step 15: rerun mutation testing on `src/self_intersect.rs` and `src/intersect.rs` (the code changed with the range), add tests for real survivors and written reasons for equivalent ones, tick step 15.
4. Step 16 onwards (Design workspace layout, selection, view controls, save/load, undo, then the sketcher).

Standing habits: commit and push after every step and every bug fix; after every kernel push start a "Random testing" run on the branch and check `test-results` at the start of the next session; answer the owner's message first, in plain words, before carrying on with work.

## Repository layout

- `kernel/`: Rust geometry kernel, compiled to WebAssembly with wasm-pack.
  - `src/tolerance.rs`: every tolerance and the exact predicates. The only place epsilons live.
  - `src/geom/`: analytic curves (`curve.rs`: Line, Circle), surfaces (`surface.rs`: Plane, Cylinder, Sphere), similarity transforms (`transform.rs`), placements (`placement.rs`: a rigid motion kept apart from geometry, rotation as a unit quaternion plus a shift).
  - `src/topology.rs`: B-rep arenas (Vertex, Edge, Coedge, Loop, Face, Shell, Body) and Euler counts.
  - `src/validate.rs`: `validate()` and `checked()`. Every operation's result goes through `checked()`.
  - `src/tessellate.rs`: B-rep → watertight triangle mesh (constrained Delaunay in uv space via `spade`).
  - `src/placed.rs`: `Placed` = a body's local geometry plus its placement. Moves and turns change only the placement; volume, area and the mesh's shape come from the untouched geometry; `baked()` gives world geometry where it is needed.
  - `src/accurate.rs`: double-double arithmetic (exact two-sum/two-product, 3×3 determinants) for sums where large terms cancel.
  - `src/mesh.rs`: triangle mesh, volume (double-double determinants), area, closed-mesh check.
  - `src/mass.rs`: exact volume and area of a B-rep from its edges (vector area by Stokes, divergence theorem, cylinder flux, Gauss–Bonnet on spheres), written to keep digits for far-away and huge-radius geometry. The app shows these, not mesh values.
  - `src/display.rs`: mesh shaped for the viewer (per-face normals, edge lines).
  - `src/stl.rs`: binary STL export (reports the largest rounding to single precision and warns past MIN_FEATURE) and reading it back.
  - `src/ops/`: modelling operations (`primitives.rs`: box, cylinder, sphere; `profile.rs`: profiles of lines, arcs (bulges) and circles, and their validity rules; `extrude.rs`: extrusion of a profile; `transform.rs`: move, rotate, which take and return `Placed`; a rotation pivot must lie in model space). Each returns `Result<Body, KernelError>` via `ops::finish`.
  - `src/intersect.rs`: where curves and surfaces meet (lines and circles against planes, cylinders, spheres and each other; the closed curves where two surfaces cross). Proposes candidate points only, never decides that two things touch; known shared points are divided out so tangent joins aren't mistaken for contacts.
  - `src/self_intersect.rs`: the self-intersection check `validate` runs (edge–edge, edge–face, face–face; each candidate from `intersect.rs` measured against LINEAR), with point-in-face classification and sweep-and-prune pairing.
  - `src/fixtures.rs`: hand-built test bodies (cube, cylinder, sphere, half cylinder, tube, sphere cap/slice/octant) that don't use `ops`, so validation and tessellation are tested against shapes whose correctness is obvious from the code.
  - `src/lib.rs`: the `#[wasm_bindgen]` API the app calls (`make_box`, `make_cylinder`, `make_sphere`, `make_extrude` → `BodyView`, with exact volume and area; `export_stl(spec, name)` → `StlFile`, where a `BodySpec` names the same shapes). Keep it thin.
  - `src/debug_dump.rs`: failure dumps: ASCII STL per body plus `index.html`, a viewer that loads nothing (plain 2D canvas, works offline, draws relative to the scene's middle in doubles). In red: faces and edges a validation error names, vertices off their edges, every face of an inside-out shell, the mesh's open or flipped edges; dashed red: a named edge's own curve. `checked` writes one (`dump_invalid`, at most 20 per process) into `kernel/target/failure-dumps/` before panicking and names it in the panic; the harness writes its own there too, and `endless.sh` copies them into each nightly failure folder. `examples/dump_demo.rs` writes the two dumps the browser check opens.
  - `tests/stateful.rs`: stateful random-testing harness (see its header). When a kernel operation lands, add it to `Op`, `Scene::transitions`, `apply_op` and `replay_op` the same day.
  - `tests/regressions/`: proptest failure seeds and `stateful/*.json` minimal failing chains (committed; replayed forever by `saved_regressions_still_pass`).
  - `scripts/overnight.sh`: Tier 3 run. `scripts/endless.sh`: the same, round after round with random seeds, logging to `endless-results/`.
- `prototypes/oracle/compare.py`: OpenCascade oracle comparison for bodies written by the harness (box, cylinder, sphere, extrusion).
- TypeScript (one npm workspace at the repo root, one lockfile; packages are TypeScript source with `exports` pointing at `src/index.ts`, no build step between them; imports inside a package name their `.ts` files so Node's test runner can load them; every package has `test/*.test.ts` run by `npm test` at the root):
  - `packages/core`: the shared document model and the kernel bridge. `src/kernel/`: `kernel-client.ts` is the only way the app talks to the kernel (`kernel.call(op, ...args)` returns a promise; add new ops to `KernelOps` and the worker's `ops` table), `kernel.worker.ts` runs the WASM kernel in a Web Worker, `kernel-types.ts` shapes of kernel results and inputs (`Outline`, the kernel's `ProfileIn`); `npm run kernel` (in `apps/fission`) builds the WASM package into `src/kernel/wasm/` (generated, gitignored). `src/model/`: built: `project.ts` (format version and migrations), `representation.ts` (registry), `feature.ts` (intent, provenance, timeline), `graph.ts` (dependencies, staleness), `links.ts`, `overlay.ts`, `workspace.ts` (the public Workspace API); DRAFT: `material.ts`, `machines.ts`, `search.ts`, `feedback.ts`, `parameters.ts`, `references.ts`, `session.ts`, `viewport.ts`. See docs/integration.md.
  - `packages/viewport`: the one Three.js viewport every workspace draws into (`Viewer`, implements `SharedViewport`) and the camera re-framing rule.
  - `packages/ui`: shared UI kit: number formatting, theme (`theme.css`), workspace switcher, placeholder page.
  - `packages/testing`: the Workspace API boundary test, the "zero exports" journeys (`journeys/*.journey.ts`, on the real kernel through `src/node-kernel.ts`; `JOURNEYS`/`ROUND_TRIPS` list the ones waiting), and DRAFT harness interfaces.
  - `packages/ai`: the optional AI assistant (docs/ai.md): providers (placeholders), `askForCommands`, `buildContext`, specialist models and per-workspace plans; the panel itself is `apps/fission/src/assistant.ts`.
  - `packages/storage`, `packages/community`: placeholders (interfaces only; every function throws "not implemented").
  - `workspaces/design`: the CAD workspace (`workspace.ts`; `profiles.ts` ready-made outlines until the sketcher). `workspaces/render`, `simulate`, `manufacture`, `laser`, `slice`, `circuit`, `vector`, `image`: placeholders.
  - `apps/fission`: the app shell (`src/main.ts`: top bar, workspace switcher, side panel, shared viewport; `#design`, `#slice`… links open a workspace), `e2e/smoke.mjs` browser test, `e2e/dump-viewer.mjs` browser check of the kernel's failure-dump page (both run by `npm run e2e`).
- `docs/roadmap.md`: the full roadmap (everything beyond the next stretch below). `docs/community.md`: open questions for the community library's server. `docs/integration.md`: how the workspaces work together. `docs/project-format.md`: the open project format and its migration rules. `docs/ai.md`: the AI assistant's architecture.
- `prototypes/`: Python sketches of the maths, used to try algorithms before writing Rust.
- `.github/workflows/`: `ci.yml` (kernel tests, app build), `pages.yml` (deploys `main` to GitHub Pages), `nightly.yml` ("Random testing": every 6 hours, 4 jobs × ~5 h of `endless.sh`; results accumulate on the `test-results` branch: `summary.txt`, `log.csv`, `failures/<seed>/`; an issue is opened when something is found).

## Commands

- Tier 1 (after every change): `cd kernel && cargo clippy --all-targets && cargo test <module>`
- Before pushing kernel changes, also build for the browser: `cd kernel && cargo build --target wasm32-unknown-unknown` (code gated with `#[cfg(not(target_arch = "wasm32"))]`, like `debug_dump`, must not be called from code that is built there). CI uses the latest stable Rust, whose clippy may have lints the local toolchain lacks: `rustup update stable` first.
- All kernel tests: `cd kernel && cargo test` (must show 0 failed, 0 ignored). Run them in a debug build: in `--release`, `validate::tests::checked_panics_in_test_builds` and `checked_writes_a_failure_dump_before_panicking` fail on purpose, because invalid results only panic when `debug_assertions` is on.
- After every push that changes `kernel/`, start a "Random testing" run on the pushed branch (GitHub Actions, `nightly.yml`, workflow_dispatch with `ref` = the branch). Scheduled runs only test `main`, so work not yet merged is tested only this way. Check its results on the `test-results` branch at the start of the next session.
- Precision measurement: `cd kernel && cargo run --release --example precision_budget` (how far intersection points land from both pieces, by part size and distance from the origin; evidence for the modelling range).
- Mutation testing: `cd kernel && cargo mutants -f src/<file>.rs` (install once per container: `cargo install cargo-mutants --locked`; not while `rustup update` runs). Each surviving mutant gets a test, or is listed as equivalent, with the reason, in a "Mutation testing (...) leaves these survivors" paragraph at the end of the file's top `//!` comment (see `mass.rs`, `ops/profile.rs`).
- Random-testing results: `log.csv` on the `test-results` branch has `commit` and `branch` columns (and each `failures/<seed>/` a `commit.txt`) naming the code each round tested; a failure from an older commit may already be fixed or out of range.
- Install (repo root, npm workspaces): `npm install`
- Build the app: `cd apps/fission && npm run build`
- Dev server: `cd apps/fission && npm run dev`
- Unit tests of every package and workspace: `npm test` (repo root)
- Type-check every package, including ones the app does not import yet: `npm run typecheck` (repo root, after a build so the WASM types exist)
- Browser smoke test: `cd apps/fission && npm run build && npm run e2e`
- "Zero exports" journeys on the real kernel: `npm run journeys` (repo root, after a build)
- Stateful random testing, quick mode (~200 cases, ~50 s, also part of `cargo test`; ~95% of operations in range, ~5% with one extreme input, counted in the report's "~extreme input" row): `cd kernel && cargo test --test stateful -- --nocapture`
- Endless mode (owner's own computer, no Claude involved; random seed per round until Ctrl+C, results in `kernel/endless-results/`, gitignored): `cd kernel && scripts/endless.sh [cases-per-round] [rounds, 0 = endless] [python]`
- Overnight mode (100,000 cases × 4 seeds in release, then the OpenCascade oracle): `cd kernel && scripts/overnight.sh [cases] [seeds] [python]` (needs `pip install cadquery-ocp`)

Note: `wasm-opt` is disabled in `kernel/Cargo.toml` because the sandbox can't download binaryen. Harmless; re-enable when size matters.

## Supported modelling range

Every serious kernel works inside a fixed range (commercial kernels commonly use a 1 km box). Fission's:
- Feature sizes (any length parameter: width, radius, distance, and a profile's overall span) from 1 µm to 1 km: `tolerance::MIN_FEATURE` = 1e-3 mm to `tolerance::MAX_SIZE` = 1e6 mm.
- Every point of every body within ±100 km of the origin: `tolerance::MAX_COORD` = 1e8 mm. That far out a double resolves ~15 nm, fine for placing a body but too coarse to intersect there.
- Linear tolerance 10 nm (`LINEAR` = 1e-5 mm), 100× below the smallest feature. Chosen with the owner after step 15, from measurements: `examples/precision_budget.rs`, and `intersect::tests::the_modelling_range_leaves_room_for_rounding`, which fails if LINEAR or MAX_SIZE move past what doubles support (it fails for 1 nm at 1 km, 10 nm at 10 km and 1 nm at 10 km). At 1 km, crossings steeper than 0.6° land ~300× inside LINEAR, but 0.06° to 0.6° crossings can slide 0.4 LINEAR along the curve: booleans must handle shallow crossings with care (step 45).
- Geometry is intersected near its own origin. Before booleans (step 44), when two bodies meet, bake them into a frame centred on them, not the world frame: at 100 km out, the position alone costs ~0.07 LINEAR per intersection at shallow crossings.
- There is no rule on the ratio of smallest feature to part size yet (the cap makes it at most 1e9). Measure again at step 44, when the volume formula for turned, baked thin parts is rewritten.
- Operations outside the range return `KernelError::InvalidInput`; they never panic and never produce geometry.
- Volumes, areas and projections are computed relative to a local origin (the body's or mesh's bounding-box centre, or a point on the face), never the world origin.
- The fuzzer spends ~95% of its inputs inside the range and ~5% on extreme inputs, which only have to produce clean errors.

## Kernel conventions

- Units are millimetres. Z is up (the viewer sets `Object3D.DEFAULT_UP` to +Z).
- Model sizes must be within (LINEAR, MAX_SIZE]; `ops::check_length` enforces this for every length input.
- A face's outward normal is its surface's natural normal (∂u × ∂v), flipped when `sense` is false. Cylinder and sphere natural normals point away from the axis/centre.
- Loops run counter-clockwise seen from outside, so the face interior is on the left of every coedge (normal × tangent points into the face). The first loop of a face is the outer one when it has one.
- Every edge is used by exactly two coedges, once in each direction. Edges run start → end over t0 < t1; full circles are closed edges with start == end and no seam vertex. Cylinder side faces have no seam edge; they have two loops.
- Euler–Poincaré per shell: V − E + F − R = 2(1 − genus), where R counts inner loops.
- Tessellation: edges are discretised once and shared by both faces, so meshes are watertight by construction. `TessOptions::refine` multiplies every curved segment count (used for Richardson extrapolation of mass properties).
- Kernel operations never panic on bad user input; they return `KernelError::InvalidInput`. Invalid results panic in debug/test builds (they are bugs) and return `KernelError::InvalidResult` in release.

## Definition of done for a roadmap item

1. Tier 1 is clean: clippy has no warnings, and the tests for the changed modules pass.
2. Tier 2 property tests for the feature exist and pass, with nasty cases included.
3. The test quality rules below are met (hand-worked test with the working shown, 0.9×/1.1× boundary tests).
4. If the feature is visible, it has been checked in a real browser (the e2e smoke test, or a Playwright screenshot).
5. The roadmap item is ticked (below, or in `docs/roadmap.md`), then committed and pushed with a message saying what was done and how it was verified.

## Ecosystem: one project, many workspaces

Nine workspaces (Design, Render, Simulate, Manufacture, Laser, Slice, Circuit, Vector, Image) share one project and one document model. Making them work together without any hassle is the priority, ahead of any single workspace's features. The rules (Design is the source of truth for geometry; references by stable ID that re-resolve or warn, never break silently; representations most exact first; live links; lossless round trips; intent, provenance and staleness; one of each shared thing; placeholders stay placeholders; no private shortcuts) are in `docs/integration.md`, and the assistant's (optional; commands only, previewed, one undo step; never controls a machine; keys only in the user's browser) in `docs/ai.md`. Read the one that applies before changing `packages/core/src/model`, a workspace or `packages/ai`. Two rules hold everywhere:

- Never use other companies' product names, logos or UI styles anywhere in the UI, code or docs. Use our own names and visual style. (Tools we depend on, like OpenCascade for the oracle, are named where needed.)
- Community sharing is free only: anyone may share what they make and anyone may download it, with no paid content and no payments anywhere.

## App conventions

- The main thread never loads the WASM module; every kernel call goes through `KernelClient` to the worker (the e2e test checks this).
- Wrap UI-driven kernel calls in `latestOnly` so a late reply to an old request never overwrites a newer result.
- Kernel errors arrive as rejected promises with the kernel's message; show them, never swallow them.

## Git workflow

- Develop on the branch named by the session. Commit after every completed step (each roadmap item separately) and after every bug fix together with its regression test; never leave more than one step uncommitted.
- Push after each commit, without asking first (owner's decision): pushes only touch the session's branch, never `main`, and random testing only runs on pushed work.
- Commit messages: a first line naming the step and feature (e.g. "Step 7: box primitive in the viewer"), then what changed and how it was verified.
- Commit as the owner's GitHub account (each new container: `git config user.name benpy28` and `git config user.email 333175357+benpy28@users.noreply.github.com`), and keep the Co-Authored-By: Claude line in every commit message.
- Never commit generated files (`apps/fission/src/kernel/`, `kernel/target/`, `apps/fission/dist/`).

## Roadmap: the next steps (mark items [x] when done)

The full roadmap, with every step done so far and everything further out (booleans onwards, the other workspaces, the AI assistant, community), is `docs/roadmap.md`. Each item lives in one file only. When a stretch of the roadmap comes up next, move its items from there to here; once a stretch here is all ticked, move it back. Steps 1–14 are done (see `docs/roadmap.md`).

Kernel foundations
- [ ] 15. Self-intersection check in validate(). Easy for planes/cylinders/spheres; must be extended for general surfaces when NURBS arrive (63–64)

App shell
- [ ] 16. Design workspace layout: toolbar, browser panel, properties panel, viewport (the app shell and workspace switcher already exist)
- [ ] 17. Selection of bodies/faces/edges with highlighting
- [ ] 18. View controls: home, top/front/right, fit, view cube
- [ ] 19. Save/load JSON documents + autosave
- [ ] 20. Undo/redo (document snapshots for now; switches to timeline edits at 32–33)

Sketcher
- [ ] 21. Sketch on ground plane: lines with grid snapping. Sketches must produce Outline through the existing representation registry (I8), with a test; no sketch-only path (register `design.sketch` with `outlineProducer`; the stand-in test in workspaces/design/test/document.test.ts shows the shape)
- [ ] 22. Rectangle and circle tools
- [ ] 23. Arc tools (3-point, tangent)
- [ ] 24. Sketch on any planar face
- [ ] 25. Project/include edges into a sketch (copies for now; linked to their source through the naming scheme from 32)
- [ ] 26. Profile detection (closed regions, nested)
- [ ] 27. Constraint solver core (Newton–Raphson): coincident, horizontal, vertical
- [ ] 28. Parallel, perpendicular, equal, tangent
- [ ] 29. Editable dimensions (length, radius, angle)
- [ ] 30. Constraint status colours
- [ ] 31. Trim, extend, offset, mirror

Parametric
- [ ] 32. Feature timeline (sketch → extrude replayed on rebuild). Decide the topological naming ID scheme here (e.g. "face created by feature X, from profile edge Y, side Z") and give every face/edge such an ID, so 50 is an upgrade, not a rewrite. Undo/redo becomes "undo this timeline edit"
- [ ] 33. Edit any feature and rebuild after it; projected edges and sketch planes re-resolve through their IDs
- [ ] 34. User parameters and expressions
- [ ] 35. Cone and torus surfaces
- [ ] 36. Revolve
- [ ] 37. Per-feature error display on the timeline

Integration (the priority whenever a workspace is built; each item lands before the workspace that first needs it)
- [ ] I1. Project file holds every workspace's data; save/load round-trips it (with step 19)
- [ ] I2. References by stable ID with re-resolution after every rebuild, and unresolved-reference warnings shown on the holding item (with steps 32–33, completed at 50)
- [ ] I4. One selection and one undo/redo history across workspaces (with steps 17 and 20)
- [ ] I5. Switching workspaces keeps camera and selection; a workspace's view of the design updates live after an edit

## Testing rules

### Goal
Geometry bugs are silent: a face 0.0001mm off looks fine until a boolean fails three operations later. Nothing is "done" until it is checked automatically. Never weaken, skip or delete a test to make it pass. Never loosen a tolerance to make a test pass without asking the owner first.

### Validate after every operation
Every kernel operation (primitive, extrude, revolve, boolean, fillet, shell, import) must end with validate(solid), which checks:
- Watertight: every edge is shared by exactly two faces
- Consistent orientation: all face normals point outward
- Euler–Poincaré holds (V − E + F − R = 2(1 − genus) per shell)
- Every vertex lies on its edges, and every edge lies on its faces, within tolerance
- No zero-length edges, zero-area faces, or self-intersections

In debug and test builds, validation runs automatically and panics on failure.

### Tolerance
- One global tolerance system: `kernel/src/tolerance.rs`. Never hard-code epsilon values anywhere else.
- Use exact/robust predicates (the `robust` crate) for orientation and in/out tests.
- Every test that compares floats uses the tolerance system, never `==`.

### Tier 1: fast checks (after every change, under 30 s)
- `cargo check`, `cargo clippy`, and unit tests for the changed module only.
- Unit tests for maths: curve/surface evaluation, derivatives, normals, transforms, intersections against hand-calculated answers.

### Tier 2: property tests (before calling a feature done, under 5 min)
Use proptest for properties that must always hold:
- Booleans: vol(A ∪ B) = vol(A) + vol(B) − vol(A ∩ B); A − A is empty; A ∪ A = A; A ∩ B = B ∩ A
- Transforms don't change volume or surface area
- Extrude: volume = profile area × distance
- Round trips: export → import gives the same topology and geometry within tolerance (native format and STEP)
- Rebuild determinism: rebuilding the same timeline twice gives identical results

Include nasty cases on purpose: coplanar faces, touching edges, shared vertices, tiny overlaps, near-tangent surfaces, very large and very small sizes.

### Tier 3: overnight suite (only on schedule or when asked)
1. Large property-test runs (thousands of cases per property, multiple seeds).
2. Oracle comparison with OpenCascade (Python + cadquery/OCP): volume, area, face count, bounding box. Log disagreements for review; OpenCascade isn't always right either.
3. Golden models in `tests/golden/` (brackets, enclosures, gears, phone case): rebuild and compare to the saved result.
4. Simulated user sessions: a bot builds random models (sketch → extrude → cut → fillet → pattern), edits an early timeline step and rebuilds. Record % rebuilding without errors, % where later features still attach to the right face/edge, % passing validate(), and rebuild time vs feature count.
5. Performance: booleans, rebuilds and tessellation on the golden models.

### Deterministic and reproducible
- Every random test and simulated session uses a seed. Same seed + same code = same result.
- On failure, save the seed and the minimal failing input in `tests/regressions/` so it replays exactly.
- When proptest shrinks a failure to a minimal case, keep that case as a permanent test.

### Test quality rules for every new module
- Every new module needs at least one hand-worked test: an expected value worked out independently of the code (by hand, from geometry or algebra), with the working shown in a comment next to the assertion. Example: "closest point on a unit circle to (2,0): it lies on the ray from the centre through the point at distance r, so (1,0)".
- Every new module that compares against a tolerance needs boundary tests at 0.9× (must pass) and 1.1× (must fail) of that tolerance.
- Self-consistency tests (round trips like project(eval(uv)) == uv, finite differences vs analytic derivatives, two code paths agreeing) are allowed and useful, but don't count towards either requirement. They catch inconsistency, not a shared mistake.
- A test must be able to fail. When adding a check to validate(), also add a test that breaks a valid body in exactly that way and asserts the specific error.
- Mutation testing (`cargo mutants`) is used to find code that no test notices being broken. Surviving mutants in kernel code get a test, or a written reason why the mutant is equivalent.

### Every bug gets a regression test
Reproduce it as a failing test first (shape files or timeline JSON), then fix it, then keep the test forever. Never fix a geometry bug without a test that would have caught it.

### Metrics and baselines
- Known-good metrics live in `tests/baseline.json` (rebuild success rate, naming success rate, validation pass rate, performance).
- Flag anything worse by more than 2% (success rates) or 15% (performance).
- Only update the baseline when the owner confirms the change is intentional.

### Visual debugging
When a geometry test fails, export the failing shape(s) as STL plus a small HTML viewer page with the problem edges/faces highlighted.

### Reporting
After a run, report briefly: PASS/FAIL per tier; any metric that moved from baseline (old vs new); new failing seeds/cases, where they were saved, and a one-line description of each shape; best guess at the cause and which recent change likely did it. Don't list everything that passed.

### Saving usage
- Read only relevant files; search instead of reading whole files.
- Keep modules small with clear interfaces (curves, surfaces, topology, intersect, boolean, fillet, io, sketch, timeline).
- Don't rerun passing tests unless the code they cover changed.
- If a fix fails twice, stop and explain the problem instead of trying random changes.

## Crash-freedom (top priority)

- No kernel operation may panic on any input: bad input returns `KernelError::InvalidInput`, never silently broken geometry.
- Cost must be bounded for every legal input (e.g. `MAX_SEGMENTS_PER_TURN`).
- Use `geom::unit` (not `normalize`) on any user-supplied direction: lengths can overflow or underflow.
- In the harness, a check must verify what an operation did (independent position tracking), not only invariants it preserves.

## Owner preferences
- Explain things in chat in plain words, not in Markdown or PDF documents.
- Call roadmap items "steps", not days.
- Show evidence, not claims: when asked whether tests work, run them (including a deliberately broken case) and show the output.
