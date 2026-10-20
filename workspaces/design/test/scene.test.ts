import { test } from "node:test";
import assert from "node:assert/strict";
import type { BodyView, DisplayMesh } from "@fission/core";
import { nameBody } from "../src/naming.ts";
import { bodyReference, designReference } from "../src/references.ts";
import { joinBodies, resolveInScene, sceneHit, sceneReference, type ShownBody } from "../src/scene.ts";
import { highlightOf, NOT_ON_BODY, selectionRows, survivors } from "../src/selection.ts";
import { pickChange } from "../src/picking.ts";
import { BOX_VIEW, CYLINDER_VIEW } from "./views.ts";

/** A display mesh with one triangle per face (three points of its own) and one line per edge, the way the kernel lays them out. */
function meshFor(faces: number, edges: number): DisplayMesh {
  const mesh: DisplayMesh = { positions: [], normals: [], indices: [], triangle_faces: [], edge_lines: [], edge_line_edges: [] };
  for (let f = 0; f < faces; f++) {
    mesh.positions.push(f, 0, 0, f, 1, 0, f, 0, 1);
    mesh.normals.push(1, 0, 0, 1, 0, 0, 1, 0, 0);
    mesh.indices.push(3 * f, 3 * f + 1, 3 * f + 2);
    mesh.triangle_faces.push(f);
  }
  for (let e = 0; e < edges; e++) {
    mesh.edge_lines.push(e, 0, 0, e, 1, 1);
    mesh.edge_line_edges.push(e);
  }
  return mesh;
}

const shown = (feature: string, view: BodyView, place = 1): ShownBody => {
  const v = { ...view, mesh: meshFor(view.faces, view.edges) };
  return { feature, place, view: v, names: nameBody(feature, v, () => null) };
};
// A box (6 faces, 12 edges) built by feature-1, then a cylinder (3 faces, 2 edges) by feature-4.
const box = shown("feature-1", BOX_VIEW);
const cylinder = shown("feature-4", CYLINDER_VIEW, 2);
const scene = joinBodies([box, cylinder]);

