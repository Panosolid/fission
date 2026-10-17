// Sketch snapping (snap.ts): a pointer near a point lands on it exactly,
// near a point's column or row lines up with it, otherwise on the grid;
// the reach is SNAP_PIXELS screen pixels. Hand-worked cases with the sums
// shown, the reach's boundary at 0.9× and 1.1×, the tools' own rules (no
// rectangle on its first corner's row, H/V from a chain's last point),
// the marks drawn, and seeded random sketches checked against a simple
// model that works from the curves rather than the sketch's point list.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SketchDrawing, SketchXY } from "@fission/core";
import { partDocument, type DesignDocument, type Sketch } from "../src/document.ts";
import { addSketch, drawArc, drawCircle, drawLine, pointAt, sketchCurves } from "../src/sketch.ts";
import { clickAt, startTool, type CircleTool, type LineTool, type RectangleTool, type SketchTool } from "../src/sketch-tool.ts";
import { MARK_PIXELS, SNAP_PIXELS, snapLabel, snapMarks, snapOnSketch, snapPointer, snapTargets, withSnap, type Snap, type SnapTargets } from "../src/snap.ts";

function blank() {
  const s = addSketch(partDocument("box", 40, 30, 20));
  return { doc: s.doc, sketch: s.id };
}
const sketchOf = (doc: DesignDocument, id: string): Sketch => doc.sketches.find((s) => s.id === id)!;
const line = (sketch: string, from: LineTool["from"] = null): LineTool => ({ kind: "line", sketch, from });

/** A sketch with one line (0, 0) → (33, 0): its ends are off the 10 mm grid at x = 33, its midpoint is (16.5, 0). */
function oneLine() {
  const { doc, sketch } = blank();
  return { doc: drawLine(doc, sketch, [0, 0], [33, 0]).doc, sketch };
}

test("SNAP_PIXELS is 10 screen pixels", () => {
  assert.equal(SNAP_PIXELS, 10);
});

test("hand-worked: a pointer 5 mm from an endpoint snaps to it at a pixel of 0.5 mm, exactly at the reach", () => {
  const { doc, sketch } = oneLine();
  // Reach = 10 px × 0.5 mm = 5 mm. The pointer (36, 4) is (3, 4) from (33, 0): √(9 + 16) = 5 ≤ 5, so it snaps,
  // to (33, 0) exactly, though the grid (10 mm) would put it at (40, 0).
  const s = snapOnSketch(doc, line(sketch), [36, 4], [40, 0], 0.5);
  assert.deepEqual(s, { kind: "endpoint", at: [33, 0] });
});

test("hand-worked: a pointer near a line's middle snaps to its midpoint", () => {
  const { doc, sketch } = oneLine();
  // Midpoint of (0, 0) → (33, 0) is (16.5, 0). The pointer (16, 3) is √(0.25 + 9) ≈ 3.04 mm from it, under the
  // 5 mm reach, and 16 mm or more from either end.
  assert.deepEqual(snapOnSketch(doc, line(sketch), [16, 3], [20, 0], 0.5), { kind: "midpoint", at: [16.5, 0] });
});

test("hand-worked: the nearer of two points within reach wins", () => {
  const { doc, sketch } = blank();
  const d = drawLine(doc, sketch, [0, 0], [6, 0]).doc;
  // Reach 10 mm (pixel 1). The pointer (2.9, 0) is 2.9 from (0, 0), 3.1 from (6, 0) and 0.1 from the midpoint (3, 0):
  // the midpoint is nearest.
  assert.deepEqual(snapOnSketch(d, line(sketch), [2.9, 0], [0, 0], 1), { kind: "midpoint", at: [3, 0] });
  // At (0.4, 0.2): √(0.16 + 0.04) ≈ 0.45 from (0, 0), 2.6 from the midpoint: the endpoint.
  assert.deepEqual(snapOnSketch(d, line(sketch), [0.4, 0.2], [0, 0], 1), { kind: "endpoint", at: [0, 0] });
});

