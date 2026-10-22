// Step 27c: pins on any earlier body's edges (the naming model's rules 11
// and 13), the parts the kernel isn't needed for: which feature a new pin
// names, what the sketch then depends on (sketch.ts `withPins`), moving a
// point onto a target (`movePointOnto`), the timeline's rules through a pin
// (a drag across it refused with words, suppressing the body greys the
// sketch, deleting it asks and holds the point), and the snap's choice of
// one of several points at one place (snap.ts SAME_PLACE). On the real
// kernel: packages/testing/journeys/naming.journey.ts (R11, R13 and the
// "pins" sessions against the model), body-pins.journey.ts, face-tilted
// and face-chaos.
import { test } from "node:test";
import assert from "node:assert/strict";
import { builds, greyedBy, greyedItems, insertPreset, partDocument, type DesignDocument } from "../src/document.ts";
import type { EdgeTarget } from "../src/face-edges.ts";
import { drawnFrame, facePlane } from "../src/face-sketch.ts";
import { addFaceSketch, addSketch, deleteCurve, drawCircle, movePoint, movePointOnto, pinNewPoints } from "../src/sketch.ts";
import { SAME_PLACE, snapPointer, snapTargets } from "../src/snap.ts";
import { startTool } from "../src/sketch-tool.ts";
import { deleteItem, reorderItem, suppressItem } from "../src/timeline-edits.ts";
import { deleteWords } from "../src/delete-ask.ts";
import { extrudeSketch } from "../src/extrude.ts";

/** A 40 × 30 × 20 box (feature-1) and a 10 × 10 × 10 one (feature-2). */
function twoBoxes(): DesignDocument {
  return insertPreset(partDocument("box", 40, 30, 20), "box", 10, 10, 10).doc;
}

const target = (at: [number, number], name: string, feature: string, kind: EdgeTarget["kind"] = "endpoint"): EdgeTarget => ({ at, kind, name, feature });
/** The second box's back right top corner seen from above, and its top right edge's middle (names as naming.ts gives a box's). */
const BOX2_CORNER = target([10, 10], "back+right&back+top&right+top", "feature-2");
const BOX2_MIDDLE = target([10, 5], "right+top", "feature-2", "midpoint");
/** The first box's own top back right corner, for a sketch on its top. */
const BOX1_CORNER = target([40, 30], "back+right&back+top&right+top", "feature-1");

const item = (doc: DesignDocument, id: string) => doc.timeline.features.find((f) => f.id === id)!;
const sketch = (doc: DesignDocument, id: string) => doc.sketches.find((s) => s.id === id)!;
const centreOf = (doc: DesignDocument, id: string, k = -1) => (sketch(doc, id).curves.at(k) as { centre: string }).centre;

/** A circle of radius 2 centred on `t` in sketch `id`, pinned as a click there is. */
function circleOn(doc: DesignDocument, id: string, t: EdgeTarget, targets: EdgeTarget[] = [t]): DesignDocument {
  return pinNewPoints(doc, drawCircle(doc, id, t.at, 2).doc, id, targets);
}

test("27c, hand-worked: a pin on another body names its feature, and the sketch depends on it once, for as long as a pin names it", () => {
  // A sketch on XY after both boxes: a circle centred on box 2's corner (10, 10) is pinned there, naming feature-2.
  const xy = addSketch(twoBoxes());
  assert.deepEqual(item(xy.doc, xy.id).dependsOn, []);
  const one = circleOn(xy.doc, xy.id, BOX2_CORNER);
  assert.deepEqual(sketch(one, xy.id).pins, [{ point: centreOf(one, xy.id), kind: "endpoint", name: BOX2_CORNER.name, feature: "feature-2" }]);
  assert.deepEqual(item(one, xy.id).dependsOn, ["feature-2"]);
  // On box 1's top: its own corner's pin names no feature (as 0.26 wrote them); box 2's does. The sketch depends on
  // box 1 (its face) and box 2, each once, however many pins name them.
  const top = addFaceSketch(twoBoxes(), { plane: facePlane("feature-1", "top"), feature: "feature-1" }, drawnFrame([0, 0, 1], [20, 15, 20]));
  let doc = circleOn(top.doc, top.id, BOX1_CORNER);
  assert.deepEqual(sketch(doc, top.id).pins![0], { point: centreOf(doc, top.id), kind: "endpoint", name: BOX1_CORNER.name });
  assert.deepEqual(item(doc, top.id).dependsOn, ["feature-1"]);
  doc = circleOn(doc, top.id, BOX2_CORNER);
  const second = centreOf(doc, top.id);
  doc = circleOn(doc, top.id, BOX2_MIDDLE);
  assert.deepEqual(item(doc, top.id).dependsOn, ["feature-1", "feature-2"]);
  assert.deepEqual(sketch(doc, top.id).pins!.map((p) => p.feature), [undefined, "feature-2", "feature-2"]);
  // The corner's centre moved by hand: its pin goes, but the middle's still names box 2.
  doc = movePoint(doc, top.id, second, 3, 3);
  assert.deepEqual(item(doc, top.id).dependsOn, ["feature-1", "feature-2"]);
  // The middle's circle deleted: nothing names box 2, so the sketch depends on its face's feature alone.
  doc = deleteCurve(doc, top.id, sketch(doc, top.id).curves.at(-1)!.id);
  assert.deepEqual(item(doc, top.id).dependsOn, ["feature-1"]);
  assert.equal(sketch(doc, top.id).pins!.length, 1);
});

