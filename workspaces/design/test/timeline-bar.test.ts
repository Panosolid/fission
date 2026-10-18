import { test } from "node:test";
import assert from "node:assert/strict";
import { partDocument, type DesignDocument } from "../src/document.ts";
import { addSketch } from "../src/sketch.ts";
import { extrudeSketch } from "../src/extrude.ts";
import { timelineBarItems } from "../src/timeline-bar.ts";

/**
 * A box (feature-1), Sketch 1 (sketch-2) and its extrude (feature-3), built
 * by the document's own edits: a new project's counter starts at 2, each
 * edit takes the next id, and with no marker each goes in last.
 */
function threeItems(): DesignDocument {
  const box = partDocument("box", 40, 30, 20);
  const sketched = addSketch(box).doc;
  return extrudeSketch(sketched, "sketch-2", 10).doc;
}
const withMarker = (doc: DesignDocument, marker: string | undefined): DesignDocument => ({ ...doc, timeline: { ...doc.timeline, marker } });

test("the bar shows every item in build order, numbered and drawn by its kind", () => {
  const { items, marker } = timelineBarItems(threeItems());
  // Worked by hand: the items are the three edits above in the order made;
  // the numbers count from 1 like the browser's Timeline rows; with no
  // marker every item is built, so the marker stands after all 3.
  assert.deepEqual(
    items.map((i) => [i.id, i.label, i.icon]),
    [
      ["feature-1", "1. Box: 40 × 30 × 20 mm", "box"],
      ["sketch-2", "2. Sketch 1 on the XY plane", "sketch"],
      ["feature-3", "3. Extrude Sketch 1 by 10 mm", "extrude"],
    ],
  );
  assert.equal(marker, 3);
  assert.deepEqual(items.map((i) => [i.suppressed, i.rolledBack]), [[false, false], [false, false], [false, false]]);
});

test("the marker stands after the item it names, and the items after it are rolled back", () => {
  // Marker on sketch-2, the 2nd item: 2 items come before it; only the 3rd is after it.
  const on = timelineBarItems(withMarker(threeItems(), "sketch-2"));
  assert.equal(on.marker, 2);
  assert.deepEqual(on.items.map((i) => i.rolledBack), [false, false, true]);
  // "start": nothing before it, everything rolled back.
  const start = timelineBarItems(withMarker(threeItems(), "start"));
  assert.equal(start.marker, 0);
  assert.deepEqual(start.items.map((i) => i.rolledBack), [true, true, true]);
  // On the last item: the same as no marker.
  const last = timelineBarItems(withMarker(threeItems(), "feature-3"));
  assert.equal(last.marker, 3);
  assert.deepEqual(last.items.map((i) => i.rolledBack), [false, false, false]);
});

test("a suppressed item says so, apart from where the marker is", () => {
  const doc = threeItems();
  const suppressed = { ...doc, timeline: { features: doc.timeline.features.map((f) => (f.id === "feature-1" ? { ...f, suppressed: true } : f)) } };
  const { items, marker } = timelineBarItems(suppressed);
  assert.deepEqual(items.map((i) => [i.suppressed, i.rolledBack]), [[true, false], [false, false], [false, false]]);
  assert.equal(marker, 3, "suppressing an item never moves the marker");
});

test("a kind the bar has no drawing for gets the plain one, never another kind's", () => {
  const doc = threeItems();
  const odd = { ...doc, timeline: { features: [{ ...doc.timeline.features[0], intent: { ...doc.timeline.features[0].intent, type: "loft" } }] } };
  assert.equal(timelineBarItems(odd).items[0].icon, "feature");
  // An inherited name is not a kind: "constructor" must not find Object's.
  const proto = { ...doc, timeline: { features: [{ ...doc.timeline.features[0], intent: { ...doc.timeline.features[0].intent, type: "constructor" } }] } };
  assert.equal(timelineBarItems(proto).items[0].icon, "feature");
});

test("a marker naming no item is refused by name, never drawn at the start or the end", () => {
  assert.throws(() => timelineBarItems(withMarker(threeItems(), "feature-9")), /the timeline marker "feature-9" names no item in the timeline/);
});