test("hand-worked: a circle's centre is a centre, an arc's end an endpoint", () => {
  const { doc, sketch } = blank();
  let d = drawCircle(doc, sketch, [50, 50], 7).doc;
  d = drawArc(d, sketch, [-10, 0], [0, 10], [-10, 10]).doc;
  assert.deepEqual(snapOnSketch(d, line(sketch), [50.3, 49.6], [50, 50], 0.1), { kind: "centre", at: [50, 50] });
  assert.deepEqual(snapOnSketch(d, line(sketch), [-9.8, 10.1], [-10, 10], 0.1), { kind: "centre", at: [-10, 10] });
  assert.deepEqual(snapOnSketch(d, line(sketch), [0.2, 9.9], [0, 10], 0.1), { kind: "endpoint", at: [0, 10] });
});

test("hand-worked: drawing on from (33, 0), a pointer near its column snaps vertical", () => {
  const { doc, sketch } = oneLine();
  const from = pointAt(sketchOf(doc, sketch), [33, 0])!;
  // Reach 5 mm. The pointer (34.2, 27) is 1.2 mm off x = 33 and far from every point, so x is 33 (from the chain's
  // last point) and y the grid's 30: the line (33, 0) → (33, 30) is vertical.
  const s = snapOnSketch(doc, line(sketch, from), [34.2, 27], [30, 30], 0.5);
  assert.deepEqual(s, { kind: "aligned", at: [33, 30], column: [33, 0], row: null });
  assert.equal(snapLabel(s), "vertical from 33,0");
  // (12, 1.5) is 1.5 off the row y = 0, but √(4.5² + 1.5²) ≈ 4.74 ≤ 5 from the midpoint (16.5, 0): a point beats a line-up.
  assert.equal(snapOnSketch(doc, line(sketch, from), [12, 1.5], [10, 0], 0.5).kind, "midpoint");
  // (8, 1.5): 8.6 from the midpoint, 8.1 from (0, 0); 1.5 off the row y = 0 of both ends, 8 off column x = 0: horizontal.
  assert.deepEqual(snapOnSketch(doc, line(sketch, from), [8, 1.5], [10, 0], 0.5), { kind: "aligned", at: [10, 0], column: null, row: [0, 0] });
});

test("hand-worked: a column from one point and a row from another meet, closing a corner", () => {
  const { doc, sketch } = blank();
  let d = drawLine(doc, sketch, [0, 0], [33, 0]).doc;
  const corner = pointAt(sketchOf(d, sketch), [33, 0])!;
  d = drawLine(d, sketch, corner, [33, 21]).doc;
  // Reach 5 mm. The pointer (1.5, 22): 22 mm or more from every point and midpoint; 1.5 off x = 0 (the point (0, 0))
  // and 1 off y = 21 (the point (33, 21)), so it lands on (0, 21), not the grid's (0, 20).
  const s = snapOnSketch(d, line(sketch), [1.5, 22], [0, 20], 0.5);
  assert.deepEqual(s, { kind: "aligned", at: [0, 21], column: [0, 0], row: [33, 21] });
  assert.equal(snapLabel(s), "vertical from 0,0 and horizontal from 33,21");
});

test("lined up with one point's column and row both is that point, by its own name", () => {
  const targets: SnapTargets = { points: [{ at: [0, 0], kind: "endpoint" }], columns: [[0, 0]], rows: [[0, 0]], own: [] };
  // (8, 8) is √128 ≈ 11.3 from (0, 0), out of the 10 mm reach, but 8 off its column and its row.
  assert.deepEqual(snapPointer([8, 8], [10, 10], targets, 1), { kind: "endpoint", at: [0, 0] });
});