test("27c, hand-worked: a point moved onto a target lands exactly there and is pinned in place of its old pin; again, the same document", () => {
  const xy = addSketch(twoBoxes());
  const drawn = drawCircle(xy.doc, xy.id, [50, 50], 2).doc;
  const centre = centreOf(drawn, xy.id);
  const onto = movePointOnto(drawn, xy.id, centre, BOX2_CORNER);
  const p = sketch(onto, xy.id).points.find((x) => x.id === centre)!;
  assert.deepEqual([p.x, p.y], [10, 10]);
  assert.deepEqual(sketch(onto, xy.id).pins, [{ point: centre, kind: "endpoint", name: BOX2_CORNER.name, feature: "feature-2" }]);
  assert.deepEqual(item(onto, xy.id).dependsOn, ["feature-2"]);
  assert.equal(movePointOnto(onto, xy.id, centre, BOX2_CORNER), onto);
  // Onto the middle (10, 5): the pin is replaced where it was in the list, not added.
  const middle = movePointOnto(onto, xy.id, centre, BOX2_MIDDLE);
  assert.deepEqual(sketch(middle, xy.id).pins, [{ point: centre, kind: "midpoint", name: "right+top", feature: "feature-2" }]);
  // On a sketch on box 1's top, onto its own corner: no feature named, as pinNewPoints writes it.
  const top = addFaceSketch(twoBoxes(), { plane: facePlane("feature-1", "top"), feature: "feature-1" }, drawnFrame([0, 0, 1], [20, 15, 20]));
  const t = drawCircle(top.doc, top.id, [5, 5], 2).doc;
  const own = movePointOnto(t, top.id, centreOf(t, top.id), BOX1_CORNER);
  assert.deepEqual(sketch(own, top.id).pins, [{ point: centreOf(t, top.id), kind: "endpoint", name: BOX1_CORNER.name }]);
  assert.deepEqual(item(own, top.id).dependsOn, ["feature-1"]);
});

test("27c, hand-worked: a drag across a pin's link is refused either way, in words, and allowed once the pin is gone", () => {
  // Timeline: Feature 1, Feature 2, Sketch 1 (on XY, pinned to Feature 2).
  const xy = addSketch(twoBoxes());
  const doc = circleOn(xy.doc, xy.id, BOX2_CORNER);
  const before = reorderItem(doc, xy.id, 1);
  assert.deepEqual(before, { refused: "before-dependency", message: "Sketch 1 can't go before Feature 2 (box): it is snapped to an edge of Feature 2 (box)" });
  const after = reorderItem(doc, "feature-2", 2);
  assert.deepEqual(after, { refused: "after-dependent", message: "Feature 2 (box) can't go after Sketch 1: Sketch 1 is snapped to an edge of it" });
  // To the very start it would be before Feature 2 too: refused the same way.
  assert.deepEqual(reorderItem(doc, xy.id, 0), before);
  // A sketch on Feature 1's top pinned to Feature 2 names each link in its own words.
  const top = addFaceSketch(twoBoxes(), { plane: facePlane("feature-1", "top"), feature: "feature-1" }, drawnFrame([0, 0, 1], [20, 15, 20]));
  const both = circleOn(top.doc, top.id, BOX2_CORNER);
  assert.equal((reorderItem(both, "feature-1", 2) as { message: string }).message, "Feature 1 (box) can't go after Sketch 1: Sketch 1 is drawn on a face of it");
  assert.equal((reorderItem(both, "feature-2", 2) as { message: string }).message, "Feature 2 (box) can't go after Sketch 1: Sketch 1 is snapped to an edge of it");
  // The pin gone (its point moved by hand): the sketch may go straight after Feature 1, before Feature 2.
  const free = movePoint(doc, xy.id, centreOf(doc, xy.id), 3, 3);
  const moved = reorderItem(free, xy.id, 0);
  assert.ok("doc" in moved && moved.doc.timeline.features.map((f) => f.id).join() === `${xy.id},feature-1,feature-2`);
});

