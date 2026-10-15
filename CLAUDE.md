# Fission

Goal: a free, open-source parametric CAD app that rivals Fusion 360.
Stack: Rust kernel (`kernel/`) compiled to WebAssembly, TypeScript + Three.js app (`app/`), Python prototypes (`prototypes/`).

Work one roadmap item per session/day, in order. Each item ends with something visible or tested, and is committed and pushed.

## Roadmap (mark items [x] when done)

Kernel foundations
- [x] 1. Testing rules in repo; tolerance module with exact predicates
- [x] 2. Curves and surfaces: line, circle, plane, cylinder, sphere (eval, normal, closest point)
- [x] 3. B-rep data structure + validate(): watertight, orientation, Euler–Poincaré
- [ ] 4. validate(): vertex-on-edge, edge-on-face, zero-length edges, zero-area faces
- [ ] 5. Tessellation of planar faces + watertight mesh check
- [ ] 6. Tessellation of cylinder and sphere faces
- [ ] 7. Box primitive; viewer shows a kernel B-rep box with edges
- [ ] 8. Extrude polygon profiles with holes; property test volume = area × distance
- [ ] 9. Arcs/circles in profiles (cylindrical side faces); cylinder primitive
- [ ] 10. Sphere primitive; accurate volume and area
- [ ] 11. Move/rotate bodies; property test volume/area invariance
- [ ] 12. STL export + download button + round-trip test
- [ ] 13. Failure dumps: STL + HTML viewer with problem edges highlighted
- [ ] 14. Self-intersection check in validate()

App shell
- [ ] 15. Fusion-style layout: toolbar, browser panel, properties panel, viewport
- [ ] 16. Selection of bodies/faces/edges with highlighting
- [ ] 17. View controls: home, top/front/right, fit, view cube
- [ ] 18. Save/load JSON documents + autosave
- [ ] 19. Undo/redo

Sketcher
- [ ] 20. Sketch on ground plane: lines with grid snapping
- [ ] 21. Rectangle and circle tools
- [ ] 22. Arc tools (3-point, tangent)
- [ ] 23. Sketch on any planar face
- [ ] 24. Profile detection (closed regions, nested)
- [ ] 25. Constraint solver core (Newton–Raphson): coincident, horizontal, vertical
- [ ] 26. Parallel, perpendicular, equal, tangent
- [ ] 27. Editable dimensions (length, radius, angle)
- [ ] 28. Constraint status colours
- [ ] 29. Trim, extend, offset, mirror

Parametric
- [ ] 30. Feature timeline (sketch → extrude replayed on rebuild)
- [ ] 31. Edit any feature and rebuild after it
- [ ] 32. User parameters and expressions
- [ ] 33. Cone and torus surfaces
- [ ] 34. Revolve
- [ ] 35. Per-feature error display on the timeline

Booleans
- [ ] 36. Plane–plane and line–plane intersection
- [ ] 37. Splitting planar faces along intersection lines
- [ ] 38. Inside/outside classification with exact predicates
- [ ] 39. Union/subtract/intersect for planar solids + boolean property tests
- [ ] 40. Coplanar faces, touching edges, shared vertices
- [ ] 41. Plane–cylinder intersection (drill a hole through a box)
- [ ] 42. Cylinder–cylinder, plane–sphere
- [ ] 43. Extrude modes (join/cut/intersect/new body), symmetric, to-face, taper
- [ ] 44. Hole feature, Combine tool

Robustness
- [ ] 45. Topological naming (stable face/edge IDs)
- [ ] 46. Cached feature results, incremental rebuild
- [ ] 47. Kernel in a Web Worker
- [ ] 48. Golden models, tests/baseline.json, simulated-user bot (Tier 3)
- [ ] 49. Oracle comparison against OpenCascade

Modelling tools
- [ ] 50. Construction planes, axes, points
- [ ] 51. Rectangular/circular patterns, mirror
- [ ] 52. Chamfer
- [ ] 53. Fillet between planar faces
- [ ] 54. Fillet planar–curved, edge chains
- [ ] 55. Shell
- [ ] 56. Draft
- [ ] 57. Move/copy/align bodies
- [ ] 58. Measure, section view
- [ ] 59. Appearances, physical properties

Advanced geometry
- [ ] 60. NURBS curves (eval, knot insertion)
- [ ] 61. NURBS surfaces
- [ ] 62. Sketch splines
- [ ] 63. Sweep
- [ ] 64. Loft
- [ ] 65. NURBS surface–surface intersection (marching)
- [ ] 66. General fillets on curved faces

Interoperability
- [ ] 67. STEP export
- [ ] 68. STEP import (simple parts)
- [ ] 69. Healing imported geometry
- [ ] 70. 3MF and OBJ export

Assemblies and drawings
- [ ] 71. Components with their own bodies/timelines
- [ ] 72. Joints: rigid, revolute, slider
- [ ] 73. Interference checking
- [ ] 74. Drawings: projected views
- [ ] 75. Hidden-line removal
- [ ] 76. Drawing dimensions, PDF/DXF export

Extras
- [ ] 77. Realistic rendering
- [ ] 78. Tetrahedral meshing + FEM stress
- [ ] 79. CAM: 2.5D toolpaths, G-code
- [ ] 80. Sheet metal
- [ ] 81. Cloud saving, versions, sharing

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