test("the reach's boundary: 0.9 × SNAP_PIXELS snaps, 1.1 × does not, for points, columns and rows", () => {
  const pixel = 0.25; // reach 2.5 mm
  const reach = SNAP_PIXELS * pixel;
  const point: SnapTargets = { points: [{ at: [0, 0], kind: "endpoint" }], columns: [], rows: [], own: [] };
  // Along (0.6, 0.8), a unit direction (0.36 + 0.64 = 1): the pointer is 0.9 and 1.1 reaches from the point.
  assert.equal(snapPointer([0.6 * 0.9 * reach, 0.8 * 0.9 * reach], [5, 5], point, pixel).kind, "endpoint");
  assert.equal(snapPointer([0.6 * 1.1 * reach, 0.8 * 1.1 * reach], [5, 5], point, pixel).kind, "grid");
  const column: SnapTargets = { points: [], columns: [[0, 0]], rows: [], own: [] };
  assert.equal(snapPointer([0.9 * reach, 40], [5, 40], column, pixel).kind, "aligned");
  assert.equal(snapPointer([1.1 * reach, 40], [5, 40], column, pixel).kind, "grid");
  const row: SnapTargets = { points: [], columns: [], rows: [[0, 0]], own: [] };
  assert.equal(snapPointer([40, -0.9 * reach], [40, 0], row, pixel).kind, "aligned");
  assert.equal(snapPointer([40, -1.1 * reach], [40, 0], row, pixel).kind, "grid");
});

test("exactly at the reach still snaps, to a point, a column and a row", () => {
  // Pixel 0.5: reach 5 mm. (3, 4) from the point is √25 = 5 exactly; 5 off the column and the row exactly.
  const point: SnapTargets = { points: [{ at: [0, 0], kind: "endpoint" }], columns: [], rows: [], own: [] };
  assert.equal(snapPointer([3, 4], [10, 10], point, 0.5).kind, "endpoint");
  assert.equal(snapPointer([5, 40], [10, 40], { points: [], columns: [[0, 0]], rows: [], own: [] }, 0.5).kind, "aligned");
  assert.equal(snapPointer([40, 5], [40, 10], { points: [], columns: [], rows: [[0, 0]], own: [] }, 0.5).kind, "aligned");
});

test("an unknown or nonsense pixel size snaps to the grid only", () => {
  const { doc, sketch } = oneLine();
  for (const pixel of [undefined, 0, -1, NaN, Infinity]) assert.deepEqual(snapOnSketch(doc, line(sketch), [33, 0], [30, 0], pixel), { kind: "grid", at: [30, 0] });
});

test("an empty sketch snaps to the grid, and an unknown sketch is refused", () => {
  const { doc, sketch } = blank();
  assert.deepEqual(snapOnSketch(doc, line(sketch), [0.1, 0.1], [0, 0], 1), { kind: "grid", at: [0, 0] });
  assert.throws(() => snapOnSketch(doc, line("sketch-99"), [0, 0], [0, 0], 1), /no sketch sketch-99/);
});

test("the line tool never snaps onto its own last point, by a point or by lining up", () => {
  const { doc, sketch } = oneLine();
  const from = pointAt(sketchOf(doc, sketch), [33, 0])!;
  const targets = snapTargets(sketchOf(doc, sketch), line(sketch, from));
  assert.ok(!targets.points.some((t) => t.at[0] === 33 && t.at[1] === 0), "a click there would draw nothing");
  // (33.5, 0.5) is 0.5 off its column and its row (and (0, 0)'s row): lined up, that is (33, 0) itself, so the grid's (30, 0).
  assert.deepEqual(snapOnSketch(doc, line(sketch, from), [33.5, 0.5], [30, 0], 0.5), { kind: "grid", at: [30, 0] });
  // A chain's first click not yet a point lines up too: from (−50, 50), the pointer (−49, 80) snaps vertical.
  assert.deepEqual(snapOnSketch(doc, line(sketch, [-50, 50]), [-49, 80], [-50, 80], 0.5), { kind: "aligned", at: [-50, 80], column: [-50, 50], row: null });
});

test("the rectangle never lines up with its first corner's column or row, where a second corner draws nothing", () => {
  const { doc, sketch } = oneLine();
  const rect: RectangleTool = { kind: "rectangle", sketch, corner: [0, 0] };
  const targets = snapTargets(sketchOf(doc, sketch), rect);
  // (0, 0) is the first corner (and a point): neither a target nor a column or row. (33, 0) shares its row, so it
  // is a column but not a row.
  assert.deepEqual(targets.columns, [[33, 0]]);
  assert.deepEqual(targets.rows, []);
  assert.ok(!targets.points.some((t) => t.at[0] === 0 && t.at[1] === 0));
  // The pointer (2, 18), 2 mm off the corner's column: the grid's (0, 20), not a line-up.
  assert.equal(snapOnSketch(doc, rect, [2, 18], [0, 20], 0.5).kind, "grid");
  // The pointer (32, 18): x lines up with (33, 0), y is the grid's 20; a 33 × 20 rectangle.
  assert.deepEqual(snapOnSketch(doc, rect, [32, 18], [30, 20], 0.5).at, [33, 20]);
});

