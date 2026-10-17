# CAD steps and kernel

Progress file for one workstream (rules: root CLAUDE.md, "Workstreams and where progress lives"). Only threads working on this workstream edit this file. Each item lives in one place: move the next item here from `docs/roadmap.md` when one is ticked, and ticked ones back there.

Done: steps 1–22 (step 15: the self-intersection check, mutation-tested; 16: the Design layout; 17: one selection of bodies, faces and edges, with placeholder ids until step 32; 18: view controls, Fit framed to the narrower field of view, and the view cube; 19: save and open a .fission.json file, projects kept in the browser, autosave, and the phone top bar menu; 20: undo/redo of whole-project snapshots, Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y, one labelled step per edit, hand-over or accepted AI command, the selection and camera kept through undo; 21: sketches on the ground plane: 21a the kernel's grid snapping and closed outline, 21b sketches saved with ids from a counter and one undo step per edit, 21c the line tool, 21d Extrude of a closed sketch replacing the part until step 32, rebuilt from the kernel's outline at every build; 22: the rectangle tool (22a), circles in saved sketches and the kernel's outline (22b) and the circle tool (22c)); the modelling range is 1 km / 10 nm (decided during step 15, measured and guarded by a test).

Next: 23 (arc tools), starting from main once 22c has merged: split it into substeps first. Then the timeline (32, 33) before 24 (owner's order, docs/document-model.md section 6).

- [ ] 23. Arc tools (3-point, tangent). A likely split, for the thread that starts it to confirm: 23a arcs in the saved sketch and the kernel's outline (the kernel's profile loops already take a line's bulge, `kernel-types.ts`; an arc as its own curve kind between two point ids, like the circle in 22b, so the tool can share ends with lines); 23b the 3-point arc tool (start, end, a point on it; three points on one line refused with a note); 23c the tangent arc from a line's end. Starting point: `workspaces/design/src/sketch-tool.ts` (the circle tool, `circleSegments` for drawing curves as segments), `sketch.ts` `drawCircle`, `kernel/src/sketch.rs` `check_circles`/`sketch_outline`.

Notes from step 21 for later steps:
- Points join only when their snapped coordinates are equal (point snapping comes with constraints, 27). No AI commands for sketching or extruding yet (the AI workstream's call).
- A sketch can't be opened again for editing once finished, so the extrude's live link to its sketch (the part rebuilds after a sketch edit, `applySketchEdit`) is reachable in the app only from step 33 (edit any feature); it is tested in `extrude.test.ts` and `extrude-sketch.journey.ts`.
- Extruding a sketch on XZ or YZ is refused with a message until sketches on other planes exist (24): the kernel extrudes along +Z only. Only positive distances, one direction (no symmetric or two-sided yet).
- A preset after an extrude takes the height box's value as its height (the boxes are shared), and takes new counter ids.

Notes from step 22 for later steps:
- A circle together with any other curve is "the sketch makes n separate loops" until regions (26). The circle tool keeps only the centre as a point; the click on the circle sets the radius (√(dx² + dy²) with Math.sqrt, not Math.hypot, which V8 rounds a unit off for (10, 30)).
- The viewport draws a circle as `CIRCLE_SEGMENTS` = 64 straight segments (`circleSegments`, drawing only; the sketch and the kernel keep the exact circle), so its `sketchLines` count is 64 per circle.
