import { test } from "node:test";
import assert from "node:assert/strict";
import { ChangeNotes, DependencyGraph } from "@fission/core";
import { partDocument, type DesignDocument } from "../src/document.ts";
import { extrudeSketch } from "../src/extrude.ts";
import { addSketch, drawRectangle } from "../src/sketch.ts";
import { PART_VIEW, syncGraph } from "../src/graph.ts";

test("an edit marks the part's numbers out of date until they are rebuilt", () => {
  const g = new DependencyGraph();
  syncGraph(g, partDocument("l-bracket", 40, 30, 20), null, new ChangeNotes());
  // Everything is new, so everything downstream is stale: the feature and the view.
  assert.deepEqual(new Set(g.stale()), new Set(["feature-1", PART_VIEW]));
  g.markFresh("feature-1");
  g.markFresh(PART_VIEW);
  // Changing the profile's width reaches the view through the feature.
  syncGraph(g, partDocument("l-bracket", 41, 30, 20), partDocument("l-bracket", 40, 30, 20), new ChangeNotes());
  assert.equal(g.isStale(PART_VIEW), true);
  assert.deepEqual([...g.upstreamOf(PART_VIEW)].sort(), ["feature-1", "profile-1"]);
});

test("an unchanged document marks nothing", () => {
  const g = new DependencyGraph();
  const doc = partDocument("box", 40, 30, 20);
  syncGraph(g, doc, null, new ChangeNotes());
  g.markFresh("feature-1");
  g.markFresh(PART_VIEW);
  syncGraph(g, partDocument("box", 40, 30, 20), doc, new ChangeNotes());
  assert.deepEqual(g.stale(), []);
});

test("switching from an extrusion to a box drops the profile without leaving a dangling input", () => {
  const g = new DependencyGraph();
  const bracket = partDocument("l-bracket", 40, 30, 20);
  syncGraph(g, bracket, null, new ChangeNotes());
  syncGraph(g, partDocument("box", 40, 30, 20), bracket, new ChangeNotes());
  assert.equal(g.has("profile-1"), false);
  assert.deepEqual(g.missingInputs(), []);
  assert.equal(g.isStale(PART_VIEW), true);
});

test("an extrude whose sketch is deleted goes in the graph without it, opened or deleted after (24d2: it builds from its kept shape)", () => {
  // Found by the browser check: opening a file whose extrude's sketch is gone threw "depends on sketch-2, which is not in the project".
  const s = addSketch(partDocument("box", 40, 30, 20));
  const rect = drawRectangle(s.doc, s.id, [0, 0], [40, 30]);
  const e = extrudeSketch(rect.doc, s.id, 10);
  const whole = e.doc.sketches[0];
  const gone: DesignDocument = {
    ...e.doc,
    sketches: [],
    timeline: { features: e.doc.timeline.features.filter((f) => f.id !== s.id) },
    kept: { [e.id]: { points: whole.points, curves: whole.curves } },
  };
  // Opened as it is: the extrude is in, reading nothing, and the part's numbers read it.
  const opened = new DependencyGraph();
  syncGraph(opened, gone, null, new ChangeNotes());
  assert.equal(opened.has(e.id), true);
  assert.deepEqual(opened.missingInputs(), []);
  // Deleted from a document that had it: the sketch leaves, no input dangles, and the extrude is not out of date (its shape is kept).
  const g = new DependencyGraph();
  syncGraph(g, e.doc, null, new ChangeNotes());
  for (const f of e.doc.timeline.features) g.markFresh(f.id);
  syncGraph(g, gone, e.doc, new ChangeNotes());
  assert.equal(g.has(s.id), false);
  assert.deepEqual(g.missingInputs(), []);
  assert.equal(g.isStale(e.id), false);
});
