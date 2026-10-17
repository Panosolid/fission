import { test } from "node:test";
import assert from "node:assert/strict";
import type { BodySpec, BodyView, Outline } from "@fission/core";
import { lastFeature, partDocument } from "../src/document.ts";
import { extrudeSketch } from "../src/extrude.ts";
import { featureNames, nameBody, outlineCurves } from "../src/naming.ts";
import { addSketch, drawRectangle } from "../src/sketch.ts";
import { BOX_VIEW, CYLINDER_VIEW } from "./views.ts";

const side = (piece: number, boundary = 0) => ({ role: "side" as const, boundary, piece });

/**
 * A rectangle's extrude as the kernel gives it (extrude.rs): faces start,
 * end, then the side of each piece; for each piece k its edge in the start
 * cap (walked forwards by the side), then in the end cap (forwards by the
 * end cap), then the upright at corner k, walked forwards by the side
 * before it and backwards by side k.
 */
function extrudeView(pieces: number): BodyView {
  const face_roles = [{ role: "start" as const }, { role: "end" as const }, ...Array.from({ length: pieces }, (_, k) => side(k))];
  const edge_faces: [number, number][] = [];
  for (let k = 0; k < pieces; k++) edge_faces.push([2 + k, 0], [1, 2 + k]);
  for (let k = 0; k < pieces; k++) edge_faces.push([2 + ((k + pieces - 1) % pieces), 2 + k]);
  return { face_roles, edge_faces, face_types: [], edge_types: [] } as unknown as BodyView;
}

test("a box: six faces by direction, twelve edges by the two faces they join", () => {
  const n = nameBody("feature-1", BOX_VIEW, () => null);
  assert.deepEqual(n.faces, ["bottom", "top", "front", "back", "left", "right"]);
  // Edge k's faces from views.ts, each pair a set written in alphabetical order.
  assert.deepEqual(n.edges, [
    "bottom+left",
    "back+bottom",
    "bottom+right",
    "bottom+front",
    "front+top",
    "right+top",
    "back+top",
    "left+top",
    "front+right",
    "front+left",
    "back+left",
    "back+right",
  ]);
  assert.equal(n.feature, "feature-1");
  // A cylinder: the rims, bottom with the side and the side with the top.
  assert.deepEqual(nameBody("feature-1", CYLINDER_VIEW, () => null).edges, ["bottom+side", "side+top"]);
});

test("an extrude's sides are named by the sketch curve each piece came from, and the uprights in order round the outline", () => {
  // Pieces 0-3 came from line-5, line-3, line-6, line-4 (the kernel walked the sketch from line-5).
  const curves = ["line-5", "line-3", "line-6", "line-4"];
  const n = nameBody("feature-9", extrudeView(4), (b, p) => (b === 0 ? curves[p] : null));
  assert.deepEqual(n.faces, ["start", "end", "side:line-5", "side:line-3", "side:line-6", "side:line-4"]);
  // Piece 0's edges: in the start cap "side:line-5+start" (sorted: "side…" < "start"), in the end cap "end+side:line-5".
  assert.deepEqual(n.edges.slice(0, 2), ["side:line-5+start", "end+side:line-5"]);
  // The upright at corner 1 comes after piece 0 and before piece 1; at corner 0 after piece 3 (the last), before piece 0.
  assert.deepEqual(n.edges.slice(8), ["side:line-4>side:line-5", "side:line-5>side:line-3", "side:line-3>side:line-6", "side:line-6>side:line-4"]);
});

test("a half disc: its line and arc meet at both corners, and the order tells the two uprights apart", () => {
  const n = nameBody("feature-2", extrudeView(2), (_, p) => ["line-1", "arc-2"][p]);
  // Corner 0 (the line's start): after the arc, before the line; corner 1: after the line, before the arc.
  assert.deepEqual(n.edges.slice(4), ["side:arc-2>side:line-1", "side:line-1>side:arc-2"]);
  assert.equal(new Set(n.edges).size, 6);
});

