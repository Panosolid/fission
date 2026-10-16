import { test } from "node:test";
import assert from "node:assert/strict";
import { ChangeNotes, DependencyGraph } from "@fission/core";
import { partDocument } from "../src/document.ts";
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
