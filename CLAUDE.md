# Fission

A free, open-source parametric CAD app that rivals Fusion 360. Inspired by what ArtCraft is doing to Adobe: professional tools without the subscription.

The owner is a student learning the maths behind every algorithm. Correctness beats speed: geometry bugs are silent, so nothing is done until it is checked automatically.

## Repository layout

- `kernel/`: Rust geometry kernel, compiled to WebAssembly with wasm-pack.
  - `src/tolerance.rs`: every tolerance and the exact predicates. The only place epsilons live.
  - `src/geom/`: analytic curves (`curve.rs`: Line, Circle), surfaces (`surface.rs`: Plane, Cylinder, Sphere), similarity transforms (`transform.rs`).
  - `src/topology.rs`: B-rep arenas (Vertex, Edge, Coedge, Loop, Face, Shell, Body) and Euler counts.
  - `src/validate.rs`: `validate()` and `checked()`. Every operation's result goes through `checked()`.
  - `src/tessellate.rs`: B-rep → watertight triangle mesh (constrained Delaunay in uv space via `spade`).
  - `src/mesh.rs`: triangle mesh, volume, area, closed-mesh check.
  - `src/display.rs`: mesh shaped for the viewer (per-face normals, edge lines).
  - `src/ops/`: modelling operations (`primitives.rs`: box). Each returns `Result<Body, KernelError>` via `ops::finish`.
  - `src/fixtures.rs`: hand-built test bodies that don't use `ops`, so validation and tessellation are tested against shapes whose correctness is obvious from the code.
  - `src/lib.rs`: the `#[wasm_bindgen]` API the app calls (`make_box` → `BodyView`). Keep it thin.
  - `src/debug_dump.rs`: failure dumps (STL + HTML viewer with problem edges/faces in red).
  - `tests/stateful.rs`: stateful random-testing harness (see its header). When a kernel operation lands, add it to `Op`, `Scene::transitions`, `apply_op` and `replay_op` the same day.
  - `tests/regressions/`: proptest failure seeds and `stateful/*.json` minimal failing chains (committed; replayed forever by `saved_regressions_still_pass`).
  - `scripts/overnight.sh`: Tier 3 run.
- `prototypes/oracle/compare.py`: OpenCascade oracle comparison for bodies written by the harness.
- `app/`: Vite + TypeScript + Three.js web app. `src/main.ts` UI; `src/viewer.ts` Three.js viewport; `src/kernel.worker.ts` runs the WASM kernel in a Web Worker; `src/kernel-client.ts` is the only way the app talks to it (`kernel.call(op, ...args)` returns a promise; add new ops to `KernelOps` and the worker's `ops` table); `src/kernel-types.ts` shapes of kernel results; `test/` unit tests (Node test runner); `e2e/smoke.mjs` browser test. `npm run kernel` builds the WASM package into `app/src/kernel/` (generated, gitignored).
- `prototypes/`: Python sketches of the maths, used to try algorithms before writing Rust.
- `.github/workflows/`: `ci.yml` (kernel tests, app build), `pages.yml` (deploys `main` to GitHub Pages).

## Commands

- Tier 1 (after every change): `cd kernel && cargo clippy --all-targets && cargo test <module>`
- All kernel tests: `cd kernel && cargo test` (must show 0 failed, 0 ignored)
- Mutation testing: `cd kernel && cargo mutants -f src/<file>.rs`
- Build the app: `cd app && npm install && npm run build`
- Dev server: `cd app && npm run dev`
- App unit tests: `cd app && npm test`
- Browser smoke test: `cd app && npm run build && npm run e2e`
- Stateful random testing, quick mode (~200 cases, ~30 s, also part of `cargo test`): `cd kernel && cargo test --test stateful -- --nocapture`
- Overnight mode (100,000 cases × 4 seeds in release, then the OpenCascade oracle): `cd kernel && scripts/overnight.sh [cases] [seeds] [python]` (needs `pip install cadquery-ocp`)

Note: `wasm-opt` is disabled in `kernel/Cargo.toml` because the sandbox can't download binaryen. Harmless; re-enable when size matters.

## Supported modelling range

Every serious kernel works inside a fixed range (Parasolid: a 1 km box). Fission's:
- Feature sizes (any length parameter: width, radius, distance) from 1 µm to 10 km: `tolerance::MIN_FEATURE` = 1e-3 mm to `tolerance::MAX_SIZE` = 1e7 mm.
- Every point of every body within ±100 km of the origin: `tolerance::MAX_COORD` = 1e8 mm.
- Linear tolerance stays 1 nm (`LINEAR` = 1e-6 mm), 1000× below the smallest feature. At 100 km a double resolves ~15 nm, so this is tighter than Parasolid's box; the stateful harness tests the edges of the range.
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

## App conventions

- The main thread never loads the WASM module; every kernel call goes through `KernelClient` to the worker (the e2e test checks this).
- Wrap UI-driven kernel calls in `latestOnly` so a late reply to an old request never overwrites a newer result.
- Kernel errors arrive as rejected promises with the kernel's message; show them, never swallow them.

## Git workflow

- Commit after every completed step and after every bug fix together with its regression test. Never leave more than one step uncommitted. Push after each commit.

- Develop on the branch named by the session; commit each roadmap item separately and push it.
- Commit messages: a first line naming the step and feature (e.g. "Step 7: box primitive in the viewer"), then what changed and how it was verified.
- Never commit generated files (`app/src/kernel/`, `kernel/target/`, `app/dist/`).

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
- [ ] 9. Extrude polygon profiles with holes; property test volume = area × distance
- [ ] 10. Arcs/circles in profiles (cylindrical side faces); cylinder primitive
- [ ] 11. Sphere primitive; accurate volume and area
- [ ] 12. Move/rotate bodies; property test volume/area invariance
- [ ] 13. STL export + download button + round-trip test
- [ ] 14. Failure dumps: STL + HTML viewer with problem edges highlighted
- [ ] 15. Self-intersection check in validate(). Easy for planes/cylinders/spheres; must be extended for general surfaces when NURBS arrive (63–64)

App shell
- [ ] 16. Fusion-style layout: toolbar, browser panel, properties panel, viewport
- [ ] 17. Selection of bodies/faces/edges with highlighting
- [ ] 18. View controls: home, top/front/right, fit, view cube
- [ ] 19. Save/load JSON documents + autosave
- [ ] 20. Undo/redo (document snapshots for now; switches to timeline edits at 32–33)

Sketcher
- [ ] 21. Sketch on ground plane: lines with grid snapping
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
- [ ] 44. Union/subtract/intersect for planar solids + boolean property tests + oracle comparison; add cargo-fuzz (coverage-guided) over the harness's operation set
- [ ] 45. Coplanar faces, touching edges, shared vertices
- [ ] 46. Plane–cylinder intersection (drill a hole through a box)
- [ ] 47. Cylinder–cylinder, plane–sphere
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
