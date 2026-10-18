// Regression (Ben, 2026-10-18): with three bodies, selecting Body 3 or
// Body 1 in the browser showed the last body's numbers and feature in the
// properties panel whatever was selected, because the panel always showed
// "the part" (the last solid feature) from before every body was drawn.
// The panel now describes the body the selection is on (`panelBody`), and
// every place a body is called "Body n" uses the browser's number for it
// (`ShownBody.place`), even when a body before it failed to build.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { BodyView, DisplayMesh } from "@fission/core";
import { nameBody } from "../src/naming.ts";
import { bodyReference, designReference, profileReference } from "../src/references.ts";
import { joinBodies, type ShownBody } from "../src/scene.ts";
import { highlightOf, panelBody, selectionRows } from "../src/selection.ts";
import { BOX_VIEW, CYLINDER_VIEW } from "./views.ts";

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

const shown = (feature: string, place: number, view: BodyView, volume: number): ShownBody => {
  const v = { ...view, volume, mesh: meshFor(view.faces, view.edges) };
  return { feature, place, view: v, names: nameBody(feature, v, () => null) };
};

// Ben's design: the cylinder preset ⌀40 × 20 (feature-1): π · 20² · 20 =
// 8000π ≈ 25,132.74 mm³; Extrude 1, a circle of radius 4.2 by 30 (feature-5):
// π · 4.2² · 30 = 529.2π ≈ 1,662.53 mm³, the number the panel showed;
// Extrude 2, a 12 × 10 rectangle by 30 (feature-12): 12 · 10 · 30 = 3600 mm³.
const big = shown("feature-1", 1, CYLINDER_VIEW, 8000 * Math.PI);
const small = shown("feature-5", 2, CYLINDER_VIEW, 529.2 * Math.PI);
const block = shown("feature-12", 3, BOX_VIEW, 3600);
const scene = joinBodies([big, small, block]);

test("the panel describes the selected body, not always the last one", () => {
  // Body 1 selected: the big cylinder's 8000π, not the last body's.
  assert.equal(panelBody([bodyReference("feature-1")], scene)?.view.volume, 8000 * Math.PI);
  assert.equal(panelBody([bodyReference("feature-1")], scene)?.feature, "feature-1");
  assert.equal(panelBody([bodyReference("feature-5")], scene)?.place, 2);
  assert.equal(panelBody([bodyReference("feature-12")], scene)?.view.volume, 3600);
  // A face or an edge selected: the body it is on (the small cylinder's top, the block's edge 0).
  assert.equal(panelBody([designReference("face", small.names, 1)!], scene)?.feature, "feature-5");
  assert.equal(panelBody([designReference("edge", block.names, 0)!], scene)?.feature, "feature-12");
  // Several selected: the newest item's body (Body 1 then the small top → Body 2; the other way → Body 1).
  assert.equal(panelBody([bodyReference("feature-1"), designReference("face", small.names, 1)!], scene)?.place, 2);
  assert.equal(panelBody([designReference("face", small.names, 1)!, bodyReference("feature-1")], scene)?.place, 1);
  // A body not shown or a profile after it: still the newest item that is on a shown body.
  assert.equal(panelBody([bodyReference("feature-5"), bodyReference("feature-99"), profileReference("profile-1")], scene)?.place, 2);
});

test("with nothing on a shown body selected, the panel describes the last body, as before", () => {
  assert.equal(panelBody([], scene)?.place, 3);
  assert.equal(panelBody([profileReference("profile-1")], scene)?.place, 3);
  assert.equal(panelBody([bodyReference("feature-99")], scene)?.place, 3);
  assert.equal(panelBody([], null), null);
  assert.equal(panelBody([bodyReference("feature-1")], joinBodies([])), null);
});

test("the selection, the highlight and the panel agree on each body", () => {
  // Faces: the big cylinder 0-2, the small one 3-5, the block 6-11.
  for (const [b, faces] of [
    [big, [0, 1, 2]],
    [small, [3, 4, 5]],
    [block, [6, 7, 8, 9, 10, 11]],
  ] as const) {
    const items = [bodyReference(b.feature)];
    assert.deepEqual(highlightOf(items, scene).faces, faces);
    assert.equal(selectionRows(items, scene)[0].name, `Body ${b.place}`);
    assert.equal(panelBody(items, scene), scene.bodies[b.place - 1]);
  }
});

test("a body is named by the browser's number for it, even when one before it did not build", () => {
  // Body 2 (feature-5) failed: the scene shows Body 1 and Body 3, so the block is the scene's second body but still Body 3.
  const gap = joinBodies([big, block]);
  assert.deepEqual(selectionRows([bodyReference("feature-12")], gap), [{ name: "Body 3", type: "solid", id: "body:feature-12" }]);
  assert.equal(panelBody([bodyReference("feature-12")], gap)?.place, 3);
  assert.equal(panelBody([], gap)?.place, 3);
  assert.deepEqual(highlightOf([bodyReference("feature-12")], gap).faces, [3, 4, 5, 6, 7, 8]);
});
