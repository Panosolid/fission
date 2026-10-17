// The timeline model (src/timeline-model.ts) on its own: it is the oracle
// the random timeline sessions trust, so its answers are checked here by
// hand, with the working next to each assertion.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyOp,
  createModel,
  faceKey,
  polygonValid,
  rebuild,
  resolveFace,
  segmentsTouch,
  type ConcreteOp,
  type ItemResult,
  type ModelBody,
  type Point,
  type TimelineModel,
} from "../src/timeline-model.ts";

const near = (a: number, b: number) => Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(a), Math.abs(b));
const run = (m: TimelineModel, ...ops: ConcreteOp[]) => ops.map((op) => applyOp(m, op));
const results = (m: TimelineModel) => rebuild(m.doc).results;
const bodyOf = (r: ItemResult): ModelBody => {
  assert.equal(r.status, "built");
  assert.ok(r.status === "built" && r.body);
  return r.body;
};
const face = (b: ModelBody, key: string) => {
  const f = b.faces.find((x) => faceKey(x.name) === key);
  assert.ok(f, `no face ${key} in [${b.faces.map((x) => faceKey(x.name)).join(", ")}]`);
  return f;
};
const RECT: Point[] = [
  [0, 0],
  [40, 0],
  [40, 30],
  [0, 30],
];

test("a 40 × 30 × 20 box: volume, and each face named by its direction with its area and centre", () => {
  const m = createModel();
  run(m, { op: "add-preset", kind: "box", sizes: [40, 30, 20] });
  const b = bodyOf(results(m)["item-1"]);
  // 40 · 30 · 20 = 24000 mm³.
  assert.equal(b.volume, 24000);
  // Top: the 40 × 30 face at z = 20, centre (20, 15, 20). Front (−Y, y = 0): 40 × 20 = 800, centre (20, 0, 10). Right (+X): 30 × 20 = 600 at x = 40.
  assert.deepEqual(face(b, "item-1/top"), { name: { feature: "item-1", role: "top" }, area: 1200, centroid: [20, 15, 20] });
  assert.deepEqual([face(b, "item-1/front").area, face(b, "item-1/front").centroid], [800, [20, 0, 10]]);
  assert.deepEqual([face(b, "item-1/right").area, face(b, "item-1/right").centroid], [600, [40, 15, 10]]);
  assert.equal(b.faces.length, 6);
});

test("a rectangle sketch extruded by 10: caps named start and end, sides named by their line's id", () => {
  const m = createModel();
  const [sketch] = run(m, { op: "add-sketch", shape: { kind: "polygon", corners: RECT } }, { op: "add-extrude", sketch: "item-1", distance: 10 });
  // The sketch is item-1, its sides curve-2 … curve-5 in corner order; the extrude is item-6.
  assert.deepEqual(sketch, { kind: "done", ids: ["item-1", "curve-2", "curve-3", "curve-4", "curve-5"] });
  const b = bodyOf(results(m)["item-6"]);
  // 40 · 30 · 10 = 12000 mm³; start cap 1200 mm² at z = 0 centred (20, 15); end cap the same at z = 10.
  assert.equal(b.volume, 12000);
  assert.deepEqual(face(b, "item-6/start").centroid, [20, 15, 0]);
  assert.deepEqual(face(b, "item-6/end").centroid, [20, 15, 10]);
  // Side of curve-2, (0, 0) → (40, 0): 40 · 10 = 400 mm², centre (20, 0, 5). Side of curve-3, (40, 0) → (40, 30): 300 mm² at x = 40.
  assert.deepEqual([face(b, "item-6/side:curve-2").area, face(b, "item-6/side:curve-2").centroid], [400, [20, 0, 5]]);
  assert.deepEqual([face(b, "item-6/side:curve-3").area, face(b, "item-6/side:curve-3").centroid], [300, [40, 15, 5]]);
  assert.equal(b.faces.length, 6);
});

