// The timeline hunt's finding 12 (bug-hunts/timeline-2026-10-19.txt): a file
// in which another item took Sketch 1's id was refused as "Design timeline
// item feature-1 is a sketch with no content in the sketches list", which
// sends the reader looking for a missing sketch. Two items with one id are
// now said as that, before anything else is read.

import { test } from "node:test";
import assert from "node:assert/strict";
import { partDocument, readDesignDocument, type DesignDocument } from "../src/document.ts";
import { addSketch, drawRectangle } from "../src/sketch.ts";
import { extrudeSketch } from "../src/extrude.ts";

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const refusedWith = (d: unknown) => {
  try {
    readDesignDocument(d);
  } catch (e) {
    return (e as Error).message;
  }
  return null;
};

test("the hunt's file: Sketch 1's id changed to the box's, feature-1, is refused as an id used twice", () => {
  const s = addSketch(partDocument("box", 40, 30, 20));
  const d = clone(extrudeSketch(drawRectangle(s.doc, s.id, [0, 0], [10, 10]).doc, s.id, 10).doc) as DesignDocument;
  assert.equal(refusedWith(d), null, "the file as saved opens");
  // By hand: the box is feature-1, Sketch 1 sketch-2; the hunt renamed the sketch item (not its content) to feature-1.
  d.timeline.features[1].id = "feature-1";
  assert.equal(refusedWith(d), "Design id feature-1 is used twice");
});

test("two solid items with one id are refused the same way, naming the id", () => {
  const d = clone(partDocument("box", 40, 30, 20)) as DesignDocument;
  d.timeline.features.push({ ...clone(d.timeline.features[0]) });
  assert.equal(refusedWith(d), "Design id feature-1 is used twice");
  // And a file with every id once still opens (the check can pass).
  d.timeline.features[1].id = "feature-7";
  d.timeline.features[1].provenance.self.id = "feature-7";
  d.nextId = 8;
  assert.equal(refusedWith(d), null);
});

// Issue #262 (project-loader fuzzing): a file listing Sketch 1's content twice,
// the second copy with `projected: ""`, was refused with the engine's own
// "(s.projected ?? []).map is not a function". Only the first copy was checked
// (the second was looked past), so the second's text reached the id count.
// A sketch's content listed twice is now refused as that, before either is read.
test("a sketch's content listed twice is refused as that, not with an engine message", () => {
  const s = addSketch(partDocument("box", 40, 30, 20));
  const d = clone(drawRectangle(s.doc, s.id, [0, 0], [10, 10]).doc) as DesignDocument;
  assert.equal(refusedWith(d), null, "the file as saved opens");
  // By hand: Sketch 1 is sketch-2; a second copy of its content with a projections field that is text, as the fuzzer's.
  d.sketches.push({ ...clone(d.sketches[0]), projected: "" as unknown as [] });
  assert.equal(refusedWith(d), "Design sketch sketch-2 is listed twice in the sketches list");
  // A plain second copy (nothing malformed in it) is refused the same way: it was silently ignored before.
  d.sketches[1] = clone(d.sketches[0]);
  assert.equal(refusedWith(d), "Design sketch sketch-2 is listed twice in the sketches list");
});
