# Fission

A free, open-source suite for making things. Parametric CAD is at its heart, and rendering, simulation, CNC machining, laser cutting and 3D printing are workspaces of the same app, all sharing one project. It runs in the browser, needs no installation and has no subscription.

Fission is early. The geometry kernel's foundations are built and heavily tested, and the app shows and exports kernel-made solids. The sketcher, the parametric timeline and booleans come next. The [roadmap](CLAUDE.md#roadmap-mark-items-x-when-done) lists every step and which ones are done.

## What makes it different

**A kernel written from scratch, correctness first.** The geometry kernel is Rust compiled to WebAssembly. It is a boundary representation (B-rep): faces are exact planes, cylinders and spheres, and edges are exact lines and circles. Triangles exist only for drawing and for export. Volume and area are calculated from the exact shape (divergence theorem, Stokes, Gauss–Bonnet) in double-double arithmetic, so the numbers shown are the shape's true values, not mesh estimates.

**Every result is checked before it leaves the kernel.** After every operation, `validate()` checks the solid:
- it is watertight, and its faces point outward;
- Euler–Poincaré holds;
- every vertex lies on its edges, and every edge lies on its faces;
- nothing has zero size;
- nothing cuts through or touches itself.

A failure stops a test build and writes a failure dump: STL files plus an offline HTML viewer with the faulty faces, edges and vertices in red.

**A fixed modelling range, enforced.** Every tolerance lives in one file, and there are no stray epsilons anywhere else. The range is:
- sizes from 1 µm to 1 km;
- every point within 100 km of the origin;
- a 10 nm linear tolerance.

These limits were chosen from measurements of how many digits intersections lose, and a test fails if they are ever moved past what double-precision arithmetic supports.

Inputs outside the range get a clear error, never quietly wrong geometry. A body's shape is stored apart from its position, so moving a part far away and back loses nothing.

**No crashes by design.** Bad input returns an error. Every operation has a bounded cost, so no input can freeze the app.

## How it is tested

Geometry bugs are silent: a face a micrometre out looks fine until a later operation fails. So nothing counts as done until it is checked automatically, and every test must be able to fail.

- **Hand-worked tests.** Expected values are worked out independently, from geometry or algebra, with the working written next to the assertion. For example, two overlapping cubes must meet at exactly six listed points.
- **Tolerance boundaries.** Every tolerance is tested at 0.9× its limit (must pass) and at 1.1× (must fail).
- **Mutation testing** with `cargo mutants`. Every small change to the kernel that no test notices gets a new test, or a written reason why it changes nothing.
- **A stateful random tester.** It builds, moves and turns random parts thousands of times, including at the edges of the range. It checks results against its own independent tracking, not only against the kernel's checker. Every failure is shrunk to a minimal case and kept as a permanent regression test.
- **An independent oracle.** Random parts are built in both Fission and OpenCascade, and their volume, area, face count and bounding box are compared.
- **Round-the-clock runs.** A GitHub Actions workflow runs the random tester and the oracle for hours at a time, four jobs in parallel. Results accumulate on the `test-results` branch, and an issue opens when something new is found.
- **Browser tests.** Playwright clicks through the real app in a real browser and checks the numbers it shows and the files it downloads.
- **Measured precision.** `kernel/examples/precision_budget.rs` measures how many digits intersections lose for each part size and distance from the origin, so the modelling range is chosen from evidence.

## One project, many workspaces

| Workspace | What it does | Status |
|---|---|---|
| Design | Parametric solid modelling: sketches, features, booleans, fillets | In progress |
| Render | Materials, lighting, path-traced images | Placeholder |
| Simulate | Static stress, thermal and modal studies on the exact geometry | Placeholder |
| Manufacture | CNC setups, 2.5D and 3D toolpaths, G-code | Placeholder |
| Laser | Cut, engrave and score jobs from faces and sketches; DXF and SVG | Placeholder |
| Slice | 3D-print plates, slicing, G-code for any printer | Placeholder |

Design is the source of truth for geometry. Other workspaces never copy it: they refer to bodies, faces and edges by stable IDs, so a load stays on its face and a toolpath stays on its pocket when the design changes. A reference that can't be found any more shows a warning instead of breaking silently.

One viewport, one selection, one undo history, one materials library and one units system are shared by every workspace.

A community library, planned, will be free only: anyone can share and download, with no paid content and no payments.

## Layout

| Path | Contents |
|---|---|
| `kernel/` | Rust geometry kernel (WebAssembly) |
| `packages/core` | Document model and the kernel bridge (the kernel runs in a Web Worker) |
| `packages/viewport` | The shared Three.js viewport |
| `packages/ui` | Shared UI parts |
| `workspaces/*` | One package per workspace |
| `apps/fission` | The app shell |
| `prototypes/` | Python sketches of the maths, and the OpenCascade oracle |

## Building and testing

You need Rust (stable, with the `wasm32-unknown-unknown` target), wasm-pack and Node.js.

```sh
npm install                                   # at the repository root
cd kernel && cargo test                       # every kernel test, including a short random run
cd ../apps/fission && npm run kernel          # build the WebAssembly kernel
npm run dev                                   # start the app locally
npm run build && npm run e2e                  # browser tests
```

`CLAUDE.md` holds the full set of commands, the testing rules and the roadmap.

## Licence

No licence has been chosen yet. Until one is added, the code is not open source in the legal sense.