test("a slot, a cylinder and a sphere by hand", () => {
  const m = createModel();
  run(
    m,
    { op: "add-sketch", shape: { kind: "slot", at: [0, 0], length: 20, radius: 5 } },
    { op: "add-extrude", sketch: "item-1", distance: 2 },
    { op: "add-preset", kind: "cylinder", sizes: [10, 4] },
    { op: "add-preset", kind: "sphere", sizes: [6] },
  );
  const r = results(m);
  // Slot: a 20 × 10 rectangle and two half circles of radius 5: 200 + 25π mm², × 2 = 400 + 50π mm³.
  const slot = bodyOf(r["item-6"]);
  assert.ok(near(slot.volume, 400 + 50 * Math.PI));
  // The right end (curve-3, a half circle round (20, 0)): half a cylinder, π · 5 · 2 = 10π mm²; its centroid is 2r/π = 10/π
  // beyond the axis (the mean of r cos θ over −π/2 … π/2), half way up: (20 + 10/π, 0, 1).
  const end = face(slot, "item-6/side:curve-3");
  assert.ok(near(end.area, 10 * Math.PI) && near(end.centroid[0], 20 + 10 / Math.PI) && end.centroid[1] === 0 && end.centroid[2] === 1);
  // Cylinder ⌀10 × 4: π · 5² · 4 = 100π mm³; side 2π · 5 · 4 = 40π mm², centre (0, 0, 2).
  const cyl = bodyOf(r["item-7"]);
  assert.ok(near(cyl.volume, 100 * Math.PI) && near(face(cyl, "item-7/side").area, 40 * Math.PI));
  assert.deepEqual(face(cyl, "item-7/side").centroid, [0, 0, 2]);
  // Sphere ⌀6: 4/3 π 3³ = 36π mm³; each half 2π · 3² = 18π mm², its centroid r/2 = 1.5 from the centre (Archimedes: equal heights, equal areas).
  const sph = bodyOf(r["item-8"]);
  assert.ok(near(sph.volume, 36 * Math.PI) && near(face(sph, "item-8/upper").area, 18 * Math.PI));
  assert.deepEqual(face(sph, "item-8/upper").centroid, [0, 0, 1.5]);
  assert.deepEqual(face(sph, "item-8/lower").centroid, [0, 0, -1.5]);
});

test("a clockwise rectangle: the same names on the same faces as the counter-clockwise one", () => {
  const m = createModel();
  run(m, { op: "add-sketch", shape: { kind: "polygon", corners: [...RECT].reverse() } }, { op: "add-extrude", sketch: "item-1", distance: 10 });
  // Reversed corners (0,30), (40,30), (40,0), (0,0): curve-4 now runs (40, 0) → (0, 0), the front side: 400 mm² at y = 0;
  // curve-3 runs (40, 30) → (40, 0), the right side, 300 mm² at x = 40.
  const b = bodyOf(results(m)["item-6"]);
  assert.deepEqual([face(b, "item-6/side:curve-4").area, face(b, "item-6/side:curve-4").centroid], [400, [20, 0, 5]]);
  assert.deepEqual([face(b, "item-6/side:curve-3").area, face(b, "item-6/side:curve-3").centroid], [300, [40, 15, 5]]);
  assert.equal(b.volume, 12000);
});

