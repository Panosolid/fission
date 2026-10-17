# Sketches, features, the timeline and undo

How Design's document fits together, decided before step 21b saves the first sketch (design check, 2026-10-17), so that undo (step 20), the file format (docs/project-format.md) and the timeline (step 32) never need a rewrite. Fusion 360 is the reference for behaviour; where we are unsure how it behaves, we ask the owner, who has it.

## 1. The document is an ordered recipe; geometry is never stored

- Design's data is a list of timeline items in build order: sketches, features (extrude, box, later revolve, fillet…), and later construction planes. A sketch is a timeline item of its own, as in Fusion ("Sketch 1", then "Extrude 1"), not a separate unordered list: a sketch on a face (24) must come after the feature that made the face, and the extrude that uses it after that, so order is part of the data.
- Every item stores its intent (what the user asked for), never the geometry it produced. Bodies, faces, sketch outlines and profiles are worked out by replaying the list through the kernel. A cache of results (51) lives only in memory, keyed by the inputs that made it; it is never written to the file and never trusted over a rebuild.
- Big data that is not a recipe (an image's pixels, an imported mesh or STEP file) goes into the project as a blob referenced by a content hash, not inline in the JSON, once such data is saved. This keeps undo snapshots (section 4) small.

## 2. Ids

- Every timeline item, sketch point and sketch curve has an id that is unique in the document and never reused, even after the thing is deleted. Ids come from a counter stored in the document (`nextId`): `sketch-2`, `point-3`, `line-4`, `feature-5`. Taking "the largest id + 1" instead would hand a deleted item's id to a new one, and a link, selection or AI command naming the old one would silently point at the new one.
- Ids are never list positions. Names people read ("Sketch 1", "Extrude 2") are numbered by position at display time and are not ids.
- A merge of two documents (remix updates, X12/C4) renumbers the incoming side's new ids; nothing else ever changes an id.
- Topological naming (32, 50) builds on these ids: a face made by an extrude is named from the feature id and the id of the sketch curve it was swept from ("feature-5 / side of line-4"), so sketch curves need stable ids from the first saved sketch (21b).

## 3. Sketches

- A sketch item's intent is `{ type: "sketch", parameters: { plane } }`. `plane` is a reference, not coordinates: `"XY"`, `"XZ"`, `"YZ"` for the origin planes (21), a stable face id from 32 for a sketch on a face (24), a construction plane's id later (53). The plane's position is worked out on replay, so a sketch follows its face when an earlier feature changes.
- The sketch's content sits in Design's `sketches` list under the same id: `points` (`{ id, x, y }`, in mm, in the sketch plane's own 2D frame, never world coordinates), `curves` (`{ id, kind: "line", start, end }` naming point ids; circles `{ id, kind: "circle", centre, radius }` round a point id, radius in mm, from 22b; arcs `{ id, kind: "arc", start, end, centre }`, counter-clockwise round the centre from start to end, three point ids, from 23a) and `constraints` (empty until 27). Lines drawn in a chain share their end points, so "coincident" is already true in the data when the solver arrives.
- Profiles are never stored. The kernel finds a sketch's closed outline (21a, `sketch_outline`) or regions (26) on replay.
- A feature refers to what it uses by id: an extrude of a sketch is `{ type: "extrude", parameters: { sketch: "sketch-2", distance: 10 } }` with `dependsOn: ["sketch-2"]`. Until 26 a sketch has one closed outline and that is what is extruded. From 26 a `region` parameter names the region by the ids of the curves around it (exact form decided at 26), never by an index, so adding a line elsewhere in the sketch never makes an extrude pick a different region.

## 4. Undo stays whole-document snapshots, for good

- Undo (20) keeps the project as text after each step. That stays: it is not replaced by "undo this timeline edit" at 32. Every timeline edit (add, edit, delete, reorder, suppress, move the rollback marker, draw a line in a sketch) already is one recorded step, so snapshot undo is timeline undo, and it is correct for every kind of change without writing an inverse for each command (a source of bugs). The same goes for ownership hand-overs and accepted AI commands, which already undo as one step each.
- Because the document holds only intent, a snapshot is kilobytes; 100 steps is a few megabytes at most. If a project's text ever passes about 1 MB, the history keeps each workspace's part separately and shares parts that did not change; the interface stays the same.
- Undo rebuilds by replaying the restored recipe. With the result cache (51), returning to an earlier recipe finds its results already cached, so undo stays instant on big parts.
- An AI preview (A2) is the same mechanism: apply the commands to a copy of the document, replay it, draw the result ghosted; Accept is one `history.step`. It does not need to wait for 32.

## 5. Replay

- Design's rebuild walks the timeline in order up to the rollback marker, skipping suppressed items. Each item is one pure kernel operation with explicit inputs (the resolved plane, the outline, earlier bodies, and the item and curve ids for naming); the kernel never reads the project file. A failing item records its error and the items after it that depend on it are marked failed (37 shows them on the timeline); nothing throws past the rebuild.
- The rollback marker is stored in the document (`timeline.marker`: the id of the last item built, absent for "all"), as Fusion saves it with the design, so moving it is an undo step.
- An item can never be moved before something it depends on (its `dependsOn`, its sketch plane's feature); the reorder is refused with a message.
- Until 32 there is one body: the last solid feature's. Step 32 builds every solid feature, gives each its own body ("New body", as Fusion's first extrude) until joins and cuts arrive with booleans (44, 48), turns the box, cylinder and sphere presets into ordinary features inserted from the toolbar, and keeps the ready-made profiles as example sketches.

## 6. What this changes in the plan

- 21b saves Design data version 2 (docs/project-format.md, "Planned: Design's data version 2") with a tested migration from version 1: `nextId`, the `sketches` list, sketch items in the timeline, points and curves with ids, `constraints: []`. The browser lists sketches in the timeline and in a Sketches group. Each sketch edit ("Draw line") is one undo step. Ids never reused gets a test that deletes the newest line, draws another and checks the new id differs (and fails when the counter is replaced by "largest id + 1").
- 21c draws chains whose lines share end points.
- 21d extrudes a closed sketch as a new extrude feature after the sketch, depending on it. While there is one body (until 32), extruding a sketch replaces the part's current solid feature, as one undo step that says so ("Replace the part with Extrude of Sketch 1").
- Order (owner's decision, 2026-10-17): 21, 22, 23, then 32 and 33, then 24 onwards. Sketches on faces (24) and projected edges (25) then refer to faces and edges by stable id from the start, instead of by kernel index "for now" and reworked later.
- After 33: re-check the integration pieces X1–X8, which were built on preset shapes only, against real sketches and timelines (section in docs/roadmap.md, step 33).

## 7. Tests this model needs

- 21b: the version 1 → 2 migration on a real version 1 file; save and open byte-identical; the seeded history fuzz (packages/testing) extended with sketch edits (draw, delete, move a point) against its model; the ids test above.
- 32: seeded random timelines (add, edit, delete, reorder, suppress, move the marker, undo, redo, save and open) against a simple model, checking at every step that the rebuilt bodies equal a rebuild from scratch of the same document, and that save, open and rebuild changes nothing. Deliberate breaks: a reorder past a dependency allowed, a suppressed item built, a marker ignored; each must fail a test.
