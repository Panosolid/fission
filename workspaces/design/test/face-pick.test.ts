// Step 26d: where Create sketch puts a new sketch (face-pick.ts), worked
// by hand on a 40 × 30 × 20 box and a cylinder of radius 5 and height 10
// beside it; then seeded sessions against a plain model
// (face-pick-session.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import type { BodyView } from "@fission/core";
import { CURVED_FACE, sketchableFaces, sketchSpot, UNNAMED_FACE } from "../src/face-pick.ts";
import { nameBody } from "../src/naming.ts";
import { joinBodies } from "../src/scene.ts";
import { REAL, runFacePickSession } from "./face-pick-session.ts";
import { partDocument } from "../src/document.ts";
import { addFaceSketch, sketchSide } from "../src/sketch.ts";
import { DEFAULT_GRID, sketchDrawings, startTool } from "../src/sketch-tool.ts";
import { BOX_VIEW, CYLINDER_VIEW } from "./views.ts";

const empty = { positions: [], normals: [], indices: [], triangle_faces: [], edge_lines: [], edge_line_edges: [] };
// The box (0..40, 0..30, 0..20), faces in make_box's order: bottom, top, front (−Y), back, left (−X), right.
const box = {
  ...BOX_VIEW,
  mesh: empty,
  face_normals: [[0, 0, -1], [0, 0, 1], [0, -1, 0], [0, 1, 0], [-1, 0, 0], [1, 0, 0]],
  face_centroids: [[20, 15, 0], [20, 15, 20], [20, 0, 10], [20, 30, 10], [0, 15, 10], [40, 15, 10]],
} as BodyView;
// The cylinder round (60, 0) from z 0 to 10: bottom, top, and its round side (no plane, so no normal).
const cylinder = { ...CYLINDER_VIEW, mesh: empty, face_normals: [[0, 0, -1], [0, 0, 1], null], face_centroids: [[60, 0, 0], [60, 0, 10], [60, 0, 5]] } as BodyView;
const shown = (feature: string, view: BodyView, place: number) => ({ feature, place, view, names: nameBody(feature, view, () => null) });
// Joined: the box's faces are 0 to 5, the cylinder's 6 (bottom), 7 (top) and 8 (side).
const scene = joinBodies([shown("feature-1", box, 1), shown("feature-4", cylinder, 2)]);
const pick = (face: number | null, plane?: string | null) => ({ face, plane, edge: null, shift: false });

test("hand-worked: the box's top gets the ground plane's frame lifted to z = 20, facing up", () => {
  // Outward +Z is along XY's normal (|1| beats XZ's and YZ's 0): side +1, normal +Z, x +X turned by nothing;
  // the origin is the plane z = 20's nearest point to the world's origin, (0, 0, 20).
  assert.deepEqual(sketchSpot(pick(1), scene), {
    kind: "face",
    face: { plane: "face:feature-1/top", feature: "feature-1" },
    drawn: { plane: { origin: [0, 0, 20], xAxis: [1, 0, 0], normal: [0, 0, 1] }, side: 1 },
  });
});

test("hand-worked: the bottom and back faces keep the world's axes and face against the frame's normal (side −1)", () => {
  // Bottom: outward −Z; XY's normal +Z is the nearest (|−1|), against it, so side −1 and the normal stays +Z
  // (into the box): x is still +X, so the sketch's coordinates are the world's x and y; origin (0, 0, 0).
  assert.deepEqual(sketchSpot(pick(0), scene), { kind: "face", face: { plane: "face:feature-1/bottom", feature: "feature-1" }, drawn: { plane: { origin: [0, 0, 0], xAxis: [1, 0, 0], normal: [0, 0, 1] }, side: -1 } });
  // Back (y = 30): outward +Y against XZ's normal −Y: side −1, normal −Y, x +X; the origin is −Y × (point · −Y) = (0, 30, 0).
  assert.deepEqual(sketchSpot(pick(3), scene), { kind: "face", face: { plane: "face:feature-1/back", feature: "feature-1" }, drawn: { plane: { origin: [0, 30, 0], xAxis: [1, 0, 0], normal: [0, -1, 0] }, side: -1 } });
  // Left (x = 0): outward −X against YZ's normal +X: side −1, normal +X, x along +Y, origin (0, 0, 0).
  assert.deepEqual(sketchSpot(pick(4), scene), { kind: "face", face: { plane: "face:feature-1/left", feature: "feature-1" }, drawn: { plane: { origin: [0, 0, 0], xAxis: [0, 1, 0], normal: [1, 0, 0] }, side: -1 } });
});

test("hand-worked: the front and right faces are the front and side planes moved onto them, facing out (side +1)", () => {
  // Front (y = 0): outward −Y is XZ's normal: side +1, origin (0, 0, 0) (−0 written as 0).
  assert.deepEqual(sketchSpot(pick(2), scene), { kind: "face", face: { plane: "face:feature-1/front", feature: "feature-1" }, drawn: { plane: { origin: [0, 0, 0], xAxis: [1, 0, 0], normal: [0, -1, 0] }, side: 1 } });
  // Right (x = 40): outward +X is YZ's normal: side +1, x along +Y, origin (40, 0, 0).
  assert.deepEqual(sketchSpot(pick(5), scene), { kind: "face", face: { plane: "face:feature-1/right", feature: "feature-1" }, drawn: { plane: { origin: [40, 0, 0], xAxis: [0, 1, 0], normal: [1, 0, 0] }, side: 1 } });
});

