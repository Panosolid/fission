import { test } from "node:test";
import assert from "node:assert/strict";
import type { BodyView, GeometryReference, StableId } from "@fission/core";
import { designReference, readDesignReference } from "../src/references.ts";
import { highlightOf, NOT_ON_BODY, selectionRows } from "../src/selection.ts";

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
