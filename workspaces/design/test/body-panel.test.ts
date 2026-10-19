// Regression (Ben, 2026-10-18): with three bodies, selecting Body 3 or
// Body 1 in the browser showed the last body's numbers and feature in the
// properties panel whatever was selected, because the panel always showed
// "the part" (the last solid feature) from before every body was drawn.
// The panel now describes the body the selection is on (`panelFocus`), and
// every place a body is called "Body n" uses the browser's number for it
// (`ShownBody.place`), even when a body before it failed to build.
// Regression (timeline bug hunt 2026-10-19, finding 5): a feature that
// failed still had a Body row; selecting it selected a body that did not
// exist, and the panel described another body's feature and volume. Now a
// failed feature has no Body row, its Timeline row selects nothing, and a
// selected body that did not build is described as having no body.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { BodyView, DisplayMesh, Feature } from "@fission/core";
import { bodyRows, browserTree, rowReference } from "../src/browser.ts";
import type { DesignDocument } from "../src/document.ts";
import { nameBody } from "../src/naming.ts";
import { bodyReference, designReference, profileReference } from "../src/references.ts";
import { joinBodies, type ShownBody } from "../src/scene.ts";
import { highlightOf, panelFocus, selectionRows } from "../src/selection.ts";
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

// The design those three bodies come from, written out by hand: three
// presets standing in for the cylinder and the two extrudes (the panel and
// the rows only read ids, order and whether each builds), feature-99
// suppressed between them, so it builds nothing and has no row at all.
const solid = (id: string, summary: string, suppressed = false): Feature => ({
  id,
  intent: { type: "box", parameters: {}, summary },
  provenance: { self: { workspace: "design", id, label: id }, from: [] },
  dependsOn: [],
  suppressed,
});
const doc: DesignDocument = {
  version: 3,
  nextId: 100,
  sketches: [],
  profiles: [],
  timeline: { features: [solid("feature-1", "Cylinder"), solid("feature-5", "Extrude 1"), solid("feature-99", "Box", true), solid("feature-12", "Extrude 2")] },
} as DesignDocument;
const featureOf = (id: string) => doc.timeline.features.find((f) => f.id === id)!;
/** The panel's focus as [feature id, body place or null], for comparing. */
const focusOf = (items: Parameters<typeof panelFocus>[0], s: typeof scene | null) => ((f) => f && [f.feature.id, f.body?.place ?? null])(panelFocus(items, s, doc));

test("the panel describes the selected body, not always the last one", () => {
  // Body 1 selected: the big cylinder's 8000π, not the last body's.
  assert.equal(panelFocus([bodyReference("feature-1")], scene, doc)?.body?.view.volume, 8000 * Math.PI);
  assert.equal(panelFocus([bodyReference("feature-1")], scene, doc)?.feature, featureOf("feature-1"));
  assert.equal(panelFocus([bodyReference("feature-5")], scene, doc)?.body?.place, 2);
  assert.equal(panelFocus([bodyReference("feature-12")], scene, doc)?.body?.view.volume, 3600);
  // A face or an edge selected: the body it is on (the small cylinder's top, the block's edge 0).
  assert.deepEqual(focusOf([designReference("face", small.names, 1)!], scene), ["feature-5", 2]);
  assert.deepEqual(focusOf([designReference("edge", block.names, 0)!], scene), ["feature-12", 3]);
  // Several selected: the newest item's body (Body 1 then the small top → Body 2; the other way → Body 1).
  assert.deepEqual(focusOf([bodyReference("feature-1"), designReference("face", small.names, 1)!], scene), ["feature-5", 2]);
  assert.deepEqual(focusOf([designReference("face", small.names, 1)!, bodyReference("feature-1")], scene), ["feature-1", 1]);
  // A feature the design no longer has, or a profile, after it: passed over, the newest item naming one of its features counts.
  assert.deepEqual(focusOf([bodyReference("feature-5"), bodyReference("feature-404"), profileReference("profile-1")], scene), ["feature-5", 2]);
});

test("with nothing naming a feature selected, the panel describes the part, as before", () => {
  // The part is the last solid feature that builds: feature-12, Body 3.
  assert.deepEqual(focusOf([], scene), ["feature-12", 3]);
  assert.deepEqual(focusOf([profileReference("profile-1")], scene), ["feature-12", 3]);
  assert.deepEqual(focusOf([bodyReference("feature-404")], scene), ["feature-12", 3]);
  // Before any rebuild has drawn it: the part, with no body yet.
  assert.deepEqual(focusOf([], null), ["feature-12", null]);
  // Nothing builds (every solid suppressed): nothing to describe.
  const none = { ...doc, timeline: { features: doc.timeline.features.map((f) => ({ ...f, suppressed: true })) } };
  assert.equal(panelFocus([], scene, none), null);
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
    assert.equal(panelFocus(items, scene, doc)?.body, scene.bodies[b.place - 1]);
  }
});

