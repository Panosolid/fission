# Kernel

Rust geometry kernel, compiled to WebAssembly with wasm-pack. Read with the root CLAUDE.md (top rules, general testing rules, git workflow).

## Modules (each file's top comment has the rest)

- `src/tolerance.rs`: every tolerance and the exact predicates; the only place epsilons live.
- `src/geom/`: curves (`curve.rs`: Line, Circle), surfaces (`surface.rs`: Plane, Cylinder, Sphere), similarity transforms (`transform.rs`), placements (`placement.rs`: rotation as a unit quaternion plus a shift, kept apart from geometry).
- `src/topology.rs`: B-rep arenas (Vertex, Edge, Coedge, Loop, Face, Shell, Body) and Euler counts.
- `src/validate.rs`: `validate()` and `checked()`; every operation's result goes through `checked()`.
- `src/self_intersect.rs`: the self-intersection check `validate` runs (edge–edge, edge–face, face–face), measuring candidates from `src/intersect.rs`, which only proposes points, never decides that two things touch.
- `src/placed.rs`: `Placed` = local geometry plus placement; moves and turns change only the placement; `baked()` gives world geometry where it is needed.
- `src/tessellate.rs` (watertight mesh, constrained Delaunay in uv via `spade`), `src/mesh.rs` (mesh volume with double-double determinants, area, closed check), `src/accurate.rs` (double-double arithmetic), `src/display.rs` (per-face normals, edge lines for the viewer).
- `src/mass.rs`: exact volume and area from the B-rep's edges, keeping digits far away and at huge radii. The app shows these, not mesh values.
- `src/stl.rs`: binary STL export (reports the largest rounding to single precision, warns past MIN_FEATURE) and reading it back.
- `src/ops/`: `primitives.rs` (box, cylinder, sphere), `profile.rs` (lines, arcs as bulges, circles, and their validity rules), `extrude.rs`, `transform.rs` (move, rotate on `Placed`; a rotation pivot must lie in model space). Each returns `Result<Body, KernelError>` via `ops::finish`.
- `src/fixtures.rs`: hand-built test bodies (cube, cylinder, sphere, half cylinder, tube, sphere cap/slice/octant, `two_shells`) that don't use `ops`.
- `src/lib.rs`: the thin `#[wasm_bindgen]` API (`make_box`, `make_cylinder`, `make_sphere`, `make_extrude` → `BodyView` with exact volume and area; `export_stl(spec, name)` → `StlFile`, a `BodySpec` naming the same shapes). Keep it thin.
- `src/debug_dump.rs`: failure dumps (ASCII STL per body + an offline `index.html`; dashed red: a named edge's own curve). `checked` writes one (`dump_invalid`, at most 20 per process) into `target/failure-dumps/` before panicking and names it in the panic; the harness writes its own there too; `endless.sh` copies them into each nightly failure folder; `examples/dump_demo.rs` writes the two dumps the browser check opens.
- `tests/stateful.rs`: the stateful random-testing harness (see its header). When a kernel operation lands, add it to `Op`, `Scene::transitions`, `apply_op` and `replay_op` the same day.
- `tests/regressions/`: proptest failure seeds and `stateful/*.json` minimal failing chains (committed; replayed forever by `saved_regressions_still_pass`).
- `scripts/overnight.sh` (Tier 3 run), `scripts/endless.sh` (the same, round after round with random seeds, into `endless-results/`).
- `../prototypes/oracle/compare.py`: OpenCascade oracle comparison for bodies the harness writes (box, cylinder, sphere, extrusion).

## Commands

- Tier 1, after every change: `cargo clippy --all-targets && cargo test <module>` (plus `cargo check`).
- All kernel tests: `cargo test` (must show 0 failed, 0 ignored). Run them in a debug build: in `--release`, `validate::tests::checked_panics_in_test_builds` and `checked_writes_a_failure_dump_before_panicking` fail on purpose, because invalid results only panic when `debug_assertions` is on.
- Before pushing kernel changes, also build for the browser: `cargo build --target wasm32-unknown-unknown` (code gated with `#[cfg(not(target_arch = "wasm32"))]`, like `debug_dump`, must not be called from code built there). CI uses the latest stable Rust, whose clippy may have lints the local toolchain lacks: `rustup update stable` first.
- After every push that changes `kernel/`, start a "Random testing" run on the pushed branch (GitHub Actions, `nightly.yml`, workflow_dispatch with `ref` = the branch). Scheduled runs only test `main` (every 6 hours, 4 jobs × ~5 h of `endless.sh`), so unmerged work is tested only this way. Results accumulate on the `test-results` branch: `summary.txt`, `log.csv` (with `commit` and `branch` columns naming the code each round tested), `failures/<seed>/` (with `commit.txt`); an issue is opened when something is found. A failure from an older commit may already be fixed or out of range.
- Stateful random testing, quick mode (~200 cases, ~50 s, also part of `cargo test`; ~95% of operations in range, ~5% with one extreme input, counted in the report's "~extreme input" row): `cargo test --test stateful -- --nocapture`
- Precision measurement: `cargo run --release --example precision_budget` (how far intersection points land from both pieces, by part size and distance from the origin; evidence for the modelling range).
- Mutation testing: `CARGO_PROFILE_DEV_OPT_LEVEL=0 CARGO_PROFILE_DEV_DEBUG=0 cargo mutants -f src/<file>.rs -j 4 -- --lib` (install once per container: `cargo install cargo-mutants --locked`; not while `rustup update` runs). The two variables make each mutant's build about five times faster than the default opt-level 2 builds, which dominate the run (829 mutants: 40 min instead of ~5 h); the lib tests stay debug builds, so the result is the same.
- Endless mode (owner's own computer, no Claude involved; random seed per round until Ctrl+C, results in `endless-results/`): `scripts/endless.sh [cases-per-round] [rounds, 0 = endless] [python]`
- Overnight mode (100,000 cases × 4 seeds in release, then the OpenCascade oracle): `scripts/overnight.sh [cases] [seeds] [python]` (needs `pip install cadquery-ocp`)
- `wasm-opt` is disabled in `Cargo.toml` because the sandbox can't download binaryen. Harmless; re-enable when size matters.

## Supported modelling range

Every serious kernel works inside a fixed range (commercial kernels commonly use a 1 km box). Fission's:
- Feature sizes (any length parameter: width, radius, distance, and a profile's overall span) from 1 µm to 1 km: `tolerance::MIN_FEATURE` = 1e-3 mm to `tolerance::MAX_SIZE` = 1e6 mm. Model sizes must be within (LINEAR, MAX_SIZE]; `ops::check_length` enforces this for every length input.
- Every point of every body within ±100 km of the origin: `tolerance::MAX_COORD` = 1e8 mm. That far out a double resolves ~15 nm, fine for placing a body but too coarse to intersect there.
- Linear tolerance 10 nm (`LINEAR` = 1e-5 mm), 100× below the smallest feature. Chosen with the owner during step 15, while the self-intersection check was being built (commit a625416, replacing 10 km / 1 nm), from measurements: `examples/precision_budget.rs`, and `intersect::tests::the_modelling_range_leaves_room_for_rounding`, which fails if LINEAR or MAX_SIZE move past what doubles support (it fails for 1 nm at 1 km, 10 nm at 10 km and 1 nm at 10 km). At 1 km, crossings steeper than 0.6° land ~300× inside LINEAR, but 0.06° to 0.6° crossings can slide 0.4 LINEAR along the curve: booleans must handle shallow crossings with care (step 45).
- Geometry is intersected near its own origin. Before booleans (step 44), when two bodies meet, bake them into a frame centred on them, not the world frame: at 100 km out, the position alone costs ~0.07 LINEAR per intersection at shallow crossings.
- There is no rule on the ratio of smallest feature to part size yet (the cap makes it at most 1e9). Measure again at step 44, when the volume formula for turned, baked thin parts is rewritten.
- Operations outside the range return `KernelError::InvalidInput`; they never panic and never produce geometry.
- Volumes, areas and projections are computed relative to a local origin (the body's or mesh's bounding-box centre, or a point on the face), never the world origin.
- The fuzzer spends ~95% of its inputs inside the range and ~5% on extreme inputs, which only have to produce clean errors.

## Conventions

- Units are millimetres. Z is up (the viewer sets `Object3D.DEFAULT_UP` to +Z).
- A face's outward normal is its surface's natural normal (∂u × ∂v), flipped when `sense` is false. Cylinder and sphere natural normals point away from the axis/centre.
- Loops run counter-clockwise seen from outside, so the face interior is on the left of every coedge (normal × tangent points into the face). The first loop of a face is the outer one when it has one.
- Every edge is used by exactly two coedges, once in each direction. Edges run start → end over t0 < t1; full circles are closed edges with start == end and no seam vertex. Cylinder side faces have no seam edge; they have two loops.
- Euler–Poincaré per shell: V − E + F − R = 2(1 − genus), where R counts inner loops.
- Tessellation: edges are discretised once and shared by both faces, so meshes are watertight by construction. `TessOptions::refine` multiplies every curved segment count (used for Richardson extrapolation of mass properties).
- Invalid results panic in debug/test builds (they are bugs) and return `KernelError::InvalidResult` in release.

## Crash-freedom (top priority)

- No kernel operation may panic on any input: bad input returns `KernelError::InvalidInput`, never silently broken geometry.
- Cost must be bounded for every legal input (e.g. `MAX_SEGMENTS_PER_TURN`).
- Use `geom::unit` (not `normalize`) on any user-supplied direction: lengths can overflow or underflow.
- In the harness, a check must verify what an operation did (independent position tracking), not only invariants it preserves.

## Kernel testing rules

### Validate after every operation
Every kernel operation (primitive, extrude, revolve, boolean, fillet, shell, import) must end with validate(solid), which checks:
- Watertight: every edge is shared by exactly two faces
- Consistent orientation: all face normals point outward
- Euler–Poincaré holds (V − E + F − R = 2(1 − genus) per shell)
- Every vertex lies on its edges, and every edge lies on its faces, within tolerance
- No zero-length edges, zero-area faces, or self-intersections

In debug and test builds, validation runs automatically and panics on failure. When adding a check to validate(), also add a test that breaks a valid body in exactly that way and asserts the specific error.

### Tolerance
- One global tolerance system: `src/tolerance.rs`. Never hard-code epsilon values anywhere else.
- Use exact/robust predicates (the `robust` crate) for orientation and in/out tests.
- Every test that compares floats uses the tolerance system, never `==`.

### Tier 1: fast checks (after every change, under 30 s)
- The Tier 1 command above: unit tests for the changed module only.
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

### Mutation testing
`cargo mutants` finds code that no test notices being broken. Every surviving mutant in kernel code gets a test, or is listed as equivalent, with the reason, in a "Mutation testing (...) leaves these survivors" paragraph at the end of the file's top `//!` comment (see `mass.rs`, `ops/profile.rs`).

### Visual debugging
When a geometry test fails, export the failing shape(s) as STL plus a small HTML viewer page with the problem edges/faces highlighted (`src/debug_dump.rs`).
