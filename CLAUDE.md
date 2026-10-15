# Fission

Goal: a free, open-source parametric CAD app that rivals Fusion 360.
Stack: Rust kernel (`kernel/`) compiled to WebAssembly, TypeScript + Three.js app (`app/`), Python prototypes (`prototypes/`).

Work one roadmap item per session/day, in order. Each item ends with something visible or tested, and is committed and pushed.

## Roadmap (mark items [x] when done)

Kernel foundations
- [x] 1. Testing rules in repo; tolerance module with exact predicates
- [x] 2. Curves and surfaces: line, circle, plane, cylinder, sphere (eval, normal, closest point)
- [x] 3. B-rep data structure + validate(): watertight, orientation, Euler–Poincaré
- [x] 4. validate(): vertex-on-edge, edge-on-face, zero-length edges, zero-area faces
- [x] 5. Tessellation of planar faces + watertight mesh check
- [ ] 6. Tessellation of cylinder and sphere faces
- [ ] 7. Box primitive; viewer shows a kernel B-rep box with edges
- [ ] 8. Kernel runs in a Web Worker from here on; every app→kernel call is an async message
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
- [ ] 44. Union/subtract/intersect for planar solids + boolean property tests + oracle comparison
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

## Owner preferences
Explain things in chat in plain words, not in Markdown or PDF documents.