test("a body is named by the browser's number for it, even when one before it did not build", () => {
  // Body 2 (feature-5) failed: the scene shows Body 1 and Body 3, so the block is the scene's second body but still Body 3.
  const gap = joinBodies([big, block]);
  assert.deepEqual(selectionRows([bodyReference("feature-12")], gap), [{ name: "Body 3", type: "solid", id: "body:feature-12" }]);
  assert.deepEqual(focusOf([bodyReference("feature-12")], gap), ["feature-12", 3]);
  assert.deepEqual(focusOf([], gap), ["feature-12", 3]);
  assert.deepEqual(highlightOf([bodyReference("feature-12")], gap).faces, [3, 4, 5, 6, 7, 8]);
});

test("finding 5: a feature that failed has no Body row, and its Timeline row selects nothing", () => {
  // Built: feature-1, feature-5, feature-12 are Body 1, 2 and 3 (feature-99 is suppressed, so it never counts).
  const rows = (failed: string[]) => bodyRows(doc, new Set(failed)).map((r) => [r.id, r.label, r.feature.id]);
  assert.deepEqual(rows([]), [
    ["body-1", "Body 1", "feature-1"],
    ["body-2", "Body 2", "feature-5"],
    ["body-3", "Body 3", "feature-12"],
  ]);
  // feature-5 failed: no Body 2; Body 3 keeps its number (the panel and the selection list call it Body 3 too).
  assert.deepEqual(rows(["feature-5"]), [
    ["body-1", "Body 1", "feature-1"],
    ["body-3", "Body 3", "feature-12"],
  ]);
  // The first and the last failed: Body 2 alone.
  assert.deepEqual(rows(["feature-1", "feature-12"]), [["body-2", "Body 2", "feature-5"]]);
  // The browser's Bodies group is these rows.
  const group = (failed: string[]) => browserTree(doc, new Set(failed)).find((g) => g.id === "bodies")!.children!.map((n) => n.label);
  assert.deepEqual(group(["feature-5"]), ["Body 1", "Body 3"]);
  // The rows a failed feature had select nothing: its Body row's id and its Timeline row.
  const failed = new Set(["feature-5"]);
  assert.equal(rowReference("body-2", doc, failed), null);
  assert.equal(rowReference("feature-5", doc, failed), null);
  // The others still select their own bodies, Body 3's row by its own number.
  assert.equal(rowReference("body-3", doc, failed)?.id, "body:feature-12");
  assert.equal(rowReference("feature-12", doc, failed)?.id, "body:feature-12");
  assert.equal(rowReference("body-1", doc, failed)?.id, "body:feature-1");
  // Before the fix: every feature that builds in the data had a row, the failed one included.
  assert.equal(rowReference("body-2", doc)?.id, "body:feature-5");
});

test("finding 5: a selected body that did not build is described as having none, never by another body", () => {
  // The bug hunt's case: the box (Body 1) failed, Extrude 1 (Body 2) built; Body 1 selected.
  // Before the fix the panel described the last body shown, Extrude 1, with its 1,000 mm³.
  const onlySecond = joinBodies([small]);
  assert.deepEqual(focusOf([bodyReference("feature-1")], onlySecond), ["feature-1", null]);
  // A face of it, kept in the selection from before it failed: the same.
  assert.deepEqual(focusOf([designReference("face", big.names, 0)!], onlySecond), ["feature-1", null]);
  // Selected after a body that is shown: the newest item counts, even when it has no body.
  assert.deepEqual(focusOf([bodyReference("feature-5"), bodyReference("feature-1")], onlySecond), ["feature-1", null]);
  assert.deepEqual(focusOf([bodyReference("feature-1"), bodyReference("feature-5")], onlySecond), ["feature-5", 2]);
  // The part failed (feature-12 has no body shown): with nothing selected the panel describes the part, with no body, not Body 2.
  assert.deepEqual(focusOf([], onlySecond), ["feature-12", null]);
  // And the selection list says the failed body is not on the current bodies.
  assert.deepEqual(selectionRows([bodyReference("feature-1")], onlySecond), [{ name: "Body", type: "not on the current body", id: "body:feature-1" }]);
});