test("nothing gets a name it would share or can't be told: two faces alike, a side with no curve, an edge with no pair", () => {
  // Broken on purpose: the box's left face given the role "right" too. Both
  // lose their names, and so does every edge on either.
  const roles = [...BOX_VIEW.face_roles];
  roles[4] = { role: "right" };
  const n = nameBody("feature-1", { ...BOX_VIEW, face_roles: roles } as BodyView, () => null);
  assert.deepEqual(n.faces, ["bottom", "top", "front", "back", null, null]);
  // Edges 0, 2, 5, 7, 8, 9, 10, 11 touch the left or the right face.
  assert.deepEqual(n.edges, [null, "back+bottom", null, "bottom+front", "front+top", null, "back+top", null, null, null, null, null]);
  // A side whose curve isn't known, and an edge the kernel gives no pair (only in an invalid body).
  const m = nameBody("feature-9", { ...extrudeView(4), edge_faces: [null, ...extrudeView(4).edge_faces.slice(1)] } as BodyView, (_, p) => (p === 2 ? null : `line-${p}`));
  assert.equal(m.faces[4], null);
  assert.equal(m.edges[0], null);
  assert.equal(m.edges[4], null); // piece 2's start-cap edge
  assert.equal(m.edges[2], "side:line-1+start");
  // Two edges alike: the same two faces given to two edges in the same order.
  const twice = { ...BOX_VIEW, edge_faces: [[0, 4], [0, 4], ...BOX_VIEW.edge_faces.slice(2)] } as BodyView;
  assert.deepEqual(nameBody("feature-1", twice, () => null).edges.slice(0, 3), [null, null, "bottom+right"]);
});

test("ids are escaped, so one holding : / + or > can never read as another name", () => {
  const n = nameBody("f/1", extrudeView(3), (_, p) => ["a:b", "c+d", "e>f"][p]);
  assert.equal(n.feature, "f%2F1");
  assert.deepEqual(n.faces.slice(2), ["side:a%3Ab", "side:c%2Bd", "side:e%3Ef"]);
  assert.equal(n.edges[7], "side:a%3Ab>side:c%2Bd");
  // The counter's own ids are unchanged.
  assert.equal(nameBody("feature-1", BOX_VIEW, () => null).faces[0], "bottom");
});

test("outlineCurves: a sketch's pieces by the curve ids of each kind, a ready-made profile's by number", () => {
  // sketch_outline's pieces index each kind's list as given: piece 0 is the second line, piece 1 the first arc.
  const sketched: Outline = { outer: { path: { corners: [], bulges: [] } }, holes: [], pieces: [{ curve: "line", index: 1, reversed: true }, { curve: "arc", index: 0, reversed: false }] };
  const of = outlineCurves(sketched, { line: ["line-3", "line-7"], arc: ["arc-9"], circle: [] });
  assert.deepEqual([of(0, 0), of(0, 1), of(0, 2), of(1, 0)], ["line-7", "arc-9", null, null]);
  // Without the sketch's curves there are no names to give.
  assert.equal(outlineCurves(sketched)(0, 0), null);
  // A ready-made outline (no pieces): numbered as the profile gives them; a hole's with its loop.
  const plate: Outline = { outer: { path: { corners: [], bulges: [] } }, holes: [] };
  assert.deepEqual([outlineCurves(plate)(0, 3), outlineCurves(plate)(2, 0)], ["piece-3", "hole-2-piece-0"]);
});

test("featureNames: a box by role alone; a sketch's extrude by the sketch's own curve ids", () => {
  const box = partDocument("box", 40, 30, 20);
  assert.deepEqual(featureNames(box, lastFeature(box), { box: { width: 40, depth: 30, height: 20 } }, BOX_VIEW).faces[1], "top");
  // A rectangle: drawRectangle's four lines, (0, 0) → (40, 0) first, then on round.
  let doc = partDocument("box", 40, 30, 20);
  const sketch = addSketch(doc);
  const rect = drawRectangle(sketch.doc, sketch.id, [0, 0], [40, 30]);
  const extruded = extrudeSketch(rect.doc, sketch.id, 10);
  doc = extruded.doc;
  const lines = doc.sketches[0].curves.map((c) => c.id);
  assert.equal(lines.length, 4);
  // The kernel walked it from the third line: pieces are lines 2, 3, 0, 1.
  const profile: Outline = { outer: { path: { corners: [], bulges: [] } }, holes: [], pieces: [2, 3, 0, 1].map((index) => ({ curve: "line" as const, index, reversed: false })) };
  const spec: BodySpec = { extrude: { profile, distance: 10 } };
  const n = featureNames(doc, lastFeature(doc), spec, extrudeView(4));
  assert.equal(n.feature, extruded.id);
  assert.deepEqual(n.faces.slice(2), [2, 3, 0, 1].map((k) => `side:${lines[k]}`));
});