test("polygon rules are exact on the grid: a corner on another side, a cusp, and one grid step away", () => {
  // The square with its third corner moved to (−10, 15): side (40, 0) → (−10, 15) crosses side (0, 30) → (0, 0) at x = 0,
  // t = 40/50 = 0.8, y = 0.8 · 15 = 12, which is on that side (0 ≤ 12 ≤ 30): a crossing.
  assert.equal(polygonValid([RECT[0], RECT[1], [-10, 15], RECT[3]]), false);
  assert.equal(polygonValid(RECT), true);
  // A corner exactly on a side that isn't its neighbour: (20, 0) on (0, 0) → (40, 0) after a notch, invalid; one step up, valid.
  assert.equal(polygonValid([[0, 0], [40, 0], [40, 30], [20, 0], [0, 30]]), false);
  assert.equal(polygonValid([[0, 0], [40, 0], [40, 30], [20, 1], [0, 30]]), true);
  // A cusp: (0,0) → (40,0) → (20,0) doubles back at (40, 0). Turning by one grid step instead, (20, 1), is fine.
  assert.equal(polygonValid([[0, 0], [40, 0], [20, 0], [0, 30]]), false);
  assert.equal(polygonValid([[0, 0], [40, 0], [20, 1], [0, 30]]), true);
  // Going straight on through a corner is not a cusp: (0,0) → (20,0) → (40,0).
  assert.equal(polygonValid([[0, 0], [20, 0], [40, 0], [40, 30], [0, 30]]), true);
  // Two corners in one place, and a flat triangle.
  assert.equal(polygonValid([[0, 0], [40, 0], [40, 0], [0, 30]]), false);
  assert.equal(polygonValid([[0, 0], [10, 0], [20, 0]]), false);
  // Touching at one end, collinear overlap, and parallel apart.
  assert.equal(segmentsTouch([0, 0], [10, 0], [10, 0], [10, 5]), true);
  assert.equal(segmentsTouch([0, 0], [10, 0], [5, 0], [15, 0]), true);
  assert.equal(segmentsTouch([0, 0], [10, 0], [0, 1], [10, 1]), false);
  assert.equal(segmentsTouch([0, 0], [10, 0], [11, 0], [15, 0]), false);
});

test("reordering past a dependency is refused, and records no undo step", () => {
  const m = createModel();
  run(m, { op: "add-sketch", shape: { kind: "polygon", corners: RECT } }, { op: "add-extrude", sketch: "item-1", distance: 10 }, { op: "add-preset", kind: "box", sizes: [1, 1, 1] });
  const undo = m.undo.length;
  // Order: sketch item-1, extrude item-6, box item-7. The extrude to the front would come before its sketch.
  assert.deepEqual(applyOp(m, { op: "reorder", item: "item-6", to: 0 }), { kind: "refused", cause: "before-dependency" });
  // The sketch to the end would come after the extrude that uses it.
  assert.deepEqual(applyOp(m, { op: "reorder", item: "item-1", to: 2 }), { kind: "refused", cause: "after-dependent" });
  // The box to the front is fine.
  assert.deepEqual(applyOp(m, { op: "reorder", item: "item-7", to: 0 }), { kind: "done", ids: [] });
  assert.deepEqual(rebuild(m.doc).order, ["item-7", "item-1", "item-6"]);
  assert.equal(m.undo.length, undo + 1);
});

test("suppress, the marker, delete: what the extrude says, and its names coming back unchanged", () => {
  const m = createModel();
  run(m, { op: "add-sketch", shape: { kind: "polygon", corners: RECT } }, { op: "add-extrude", sketch: "item-1", distance: 10 });
  const names = bodyOf(results(m)["item-6"]).faces.map((f) => faceKey(f.name));
  run(m, { op: "suppress", item: "item-1", on: true });
  assert.deepEqual(results(m)["item-6"], { status: "failed", cause: "suppressed-input", input: "item-1" });
  run(m, { op: "suppress", item: "item-1", on: false });
  assert.deepEqual(bodyOf(results(m)["item-6"]).faces.map((f) => faceKey(f.name)), names);
  // The marker on the sketch: the extrude is rolled back, not failed. A box added now goes in after the sketch, and the marker moves onto it.
  run(m, { op: "marker", at: "item-1" });
  assert.deepEqual(results(m)["item-6"], { status: "rolled-back" });
  run(m, { op: "add-preset", kind: "box", sizes: [1, 2, 3] });
  assert.deepEqual([rebuild(m.doc).order, m.doc.marker], [["item-1", "item-7", "item-6"], "item-7"]);
  run(m, { op: "marker", at: null });
  // Deleting the sketch leaves the extrude, failed and naming it; undo brings both back with the same names.
  run(m, { op: "delete-item", item: "item-1" });
  assert.deepEqual(results(m)["item-6"], { status: "failed", cause: "deleted-input", input: "item-1" });
  run(m, { op: "undo" });
  assert.deepEqual(bodyOf(results(m)["item-6"]).faces.map((f) => faceKey(f.name)), names);
  // Deleting the item the marker is on moves it to the one before.
  run(m, { op: "marker", at: "item-7" }, { op: "delete-item", item: "item-7" });
  assert.equal(m.doc.marker, "item-1");
  run(m, { op: "marker", at: "item-1" }, { op: "delete-item", item: "item-1" });
  assert.equal(m.doc.marker, "start");
});

