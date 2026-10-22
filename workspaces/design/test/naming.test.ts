import { test } from "node:test";
import assert from "node:assert/strict";
import type { BodySpec, BodyView, KernelCalls, Outline } from "@fission/core";
import { lastFeature, partDocument, type DesignDocument } from "../src/document.ts";
import { extrudeSketch, featureBuild } from "../src/extrude.ts";
import { featureNames, nameBody, outlineCurves, pieceWays, twiceArea } from "../src/naming.ts";
import { addSketch, deleteCurve, drawRectangle } from "../src/sketch.ts";
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
  assert.deepEqual(featureNames(lastFeature(box).id, { spec: { box: { width: 40, depth: 30, height: 20 } } }, BOX_VIEW).faces[1], "top");
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
  const n = featureNames(lastFeature(doc).id, { spec, curves: { line: lines, arc: [], circle: [] } }, extrudeView(4));
  assert.equal(n.feature, extruded.id);
  assert.deepEqual(n.faces.slice(2), [2, 3, 0, 1].map((k) => `side:${lines[k]}`));
});

test("regression (hunt 2026-10-21): an extrude built from its kept shape names its sides by the kept curves, not by what its sketch holds now", async () => {
  const sketch = addSketch(partDocument("box", 40, 30, 20));
  const rect = drawRectangle(sketch.doc, sketch.id, [0, 0], [40, 30]);
  const extruded = extrudeSketch(rect.doc, sketch.id, 10);
  const lines = extruded.doc.sketches[0].curves.map((c) => c.id);
  // The first side deleted: the sketch makes no outline, so the extrude builds from its kept shape, the four lines it had.
  const old = extruded.doc.sketches[0];
  const doc: DesignDocument = { ...deleteCurve(extruded.doc, sketch.id, lines[0]), kept: { [extruded.id]: { points: old.points, curves: old.curves } } };
  const profile: Outline = { outer: { path: { corners: [], bulges: [] } }, holes: [], pieces: [0, 1, 2, 3].map((index) => ({ curve: "line" as const, index, reversed: false })) };
  // A stand-in kernel: the sketch's three lines now make no outline; the kept four make the rectangle.
  const kernel = { call: async (op: string, l: unknown[]) => (op === "sketch_outline" ? (l.length === 4 ? { closed: profile } : { open: "2 ends meet nothing" }) : null) } as unknown as KernelCalls;
  const built = await featureBuild(kernel, doc, lastFeature(doc));
  assert.deepEqual(built.curves?.line, lines, "the build names the kept shape's curves");
  const n = featureNames(lastFeature(doc).id, built, extrudeView(4));
  // Piece k is the kept shape's line k, so the sides are lines 0..3 as drawn; the sketch's three lines now would name piece 0 by line 1.
  assert.deepEqual(n.faces.slice(2), lines.map((id) => `side:${id}`));
});

test("27b, hand-worked: twiceArea is twice the signed area a loop of corners and bulges encloses", () => {
  // The square (0, 0), (2, 0), (2, 2), (0, 2) counter-clockwise: area 4, so 8; clockwise −8.
  assert.equal(twiceArea({ corners: [0, 0, 2, 0, 2, 2, 0, 2], bulges: [] }), 8);
  assert.equal(twiceArea({ corners: [0, 2, 2, 2, 2, 0, 0, 0], bulges: [] }), -8);
  // A half disc of radius 5: the line (−5, 0) → (5, 0), then the arc on to (−5, 0) with bulge tan(π/4) = 1 (half a turn).
  // Shoelace: (−5)(0) − (5)(0) + (5)(0) − (−5)(0) = 0. The arc: c = 10, r = 10 (1 + 1) / 4 = 5, σ = 4 atan(1) = π, so
  // r² (σ − sin σ) = 25π: twice the half disc's area, 12.5π.
  assert.ok(Math.abs(twiceArea({ corners: [-5, 0, 5, 0], bulges: [0, 1] }) - 25 * Math.PI) < 1e-12);
  // The arc the other way (bulge −1, under the line): −25π.
  assert.ok(Math.abs(twiceArea({ corners: [-5, 0, 5, 0], bulges: [0, -1] }) + 25 * Math.PI) < 1e-12);
  // Two corners' shoelace is a × b + b × a, and the two rounded products cancel exactly however awkward the numbers, so a
  // two-piece loop's sign is its arcs' alone (what naming.ts relies on): 0 to the bit with no arcs.
  assert.ok(Object.is(twiceArea({ corners: [1e5 + 0.1, 0.7, -3.3, 1e5 / 3], bulges: [] }), 0));
});

