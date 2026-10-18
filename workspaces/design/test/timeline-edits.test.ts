// Step 24e2: the timeline edits (delete, reorder, suppress, the marker) on
// Design's data, hand-worked, each with its undo step's name and, for a
// refused reorder, its exact message. Every result is saved and opened
// again, so each one is a document the reader takes. What the rebuild makes
// of them (a deleted sketch's extrude kept with the warning, a suppressed
// sketch failing its extrude) is checked on the real kernel in
// packages/testing/journeys/timeline.journey.ts; the seeded sessions run
// these functions against the model in packages/testing/src/timeline-design.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyProject, projectFromJson, projectToJson } from "@fission/core";
import { builds, insertAt, insertPreset, partDocument, readDesignDocument, type DesignDocument } from "../src/document.ts";
import { addSketch, drawRectangle } from "../src/sketch.ts";
import { extrudeSketch } from "../src/extrude.ts";
import { deleteItem, itemName, moveMarker, reorderItem, suppressItem, TIMELINE_STEPS } from "../src/timeline-edits.ts";

const DESIGN = [{ id: "design" as const, readData: readDesignDocument }];
const reopen = (d: DesignDocument) => projectFromJson(projectToJson({ ...emptyProject("Edits"), workspaces: { design: d } }), DESIGN).workspaces.design as DesignDocument;
const order = (d: DesignDocument) => d.timeline.features.map((f) => f.id);

/**
 * The box (feature-1, counter 2), Sketch 1 (sketch-2: a 40 × 30
 * rectangle, points 3, 4, 6, 8 and lines 5, 7, 9, 10, counter 11) and
 * Extrude 1 of it (feature-11, depending on sketch-2, counter 12).
 */
function part(): DesignDocument {
  const s = addSketch(partDocument("box", 40, 30, 20));
  const rect = drawRectangle(s.doc, s.id, [0, 0], [40, 30]);
  return extrudeSketch(rect.doc, s.id, 10).doc;
}

test("the setup is the one worked out above", () => {
  const d = part();
  assert.deepEqual(order(d), ["feature-1", "sketch-2", "feature-11"]);
  assert.deepEqual(d.timeline.features[2].dependsOn, ["sketch-2"]);
  assert.deepEqual(d.timeline.features.map(itemName), ["Feature 1 (box)", "Sketch 1", "Extrude 1"]);
  assert.equal(d.nextId, 12);
});

test("each edit's undo step has its name", () => {
  assert.equal(TIMELINE_STEPS.delete("Sketch 1"), "Delete Sketch 1");
  assert.equal(TIMELINE_STEPS.reorder("Feature 1 (box)"), "Move Feature 1 (box) in the timeline");
  assert.equal(TIMELINE_STEPS.suppress("Extrude 1"), "Suppress Extrude 1");
  assert.equal(TIMELINE_STEPS.unsuppress("Extrude 1"), "Unsuppress Extrude 1");
  assert.equal(TIMELINE_STEPS.marker, "Move the rollback marker");
});

test("deleting a sketch an extrude uses takes the sketch and its content, and leaves the extrude depending on it", () => {
  const d = part();
  const before = JSON.stringify(d);
  const after = deleteItem(d, "sketch-2");
  // Only the sketch goes: the box and the extrude stay, in order; the extrude still names sketch-2 (it keeps its last shape, settleKept).
  assert.deepEqual(order(after), ["feature-1", "feature-11"]);
  assert.deepEqual(after.sketches, []);
  assert.deepEqual(after.timeline.features[1].dependsOn, ["sketch-2"]);
  // The counter never goes back, so sketch-2's ids are never given again.
  assert.equal(after.nextId, 12);
  assert.equal(JSON.stringify(d), before, "the document before is untouched, so undo has it whole");
  assert.deepEqual(reopen(after), after);
});

test("deleting the item the marker is on moves the marker to the one before, or to the start for the first", () => {
  const atSketch = moveMarker(part(), "sketch-2");
  assert.equal(deleteItem(atSketch, "sketch-2").timeline.marker, "feature-1");
  const atBox = moveMarker(part(), "feature-1");
  const gone = deleteItem(atBox, "feature-1");
  assert.equal(gone.timeline.marker, "start");
  assert.deepEqual(order(gone), ["sketch-2", "feature-11"]);
  // A marker on another item stays where it is.
  assert.equal(deleteItem(atSketch, "feature-11").timeline.marker, "sketch-2");
  // No marker stays no marker (the key left out, as the file has it).
  assert.equal(Object.hasOwn(deleteItem(part(), "feature-11").timeline, "marker"), false);
});

test("suppress then delete: the item goes with its flag", () => {
  const d = deleteItem(suppressItem(part(), "feature-11", true), "feature-11");
  assert.deepEqual(order(d), ["feature-1", "sketch-2"]);
  assert.deepEqual(reopen(d), d);
});

test("deleting an extrude takes its kept shape; deleting a preset takes the profile only it used", () => {
  const d = part();
  const kept = { ...d, kept: { "feature-11": { points: d.sketches[0].points, curves: d.sketches[0].curves } } };
  const noExtrude = deleteItem(kept, "feature-11");
  assert.equal(Object.hasOwn(noExtrude, "kept"), false);
  assert.deepEqual(reopen(noExtrude), noExtrude);
  // A plate is feature-12 with its ready-made profile-13 (counter 12, then 13).
  const plate = insertPreset(d, "plate", 60, 40, 5);
  assert.equal(plate.id, "feature-12");
  assert.deepEqual(plate.doc.profiles.map((p) => p.id), ["profile-13"]);
  const noPlate = deleteItem(plate.doc, "feature-12");
  assert.deepEqual(noPlate.profiles, []);
  assert.equal(noPlate.nextId, 14);
  assert.deepEqual(reopen(noPlate), noPlate);
});