test("the circle lines its radius up with its centre (a level radius), and never snaps onto the centre", () => {
  const { doc, sketch } = oneLine();
  const circle: CircleTool = { kind: "circle", sketch, centre: [0, 50] };
  assert.deepEqual(snapOnSketch(doc, circle, [25, 51.2], [30, 50], 0.5), { kind: "aligned", at: [30, 50], column: null, row: [0, 50] });
  assert.deepEqual(snapOnSketch(doc, circle, [0.3, 50.3], [0, 50], 0.5), { kind: "grid", at: [0, 50] });
});

test("the arc tool never snaps onto its own start or end, and lines up with them", () => {
  const { doc, sketch } = oneLine();
  const arc: SketchTool = { kind: "arc", sketch, start: [0, 50], end: [40, 50] };
  const targets = snapTargets(sketchOf(doc, sketch), arc);
  assert.deepEqual(targets.own, [[0, 50], [40, 50]]);
  // Reach 5 mm. (0.3, 50.2) is on the start: a third point there draws nothing, so the grid's (0, 50) unnamed.
  assert.deepEqual(snapOnSketch(doc, arc, [0.3, 50.2], [0, 50], 0.5), { kind: "grid", at: [0, 50] });
  // (40.6, 70) is 0.6 off the end's column: vertical from (40, 50), y the grid's 70.
  assert.deepEqual(snapOnSketch(doc, arc, [40.6, 70], [40, 70], 0.5), { kind: "aligned", at: [40, 70], column: [40, 50], row: null });
  // Before its end, the start alone is its own: the end lines up level with it, (25, 50.8) → (30, 50) on grid x.
  assert.deepEqual(snapOnSketch(doc, { kind: "arc", sketch, start: [0, 50], end: null }, [25, 50.8], [30, 50], 0.5), { kind: "aligned", at: [30, 50], column: null, row: [0, 50] });
});

test("a click where the snap landed shares the point: a midpoint snap makes a point, an endpoint snap back on it ends the chain", () => {
  const { doc, sketch } = oneLine();
  let tool: SketchTool = line(sketch);
  let d = doc;
  // Click 1 near the midpoint: the chain starts at (16.5, 0), off the grid.
  const first = snapOnSketch(d, tool, [16.2, 0.3], [20, 0], 0.1);
  assert.deepEqual(first.at, [16.5, 0]);
  ({ doc: d, tool } = clickAt(d, tool, first.at));
  // Click 2 on the grid at (20, 30); click 3 back near (16.5, 0): it snaps there exactly and ends the chain on that point.
  ({ doc: d, tool } = clickAt(d, tool, [20, 30]));
  const back = snapOnSketch(d, tool, [16.6, -0.2], [20, 0], 0.1);
  assert.deepEqual(back, { kind: "endpoint", at: [16.5, 0] });
  const pointsBefore = sketchOf(d, sketch).points.length;
  const done = clickAt(d, tool, back.at);
  assert.equal(done.drew, true);
  assert.equal(sketchOf(done.doc, sketch).points.length, pointsBefore, "no new point: the line ended on (16.5, 0)");
  assert.equal((done.tool as LineTool).from, null, "landing on a point the sketch had ends the chain");
});

test("hand-worked marks: a square round an endpoint, a triangle round a midpoint, a circle round a centre, MARK_PIXELS out", () => {
  // Pixel 1/7 mm: MARK_PIXELS (7) px is 1 mm (7 × (1/7) is exactly 1 in doubles).
  assert.equal(MARK_PIXELS, 7);
  const px = 1 / 7;
  const square = snapMarks({ kind: "endpoint", at: [33, 0] }, px).map(([a]) => a);
  assert.deepEqual(square, [[32, -1], [34, -1], [34, 1], [32, 1]]);
  const tri = snapMarks({ kind: "midpoint", at: [10, 10] }, px);
  assert.deepEqual(tri.map(([a]) => a), [[9, 9], [11, 9], [10, 11]]);
  assert.deepEqual(tri[2][1], [9, 9], "closed");
  const ring = snapMarks({ kind: "centre", at: [0, 0] }, px);
  assert.equal(ring.length, 16);
  for (const [a] of ring) assert.ok(Math.abs(Math.sqrt(a[0] ** 2 + a[1] ** 2) - 1) < 1e-12, "every corner 1 mm out");
  assert.deepEqual(snapMarks({ kind: "grid", at: [0, 0] }, 0.2), []);
});

