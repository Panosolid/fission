// Step 25c3: what the AI assistant is told about a real timeline
// (`designAIView`): the part as the set_part that makes it, each item and
// its state in build order, the marker, the sizes a set_part keeps, and
// whether Accept changes the part or adds a body (and where). The
// assistant's preview and prompt are checked in apps/fission/e2e/assistant.mjs;
// seeded timelines against withPart in packages/testing/test/ai-view.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { AI_TIMELINE_ITEMS, designAIView } from "../src/ai-view.ts";
import { addSketch, drawLine, drawRectangle } from "../src/sketch.ts";
import { extrudeSketch } from "../src/extrude.ts";
import { insertPreset, partDocument, type DesignDocument } from "../src/document.ts";
import { moveMarker, suppressItem } from "../src/timeline-edits.ts";

/**
 * The seven-item timeline of timeline-verbs.test.ts, by Design's own edits:
 *   1 feature-1   Box 40 × 30 × 20                Body 1
 *   2 sketch-2    Sketch 1: a 40 × 30 rectangle
 *   3 feature-11  Extrude 1: Sketch 1 by 10       Body 2
 *   4 feature-12  Cylinder ⌀20 × 5, suppressed
 *   5 sketch-13   Sketch 2: one line
 *   6 feature-17  Slot 60 × 20 by 5               Body 3, the marker on it
 *   7 feature-19  Sphere ⌀10, after the marker
 */
function timeline(): DesignDocument {
  let d = partDocument("box", 40, 30, 20);
  const s1 = addSketch(d);
  d = extrudeSketch(drawRectangle(s1.doc, s1.id, [0, 0], [40, 30]).doc, s1.id, 10).doc;
  const cylinder = insertPreset(d, "cylinder", 20, 20, 5);
  d = suppressItem(cylinder.doc, cylinder.id, true);
  const s2 = addSketch(d);
  d = drawLine(s2.doc, s2.id, [0, 0], [10, 0]).doc;
  const slot = insertPreset(d, "slot", 60, 20, 5);
  const sphere = insertPreset(slot.doc, "sphere", 10, 10, 10);
  return moveMarker(sphere.doc, slot.id);
}
const doc = timeline();
const NONE: ReadonlySet<string> = new Set();
const sizes = { width: 60, depth: 20, height: 5 };
const BOX = "1. Box: 40 × 30 × 20 mm.";
const SKETCH1 = "2. Sketch 1 on the XY plane.";
const EXTRUDE1 = "3. Extrude Sketch 1 by 10 mm.";
const CYLINDER = "4. Cylinder: ⌀20 × 5 mm.";
const SKETCH2 = "5. Sketch 2 on the XY plane.";
const SLOT = "6. Extrude: Slot with round ends profile 60 × 20 mm, by 5 mm.";
const SPHERE = "7. Sphere: ⌀10 mm.";

test("hand-worked: the marker on a preset, so set_part changes it in place, and every item's state", () => {
  const v = designAIView(doc, NONE, sizes);
  // The part is the last solid that builds: the slot (item 6). The sphere is after the marker, the cylinder suppressed.
  assert.deepEqual(v.setup, [{ op: "set_part", shape: "slot", width: 60, depth: 20, height: 5 }]);
  assert.equal(v.adds, null);
  assert.deepEqual(v.keeps, sizes);
  assert.deepEqual(v.notes, [
    "The design's timeline, in build order:",
    // Bodies count in build order among the solids that build: the box 1, Extrude 1 2, the slot 3.
    `${BOX} Builds Body 1.`,
    `${SKETCH1} A sketch: builds no body.`,
    `${EXTRUDE1} Builds Body 2.`,
    `${CYLINDER} Suppressed: builds nothing.`,
    `${SKETCH2} A sketch: builds no body.`,
    `${SLOT} Builds Body 3. This is the part set_part changes.`,
    `${SPHERE} After the timeline marker: not built.`,
    "The timeline marker is after item 6: items after it are not built.",
    "set_part changes the part in place.",
    "A size set_part leaves out keeps the value it has now: width 60, depth 20, height 5.",
  ]);
});

test("hand-worked: the marker on an extruded sketch, so set_part adds a body just after it; a failed body is said to fail", () => {
  // Marker on Extrude 1 (item 3): the part is Extrude 1, which no set_part makes. withPart puts a new preset at
  // insertAt = the marker's index + 1 = 3, so it is item 4, after item 3. The kernel failed Extrude 1 here.
  const v = designAIView(moveMarker(doc, "feature-11"), new Set(["feature-11"]), { width: 40, depth: 30, height: 10 });
  assert.deepEqual(v.setup, []);
  assert.equal(v.adds, "a new body as item 4, after 3. Extrude Sketch 1 by 10 mm");
  assert.deepEqual(v.notes.slice(1, 8), [
    `${BOX} Builds Body 1.`,
    `${SKETCH1} A sketch: builds no body.`,
    `${EXTRUDE1} Failed: builds no body.`,
    // Suppressed is said before rolled back: unsuppressing it would still leave it after the marker, but suppress is the item's own state.
    `${CYLINDER} Suppressed: builds nothing.`,
    `${SKETCH2} After the timeline marker: not built.`,
    `${SLOT} After the timeline marker: not built.`,
    `${SPHERE} After the timeline marker: not built.`,
  ]);
  assert.equal(v.notes[8], "The timeline marker is after item 3: items after it are not built.");
  assert.equal(
    v.notes[9],
    "The part (the last body) is 3. Extrude Sketch 1 by 10 mm, an extruded sketch, which no command you can use changes, so set_part adds a new body as item 4, after 3. Extrude Sketch 1 by 10 mm; nothing already in the timeline changes.",
  );
  assert.equal(v.notes[10], "A size set_part leaves out keeps the value it has now: width 40, depth 30, height 10.");
});

