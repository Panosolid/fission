# CAD steps and kernel

Progress file for one workstream (rules: root CLAUDE.md, "Workstreams and where progress lives"). Only threads working on this workstream edit this file. Each item lives in one place: move the next item here from `docs/roadmap.md` when one is ticked, and ticked ones back there.

Done: steps 1–20 (step 15: the self-intersection check, mutation-tested; 16: the Design layout; 17: one selection of bodies, faces and edges, with placeholder ids until step 32; 18: view controls, Fit framed to the narrower field of view, and the view cube; 19: save and open a .fission.json file, projects kept in the browser, autosave, and the phone top bar menu; 20: undo/redo of whole-project snapshots, Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y, one labelled step per edit, hand-over or accepted AI command, the selection and camera kept through undo; 21: sketches on the ground plane: 21a the kernel's grid snapping and closed outline, 21b sketches saved with ids from a counter and one undo step per edit, 21c the line tool, 21d Extrude of a closed sketch replacing the part until step 32, rebuilt from the kernel's outline at every build); the modelling range is 1 km / 10 nm (decided during step 15, measured and guarded by a test).


Kernel mutation gaps (2026-10-17): all 144 survivors of the first whole-kernel run are killed by tests or listed as equivalent (each file's top comment and `kernel/.cargo/mutants.toml`, 47 mutants); `Placed::new` now calls `recentred`, so cargo-mutants checks it. Two bugs found and fixed with regression tests: a very flat arc let a hole outside the profile through (`profile.rs` winding), and a hole touching its outline made tessellation run for hours (`tessellate.rs` conform_planar_faces).

Next: step 22, split into substeps here first (22a, 22b…), each starting from main once the one before has merged. Then 23, then the timeline (32, 33) before 24 (owner's order, docs/document-model.md section 6).

- [ ] 22. Rectangle and circle tools. Starting point: the line tool (`workspaces/design/src/sketch-tool.ts` `clickAt`, `sketch-panel.ts`, e2e `apps/fission/e2e/sketch-tool.mjs`); a rectangle is four chained lines sharing corners (`drawLine` with point ids); a circle needs a new curve kind in the sketch data (docs/document-model.md section 3: arcs and circles add kinds at 22–23; `readDesignDocument` refuses kinds it can't read) and in the kernel's sketch outline (`kernel/src/sketch.rs`, which takes lines only; the profile rules already take circles). Extrude (21d, `extrude.ts`) takes whatever outline the kernel finds, so a closed rectangle or circle extrudes with no change there; check that with a hand-worked volume (πr²h).

Notes from step 21 for later steps:
- Points join only when their snapped coordinates are equal (point snapping comes with constraints, 27). No AI commands for sketching or extruding yet (the AI workstream's call).
- A sketch can't be opened again for editing once finished, so the extrude's live link to its sketch (the part rebuilds after a sketch edit, `applySketchEdit`) is reachable in the app only from step 33 (edit any feature); it is tested in `extrude.test.ts` and `extrude-sketch.journey.ts`.
- Extruding a sketch on XZ or YZ is refused with a message until sketches on other planes exist (24): the kernel extrudes along +Z only. Only positive distances, one direction (no symmetric or two-sided yet).
- A preset after an extrude takes the height box's value as its height (the boxes are shared), and takes new counter ids.