test("hand-worked marks: a line-up's dashed guide runs from the point to 30 px past the pointer, with a cross at the pointer", () => {
  // Pixel 0.2: dashes 6 px = 1.2 mm with 4 px = 0.8 mm gaps; 30 px past = 6 mm, so the guide runs (33, 0) → (33, 36),
  // 36 mm in 2 mm steps: 18 dashes, the first (33, 0) → (33, 1.2), the last from y = 34 to 35.2. The cross is two
  // segments ±7 px = ±1.4 mm about (33, 30).
  const marks = snapMarks({ kind: "aligned", at: [33, 30], column: [33, 0], row: null }, 0.2);
  const [cross, guide] = [marks.slice(0, 2), marks.slice(2)];
  const near = (p: SketchXY, q: SketchXY) => Math.abs(p[0] - q[0]) < 1e-9 && Math.abs(p[1] - q[1]) < 1e-9;
  const want: SketchXY[][] = [[[31.6, 28.6], [34.4, 31.4]], [[31.6, 31.4], [34.4, 28.6]]];
  cross.forEach((seg, i) => assert.ok(near(seg[0], want[i][0]) && near(seg[1], want[i][1]), `cross ${i}: ${seg}`));
  assert.equal(guide.length, 18);
  assert.ok(near(guide[0][0], [33, 0]) && near(guide[0][1], [33, 1.2]), `first dash ${guide[0]}`);
  assert.ok(near(guide[17][0], [33, 34]) && near(guide[17][1], [33, 35.2]), `last dash ${guide[17]}`);
  // A guide pointing the other way (a row to the left of its point) runs on to the left.
  // From x = 20 to −16 (6 mm past −10) is 36 mm again: 18 dashes, the last from x = 20 − 34 = −14 to −15.2.
  const left = snapMarks({ kind: "aligned", at: [-10, 5], column: null, row: [20, 5] }, 0.2).slice(2);
  assert.equal(left.length, 18);
  assert.ok(near(left[17][0], [-14, 5]) && near(left[17][1], [-15.2, 5]), `last dash ${left[17]}`);
});

test("a very long guide keeps to at most 400 dashes", () => {
  const marks = snapMarks({ kind: "aligned", at: [0, 100000], column: [0, 0], row: null }, 0.01);
  assert.ok(marks.length - 2 <= 400, `${marks.length - 2} dashes`);
});

test("snapLabel names every kind; the grid has no label", () => {
  assert.equal(snapLabel({ kind: "grid", at: [1, 2] }), "");
  assert.equal(snapLabel({ kind: "endpoint", at: [10, 0] }), "endpoint 10,0");
  assert.equal(snapLabel({ kind: "midpoint", at: [16.5, 0] }), "midpoint 16.5,0");
  assert.equal(snapLabel({ kind: "centre", at: [0, -3] }), "centre 0,-3");
  assert.equal(snapLabel({ kind: "aligned", at: [10, 0], column: null, row: [0, 0] }), "horizontal from 0,0");
});

test("withSnap shows the snap only on the sketch being edited, and nothing for the grid", () => {
  const plane = { origin: [0, 0, 0], normal: [0, 0, 1], xAxis: [1, 0, 0] } as SketchDrawing["plane"];
  const drawings: SketchDrawing[] = [{ plane, lines: [] }, { plane, lines: [], editing: { grid: 10, points: [], preview: [] } }];
  const snap: Snap = { kind: "endpoint", at: [0, 0] };
  const shown = withSnap(drawings, snap, 0.2);
  assert.equal(shown[0], drawings[0]);
  assert.deepEqual(shown[1].editing?.snap, { label: "endpoint 0,0", marks: snapMarks(snap, 0.2) });
  assert.equal(withSnap(drawings, { kind: "grid", at: [0, 0] }, 0.2), drawings);
  assert.equal(withSnap(drawings, null, 0.2), drawings);
  assert.equal(withSnap(drawings, snap, undefined), drawings);
});

