import { test } from "node:test";
import assert from "node:assert/strict";
import type { BodyView, GeometryReference, StableId } from "@fission/core";
import { nameBody } from "../src/naming.ts";
import { bodyReference, designReference, readDesignReference, resolveReference } from "../src/references.ts";
import { BOX_VIEW } from "./views.ts";

const names = nameBody("feature-1", BOX_VIEW, () => null);

test("references for a body, a face and an edge of feature #1, by name", () => {
  // The box's faces in kernel order are bottom, top, front, back, left,
  // right (primitives.rs); edge 4 is the top front edge (views.ts), where
  // the front and the top meet: "front" sorts before "top".
  assert.deepEqual(bodyReference("feature-1"), { kind: "body", id: "body:feature-1" });
  assert.deepEqual(designReference("face", names, 1), { kind: "face", id: "face:feature-1/top" });
  assert.deepEqual(designReference("edge", names, 4), { kind: "edge", id: "edge:feature-1/front+top" });
});

test("a reference resolves to the index its name has on a body, wherever the kernel put it, and to nothing when it is gone", () => {
  const top = designReference("face", names, 1)!;
  assert.equal(resolveReference(top, names), 1);
  // The same box with its faces listed the other way round: the top is now index 4.
  const reversed = { ...BOX_VIEW, face_roles: [...BOX_VIEW.face_roles].reverse(), edge_faces: BOX_VIEW.edge_faces.map((p) => p && ([5 - p[0], 5 - p[1]] as [number, number])) } as BodyView;
  const after = nameBody("feature-1", reversed, () => null);
  assert.equal(resolveReference(top, after), 4);
  assert.equal(resolveReference(designReference("edge", names, 4)!, after), 4);
  // A cylinder has a top but no front: the top resolves, the top front edge doesn't.
  const cylinder = nameBody("feature-1", { face_roles: [{ role: "bottom" }, { role: "top" }, { role: "side" }], edge_faces: [[2, 0], [1, 2]] } as BodyView, () => null);
  assert.equal(resolveReference(top, cylinder), 1);
  assert.equal(resolveReference(designReference("edge", names, 4)!, cylinder), null);
  // Another feature's face, a body, and no body built: nothing.
  assert.equal(resolveReference(top, nameBody("feature-2", BOX_VIEW, () => null)), null);
  assert.equal(resolveReference(bodyReference("feature-1"), names), null);
  assert.equal(resolveReference(top, null), null);
});

test("readDesignReference undoes the builders and refuses ids they did not build", () => {
  assert.deepEqual(readDesignReference(designReference("face", names, 1)!), { kind: "face", featureId: "feature-1", part: "top" });
  assert.deepEqual(readDesignReference(designReference("edge", names, 4)!), { kind: "edge", featureId: "feature-1", part: "front+top" });
  assert.deepEqual(readDesignReference(bodyReference("feature-1")), { kind: "body", featureId: "feature-1" });
  assert.deepEqual(readDesignReference({ kind: "face", id: "face:feature-7/side:line-4" as StableId }), { kind: "face", featureId: "feature-7", part: "side:line-4" });
  assert.deepEqual(readDesignReference({ kind: "edge", id: "edge:feature-7/side:line-4>side:arc-6" as StableId }), { kind: "edge", featureId: "feature-7", part: "side:line-4>side:arc-6" });
  const ref = (kind: GeometryReference["kind"], id: string) => ({ kind, id: id as StableId }) as GeometryReference;
  for (const bad of [
    ref("face", "edge:feature-1/front+top"), // kind and id disagree
    ref("face", "face:feature-1"), // no name
    ref("body", "body:feature-1/top"), // a body has none
    ref("face", "face:feature-1/front+top"), // an edge's name on a face
    ref("edge", "edge:feature-1/top"), // a face's name on an edge
    ref("face", "face:feature-1/3"), // the old placeholder ids
    ref("edge", "edge:feature-1/4"),
    ref("face", "face:feature-1/side:a:b"), // a curve id must be escaped
    ref("edge", "named-by-step-32"),
  ])
    assert.equal(readDesignReference(bad), null, bad.id);
});

test("bad input is refused, not turned into an id; an index with no name gives no reference", () => {
  assert.throws(() => designReference("face", names, -1), /needs a kernel index/);
  assert.throws(() => designReference("edge", names, 1.5), /needs a kernel index/);
  assert.throws(() => designReference("edge", names, Number.NaN), /needs a kernel index/);
  assert.throws(() => bodyReference(""), /invalid feature id/);
  // A ":" or "/" in the feature id would make "body:a/1" read as something else.
  assert.throws(() => bodyReference("a/1"), /invalid feature id/);
  // Past the body's faces, or a face the kernel gave no role: no reference, never a placeholder.
  assert.equal(designReference("face", names, 6), null);
  const unnamed = nameBody("feature-1", { ...BOX_VIEW, face_roles: [null, ...BOX_VIEW.face_roles.slice(1)] } as BodyView, () => null);
  assert.equal(designReference("face", unnamed, 0), null);
  assert.deepEqual(designReference("face", unnamed, 1), { kind: "face", id: "face:feature-1/top" });
});