test("two bodies joined: the second's points, faces and edges come after the first's", () => {
  // The box has 6 faces × 3 points = 18 points, so the cylinder's first
  // triangle (its points 0, 1, 2) becomes 18, 19, 20 on face 6 (its face 0
  // after the box's 6); its first line is on edge 12 (after the box's 12).
  assert.deepEqual(scene.faceStart, [0, 6]);
  assert.deepEqual(scene.edgeStart, [0, 12]);
  assert.equal(scene.mesh.positions.length, (18 + 9) * 3);
  assert.deepEqual(scene.mesh.indices.slice(18, 21), [18, 19, 20]);
  assert.deepEqual(scene.mesh.triangle_faces, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(scene.mesh.edge_line_edges.slice(11), [11, 12, 13]);
  // Points and lines are copied as they are: the cylinder's face 0 starts at (0, 0, 0) again.
  assert.deepEqual(scene.mesh.positions.slice(54, 57), [0, 0, 0]);
  assert.equal(scene.mesh.edge_lines.length, (12 + 2) * 6);
  // One body joined alone is its own mesh.
  assert.deepEqual(joinBodies([box]).mesh, box.view.mesh);
  assert.deepEqual(joinBodies([]).mesh.indices, []);
});

test("a joined index maps back to its body and the kernel's index there, and to its name", () => {
  assert.deepEqual(sceneHit(scene, "face", 5), { body: 0, index: 5 });
  assert.deepEqual(sceneHit(scene, "face", 6), { body: 1, index: 0 });
  assert.deepEqual(sceneHit(scene, "edge", 13), { body: 1, index: 1 });
  assert.equal(sceneHit(scene, "face", 9), null); // past the last body
  assert.throws(() => sceneHit(scene, "face", -1), /kernel index/);
  assert.throws(() => sceneHit(scene, "edge", 1.5), /kernel index/);
  // The cylinder's top is its kernel face 1, joined 7: "face:feature-4/top"; the box's top is face 1.
  assert.equal(sceneReference("face", scene, 7)?.id, "face:feature-4/top");
  assert.equal(sceneReference("face", scene, 1)?.id, "face:feature-1/top");
  assert.deepEqual(pickChange({ face: 7, shift: false }, scene), { change: "set", item: { kind: "face", id: "face:feature-4/top" } });
  // Every named face and edge of either body goes there and back.
  for (const kind of ["face", "edge"] as const) {
    const total = kind === "face" ? 9 : 14;
    for (let i = 0; i < total; i++) {
      const ref = sceneReference(kind, scene, i);
      if (ref) assert.equal(resolveInScene(ref, scene), i, `${kind} ${i}`);
    }
  }
  // A name on a body not shown resolves to nothing.
  assert.equal(resolveInScene(designReference("face", nameBody("feature-9", BOX_VIEW, () => null), 1)!, scene), null);
});

test("selecting the second body tints its faces only; both is the whole highlight", () => {
  const second = bodyReference("feature-4");
  assert.deepEqual(highlightOf([second], scene), { body: false, faces: [6, 7, 8], edges: [] });
  assert.deepEqual(highlightOf([second, bodyReference("feature-1")], scene), { body: true, faces: [], edges: [] });
  // The cylinder's top and the box's top front edge (kernel edge 4), in joined numbers.
  const top = sceneReference("face", scene, 7)!;
  const edge = designReference("edge", box.names, 4)!;
  assert.deepEqual(highlightOf([top, edge], scene), { body: false, faces: [7], edges: [4] });
  // A face already tinted as part of its body is listed once.
  assert.deepEqual(highlightOf([top, second], scene).faces, [7, 6, 8]);
  // Rows name each body by its place in build order.
  assert.deepEqual(selectionRows([second, top, bodyReference("feature-2")], scene), [
    { name: "Body 2", type: "solid", id: "body:feature-4" },
    { name: "Top face", type: "plane", id: "face:feature-4/top" },
    { name: "Body", type: NOT_ON_BODY, id: "body:feature-2" },
  ]);
});

test("a rebuild drops a face only from the body it was on", () => {
  // The box (feature-1) became a cylinder, which has no front; the second body is untouched.
  const front = designReference("face", box.names, 2)!;
  const cylTop = sceneReference("face", scene, 7)!;
  const after = joinBodies([shown("feature-1", CYLINDER_VIEW), cylinder]);
  assert.deepEqual(survivors([front, cylTop], after), { kept: [cylTop], dropped: [front], shared: [] });
  // With feature-4's body gone from the scene (suppressed, say), its face is left alone, not dropped.
  assert.deepEqual(survivors([cylTop], joinBodies([box])), { kept: [cylTop], dropped: [], shared: [] });
});

test("a display mesh that disagrees with its body is refused, each way", () => {
  const broken = (change: (m: DisplayMesh) => void) => {
    const b = shown("feature-1", BOX_VIEW);
    change(b.view.mesh);
    return () => joinBodies([cylinder, b]);
  };
  assert.throws(broken((m) => m.normals.pop()), /points and normals disagree/);
  assert.throws(broken((m) => m.triangle_faces.pop()), /lists disagree in length/);
  assert.throws(broken((m) => m.edge_line_edges.pop()), /lists disagree in length/);
  assert.throws(broken((m) => (m.indices[0] = 18)), /triangle corner it has no point for/);
  assert.throws(broken((m) => (m.triangle_faces[0] = 6)), /triangle on a face it does not have/);
  assert.throws(broken((m) => (m.edge_line_edges[0] = 12)), /line on an edge it does not have/);
  assert.throws(broken((m) => (m.edge_line_edges[0] = -1)), /line on an edge it does not have/);
  // The boundary itself is fine: the last point, face and edge.
  assert.doesNotThrow(broken((m) => ((m.indices[0] = 17), (m.triangle_faces[0] = 5), (m.edge_line_edges[0] = 11))));
});