/** Mulberry32: a small seeded generator, so a failing case replays from its seed. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The model: what the pointer snaps to, worked from the drawn curves
 * (sketchCurves' coordinates) rather than the sketch's point list. Every
 * line end and arc end is an endpoint, every circle or arc centre that is
 * no end a centre, every line's middle a midpoint; the tool's own
 * click is no target. Nearest within reach wins, an endpoint or centre
 * before a midpoint at the same place. Else the nearest column and row
 * within reach (the own clicks included, the rectangle's corner's column
 * and row not), else the grid; lined up onto an own click is the grid.
 */
function model(sketch: Sketch, owns: SketchXY[], rectangle: boolean, raw: SketchXY, grid: SketchXY, reach: number): { kind: string; at: SketchXY } {
  const c = sketchCurves(sketch);
  const key = (p: SketchXY) => `${p[0]},${p[1]}`;
  const ends = new Map<string, SketchXY>();
  for (const l of c.lines) [l.a, l.b].forEach((p) => ends.set(key(p), p));
  for (const a of c.arcs) [a.start, a.end].forEach((p) => ends.set(key(p), p));
  const centres = new Map<string, SketchXY>();
  for (const x of [...c.circles.map((k) => k.centre), ...c.arcs.map((a) => a.centre)]) if (!ends.has(key(x))) centres.set(key(x), x);
  const mids = c.lines.map((l): SketchXY => [(l.a[0] + l.b[0]) / 2, (l.a[1] + l.b[1]) / 2]);
  const rank = { endpoint: 0, centre: 0, midpoint: 1 } as const;
  const all = [...[...ends.values()].map((at) => ({ at, kind: "endpoint" as const })), ...[...centres.values()].map((at) => ({ at, kind: "centre" as const })), ...mids.map((at) => ({ at, kind: "midpoint" as const }))].filter((t) => !owns.some((o) => key(o) === key(t.at)));
  const d = (p: SketchXY) => Math.sqrt((p[0] - raw[0]) ** 2 + (p[1] - raw[1]) ** 2);
  const within = all.filter((t) => d(t.at) <= reach).sort((a, b) => d(a.at) - d(b.at) || rank[a.kind] - rank[b.kind]);
  if (within.length) return { kind: within[0].kind, at: within[0].at };
  const extra = new Map(owns.filter((o) => !ends.has(key(o)) && !centres.has(key(o))).map((o) => [key(o), o]));
  const refs = [...ends.values(), ...centres.values(), ...extra.values()];
  const own = rectangle ? owns[0] : undefined;
  const pick = (axis: 0 | 1) =>
    refs.filter((r) => !(rectangle && own && r[axis] === own[axis]) && Math.abs(r[axis] - raw[axis]) <= reach).sort((a, b) => Math.abs(a[axis] - raw[axis]) - Math.abs(b[axis] - raw[axis]))[0] ?? null;
  const [col, row] = [pick(0), pick(1)];
  if (!col && !row) return { kind: "grid", at: grid };
  const at: SketchXY = [col ? col[0] : grid[0], row ? row[1] : grid[1]];
  if (owns.some((o) => key(o) === key(at))) return { kind: "grid", at: grid };
  const on = all.filter((t) => key(t.at) === key(at)).sort((a, b) => rank[a.kind] - rank[b.kind])[0];
  return on ? { kind: on.kind, at: on.at } : { kind: "aligned", at };
}

