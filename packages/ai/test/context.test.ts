import { test } from "node:test";
import assert from "node:assert/strict";
import { DependencyGraph, emptyProject, type Feature } from "@fission/core";
import { buildContext } from "../src/context.ts";

const feature = (n: number): Feature => ({
  id: `feature-${n}`,
  intent: { type: "box", parameters: { width: n }, summary: `Box ${n}` },
  provenance: { self: { workspace: "design", id: `feature-${n}`, label: `F${n}` }, from: [] },
  dependsOn: [],
  suppressed: false,
});

test("the context is a structured summary of the project, not geometry", () => {
  const project = emptyProject("P");
  project.workspaces.design = { version: 1, profiles: [], timeline: { features: [feature(1)] } };
  const graph = new DependencyGraph();
  graph.set({ id: "feature-1", label: "Box 1", workspace: "design", cost: "cheap" });
  graph.set({ id: "view", label: "view", workspace: "design", cost: "cheap" }, ["feature-1"]);
  graph.changed("feature-1");
  const c = buildContext(project, { workspace: "design", graph, selection: ["feature-1"], errors: ["width must be > 0"] });
  assert.deepEqual(c, {
    workspace: "design",
    units: "mm",
    selection: [{ id: "feature-1", intent: "Box 1" }],
    features: [{ workspace: "design", id: "feature-1", summary: "Box 1", parameters: { width: 1 }, suppressed: false, afterMarker: false }],
    materials: [],
    errors: ["width must be > 0"],
    graph: { stale: ["view"], dependsOnSelection: ["view"] },
  });
});

test("each feature says whether it is after its timeline's marker (25c3)", () => {
  const project = emptyProject();
  const after = (marker?: string) => {
    project.workspaces.design = { version: 3, profiles: [], timeline: { features: [feature(1), feature(2), feature(3)], ...(marker === undefined ? {} : { marker }) } };
    return buildContext(project, { workspace: "design", graph: new DependencyGraph() }).features.map((f) => f.afterMarker);
  };
  // The marker names the last item built: on feature-2, item 3 is rolled back; at "start" all three are;
  // left out, none is; naming no item (as buildingItems reads it), none builds, so all are after it.
  assert.deepEqual(after("feature-2"), [false, false, true]);
  assert.deepEqual(after("feature-1"), [false, true, true]);
  assert.deepEqual(after("start"), [true, true, true]);
  assert.deepEqual(after(), [false, false, false]);
  assert.deepEqual(after("feature-9"), [true, true, true]);
});

test("small context stays small for local models; large gets more", () => {
  const project = emptyProject();
  project.workspaces.design = { version: 1, profiles: [], timeline: { features: Array.from({ length: 200 }, (_, i) => feature(i + 1)) } };
  const graph = new DependencyGraph();
  const small = buildContext(project, { workspace: "design", graph, errors: Array(10).fill("e") });
  assert.equal(small.features.length, 20);
  assert.equal(small.features.at(-1)!.id, "feature-200", "keeps the newest features");
  assert.equal(small.errors.length, 3);
  assert.ok(JSON.stringify(small).length < 4000, `${JSON.stringify(small).length} characters`);
  assert.equal(buildContext(project, { workspace: "design", graph, detail: "large" }).features.length, 200);
});