test("hand-worked: the second body's faces come after the first's; its round side is refused in words (Q5)", () => {
  // Joined face 7 is the cylinder's face 1 (7 − 6), its top at z = 10.
  assert.deepEqual(sketchSpot(pick(7), scene), { kind: "face", face: { plane: "face:feature-4/top", feature: "feature-4" }, drawn: { plane: { origin: [0, 0, 10], xAxis: [1, 0, 0], normal: [0, 0, 1] }, side: 1 } });
  assert.deepEqual(sketchSpot(pick(8), scene), { kind: "refused", message: CURVED_FACE });
  assert.match(CURVED_FACE, /curved/);
});

test("the faces offered to light are the flat ones: all the box's, the cylinder's two caps, never its side", () => {
  assert.deepEqual(sketchableFaces(scene), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(sketchableFaces(null), []);
});

test("an origin plane picked is that plane; anything else hit is nothing", () => {
  assert.deepEqual(sketchSpot(pick(null, "XZ"), scene), { kind: "plane", plane: "XZ" });
  assert.deepEqual(sketchSpot(pick(null, "YZ"), null), { kind: "plane", plane: "YZ" }, "no body needed for a plane");
  assert.equal(sketchSpot(pick(null, "AB"), scene), null);
  assert.equal(sketchSpot(pick(null), scene), null, "empty space");
  assert.equal(sketchSpot(pick(9), scene), null, "past the last body");
  assert.equal(sketchSpot(pick(-1), scene), null);
  assert.equal(sketchSpot(pick(1.5), scene), null);
  assert.equal(sketchSpot(pick(1), null), null, "no bodies drawn");
});

test("a face whose name another face shares is refused, not guessed (broken: the box's back given the top's role)", () => {
  const roles = BOX_VIEW.face_roles.map((r, i) => (i === 3 ? { role: "top" } : r));
  const twice = { ...box, face_roles: roles } as BodyView;
  const s = joinBodies([shown("feature-1", twice, 1)]);
  assert.deepEqual(sketchSpot(pick(1), s), { kind: "refused", message: UNNAMED_FACE });
  assert.deepEqual(sketchSpot(pick(3), s), { kind: "refused", message: UNNAMED_FACE });
  assert.deepEqual(sketchableFaces(s), [0, 2, 4, 5]);
});

test("a feature id with characters a name escapes still names its own feature", () => {
  const s = joinBodies([shown("feature:2/b", box, 1)]);
  const spot = sketchSpot(pick(1), s);
  assert.equal(spot?.kind, "face");
  assert.deepEqual(spot?.kind === "face" && spot.face, { plane: "face:feature%3A2%2Fb/top", feature: "feature:2/b" });
});

test("a body named as another feature's (names out of step with the body) is refused rather than sketched on the wrong one", () => {
  const s = joinBodies([{ feature: "feature-1", place: 1, view: box, names: nameBody("feature-9", box, () => null) }]);
  assert.deepEqual(sketchSpot(pick(1), s), { kind: "refused", message: UNNAMED_FACE });
});

test("a sketch on the bottom face is drawn saying it faces against its frame (side −1), so Look At looks from below; others say nothing", () => {
  const bottom = sketchSpot(pick(0), scene);
  const top = sketchSpot(pick(1), scene);
  assert.ok(bottom?.kind === "face" && top?.kind === "face");
  const a = addFaceSketch(partDocument("box", 40, 30, 20), bottom.face, bottom.drawn);
  const b = addFaceSketch(a.doc, top.face, top.drawn);
  assert.equal(sketchSide(b.doc, a.id), -1);
  assert.equal(sketchSide(b.doc, b.id), 1);
  assert.equal(sketchSide(b.doc, "sketch-99"), 1, "no such sketch: as an origin plane");
  const drawn = sketchDrawings(b.doc, { tool: startTool("line", a.id), grid: DEFAULT_GRID, pointer: null });
  assert.equal(drawn[0].side, -1, "the edited bottom sketch");
  assert.ok(drawn[0].editing);
  assert.equal("side" in drawn[1], false, "the top sketch, facing along its normal, says nothing");
  assert.equal(sketchDrawings(b.doc, null)[0].side, -1, "finished, it still says so");
});

test("seeded sessions: every click on random scenes agrees with the model, and every case comes up", () => {
  const all: Record<string, number> = {};
  for (let seed = 1; seed <= 20; seed++) for (const [k, n] of Object.entries(runFacePickSession(REAL, seed))) all[k] = (all[k] ?? 0) + n;
  for (const k of ["plane", "nothing", "curved", "unnamed", "face side 1", "face side -1"]) assert.ok((all[k] ?? 0) > 20, `${k} came up ${all[k] ?? 0} times: ${JSON.stringify(all)}`);
});
