# Fission

A free, open-source suite for making things: parametric CAD at its heart, with rendering, simulation, CNC, laser cutting and 3D printing as workspaces of the same app, sharing one project. Professional tools without the subscription.

The owner is a student learning the maths behind every algorithm. Correctness beats speed: geometry bugs are silent, so nothing is done until it is checked automatically.

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
  - `packages/core`: the shared document model and the kernel bridge. `src/kernel/`: `kernel-client.ts` is the only way the app talks to the kernel (`kernel.call(op, ...args)` returns a promise; add new ops to `KernelOps` and the worker's `ops` table), `kernel.worker.ts` runs the WASM kernel in a Web Worker, `kernel-types.ts` shapes of kernel results and inputs (`Outline`, the kernel's `ProfileIn`); `npm run kernel` (in `apps/fission`) builds the WASM package into `src/kernel/wasm/` (generated, gitignored). `src/model/` (DRAFT): `Project`, `Material`, `BodyReference`/`FaceReference`/`EdgeReference`, `Selection`/`History`, `SharedViewport`, `WorkspacePlugin`.
  - `packages/viewport`: the one Three.js viewport every workspace draws into (`Viewer`, implements `SharedViewport`) and the camera re-framing rule.
  - `packages/ui`: shared UI kit: number formatting, theme (`theme.css`), workspace switcher, placeholder page.
  - `packages/storage`, `packages/ai`, `packages/testing`, `packages/community`: placeholders (interfaces only; every function throws "not implemented").
  - `workspaces/design`: the CAD workspace (`workspace.ts`; `profiles.ts` ready-made outlines until the sketcher). `workspaces/render`, `simulate`, `manufacture`, `laser`, `slice`, `circuit`, `vector`, `image`: placeholders.
  - `apps/fission`: the app shell (`src/main.ts`: top bar, workspace switcher, side panel, shared viewport; `#design`, `#slice`… links open a workspace), `e2e/smoke.mjs` browser test, `e2e/dump-viewer.mjs` browser check of the kernel's failure-dump page (both run by `npm run e2e`).
- `docs/community.md`: open questions for the community library's server.
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
5. The roadmap item is ticked here, then committed and pushed with a message saying what was done and how it was verified.

## Ecosystem: one project, many workspaces

Fission is a suite of workspaces (Design, Render, Simulate, Manufacture, Laser, Slice) sharing one project and one document model. Making them work together without any hassle is the priority, ahead of any single workspace's features.