test("seeded random sketches, tools and pointers: the snap matches the model, and a click there shares the point", () => {
  const kinds = { endpoint: 0, midpoint: 0, centre: 0, aligned: 0, grid: 0 } as Record<string, number>;
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const random = rng(seed);
    const lattice = () => Math.round((random() * 40 - 20) * 2) / 2 + 0; // half-mm steps, so points and middles coincide often (+ 0: no −0)
    for (let round = 0; round < 60; round++) {
      let { doc, sketch } = blank();
      const n = 1 + Math.floor(random() * 6);
      for (let k = 0; k < n; k++) {
        const roll = random();
        const pts = sketchOf(doc, sketch).points;
        // Half the time a curve starts at a point already there, so ends are shared.
        const from = pts.length && random() < 0.5 ? pts[Math.floor(random() * pts.length)].id : ([lattice(), lattice()] as const);
        try {
          if (roll < 0.6) doc = drawLine(doc, sketch, from, [lattice(), lattice()]).doc;
          else if (roll < 0.8) doc = drawCircle(doc, sketch, from, 1 + random() * 5).doc;
          else doc = drawArc(doc, sketch, from, [lattice(), lattice()], [lattice(), lattice()]).doc;
        } catch {
          // A zero-length line or an arc round its own end: refused, as in the sketcher.
        }
      }
      const s = sketchOf(doc, sketch);
      const pts = s.points;
      const roll = random();
      // A first click: none, on a point the sketch has, or anywhere on the half-mm lattice; an arc may have a second.
      const click = (): SketchXY | null => (random() < 0.3 ? null : pts.length && random() < 0.5 ? (([p]) => [p.x, p.y] as SketchXY)([pts[Math.floor(random() * pts.length)]]) : [lattice(), lattice()]);
      const own = click();
      const ownId = own ? pointAt(s, own) : null;
      const second = own ? click() : null;
      const tool: SketchTool =
        roll < 0.4 ? line(sketch, own ? (ownId ?? own) : null) : roll < 0.6 ? { kind: "rectangle", sketch, corner: own } : roll < 0.8 ? { kind: "circle", sketch, centre: own } : { kind: "arc", sketch, start: own, end: second };
      const owns = [own, tool.kind === "arc" ? second : null].filter((p) => p !== null);
      const pixel = 0.02 + random() * 0.5;
      const reach = SNAP_PIXELS * pixel;
      for (let p = 0; p < 20; p++) {
        // Half the pointers near a point (within 1.5 reaches), half anywhere.
        const near = pts.length && random() < 0.5 ? pts[Math.floor(random() * pts.length)] : null;
        const raw: SketchXY = near ? [near.x + (random() * 3 - 1.5) * reach, near.y + (random() * 3 - 1.5) * reach] : [random() * 50 - 25, random() * 50 - 25];
        const grid: SketchXY = [Math.round(raw[0] / 5) * 5 + 0, Math.round(raw[1] / 5) * 5 + 0];
        const got = snapOnSketch(doc, tool, raw, grid, pixel);
        const want = model(s, owns, tool.kind === "rectangle", raw, grid, reach);
        const where = `seed ${seed} round ${round} pointer ${p}: ${JSON.stringify({ raw, own, tool: tool.kind, pixel })}`;
        assert.equal(got.kind, want.kind, where);
        assert.deepEqual(got.at, want.at, where);
        kinds[got.kind]++;
        // An endpoint or centre snap is a point the sketch has, exactly; a line tool's click there ends on it.
        if (got.kind === "endpoint" || got.kind === "centre") {
          const id = pointAt(s, got.at);
          assert.ok(id, where);
          if (tool.kind === "line" && tool.from !== null) {
            const done = clickAt(doc, tool, got.at);
            const drawn = sketchOf(done.doc, sketch).curves.at(-1)!;
            assert.ok(done.drew && drawn.kind === "line" && drawn.end === id, where);
          }
        }
      }
    }
  }
  // Every kind of snap came up often enough to be tested.
  for (const [kind, count] of Object.entries(kinds)) assert.ok(count >= 50, `${kind}: only ${count}`);
});

test("startTool's fresh tools have no own click: everything is a target", () => {
  const { doc, sketch } = oneLine();
  for (const kind of ["line", "rectangle", "circle", "arc"] as const) {
    const t = snapTargets(sketchOf(doc, sketch), startTool(kind, sketch));
    assert.equal(t.points.length, 3, `${kind}: two ends and a midpoint`);
    assert.equal(t.columns.length, 2);
    assert.equal(t.rows.length, 2);
  }
});