test("a side deleted and drawn again gets a new name; the old one resolves to nothing", () => {
  const m = createModel();
  run(m, { op: "add-sketch", shape: { kind: "polygon", corners: RECT } }, { op: "add-extrude", sketch: "item-1", distance: 10 });
  const old = { feature: "item-6", role: "side" as const, curve: "curve-2" };
  assert.ok(resolveFace(rebuild(m.doc), old));
  run(m, { op: "delete-curve", sketch: "item-1", curve: "curve-2" });
  assert.deepEqual(results(m)["item-6"], { status: "failed", cause: "open-outline", input: "item-1" });
  const [redrawn] = run(m, { op: "redraw-curve", sketch: "item-1", index: 0 });
  // The counter was at 7 (item-6 was the last id), so the new line is curve-7.
  assert.deepEqual(redrawn, { kind: "done", ids: ["curve-7"] });
  const r = rebuild(m.doc);
  assert.equal(resolveFace(r, old), null);
  assert.deepEqual(resolveFace(r, { ...old, curve: "curve-7" })?.centroid, [20, 0, 5]);
});

test("a corner moved so the outline crosses itself fails the extrude, and moving it back mends it", () => {
  const m = createModel();
  run(m, { op: "add-sketch", shape: { kind: "polygon", corners: RECT } }, { op: "add-extrude", sketch: "item-1", distance: 10 });
  run(m, { op: "move-corner", sketch: "item-1", corner: 2, to: [-10, 15] });
  assert.deepEqual(results(m)["item-6"], { status: "failed", cause: "invalid-outline", input: "item-1" });
  // Corner 2 at (40, 15) instead: a trapezium with parallel sides 30 (at x = 0) and 15 (at x = 40), 40 apart: (30 + 15)/2 · 40 = 900 mm², × 10.
  run(m, { op: "move-corner", sketch: "item-1", corner: 2, to: [40, 15] });
  assert.equal(bodyOf(results(m)["item-6"]).volume, 9000);
});

test("ids are never reused while undo or redo can reach them; undo, redo and no-change edits follow the snapshot rules", () => {
  const m = createModel();
  run(m, { op: "add-preset", kind: "box", sizes: [1, 1, 1] }, { op: "delete-item", item: "item-1" });
  const [again] = run(m, { op: "add-preset", kind: "box", sizes: [1, 1, 1] });
  assert.deepEqual(again, { kind: "done", ids: ["item-2"] });
  // A no-change edit records nothing and keeps the redo.
  run(m, { op: "undo" });
  assert.deepEqual(applyOp(m, { op: "marker", at: null }), { kind: "unchanged" });
  assert.equal(m.redo.length, 1);
  assert.deepEqual(applyOp(m, { op: "redo" }), { kind: "done", ids: [] });
  // An edit clears the redo; redo then does nothing.
  run(m, { op: "undo" }, { op: "add-preset", kind: "sphere", sizes: [2] });
  assert.deepEqual(applyOp(m, { op: "redo" }), { kind: "unchanged" });
  assert.deepEqual(applyOp(createModel(), { op: "undo" }), { kind: "unchanged" });
});