test("hand-worked: the marker at the start, so nothing builds and set_part adds item 1", () => {
  const v = designAIView(moveMarker(doc, "start"), NONE, sizes);
  assert.deepEqual(v.setup, []);
  // insertAt is 0 with the marker at the start: the new body is item 1, before everything.
  assert.equal(v.adds, "a new body as item 1, at the start of the timeline");
  assert.ok(v.notes.slice(1, 8).every((l, i) => l.startsWith(`${i + 1}. `)));
  assert.equal(v.notes[1], `${BOX} After the timeline marker: not built.`);
  assert.equal(v.notes[8], "The timeline marker is at the start: nothing is built.");
  assert.equal(v.notes[9], "Nothing builds a body, so set_part adds a new body as item 1, at the start of the timeline; nothing already in the timeline changes.");
});

test("hand-worked: the marker at the end with the last solid an extruded sketch adds a body as the last item", () => {
  // Box then Sketch 1 extruded: two items plus the sketch, no marker. insertAt is the length, 3, so item 4 after item 3.
  const s = addSketch(partDocument("box", 40, 30, 20));
  const d = extrudeSketch(drawRectangle(s.doc, s.id, [0, 0], [40, 30]).doc, s.id, 10).doc;
  const v = designAIView(d, NONE, sizes);
  assert.equal(v.adds, "a new body as item 4, after 3. Extrude Sketch 1 by 10 mm");
  assert.equal(v.notes.at(-3), "The timeline marker is at the end: every item is built.");
});

test("hand-worked: a suppressed sketch fails its extrude from the data, and a lost sketch's extrude builds from its kept shape", () => {
  // Sketch 1 suppressed: Extrude 1 can't build (builds() is false), with no kernel failure, so the note says why.
  const suppressed = designAIView(suppressItem(doc, "sketch-2", true), NONE, sizes);
  assert.equal(suppressed.notes[2], `${SKETCH1} Suppressed: builds nothing.`);
  assert.equal(suppressed.notes[3], `${EXTRUDE1} Failed: builds no body (its sketch is suppressed or gone).`);
  // Bodies keep counting only what builds: the slot is Body 2 now.
  assert.equal(suppressed.notes[6], `${SLOT} Builds Body 2. This is the part set_part changes.`);
  // Sketch 1 deleted with its shape kept (24d2): Extrude 1 still builds, from the kept shape. Items renumber.
  const sketch = doc.sketches.find((x) => x.id === "sketch-2")!;
  const lost: DesignDocument = {
    ...doc,
    sketches: doc.sketches.filter((x) => x !== sketch),
    timeline: { ...doc.timeline, features: doc.timeline.features.filter((f) => f.id !== "sketch-2") },
    kept: { "feature-11": { points: sketch.points, curves: sketch.curves } },
  };
  assert.equal(designAIView(lost, NONE, sizes).notes[2], "2. Extrude Sketch 1 by 10 mm. Builds Body 2. Its sketch is lost (deleted, or no longer a closed outline), so it builds from the shape it kept.");
});

test("a long timeline lists only its last items, and says how many were left out", () => {
  let d = partDocument("box", 40, 30, 20);
  for (let i = 0; i < AI_TIMELINE_ITEMS + 4; i++) d = insertPreset(d, "box", 10 + i, 10, 10).doc;
  // 1 + 44 = 45 items; the first 5 are left out, so the list starts at item 6.
  const notes = designAIView(d, NONE, sizes).notes;
  assert.equal(notes[1], "(5 earlier items left out)");
  assert.match(notes[2], /^6\. Box: 14 × 10 × 10 mm\. Builds Body 6\.$/);
  assert.equal(notes.length, 1 + 1 + AI_TIMELINE_ITEMS + 3);
  // The boundary: exactly AI_TIMELINE_ITEMS items is no cut; one more leaves the first out.
  let e = partDocument("box", 40, 30, 20);
  for (let i = 0; i < AI_TIMELINE_ITEMS - 1; i++) e = insertPreset(e, "box", 10, 10, 10).doc;
  assert.equal(designAIView(e, NONE, sizes).notes[1], `${BOX} Builds Body 1.`);
  const one = designAIView(insertPreset(e, "box", 10, 10, 10).doc, NONE, sizes).notes;
  assert.equal(one[1], "(1 earlier item left out)");
  assert.match(one[2], /^2\. Box: 10 × 10 × 10 mm\. Builds Body 2\.$/);
});

test("no design: no part, no notes, nothing added", () => {
  assert.deepEqual(designAIView(undefined, NONE, sizes), { setup: [], keeps: sizes, notes: [], adds: null });
});
