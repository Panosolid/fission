import { test } from "node:test";
import assert from "node:assert/strict";
import type { BodyView, GeometryReference, StableId } from "@fission/core";
import { designReference, readDesignReference } from "../src/references.ts";
import { droppedNote, highlightOf, NOT_ON_BODY, selectionRows, survivors } from "../src/selection.ts";

const face = (i: number, feature = "feature-1") => designReference("face", feature, i);
const edge = (i: number) => designReference("edge", "feature-1", i);
const body = designReference("body", "feature-1");

test("readDesignReference undoes designReference and refuses ids it did not build", () => {
  assert.deepEqual(readDesignReference(face(3)), { kind: "face", featureId: "feature-1", index: 3 });
  assert.deepEqual(readDesignReference(edge(0)), { kind: "edge", featureId: "feature-1", index: 0 });
  assert.deepEqual(readDesignReference(body), { kind: "body", featureId: "feature-1" });
  const ref = (kind: GeometryReference["kind"], id: string) => ({ kind, id: id as StableId }) as GeometryReference;
  for (const bad of [ref("face", "edge:feature-1/3"), ref("face", "face:feature-1"), ref("body", "body:feature-1/2"), ref("face", "face:feature-1/03"), ref("face", "face:feature-1/-1"), ref("edge", "named-by-step-32")])
    assert.equal(readDesignReference(bad), null, bad.id);
});

test("the highlight lists the selected faces and edges of the body on screen", () => {
  assert.deepEqual(highlightOf([], "feature-1"), { body: false, faces: [], edges: [] });
  assert.deepEqual(highlightOf([face(1), edge(4), face(2), edge(8)], "feature-1"), { body: false, faces: [1, 2], edges: [4, 8] });
  assert.deepEqual(highlightOf([body], "feature-1"), { body: true, faces: [], edges: [] });
  // Another feature's face (a body that is not on screen) draws nothing.
  assert.deepEqual(highlightOf([face(1, "feature-2")], "feature-1"), { body: false, faces: [], edges: [] });
});

test("properties rows give each item's name, type and placeholder id", () => {
  // A cylinder's view (primitives.rs): bottom cap, top cap, side; two rim circles.
  const view = { face_types: ["plane", "plane", "cylinder"], edge_types: ["circle", "circle"] } as BodyView;
  assert.deepEqual(selectionRows([face(2), edge(1), body], "feature-1", view), [
    { name: "Face 2", type: "cylinder", id: "face:feature-1/2" },
    { name: "Edge 1", type: "circle", id: "edge:feature-1/1" },
    { name: "Body 1", type: "solid", id: "body:feature-1" },
  ]);
  // Face 3 is past the cylinder's three faces; another feature's face is not on screen.
  assert.deepEqual(selectionRows([face(3), face(0, "feature-2")], "feature-1", view).map((r) => r.type), [NOT_ON_BODY, NOT_ON_BODY]);
  // Before anything built the type is not known yet.
  assert.deepEqual(selectionRows([face(0)], "feature-1", null)[0].type, "…");
});

// Topology of the kernel's primitives (primitives.rs): a box has 8 corners,
// 12 straight edges and 6 flat faces; a cylinder 2 vertices (one on each rim),
// 2 rim circles, and 3 faces (bottom cap, top cap, side).
const boxView = { vertices: 8, edges: 12, faces: 6, face_types: Array(6).fill("plane"), edge_types: Array(12).fill("line") } as BodyView;
const cylinderView = { vertices: 2, edges: 2, faces: 3, face_types: ["plane", "plane", "cylinder"], edge_types: ["circle", "circle"] } as BodyView;

test("a resize keeps the selected faces and edges; a change of shape drops them", () => {
  const items = [face(1), edge(4), body];
  // A wider box: same counts and types at every index, so all three stay.
  assert.deepEqual(survivors(items, "feature-1", boxView, { ...boxView, volume: 2 } as BodyView), { kept: items, dropped: [] });
  // Box to cylinder: face 1 is still a plane (the top cap) but the counts
  // changed, so it is not the same face; edge 4 is past the cylinder's two
  // edges. The body stays.
  assert.deepEqual(survivors(items, "feature-1", boxView, cylinderView), { kept: [body], dropped: [face(1), edge(4)] });
  // Same counts but a different type at the index: dropped (side face → plane).
  const swapped = { ...cylinderView, face_types: ["plane", "cylinder", "plane"] } as BodyView;
  assert.deepEqual(survivors([face(2), face(0)], "feature-1", cylinderView, swapped), { kept: [face(0)], dropped: [face(2)] });
});

test("with no earlier body only the index is checked; others' references are left alone", () => {
  // Back from another workspace: face 2 is on the cylinder, face 5 is not.
  assert.deepEqual(survivors([face(2), face(5)], "feature-1", null, cylinderView), { kept: [face(2)], dropped: [face(5)] });
  // Another feature's face, and an id Design did not build, are not Design's to drop here.
  const foreign = { kind: "face", id: "named-by-step-32" as StableId } as GeometryReference;
  assert.deepEqual(survivors([face(9, "feature-2"), foreign], "feature-1", boxView, cylinderView).dropped, []);
});

test("the note names what was dropped, and is empty when nothing was", () => {
  assert.equal(droppedNote([]), "");
  assert.match(droppedNote([face(1), edge(4)]), /^Taken out of the selection: Face 1, Edge 4\. /);
});