test("a delete of an item not in the timeline is refused, naming it", () => {
  assert.throws(() => deleteItem(part(), "feature-99"), { message: 'there is no item feature-99 in the timeline' });
});

test("a reorder to the item's own place gives the same document back: no undo step", () => {
  const d = part();
  for (const [k, id] of order(d).entries()) {
    const r = reorderItem(d, id, k);
    assert.ok("doc" in r);
    assert.equal(r.doc, d);
  }
});

test("a reorder moves the item to its place in the new order", () => {
  // Take feature-1 out ([sketch-2, feature-11]) and put it in at 2: the end.
  const r = reorderItem(part(), "feature-1", 2);
  assert.ok("doc" in r);
  assert.deepEqual(order(r.doc), ["sketch-2", "feature-11", "feature-1"]);
  assert.deepEqual(reopen(r.doc), r.doc);
  // And back to 0: the start, where it was.
  const back = reorderItem(r.doc, "feature-1", 0);
  assert.ok("doc" in back);
  assert.deepEqual(back.doc, part());
});

test("a reorder past a dependency is refused either way, with its message", () => {
  const d = part();
  // Extrude 1 to 1: [feature-1, feature-11, sketch-2], before the sketch it is built from.
  assert.deepEqual(reorderItem(d, "feature-11", 1), { refused: "before-dependency", message: "Extrude 1 can't go before Sketch 1: it is built from Sketch 1" });
  assert.deepEqual(reorderItem(d, "feature-11", 0), { refused: "before-dependency", message: "Extrude 1 can't go before Sketch 1: it is built from Sketch 1" });
  // Sketch 1 to 2: [feature-1, feature-11, sketch-2], after the extrude built from it.
  assert.deepEqual(reorderItem(d, "sketch-2", 2), { refused: "after-dependent", message: "Sketch 1 can't go after Extrude 1: Extrude 1 is built from it" });
  // Past the box is fine: [sketch-2, feature-11, feature-1] keeps the sketch before its extrude.
  const ok = reorderItem(d, "sketch-2", 0);
  assert.ok("doc" in ok);
  assert.deepEqual(order(ok.doc), ["sketch-2", "feature-1", "feature-11"]);
});

test("a reorder keeps the marker on the item it names", () => {
  const d = moveMarker(part(), "feature-1");
  const r = reorderItem(d, "feature-1", 2);
  assert.ok("doc" in r);
  assert.equal(r.doc.timeline.marker, "feature-1");
  // Everything is now before it, so everything builds.
  assert.ok(r.doc.timeline.features.every((f) => builds(r.doc, f)));
});

test("a reorder to a place outside the timeline is refused", () => {
  assert.throws(() => reorderItem(part(), "feature-1", 3), { message: "Feature 1 (box) can't go to place 3 of a timeline of 3 items" });
  assert.throws(() => reorderItem(part(), "feature-1", -1), { message: "Feature 1 (box) can't go to place -1 of a timeline of 3 items" });
  assert.throws(() => reorderItem(part(), "feature-1", 0.5), { message: "Feature 1 (box) can't go to place 0.5 of a timeline of 3 items" });
});

test("suppressing a used sketch stops its extrude building; unsuppressing brings both back", () => {
  const d = part();
  const off = suppressItem(d, "sketch-2", true);
  const [box, sketch, extrude] = off.timeline.features;
  assert.equal(sketch.suppressed, true);
  assert.deepEqual([builds(off, box), builds(off, sketch), builds(off, extrude)], [true, false, false]);
  assert.deepEqual(reopen(off), off);
  const on = suppressItem(off, "sketch-2", false);
  assert.deepEqual(on, d);
  // Already so: the same document back, no step.
  assert.equal(suppressItem(d, "sketch-2", false), d);
  assert.equal(suppressItem(off, "sketch-2", true), off);
});

test("the marker: at the start nothing builds, on the last item everything does, and a new item goes in at it", () => {
  const d = part();
  const start = moveMarker(d, "start");
  assert.ok(start.timeline.features.every((f) => !builds(start, f)));
  // A file with nothing built is still refused when opened, until the app can show a design with no body (the harness's NOTHING_BUILT).
  assert.throws(() => reopen(start), /Design data builds no body/);
  const last = moveMarker(d, "feature-11");
  assert.ok(last.timeline.features.every((f) => builds(last, f)));
  // Back to everything: the marker left out, the document as it was.
  assert.deepEqual(moveMarker(last, null), d);
  assert.equal(moveMarker(d, null), d);
  // On the box: a new sketch goes in just after it (place 1) and the marker moves onto it.
  const atBox = moveMarker(d, "feature-1");
  assert.equal(insertAt(atBox), 1);
  const s = addSketch(atBox);
  assert.deepEqual(order(s.doc), ["feature-1", "sketch-12", "sketch-2", "feature-11"]);
  assert.equal(s.doc.timeline.marker, "sketch-12");
  assert.throws(() => moveMarker(d, "sketch-99"), { message: "there is no item sketch-99 in the timeline" });
});