test("27c, hand-worked: suppressing the body a pin is on greys the sketch and what is built from it; the face's feature is named first", () => {
  const xy = addSketch(twoBoxes());
  const pinned = circleOn(xy.doc, xy.id, BOX2_CORNER);
  const ex = extrudeSketch(pinned, xy.id, 5);
  const off = suppressItem(ex.doc, "feature-2", true);
  assert.equal(greyedBy(off, item(off, xy.id)), "feature-2");
  assert.equal(greyedBy(off, item(off, ex.id)), "feature-2");
  assert.deepEqual([...greyedItems(off)].map(([f, by]) => `${f.id}:${by}`), [`${xy.id}:feature-2`, `${ex.id}:feature-2`]);
  assert.equal(builds(off, item(off, ex.id)), false);
  // Box 1 suppressed instead: the XY sketch isn't built on it, so nothing is greyed.
  const other = suppressItem(ex.doc, "feature-1", true);
  assert.equal(greyedBy(other, item(other, xy.id)), null);
  assert.equal(greyedItems(other).size, 0);
  // A sketch on box 1's top pinned to box 2, both suppressed: greyed by box 1, its face's, named first.
  const top = addFaceSketch(twoBoxes(), { plane: facePlane("feature-1", "top"), feature: "feature-1" }, drawnFrame([0, 0, 1], [20, 15, 20]));
  const t = circleOn(top.doc, top.id, BOX2_CORNER);
  const bothOff = suppressItem(suppressItem(t, "feature-1", true), "feature-2", true);
  assert.equal(greyedBy(bothOff, item(bothOff, top.id)), "feature-1");
  assert.equal(greyedItems(bothOff).get(item(bothOff, top.id)), "feature-1");
  const onlyTwo = suppressItem(t, "feature-2", true);
  assert.equal(greyedBy(onlyTwo, item(onlyTwo, top.id)), "feature-2");
});

test("27c, hand-worked: deleting the body a pin is on asks first, and says the sketch keeps its point where it is", () => {
  const xy = addSketch(twoBoxes());
  const doc = circleOn(xy.doc, xy.id, BOX2_CORNER);
  assert.deepEqual(deleteWords(doc, deleteItem(doc, "feature-2"), "feature-2"), {
    heading: "Delete Feature 2 (box)?",
    words: "Sketch 1 is snapped to an edge of Feature 2 (box). If you delete it, Sketch 1 keeps its snapped points where they are and shows they are lost. Undo brings Feature 2 (box) back.",
  });
  // The pin stays in the file, naming the deleted feature: the rebuild holds the point with "point lost".
  const gone = deleteItem(doc, "feature-2");
  assert.equal(sketch(gone, xy.id).pins![0].feature, "feature-2");
  // A sketch on box 2's top and the pinned one: the face sketch's plane is lost, the other's point held.
  const face = addFaceSketch(doc, { plane: facePlane("feature-2", "top"), feature: "feature-2" }, drawnFrame([0, 0, 1], [5, 5, 10]));
  assert.equal(
    deleteWords(face.doc, deleteItem(face.doc, "feature-2"), "feature-2")!.words,
    "Sketch 1 and Sketch 2 are built from Feature 2 (box). If you delete it, Sketch 2 stays where it is and shows its plane is lost, and Sketch 1 keeps its snapped points where they are and shows they are lost. Undo brings Feature 2 (box) back.",
  );
  // Box 1, which nothing is built on: no question.
  assert.equal(deleteWords(doc, deleteItem(doc, "feature-1"), "feature-1"), null);
});

test("27c: of points at one place the first listed is taken: within SAME_PLACE (0.9 ×) one place, beyond it (1.1 ×) two", () => {
  const xy = addSketch(twoBoxes());
  const s = sketch(xy.doc, xy.id);
  const tool = startTool("circle", xy.id);
  // Box 2's top corner listed first (on the sketch's plane, as face-edges.ts orders them), the bottom corner under it
  // seen along a slanted normal a little off; the pointer nearer the second.
  for (const [k, want] of [[0.9, "top"], [1.1, "bottom"]] as const) {
    const off = k * SAME_PLACE;
    const ts = [target([10, 10], "top", "feature-2"), target([10 + off, 10], "bottom", "feature-2")];
    const snap = snapPointer([10 + off + 1e-7, 10], [10, 10], snapTargets(s, tool, ts), 0.1);
    assert.deepEqual(snap, { kind: "endpoint", at: want === "top" ? [10, 10] : [10 + off, 10], edge: true }, `${k} × SAME_PLACE`);
  }
  // A sketch's own point at one place with a body's corner (0.9 × off): the sketch's point is taken, so a click shares it.
  const drawn = drawCircle(xy.doc, xy.id, [10, 10], 2).doc;
  const near = snapPointer([10 + 0.9 * SAME_PLACE, 10], [10, 10], snapTargets(sketch(drawn, xy.id), tool, [target([10 + 0.9 * SAME_PLACE, 10], "bottom", "feature-2")]), 0.1);
  assert.deepEqual(near, { kind: "centre", at: [10, 10] });
  // SAME_PLACE is the kernel's linear tolerance, 10 nm.
  assert.equal(SAME_PLACE, 1e-5);
});
