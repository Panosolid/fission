# CAD steps and kernel

Progress file for one workstream (rules: root CLAUDE.md, "Workstreams and where progress lives"). Only threads working on this workstream edit this file. Each item lives in one place: move the next item here from `docs/roadmap.md` when one is ticked, and ticked ones back there.

Done: steps 1–20 (step 15: the self-intersection check, mutation-tested; 16: the Design layout; 17: one selection of bodies, faces and edges, with placeholder ids until step 32; 18: view controls, Fit framed to the narrower field of view, and the view cube; 19: save and open a .fission.json file, projects kept in the browser, autosave, and the phone top bar menu; 20: undo/redo of whole-project snapshots, Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y, one labelled step per edit, hand-over or accepted AI command, the selection and camera kept through undo); the modelling range is 1 km / 10 nm (decided during step 15, measured and guarded by a test).

Next: step 21, from main; split it into substeps (21a, 21b, …) here before starting.

- [ ] 21. Sketch on ground plane: lines with grid snapping. Its geometry comes from the kernel's 2D curve library (K1), not TypeScript. Sketches must produce Outline through the existing representation registry (I8), with a test; no sketch-only path (register `design.sketch` with `outlineProducer`; the stand-in test in workspaces/design/test/document.test.ts shows the shape)
