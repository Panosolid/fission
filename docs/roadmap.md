# Fission roadmap

Every step of the plan, done and to do, as detailed as it needs to be: this file is read only when a session needs it. The next couple of steps (now 15–17) live in `CLAUDE.md` instead, which every session reads; each item is in one file only, and items move into CLAUDE.md as work reaches them and back here once done. Mark items [x] when done.

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
- 15: in CLAUDE.md

App shell (16 and 17: in CLAUDE.md)
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
- [ ] I2. Stable-ID references, re-resolved after every rebuild, warning when unresolved (rule: packages/CLAUDE.md, "Ecosystem"; with steps 32–33, completed at 50)
- [ ] I3. One materials library used by Design appearances (62) and every later workspace
- [ ] I4. One selection and one undo/redo history across workspaces (with steps 17 and 20)
- [ ] I5. Switching workspaces keeps camera and selection; a workspace's view of the design updates live after an edit
- [ ] I6. Cross-workspace tests: edit the design, check every workspace's references still resolve (or warn) in the harness and e2e

Integration foundations (owner's spec "Ecosystem integration — design and foundations"; build NOW = before step 16, in packages/core, small commits, every test green; everything not marked NOW is a typed DRAFT interface that throws "not implemented")
- [x] I7. NOW: Circuit, Vector, Image placeholders (pages, switcher, tests, roadmap sections below)
- [ ] I8. NOW: Representations (Outline: 2D exact paths on a plane; Solid: kernel B-rep; Mesh; Image: pixels with mm per pixel; Data: parameters, BOM lines, results) and a registry where each workspace declares what it PRODUCES and ACCEPTS. One shared conversion layer picks the most exact representation the target accepts, falls back to lossy ones (solid → mesh) only when it must, and returns a note to show when it did. Design produces Solid, Mesh and Outline for real. Owner's decision: Outline comes from the ready-made profiles through ONE generic producer that the sketcher plugs into at step 21. NOW part done: `representation.ts` registry; Design registers Solid, Mesh, Outline (`outlineProducer` over any `OutlineSource`); workspaces declare produces/accepts (placeholders declare nothing). Remaining: Image and Data producers and the first converters, with the workspaces that need them
- [ ] I9. NOW: Live links (DRAFT behaviour, real data structure): paste/drag between workspaces makes a live link by default, referencing the source by stable ID (topological naming for geometry, object IDs otherwise), never copied data; a link can be broken into a frozen copy (visible link/unlink icon); an unresolvable link shows a warning on the item, never breaks silently. NOW part done: `links.ts` (linkTo, fetchLinked, breakLink, resolveLink with warnings) and `linkBadge` in ui. Remaining: paste/drag in the UI and the badge on items, with the first workspace that takes links
- [ ] I10. Lossless round trips: moving something between workspaces and back loses nothing (a constrained sketch → Laser → back is still constrained; a vector logo → Design → back is still editable). Integration test for every round trip as workspaces become real. Listed in `ROUND_TRIPS` (packages/testing) with what each waits for; Design → STL's solid arrives exactly as Design builds it (journey test)
- [x] I11. NOW: Features store INTENT (type, parameters, purpose, e.g. "Hole: 5 mm, through, countersunk, on face F") for CAM, Laser, Circuit and Slice to use. Owner's decision: today's single shape is feature #1 of a one-step timeline with exactly the intent, provenance and dependency structures step 32 uses (step 32 extends the list, no migration; tested). Done: `feature.ts`, Design's `document.ts` builds the body from the intent
- [x] I12. NOW: Provenance: every object answers "where did I come from?" (e.g. "this engraving comes from Logo v3 in Vector, applied to Body 2 in Design"), shown in the properties panel; filled in for Design objects
- [ ] I13. NOW: Project-wide dependency graph and staleness: a change marks every dependent item "out of date"; cheap results (print estimates, previews) update in the background (Web Worker), expensive ones (simulations, toolpaths, renders) wait for a rerun click; stale results are never shown unmarked. Graph and flags in core, used by Design's timeline (the one-step timeline until 32). NOW part done: `graph.ts`; Design dims its numbers while out of date and marks them when a rebuild fails. Remaining: the background scheduler for cheap downstream results and rerun buttons for expensive ones, with the first downstream workspace
- [ ] I14. Project-wide search ("M3" finds every M3 hole, screw and PCB mounting hole). DRAFT now
- [ ] I15. One materials library (appearance, mechanical properties, print settings, laser power/speed, stock) and one machine library (printers, lasers, CNC; shared WebSerial/network connection layer, job queue, job history). DRAFT interfaces now
- [ ] I16. NOW: Analysis overlays: shared viewport API letting any workspace paint colours, warnings and labels on faces and edges (printability, machinability, stress, DRC). Owner's decision: the real first use is Design marking the faces of a part too big to export to STL accurately; the app never shows rejected (invalid) parts. Second use if cheap: the developer failure-dump viewer (step 14) marks problem faces through the same overlay format. NOW part done: `overlay.ts`, the Viewer paints overlays and a legend, Design marks a part too big for STL (e2e). Not done: the failure-dump viewer is a standalone page written by Rust (`debug_dump.rs`) with no shared code, so sharing the format was not cheap; it keeps its own red marking
- [ ] I17. Design feedback from downstream through overlays and the properties panel: printability (overhangs, thin walls, print time and weight), machinability (internal corners sharper than the smallest tool), stress, PCB clearance. DRAFT only now
- [ ] I18. Parameters drive everything: Design parameters usable in every workspace (laser kerf and thickness drive slot and finger-joint widths; Simulate sweeps a parameter, e.g. "thinnest wall with safety factor ≥ 2"; board size follows an enclosure parameter). DRAFT only now
- [x] I19. NOW: Open project format documented in docs/ with a version number and migration rules; workspaces are plugins against a public Workspace API in packages/core, ours included, with no private shortcuts. Done: docs/project-format.md, `readProject` + MIGRATIONS (format 2), Workspace API v1, boundary test in packages/testing
- [ ] I20. NOW: "Zero exports" journeys in packages/testing with no file exports, each also checking live links update and round trips are lossless. Now: Design → STL. Later: logo → emboss → engrave → render; enclosure → PCB outline → mounting holes → print; photo → lithophane → slice; part → simulate → change parameter → rerun. NOW part done: `npm run journeys` (Design → STL on the real kernel, in CI); the later ones are listed in `JOURNEYS`
- [x] I21. NOW: docs/integration.md (the integration model for contributors) and the rules in "Ecosystem" in CLAUDE.md (which now points to docs/integration.md)
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
- [x] A1. NOW (after I7–I21, before step 16): packages/ai: one AIProvider interface; plug-ins (placeholders): in-browser WebGPU models (default local option, downloaded once with size warnings, weak-GPU detection suggesting another option), Ollama (setup help incl. OLLAMA_ORIGINS), API key (Anthropic, OpenAI, others; the user pays their own usage; UI explains consumer chat subscriptions can't be used, an API key is required), browser built-in AI behind feature detection. The rest of the app never knows which provider is active. Done: `packages/ai/src/providers.ts` (`PROVIDERS` text drives the settings page; `dataLeavesMachine`), `keys.ts`; creating providers, detection and the key store are placeholders
- [ ] A2. NOW: commands, not geometry: the AI's only output is structured commands matching JSON schemas generated from the real command API (e.g. {"op":"hole","face":"<stable id>","diameter":5,"depth":"through"}); constrained output where supported, otherwise validate and retry once, then fail clearly; references by stable ID, never guessed coordinates; every action previewed (ghosted geometry, highlights or a parameter diff), accepted or rejected; accepted actions are ONE labelled undo step ("AI: added 5 mm hole"). Interfaces + command validation for real; fuzz test that random or malformed AI output always gives a clean error. NOW part done: `packages/core/src/model/commands.ts` (CommandSpec, generated schemas, parseCommand never throws), `WorkspacePlugin.commands` (Design: `set_part`), `askForCommands` (constrained output or schema in the prompt, one retry, clear failure), fuzz in npm test and on the real kernel in journeys. Remaining: preview / accept / reject as one undo step (`actions.ts` is a draft; needs steps 20 and 32)
- [x] A3. NOW (draft): context: a compact structured summary (active workspace, selection with stable IDs and intent, timeline features and parameters, units, materials, recent errors and failed features, the relevant part of the dependency graph), small enough for small local models; larger providers get more. Done: `buildContext` in `packages/ai/src/context.ts`, real for what exists (selection is empty until step 17)
- [x] A4. NOW (placeholders): specialist local models (ONNX Runtime Web / WebGPU), separate interface: background removal and segmentation, upscaling, inpainting (Image); image tracing to paths (Vector, Laser); print-failure classification from photos (Slice, later). Each downloaded on first use with a size warning. Done: `specialists.ts` placeholders
- [x] A5. NOW (placeholders): one assistant panel shared across workspaces, aware of the active one; indicator of the active provider and whether data stays local; settings page (choose provider, download/remove local models with sizes, enter/remove API keys). Done: the "AI off" button and the assistant panel placeholder in the app shell (`apps/fission/src/assistant.ts`), e2e-checked
- [ ] A6. NOW: evaluation suite in packages/testing (fixed prompts + project states → expected commands, e.g. "add a 5 mm hole in the middle of the top face" → the hole command with the right face ID), success rate per task type per provider, tracked over time like the fuzzer; tests that AI actions are single undo steps and rejected previews leave the project unchanged. Structure now, real runs from A7. NOW part done: `EVAL_CASES`, `runEval`, `successRates` in `packages/testing/src/ai-eval.ts`; the spec's hole case waits for steps 32 and 49. Remaining: tracking rates over time once real providers exist, and the single-undo-step / rejected-preview tests (steps 20, 32)
- [ ] A7. Design commands for real (after step 32): plain-English commands, parameter edits, failure explanations, design review (printability, thin walls), parameter variants
- [ ] A8. Each workspace's AI features once that workspace is real: Render (scene setup, material suggestions, camera framing); Simulate (loads and constraints in plain English, explain results, suggest fixes, parameter sweeps); Manufacture (strategies, tools, feeds/speeds with reasons, explain G-code, flag risky moves; never runs a machine); Laser (power/speed suggestions, parametric finger-joint boxes, photo tracing); Slice (diagnose failures from descriptions or photos, settings and orientation); Circuit (datasheet and component Q&A, explain DRC errors, schematic drafts marked "AI draft — review required"); Vector (tracing, clean-up, layout; image generation only via the user's own API key); Image (background removal, upscaling, smart selection, inpainting); suite-wide ("what breaks if I change this?" from the dependency graph, project questions like total filament, cost and parts, build instructions). The lists are in `packages/ai/src/features.ts` and shown in the assistant panel
- [x] A9. NOW: docs/ai.md (architecture, how a workspace exposes its commands) and the AI rules in CLAUDE.md. Done: docs/ai.md; the rules are in docs/ai.md, pointed to from "Ecosystem" in CLAUDE.md
- Report back to the owner when A1–A6 and A9 land: built vs placeholdered, test status, decisions needed

Community (free sharing only; starts after CAD step 33, needs a server first, see docs/community.md)
- [ ] C1. Decide the server questions in docs/community.md with the owner
- [ ] C2. Accounts and uploads: share a whole project (editable timeline and every workspace's data) or a mesh, with a free licence
- [ ] C3. Search and browse; download into a new local project; open it in any workspace
- [ ] C4. Remix: a downloaded copy links back to the original and credits its author
- [ ] C5. Moderation and reporting