- Design is the source of truth for all geometry. A change there flows to every other workspace automatically: no exporting files between workspaces.
- One project file holds everything: the design timeline, render scenes, simulation studies, CAM setups, laser jobs, print plates.
- Other workspaces refer to design bodies, faces and edges by stable IDs from topological naming (scheme at step 32, full at step 50). They never copy geometry. When the design changes, every reference re-resolves: a load stays on its face, a toolpath on its pocket, a plate updates its model.
- A reference that cannot be resolved after a design edit shows a clear warning on the item that holds it (like a failed timeline step). Never break it silently.
- Shared everywhere: one viewport, one selection, one undo/redo history, one materials library (a Design appearance = a Render material = Simulate's properties = Slice/Laser presets), one units system. Switching workspaces is instant and keeps the camera and selection.
- Placeholders stay placeholders: a page saying what the workspace will do, when work starts and "Coming soon", plus DRAFT typed interfaces whose functions throw "not implemented". No stub code that pretends to work, no fake results. Each placeholder has a test that it says so.
- The DRAFT interfaces in `packages/core/src/model` change as real workspaces are built; keep them small.
- Representations: every object describes itself as Outline, Solid, Mesh, Image and/or Data; workspaces declare what they produce and accept; conversion goes through the one shared layer, most exact first, and says so when it falls back to a lossy one (I8).
- Live links by default: pasting or dragging between workspaces links by stable ID; breaking a link makes a visible frozen copy; unresolved links warn (I9).
- Lossless round trips, with an integration test for each one (I10).
- Features store their intent, not just geometry (I11). Objects know their provenance (I12). Results depend on a project-wide graph and are marked out of date when an input changes, never shown stale unmarked (I13).
- AI (A1–A9): always optional, every feature works without it. It only issues the same commands a user could, through the public command API, so every result is built and validated by the kernel, previewed, and undoable as one step. It never starts, sends to or controls a physical machine: it may prepare a job, only a human click after a confirmation screen sends it. Local providers keep everything on the user's machine; remote ones show what will be sent before the first request. API keys live only in the user's own browser storage, are never logged, and go only to the provider they belong to.
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

## Roadmap (mark items [x] when done)

Kernel foundations
- [x] 1. Testing rules in repo; tolerance module with exact predicates
- [x] 2. Curves and surfaces: line, circle, plane, cylinder, sphere (eval, normal, closest point)
- [x] 3. B-rep data structure + validate(): watertight, orientation, Euler–Poincaré
- [x] 4. validate(): vertex-on-edge, edge-on-face, zero-length edges, zero-area faces
- [x] 5. Tessellation of planar faces + watertight mesh check
- [x] 6. Tessellation of cylinder and sphere faces
- [x] 7. Box primitive; viewer shows a kernel B-rep box with edges
- [x] 8. Kernel runs in a Web Worker from here on; every app→kernel call is an async message
- [x] 9. Extrude polygon profiles with holes; property test volume = area × distance
- [x] 10. Arcs/circles in profiles (cylindrical side faces); cylinder primitive
- [x] 11. Sphere primitive; accurate volume and area
- [x] 12. Move/rotate bodies; property test volume/area invariance. Bodies keep their geometry in local coordinates plus a placement transform; move/rotate only compose the placement, so moving far away and back loses nothing. Placements are baked once, into one body's frame, when two bodies meet (booleans, 44). Acceptance case: today a 26.5 × 0.0124 × 27 box placed 37.8 km out and moved back loses 8.7e-8 of its volume to rounding there (OpenCascade oracle, seed 0x5eed, 3000 cases); after this step it must not
- [x] 13. STL export + download button + round-trip test
- [x] 14. Failure dumps: STL + HTML viewer with problem edges highlighted
- [ ] 15. Self-intersection check in validate(). Easy for planes/cylinders/spheres; must be extended for general surfaces when NURBS arrive (63–64)

App shell
- [ ] 16. Design workspace layout: toolbar, browser panel, properties panel, viewport (the app shell and workspace switcher already exist)
- [ ] 17. Selection of bodies/faces/edges with highlighting
- [ ] 18. View controls: home, top/front/right, fit, view cube
- [ ] 19. Save/load JSON documents + autosave
- [ ] 20. Undo/redo (document snapshots for now; switches to timeline edits at 32–33)

Sketcher
- [ ] 21. Sketch on ground plane: lines with grid snapping. Sketches must produce Outline through the existing representation registry (I8), with a test; no sketch-only path
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

Test infrastructure (in place before booleans, which are built against it)
- [ ] 38. Golden models in tests/golden/ + tests/baseline.json metrics
- [ ] 39. OpenCascade oracle comparison (Python + cadquery/OCP): volume, area, face count, bounding box
- [ ] 40. Overnight fuzzing + simulated-user bot (Tier 3), extended as each new feature lands

Booleans
- [ ] 41. Plane–plane and line–plane intersection
- [ ] 42. Splitting planar faces along intersection lines
- [ ] 43. Inside/outside classification with exact predicates
- [ ] 44. Union/subtract/intersect for planar solids + boolean property tests + oracle comparison; add cargo-fuzz (coverage-guided) over the harness's operation set. Baking a placement rounds corners off their planes: before booleans bake turned geometry, `mass.rs` needs a volume formula that stays consistent then (a 1 km frame with 1 µm walls, turned and baked, gives 4010.3 instead of 4000.0 today; 37231 instead of 40000 at the old 10 km limit; see the step 12 regressions)
- [ ] 45. Coplanar faces, touching edges, shared vertices
- [ ] 46. Plane–cylinder intersection (drill a hole through a box)
- [ ] 47. Cylinder–cylinder, plane–sphere. Before making sphere faces other than hemispheres, give `mass.rs` a stable formula for sphere faces much smaller than their sphere (see its "Known limit") and teach tessellation general sphere faces
- [ ] 48. Extrude modes (join/cut/intersect/new body), symmetric, to-face, taper
- [ ] 49. Hole feature, Combine tool

Robustness
- [ ] 50. Full topological naming on top of the 32 scheme (faces split by booleans, merged faces, history matching)
- [ ] 51. Cached feature results, incremental rebuild

Modelling tools
- [ ] 52. Construction planes, axes, points
- [ ] 53. Sketch on construction planes
- [ ] 54. Rectangular/circular patterns, mirror
- [ ] 55. Chamfer
- [ ] 56. Fillet between planar faces
- [ ] 57. Fillet planar–curved, edge chains
- [ ] 58. Shell
- [ ] 59. Draft
- [ ] 60. Move/copy/align bodies
- [ ] 61. Measure, section view
- [ ] 62. Appearances, physical properties

Advanced geometry
- [ ] 63. NURBS curves (eval, knot insertion)
- [ ] 64. NURBS surfaces; extend the self-intersection check to general surfaces
- [ ] 65. Sketch splines
- [ ] 66. Sweep
- [ ] 67. Loft
- [ ] 68. NURBS surface–surface intersection (marching)
- [ ] 69. General fillets on curved faces

Interoperability
- [ ] 70. STEP export
- [ ] 71. STEP import (simple parts)
- [ ] 72. Healing imported geometry
- [ ] 73. 3MF and OBJ export

Assemblies and drawings
- [ ] 74. Components with their own bodies/timelines
- [ ] 75. Joints: rigid, revolute, slider
- [ ] 76. Interference checking
- [ ] 77. Drawings: projected views
- [ ] 78. Hidden-line removal
- [ ] 79. Drawing dimensions, PDF/DXF export

Extras
- [ ] 80. Realistic rendering
- [ ] 81. Tetrahedral meshing + FEM stress
- [ ] 82. CAM: 2.5D toolpaths, G-code
- [ ] 83. Sheet metal
- [ ] 84. Cloud saving, versions, sharing

Integration (the priority whenever a workspace is built; each item lands before the workspace that first needs it)
- [ ] I1. Project file holds every workspace's data; save/load round-trips it (with step 19)
- [ ] I2. References by stable ID with re-resolution after every rebuild, and unresolved-reference warnings shown on the holding item (with steps 32–33, completed at 50)
- [ ] I3. One materials library used by Design appearances (62) and every later workspace
- [ ] I4. One selection and one undo/redo history across workspaces (with steps 17 and 20)
- [ ] I5. Switching workspaces keeps camera and selection; a workspace's view of the design updates live after an edit
- [ ] I6. Cross-workspace tests: edit the design, check every workspace's references still resolve (or warn) in the harness and e2e

Integration foundations (owner's spec "Ecosystem integration — design and foundations"; build NOW = before step 16, in packages/core, small commits, every test green; everything not marked NOW is a typed DRAFT interface that throws "not implemented")
- [x] I7. NOW: Circuit, Vector, Image placeholders (pages, switcher, tests, roadmap sections below)
- [ ] I8. NOW: Representations (Outline: 2D exact paths on a plane; Solid: kernel B-rep; Mesh; Image: pixels with mm per pixel; Data: parameters, BOM lines, results) and a registry where each workspace declares what it PRODUCES and ACCEPTS. One shared conversion layer picks the most exact representation the target accepts, falls back to lossy ones (solid → mesh) only when it must, and returns a note to show when it did. Design produces Solid, Mesh and Outline for real. Owner's decision: Outline comes from the ready-made profiles through ONE generic producer that the sketcher plugs into at step 21
- [ ] I9. NOW: Live links (DRAFT behaviour, real data structure): paste/drag between workspaces makes a live link by default, referencing the source by stable ID (topological naming for geometry, object IDs otherwise), never copied data; a link can be broken into a frozen copy (visible link/unlink icon); an unresolvable link shows a warning on the item, never breaks silently
- [ ] I10. Lossless round trips: moving something between workspaces and back loses nothing (a constrained sketch → Laser → back is still constrained; a vector logo → Design → back is still editable). Integration test for every round trip as workspaces become real
- [ ] I11. NOW: Features store INTENT (type, parameters, purpose, e.g. "Hole: 5 mm, through, countersunk, on face F") for CAM, Laser, Circuit and Slice to use. Owner's decision: today's single shape is feature #1 of a one-step timeline with exactly the intent, provenance and dependency structures step 32 uses (step 32 extends the list, no migration; tested)
- [ ] I12. NOW: Provenance: every object answers "where did I come from?" (e.g. "this engraving comes from Logo v3 in Vector, applied to Body 2 in Design"), shown in the properties panel; filled in for Design objects
- [ ] I13. NOW: Project-wide dependency graph and staleness: a change marks every dependent item "out of date"; cheap results (print estimates, previews) update in the background (Web Worker), expensive ones (simulations, toolpaths, renders) wait for a rerun click; stale results are never shown unmarked. Graph and flags in core, used by Design's timeline (the one-step timeline until 32)
- [ ] I14. Project-wide search ("M3" finds every M3 hole, screw and PCB mounting hole). DRAFT now
- [ ] I15. One materials library (appearance, mechanical properties, print settings, laser power/speed, stock) and one machine library (printers, lasers, CNC; shared WebSerial/network connection layer, job queue, job history). DRAFT interfaces now
- [ ] I16. NOW: Analysis overlays: shared viewport API letting any workspace paint colours, warnings and labels on faces and edges (printability, machinability, stress, DRC). Owner's decision: the real first use is Design marking the faces of a part too big to export to STL accurately; the app never shows rejected (invalid) parts. Second use if cheap: the developer failure-dump viewer (step 14) marks problem faces through the same overlay format
- [ ] I17. Design feedback from downstream through overlays and the properties panel: printability (overhangs, thin walls, print time and weight), machinability (internal corners sharper than the smallest tool), stress, PCB clearance. DRAFT only now
- [ ] I18. Parameters drive everything: Design parameters usable in every workspace (laser kerf and thickness drive slot and finger-joint widths; Simulate sweeps a parameter, e.g. "thinnest wall with safety factor ≥ 2"; board size follows an enclosure parameter). DRAFT only now
- [ ] I19. NOW: Open project format documented in docs/ with a version number and migration rules; workspaces are plugins against a public Workspace API in packages/core, ours included, with no private shortcuts
- [ ] I20. NOW: "Zero exports" journeys in packages/testing with no file exports, each also checking live links update and round trips are lossless. Now: Design → STL. Later: logo → emboss → engrave → render; enclosure → PCB outline → mounting holes → print; photo → lithophane → slice; part → simulate → change parameter → rerun
- [ ] I21. NOW: docs/integration.md (the integration model for contributors) and the rules in "Ecosystem" above
- Report back to the owner when I7–I21's NOW parts land: built for real vs drafted, test status, the nine workspaces, open design questions

Render workspace (starts after CAD step 33)
- [ ] R1. Scenes in the project: bodies by reference, materials from the shared library, environment, cameras
- [ ] R2. Path-traced preview in the shared viewport; final render to an image
- [ ] R3. Scene updates live when the design changes

Laser workspace (starts after CAD step 31, when the sketcher is solid)
- [ ] L1. Jobs from design faces and sketches by reference; cut, engrave and score layers with power and speed
- [ ] L2. DXF and SVG import and export
- [ ] L3. Job preview and time estimate
- [ ] L4. Machine control for common controllers; sheet-metal flat patterns after step 83

Simulate workspace (starts after CAD step 50, booleans and full topological naming)
- [ ] S1. Studies in the project; loads and constraints on design faces by reference
- [ ] S2. Tetrahedral meshing from the exact geometry (shares step 81)
- [ ] S3. Static stress: stress, displacement, safety factor in the viewport
- [ ] S4. Thermal and modal studies

Manufacture workspace (starts after CAD step 50, booleans and full topological naming)
- [ ] M1. Setups, stock, work coordinates; a tool library shared across projects
- [ ] M2. 2D/2.5D strategies on referenced faces and edges (shares step 82)
- [ ] M3. Toolpath simulation in the viewport
- [ ] M4. G-code through post-processors for different machines; 3D strategies

Slice workspace (starts after CAD step 73, STL and 3MF export)
- [ ] P1. Printer profiles for any printer; plates with design bodies by reference that update when the design changes
- [ ] P2. Slicing: walls, infill, supports; layer preview
- [ ] P3. G-code export; several plates per project

Circuit workspace (PCB / electronics; starts after CAD step 75: full topological naming at 50, assemblies and joints at 74–75)
- [ ] E1. Schematic capture and a component library
- [ ] E2. Board layout, routing, design-rule checks; Gerber and drill export
- [ ] E3. ECAD–MCAD co-design: board outline from a Design face or sketch by reference; components in 3D inside the enclosure with live collision checks; mounting holes linked both ways with the enclosure's screw posts

Vector workspace (logo / 2D design; starts after CAD step 31: reuses the sketcher's curves and constraints)
- [ ] V1. Paths, shapes, Bézier editing, layers
- [ ] V2. Boolean path operations, text to outlines, SVG import and export
- [ ] V3. A graphic becomes, live-linked: an emboss or deboss in Design, an engraving or cut in Laser, a decal in Render, silkscreen in Circuit

Image workspace (photo / texture editing; starts after CAD step 33 and Render R1–R2)
- [ ] G1. Layers, masks, adjustments, brushes, selections; PNG and JPEG import and export with physical size (DPI or mm per pixel)
- [ ] G2. An image becomes: a texture or material map in Render, a raster engraving in Laser, a lithophane in Slice, traced outlines in Vector or a Design sketch

AI assistant (owner's spec "AI assistant — architecture and placeholders"; optional everywhere, costs us nothing to run, the user chooses the provider)
- [ ] A1. NOW (after I7–I21, before step 16): packages/ai: one AIProvider interface; plug-ins (placeholders): in-browser WebGPU models (default local option, downloaded once with size warnings, weak-GPU detection suggesting another option), Ollama (setup help incl. OLLAMA_ORIGINS), API key (Anthropic, OpenAI, others; the user pays their own usage; UI explains consumer chat subscriptions can't be used, an API key is required), browser built-in AI behind feature detection. The rest of the app never knows which provider is active
- [ ] A2. NOW: commands, not geometry: the AI's only output is structured commands matching JSON schemas generated from the real command API (e.g. {"op":"hole","face":"<stable id>","diameter":5,"depth":"through"}); constrained output where supported, otherwise validate and retry once, then fail clearly; references by stable ID, never guessed coordinates; every action previewed (ghosted geometry, highlights or a parameter diff), accepted or rejected; accepted actions are ONE labelled undo step ("AI: added 5 mm hole"). Interfaces + command validation for real; fuzz test that random or malformed AI output always gives a clean error
- [ ] A3. NOW (draft): context: a compact structured summary (active workspace, selection with stable IDs and intent, timeline features and parameters, units, materials, recent errors and failed features, the relevant part of the dependency graph), small enough for small local models; larger providers get more
- [ ] A4. NOW (placeholders): specialist local models (ONNX Runtime Web / WebGPU), separate interface: background removal and segmentation, upscaling, inpainting (Image); image tracing to paths (Vector, Laser); print-failure classification from photos (Slice, later). Each downloaded on first use with a size warning
- [ ] A5. NOW (placeholders): one assistant panel shared across workspaces, aware of the active one; indicator of the active provider and whether data stays local; settings page (choose provider, download/remove local models with sizes, enter/remove API keys)
- [ ] A6. NOW: evaluation suite in packages/testing (fixed prompts + project states → expected commands, e.g. "add a 5 mm hole in the middle of the top face" → the hole command with the right face ID), success rate per task type per provider, tracked over time like the fuzzer; tests that AI actions are single undo steps and rejected previews leave the project unchanged. Structure now, real runs from A7
- [ ] A7. Design commands for real (after step 32): plain-English commands, parameter edits, failure explanations, design review (printability, thin walls), parameter variants
- [ ] A8. Each workspace's AI features once that workspace is real: Render (scene setup, material suggestions, camera framing); Simulate (loads and constraints in plain English, explain results, suggest fixes, parameter sweeps); Manufacture (strategies, tools, feeds/speeds with reasons, explain G-code, flag risky moves; never runs a machine); Laser (power/speed suggestions, parametric finger-joint boxes, photo tracing); Slice (diagnose failures from descriptions or photos, settings and orientation); Circuit (datasheet and component Q&A, explain DRC errors, schematic drafts marked "AI draft — review required"); Vector (tracing, clean-up, layout; image generation only via the user's own API key); Image (background removal, upscaling, smart selection, inpainting); suite-wide ("what breaks if I change this?" from the dependency graph, project questions like total filament, cost and parts, build instructions)
- [ ] A9. NOW: docs/ai.md (architecture, how a workspace exposes its commands) and the AI rules in CLAUDE.md
- Report back to the owner when A1–A6 and A9 land: built vs placeholdered, test status, decisions needed

Community (free sharing only; starts after CAD step 33, needs a server first, see docs/community.md)
- [ ] C1. Decide the server questions in docs/community.md with the owner
- [ ] C2. Accounts and uploads: share a whole project (editable timeline and every workspace's data) or a mesh, with a free licence
- [ ] C3. Search and browse; download into a new local project; open it in any workspace
- [ ] C4. Remix: a downloaded copy links back to the original and credits its author
- [ ] C5. Moderation and reporting

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