test("27b, hand-worked: a corner between two sides is named by the ends of their curves, read off the kernel's order put right", () => {
  // extrudeView(3): uprights at corner k are edges 6 + k, walked forwards by side k − 1 (the piece before) and backwards by side k.
  const three: Outline = { outer: { path: { corners: [0, 0, 4, 0, 0, 3], bulges: [] } }, holes: [], pieces: [0, 1, 2].map((index) => ({ curve: "line" as const, index, reversed: false })) };
  const curves = (_: number, p: number) => ["a", "b", "c"][p];
  const n = nameBody("f", extrudeView(3), curves, pieceWays(three, false));
  // Corner 0 is where line c (piece 2) ends and line a (piece 0) starts; corner 1 where a ends and b starts.
  assert.deepEqual(n.ends!.slice(6), ["side:a@start+side:c@end", "side:a@end+side:b@start", "side:b@end+side:c@start"]);
  assert.deepEqual(n.ends!.slice(0, 6), [null, null, null, null, null, null], "no ends for an edge on a cap");
  // The kernel turned the loop round (every upright's faces the other way): read off the body, the corners are the same.
  const turned = { ...extrudeView(3), edge_faces: extrudeView(3).edge_faces.map((p, e) => (e >= 6 ? ([p[1], p[0]] as [number, number]) : p)) } as BodyView;
  assert.deepEqual(nameBody("f", turned, curves, pieceWays(three, false)).ends!.slice(6), n.ends!.slice(6));
  // Every line run backwards: corner 0 is where c starts (run backwards it ends there) and a ends.
  const back: Outline = { ...three, pieces: three.pieces!.map((p) => ({ ...p, reversed: true })) };
  assert.deepEqual(nameBody("f", extrudeView(3), curves, pieceWays(back, false)).ends!.slice(6), ["side:a@end+side:c@start", "side:a@start+side:b@end", "side:b@start+side:c@end"]);
  // No ways (a ready-made profile, or none given): no ends.
  assert.equal(nameBody("f", extrudeView(3), curves).ends, undefined);
  assert.equal(pieceWays({ ...three, pieces: undefined }, false), undefined);

  // Two pieces, line L then arc A over it counter-clockwise (twice the area 25π > 0): extrudeView(2)'s upright at corner 0
  // (edge 4) is walked forwards by side 1, A, ending there, and backwards by side 0, L, starting there; corner 1 (edge 5) the other
  // way. The body can't say which order is the outline's (each pair meets at both corners), so the area and Flip do.
  const half: Outline = { outer: { path: { corners: [-5, 0, 5, 0], bulges: [0, 1] } }, holes: [], pieces: [{ curve: "line", index: 0, reversed: false }, { curve: "arc", index: 0, reversed: false }] };
  const two = (_: number, p: number) => ["L", "A"][p];
  assert.deepEqual(nameBody("f", extrudeView(2), two, pieceWays(half, false)).ends!.slice(4), ["side:A@end+side:L@start", "side:A@start+side:L@end"]);
  // Flipped, the kernel builds from the outline mirrored and turns it round: the same order on the body reads the other way.
  assert.deepEqual(nameBody("f", extrudeView(2), two, pieceWays(half, true)).ends!.slice(4), ["side:A@start+side:L@end", "side:A@end+side:L@start"]);
});
