// The timeline model (src/timeline-model.ts) on its own: it is the oracle
// the random timeline sessions trust, so its answers are checked here by
// hand, with the working next to each assertion.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyOp,
  bodyKeys,
  buildBounds,
  createModel,
  edgeKey,
  edgeName,
  faceKey,
  outlineProblem,
  polygonValid,
  rebuild,
  resolveFace,
  segmentsTouch,
  type ConcreteOp,
  type ItemResult,
  type ModelBody,
  type ModelDoc,
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
const edge = (b: ModelBody, key: string) => {
  const e = b.edges.find((x) => edgeKey(x.name) === key);
  assert.ok(e, `no edge ${key} in [${b.edges.map((x) => edgeKey(x.name)).join(", ")}]`);
  return [e.length, e.centroid];
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

test("edges are named by the two faces they join: a set of two, sorted, except between two sides, where the order says which corner", () => {
  const a = { feature: "item-1", role: "side" as const, curve: "curve-3" };
  const b = { feature: "item-1", role: "start" as const };
  // "side:curve-3" < "start" as text, so the set is written in that order either way round.
  assert.equal(edgeKey(edgeName(b, a, false)), "item-1/side:curve-3+start");
  assert.equal(edgeKey(edgeName(a, b, false)), "item-1/side:curve-3+start");
  const c = { feature: "item-1", role: "side" as const, curve: "curve-2" };
  // Ordered: kept as given, so the two corners where two sides meet get different names.
  assert.equal(edgeKey(edgeName(a, c, true)), "item-1/side:curve-3>side:curve-2");
  assert.equal(edgeKey(edgeName(c, a, true)), "item-1/side:curve-2>side:curve-3");
});

test("a 40 × 30 × 20 box's 12 edges and a rectangle's extrude's 12, by hand", () => {
  const m = createModel();
  run(m, { op: "add-preset", kind: "box", sizes: [40, 30, 20] });
  const box = bodyOf(results(m)["item-1"]);
  assert.equal(box.edges.length, 12);
  // Bottom and front meet along y = 0, z = 0: 40 long, centre (20, 0, 0). Top and right: x = 40, z = 20, 30 long, centre (40, 15, 20).
  assert.deepEqual(edge(box, "item-1/bottom+front"), [40, [20, 0, 0]]);
  assert.deepEqual(edge(box, "item-1/right+top"), [30, [40, 15, 20]]);
  // Back and left: the upright at x = 0, y = 30, 20 high, centre (0, 30, 10).
  assert.deepEqual(edge(box, "item-1/back+left"), [20, [0, 30, 10]]);

  const n = createModel();
  run(n, { op: "add-sketch", shape: { kind: "polygon", corners: RECT } }, { op: "add-extrude", sketch: "item-1", distance: 10 });
  const b = bodyOf(results(n)["item-6"]);
  // 4 sides: 4 edges in each cap and 4 uprights.
  assert.equal(b.edges.length, 12);
  // curve-2 runs (0, 0) → (40, 0): its edge in the start cap is 40 long, centre (20, 0, 0); in the end cap (20, 0, 10).
  assert.deepEqual(edge(b, "item-6/side:curve-2+start"), [40, [20, 0, 0]]);
  assert.deepEqual(edge(b, "item-6/end+side:curve-2"), [40, [20, 0, 10]]);
  // Counter-clockwise, corner (40, 0) ends curve-2 and starts curve-3: the upright there, 10 high, centre (40, 0, 5).
  assert.deepEqual(edge(b, "item-6/side:curve-2>side:curve-3"), [10, [40, 0, 5]]);
  // Corner (0, 0) ends curve-5 (the left side, (0, 30) → (0, 0)) and starts curve-2.
  assert.deepEqual(edge(b, "item-6/side:curve-5>side:curve-2"), [10, [0, 0, 5]]);
});

test("a clockwise rectangle's uprights: the side before each corner counter-clockwise comes first", () => {
  const m = createModel();
  run(m, { op: "add-sketch", shape: { kind: "polygon", corners: [...RECT].reverse() } }, { op: "add-extrude", sketch: "item-1", distance: 10 });
  const b = bodyOf(results(m)["item-6"]);
  // Corners (0,30), (40,30), (40,0), (0,0): curve-2 the top, curve-3 the right (down), curve-4 the bottom (to the left), curve-5 the left (up).
  // Counter-clockwise round the same rectangle the bottom comes before (40, 0) and the right after it, so the upright
  // there is curve-4 then curve-3, though as drawn curve-3 comes first.
  assert.deepEqual(edge(b, "item-6/side:curve-4>side:curve-3"), [10, [40, 0, 5]]);
  assert.ok(!b.edges.some((e) => edgeKey(e.name) === "item-6/side:curve-3>side:curve-4"));
  // The bottom's edge in the start cap: (40, 0) → (0, 0), centre (20, 0, 0).
  assert.deepEqual(edge(b, "item-6/side:curve-4+start"), [40, [20, 0, 0]]);
});

test("a slot's, a cylinder's and a sphere's edges by hand", () => {
  const m = createModel();
  run(
    m,
    { op: "add-sketch", shape: { kind: "slot", at: [0, 0], length: 20, radius: 5 } },
    { op: "add-extrude", sketch: "item-1", distance: 2 },
    { op: "add-preset", kind: "cylinder", sizes: [10, 4] },
    { op: "add-preset", kind: "sphere", sizes: [6] },
  );
  const r = results(m);
  // Slot round (0, 0) and (20, 0), radius 5: curve-2 the bottom line, curve-3 the right half circle, curve-4 the top, curve-5 the left.
  const slot = bodyOf(r["item-6"]);
  assert.equal(slot.edges.length, 12);
  // The right half circle's edge in the end cap: π · 5 = 5π long; an arc's centroid is r sin(α)/α from its centre,
  // α the half angle π/2, so 2r/π = 10/π to the right of (20, 0): (20 + 10/π, 0, 2).
  const [len, at] = edge(slot, "item-6/end+side:curve-3") as [number, number[]];
  assert.ok(near(len, 5 * Math.PI) && near(at[0], 20 + 10 / Math.PI) && at[1] === 0 && at[2] === 2, `${len} ${at}`);
  // Counter-clockwise the bottom line ends at (20, −5), where the right half circle starts: upright 2 high, centre (20, −5, 1).
  assert.deepEqual(edge(slot, "item-6/side:curve-2>side:curve-3"), [2, [20, -5, 1]]);
  // And the left half circle ends at (0, −5), where the bottom starts.
  assert.deepEqual(edge(slot, "item-6/side:curve-5>side:curve-2"), [2, [0, -5, 1]]);
  // Cylinder ⌀10 × 4: two rims 10π long, round (0, 0, 0) and (0, 0, 4); no seam.
  const cyl = bodyOf(r["item-7"]);
  assert.deepEqual(cyl.edges.map((e) => edgeKey(e.name)).sort(), ["item-7/bottom+side", "item-7/side+top"]);
  assert.ok(near(edge(cyl, "item-7/side+top")[0] as number, 10 * Math.PI));
  assert.deepEqual(edge(cyl, "item-7/side+top")[1], [0, 0, 4]);
  // Sphere ⌀6: one edge, the equator, 6π long round the centre.
  const sph = bodyOf(r["item-8"]);
  assert.deepEqual(sph.edges.map((e) => edgeKey(e.name)), ["item-8/lower+upper"]);
  assert.ok(near(edge(sph, "item-8/lower+upper")[0] as number, 6 * Math.PI));
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
  // 26e (Q3): built on a suppressed sketch, the extrude is greyed by it, with no warning; before 26e it failed.
  assert.deepEqual(results(m)["item-6"], { status: "greyed", by: "item-1" });
  run(m, { op: "suppress", item: "item-1", on: false });
  assert.deepEqual(bodyOf(results(m)["item-6"]).faces.map((f) => faceKey(f.name)), names);
  // The marker on the sketch: the extrude is rolled back, not failed. A box added now goes in after the sketch, and the marker moves onto it.
  run(m, { op: "marker", at: "item-1" });
  assert.deepEqual(results(m)["item-6"], { status: "rolled-back" });
  run(m, { op: "add-preset", kind: "box", sizes: [1, 2, 3] });
  assert.deepEqual([rebuild(m.doc).order, m.doc.marker], [["item-1", "item-7", "item-6"], "item-7"]);
  run(m, { op: "marker", at: null });
  // Deleting the sketch (the owner's rule): the extrude keeps its last shape, 40 × 30 × 10 = 12000 mm³ under the
  // same names, with a warning naming the sketch; undo brings the sketch back and the warning goes.
  run(m, { op: "delete-item", item: "item-1" });
  const kept = results(m)["item-6"];
  assert.deepEqual(kept.status === "built" && kept.warning, { cause: "deleted-input", input: "item-1" });
  assert.equal(bodyOf(kept).volume, 12000);
  assert.deepEqual(bodyOf(kept).faces.map((f) => faceKey(f.name)), names);
  run(m, { op: "undo" });
  assert.equal((results(m)["item-6"] as { warning?: unknown }).warning, undefined);
  assert.deepEqual(bodyOf(results(m)["item-6"]).faces.map((f) => faceKey(f.name)), names);
  // Deleting the item the marker is on moves it to the one before.
  run(m, { op: "marker", at: "item-7" }, { op: "delete-item", item: "item-7" });
  assert.equal(m.doc.marker, "item-1");
  run(m, { op: "marker", at: "item-1" }, { op: "delete-item", item: "item-1" });
  assert.equal(m.doc.marker, "start");
});

test("what an edit must rebuild (24e): nothing for suppress, the marker or a lost sketch kept; one body for a moved corner; a redrawn side changes the inputs but not the solid", () => {
  const m = createModel();
  run(m, { op: "add-preset", kind: "box", sizes: [40, 30, 20] }, { op: "add-sketch", shape: { kind: "polygon", corners: RECT } }, { op: "add-extrude", sketch: "item-2", distance: 10 });
  // Items: box item-1, sketch item-2 (sides curve-3 to curve-6), extrude item-7.
  const keys = () => [...bodyKeys(m.doc, rebuild(m.doc)).values()];
  const step = (op: ConcreteOp) => {
    const before = keys();
    run(m, op);
    return buildBounds(before, keys());
  };
  // Two bodies, each from its own inputs: the box's kind and sizes, the extrude's rectangle, curve ids and distance.
  assert.deepEqual([...bodyKeys(m.doc, rebuild(m.doc)).keys()], ["item-1", "item-7"]);
  // Suppressing the box drops a body and builds none; unsuppressing builds it again, since the cache let it go.
  assert.deepEqual(step({ op: "suppress", item: "item-1", on: true }), { least: 0, most: 0 });
  assert.deepEqual(step({ op: "suppress", item: "item-1", on: false }), { least: 1, most: 1 });
  // The marker on the sketch rolls the extrude back (nothing to build); moving it to the end builds the extrude again.
  assert.deepEqual(step({ op: "marker", at: "item-2" }), { least: 0, most: 0 });
  assert.deepEqual(step({ op: "marker", at: null }), { least: 1, most: 1 });
  // A corner moved: the extrude's solid and inputs both change, one body; the box is untouched.
  assert.deepEqual(step({ op: "move-corner", sketch: "item-2", corner: 0, to: [-5, 0] }), { least: 1, most: 1 });
  // A side deleted: the extrude keeps its last shape, which is the sketch as it just was, so the same inputs: nothing to build.
  assert.deepEqual(step({ op: "delete-curve", sketch: "item-2", curve: "curve-4" }), { least: 0, most: 0 });
  // Drawn again: a new curve id (curve-8) names a side, so the inputs are new, but the solid is the one already held:
  // a cache keyed by inputs builds 1, one that could see the solid is the same could build 0.
  assert.deepEqual(step({ op: "redraw-curve", sketch: "item-2", index: 1 }), { least: 0, most: 1 });
  // Deleting the sketch: kept again, nothing to build. A second box the size of the first is the same inputs and solid.
  assert.deepEqual(step({ op: "delete-item", item: "item-2" }), { least: 0, most: 0 });
  assert.deepEqual(step({ op: "add-preset", kind: "box", sizes: [40, 30, 20] }), { least: 0, most: 0 });
  // A distance typed: one new body.
  assert.deepEqual(step({ op: "set-size", item: "item-7", key: "distance", value: 12 }), { least: 1, most: 1 });
});

test("a polygon drawn from another corner is the same solid, other inputs; two new bodies of one size count once", () => {
  const before = [{ spec: "a", shape: "x" }];
  assert.deepEqual(buildBounds(before, [{ spec: "b", shape: "x" }]), { least: 0, most: 1 });
  assert.deepEqual(buildBounds(before, [{ spec: "b", shape: "y" }, { spec: "b", shape: "y" }]), { least: 1, most: 1 });
  assert.deepEqual(buildBounds([], []), { least: 0, most: 0 });
  // The same rectangle from corner 2 on: same sorted corners, so the same solid.
  const m = createModel();
  run(m, { op: "add-sketch", shape: { kind: "polygon", corners: RECT } }, { op: "add-extrude", sketch: "item-1", distance: 10 });
  run(m, { op: "add-sketch", shape: { kind: "polygon", corners: [...RECT.slice(2), ...RECT.slice(0, 2)] } }, { op: "add-extrude", sketch: "item-7", distance: 10 });
  const [a, b] = [...bodyKeys(m.doc, rebuild(m.doc)).values()];
  assert.equal(a.shape, b.shape);
  assert.notEqual(a.spec, b.spec);
});

test("a side deleted and drawn again gets a new name; the old one resolves to nothing", () => {
  const m = createModel();
  run(m, { op: "add-sketch", shape: { kind: "polygon", corners: RECT } }, { op: "add-extrude", sketch: "item-1", distance: 10 });
  const old = { feature: "item-6", role: "side" as const, curve: "curve-2" };
  assert.ok(resolveFace(rebuild(m.doc), old));
  run(m, { op: "delete-curve", sketch: "item-1", curve: "curve-2" });
  // The outline is open: the extrude keeps its last shape, whose bottom side is still curve-2's (40 × 10 = 400 mm² at (20, 0, 5)).
  const kept = results(m)["item-6"];
  assert.deepEqual(kept.status === "built" && kept.warning, { cause: "open-outline", input: "item-1" });
  assert.deepEqual(resolveFace(rebuild(m.doc), old), { name: old, area: 400, centroid: [20, 0, 5] });
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
  // Crossing itself: the last shape, the 40 × 30 rectangle by 10 = 12000 mm³, with a warning.
  const kept = results(m)["item-6"];
  assert.deepEqual(kept.status === "built" && kept.warning, { cause: "invalid-outline", input: "item-1" });
  assert.equal(bodyOf(kept).volume, 12000);
  // Corner 2 at (40, 15) instead: a trapezium with parallel sides 30 (at x = 0) and 15 (at x = 40), 40 apart: (30 + 15)/2 · 40 = 900 mm², × 10.
  run(m, { op: "move-corner", sketch: "item-1", corner: 2, to: [40, 15] });
  assert.equal(bodyOf(results(m)["item-6"]).volume, 9000);
  assert.equal(m.doc.items[1].kind === "extrude" && m.doc.items[1].kept, undefined);
});

test("the owner's rule: a lost sketch's extrude keeps the shape it had just before, by its distance now, until the sketch makes an outline again", () => {
  const m = createModel();
  run(m, { op: "add-sketch", shape: { kind: "polygon", corners: RECT } }, { op: "add-extrude", sketch: "item-1", distance: 10 });
  const warning = () => {
    const r = results(m)["item-6"];
    return r.status === "built" ? (r.warning ?? null) : r;
  };
  const volume = () => bodyOf(results(m)["item-6"]).volume;
  const face = (curve: string) => resolveFace(rebuild(m.doc), { feature: "item-6", role: "side", curve });
  // Corner 2 to (40, 15): the trapezium of the test above, 900 mm² × 10 = 9000 mm³.
  run(m, { op: "move-corner", sketch: "item-1", corner: 2, to: [40, 15] });
  assert.deepEqual([volume(), warning()], [9000, null]);
  // Its right side (curve-3, (40, 0) → (40, 15)) deleted: the trapezium is kept, not the first rectangle.
  // That side's face is 15 × 10 = 150 mm², centred at (40, 7.5, 5).
  run(m, { op: "delete-curve", sketch: "item-1", curve: "curve-3" });
  assert.deepEqual([volume(), warning()], [9000, { cause: "open-outline", input: "item-1" }]);
  assert.deepEqual(face("curve-3"), { name: { feature: "item-6", role: "side", curve: "curve-3" }, area: 150, centroid: [40, 7.5, 5] });
  // The distance typed while it is lost applies to the kept shape: 900 × 20 = 18000 mm³; the side is 15 × 20 = 300 mm² at half height 10.
  run(m, { op: "set-size", item: "item-6", key: "distance", value: 20 });
  assert.deepEqual([volume(), face("curve-3")?.area, face("curve-3")?.centroid], [18000, 300, [40, 7.5, 10]]);
  // An edit to the still-open sketch doesn't reach the kept shape: corner 0 to (0, −10), still 18000.
  run(m, { op: "move-corner", sketch: "item-1", corner: 0, to: [0, -10] });
  assert.deepEqual([volume(), warning()], [18000, { cause: "open-outline", input: "item-1" }]);
  // Suppressing the sketch greys the extrude (26e, Q3), kept shape or not; unsuppressing brings the kept shape back.
  run(m, { op: "suppress", item: "item-1", on: true });
  assert.deepEqual(warning(), { status: "greyed", by: "item-1" });
  run(m, { op: "suppress", item: "item-1", on: false });
  assert.deepEqual([volume(), warning()], [18000, { cause: "open-outline", input: "item-1" }]);
  // Side 1 drawn again (curve-7): built from the sketch now, corners (0, −10), (40, 0), (40, 15), (0, 30): a trapezium
  // with parallel sides 40 (x = 0, −10 to 30) and 15 (x = 40, 0 to 15), 40 apart: (40 + 15)/2 · 40 = 1100 mm² × 20 = 22000 mm³.
  // The kept shape is forgotten, so its side curve-3 resolves to nothing.
  run(m, { op: "redraw-curve", sketch: "item-1", index: 1 });
  assert.deepEqual([volume(), warning(), face("curve-3")], [22000, null, null]);
  assert.ok(face("curve-7"));
  // Undo brings the kept shape back (it is part of the document), redo forgets it again.
  run(m, { op: "undo" });
  assert.deepEqual([volume(), warning()], [18000, { cause: "open-outline", input: "item-1" }]);
  run(m, { op: "redo" });
  // The sketch deleted now: the shape just before, 22000 mm³, its side named by curve-7.
  run(m, { op: "delete-item", item: "item-1" });
  assert.deepEqual([volume(), warning()], [22000, { cause: "deleted-input", input: "item-1" }]);
  assert.ok(face("curve-7"));
});

test("with no kept shape (a file whose extrude's sketch was already broken) the extrude fails with the cause; two corners in one place leave no loop", () => {
  // As a file from before the rule could hold it: side curve-2 deleted, no kept shape.
  const doc: ModelDoc = {
    nextId: 7,
    marker: null,
    items: [
      { id: "item-1", kind: "sketch", shape: { kind: "polygon", corners: RECT }, curves: [null, "curve-3", "curve-4", "curve-5"], suppressed: false },
      { id: "item-6", kind: "extrude", sketch: "item-1", distance: 10, suppressed: false },
    ],
  };
  assert.deepEqual(rebuild(doc).results["item-6"], { status: "failed", cause: "open-outline", input: "item-1" });
  assert.deepEqual(rebuild({ ...doc, items: [doc.items[1]] }).results["item-6"], { status: "failed", cause: "deleted-input", input: "item-1" });
  // A bow tie through one point: corners 2 and 5 both at (20, 20), so four line ends meet there, a branch, not one loop.
  const curves = ["a", "b", "c", "d", "e", "f"];
  const bowtie: Point[] = [[0, 0], [40, 0], [20, 20], [40, 40], [0, 40], [20, 20]];
  assert.equal(outlineProblem({ shape: { kind: "polygon", corners: bowtie }, curves }), "open-outline");
  // Corner 5 one grid step up, at (20, 21): the two tips are 1 mm apart and no two sides touch, so it is one valid loop.
  assert.equal(outlineProblem({ shape: { kind: "polygon", corners: [...bowtie.slice(0, 5), [20, 21]] }, curves }), null);
  // Two neighbouring corners in one place: a side of length 0, invalid (the kernel refuses that line).
  assert.equal(outlineProblem({ shape: { kind: "polygon", corners: [[0, 0], [40, 0], [40, 0], [0, 30]] }, curves: curves.slice(0, 4) }), "invalid-outline");
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

test("a sketch on a face (26e): it follows its face, greys with it, can't move before it, and holds where it was when the face goes", () => {
  const m = createModel();
  // A 40 × 30 × 20 box (item-1); RECT on its top (item-2, curves 3 to 6), extruded 10 (item-7).
  run(m, { op: "add-preset", kind: "box", sizes: [40, 30, 20] });
  assert.deepEqual(applyOp(m, { op: "add-face-sketch", shape: { kind: "polygon", corners: RECT }, face: { feature: "item-1", role: "top" } }), { kind: "done", ids: ["item-2", "curve-3", "curve-4", "curve-5", "curve-6"] });
  run(m, { op: "add-extrude", sketch: "item-2", distance: 10 });
  // The top is flat at z = 20 facing +Z, so the sketch is XY lifted by 20 (rule 8: XY turned not at all), drawn there.
  assert.deepEqual(results(m)["item-2"], { status: "built", lift: 20 });
  // The extrude stands on the top: 40 × 30 × 10 = 12000 mm³, its start cap at z = 20 and its end at 30, centred over
  // (20, 15); its right side, from (40, 0) to (40, 30), is 30 × 10 = 300 mm² centred at (40, 15, 20 + 10/2 = 25).
  const body = () => bodyOf(results(m)["item-7"]);
  assert.equal(body().volume, 12000);
  assert.deepEqual([face(body(), "item-7/start").centroid, face(body(), "item-7/end").centroid], [[20, 15, 20], [20, 15, 30]]);
  assert.deepEqual(face(body(), "item-7/side:curve-4"), { name: { feature: "item-7", role: "side", curve: "curve-4" }, area: 300, centroid: [40, 15, 25] });
  // The box 35 high: the sketch follows its top to z = 35, the extrude's end to 45.
  run(m, { op: "set-size", item: "item-1", key: "height", value: 35 });
  assert.deepEqual([results(m)["item-2"], face(body(), "item-7/end").centroid], [{ status: "built", lift: 35 }, [20, 15, 45]]);
  // Q3: the box suppressed greys the sketch and the extrude, naming the box, with no warning.
  run(m, { op: "suppress", item: "item-1", on: true });
  assert.deepEqual([results(m)["item-2"], results(m)["item-7"]], [{ status: "greyed", by: "item-1" }, { status: "greyed", by: "item-1" }]);
  run(m, { op: "suppress", item: "item-1", on: false });
  // Answer 7: the sketch can't go before the box it is drawn on, nor the box after it.
  assert.deepEqual(applyOp(m, { op: "reorder", item: "item-2", to: 0 }), { kind: "refused", cause: "before-dependency" });
  assert.deepEqual(applyOp(m, { op: "reorder", item: "item-1", to: 1 }), { kind: "refused", cause: "after-dependent" });
  // Q1: the box deleted. The sketch holds z = 35, where it last was, not 20 where it was drawn, saying its plane is
  // lost; the extrude is built there from it, saying its source is lost: still 12000 mm³, its end at 45.
  run(m, { op: "delete-item", item: "item-1" });
  assert.deepEqual(results(m)["item-2"], { status: "built", lift: 35, plane: "plane-lost" });
  assert.deepEqual([body().volume, face(body(), "item-7/end").centroid, (results(m)["item-7"] as { source?: string }).source], [12000, [20, 15, 45], "item-2"]);
  // Undo brings the box back and the sketch follows it again, holding nothing.
  run(m, { op: "undo" });
  assert.deepEqual(results(m)["item-2"], { status: "built", lift: 35 });
  assert.equal((m.doc.items.find((i) => i.id === "item-2") as { on?: { held?: number } }).on?.held, undefined);
  // A sketch on the extrude's end (item-8, curves 9 to 12) lies at z = 45; its extrude of 5 (item-13) ends at 50.
  run(m, { op: "add-face-sketch", shape: { kind: "polygon", corners: RECT }, face: { feature: "item-7", role: "end" } }, { op: "add-extrude", sketch: "item-8", distance: 5 });
  assert.deepEqual([results(m)["item-8"], face(bodyOf(results(m)["item-13"]), "item-13/end").centroid], [{ status: "built", lift: 45 }, [20, 15, 50]]);
  // The box suppressed greys all four, every one by the box.
  run(m, { op: "suppress", item: "item-1", on: true });
  assert.deepEqual(["item-2", "item-7", "item-8", "item-13"].map((id) => results(m)[id]), Array(4).fill({ status: "greyed", by: "item-1" }));
  // The lower sketch deleted while greyed: the extrude keeps its shape where the sketch lay with nothing suppressed (z 35),
  // so once the box is back it is the 12000 mm³ block from 35 to 45 with the kept-shape warning, and the upper sketch still
  // finds its end at 45.
  run(m, { op: "delete-item", item: "item-2" }, { op: "suppress", item: "item-1", on: false });
  assert.deepEqual(results(m)["item-7"].status === "built" && results(m)["item-7"].warning, { cause: "deleted-input", input: "item-2" });
  assert.deepEqual([face(body(), "item-7/start").centroid, results(m)["item-8"]], [[20, 15, 35], { status: "built", lift: 45 }]);
});

test("a face sketch with nothing held stays where it was drawn; a sketch held then given its face back forgets the hold", () => {
  const doc: ModelDoc = {
    nextId: 9,
    marker: null,
    items: [{ id: "item-2", kind: "sketch", shape: { kind: "polygon", corners: RECT }, curves: ["a", "b", "c", "d"], suppressed: false, on: { feature: "item-1", role: "top", drawn: 20 } }],
  };
  // Its box is not in the timeline and it holds no height (a file written by hand): it stays at z = 20, as drawn.
  assert.deepEqual(rebuild(doc).results["item-2"], { status: "built", lift: 20, plane: "plane-lost" });
  // Held at 7, it stays at 7.
  const held: ModelDoc = JSON.parse(JSON.stringify(doc));
  (held.items[0] as { on: { held?: number } }).on.held = 7;
  assert.deepEqual(rebuild(held).results["item-2"], { status: "built", lift: 7, plane: "plane-lost" });
  // A box of height 12 put in before it (reordered there) gives it its face back: it follows to 12 and the hold is forgotten.
  const m: TimelineModel = { ...createModel(), doc: { ...held, items: [{ id: "item-1", kind: "box", width: 5, depth: 5, height: 12, suppressed: false }, ...held.items] } };
  run(m, { op: "marker", at: "item-1" }, { op: "marker", at: null });
  assert.deepEqual(results(m)["item-2"], { status: "built", lift: 12 });
  assert.equal((m.doc.items[1] as { on: { held?: number } }).on.held, undefined);
});
