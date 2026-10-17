// Step 23b: the 3-point arc tool (sketch-tool.ts `arcThrough`, the arc's
// clicks): hand-worked centres, the notes for clicks that make no arc, the
// rounding bound at 0.9× and 1.1×, and seeded sessions on whole and decimal
// grids checked against a model that works in whole grid steps.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SketchXY } from "@fission/core";
import { partDocument, readDesignDocument, type DesignDocument } from "../src/document.ts";
import { addSketch, drawRectangle, sketchCurves } from "../src/sketch.ts";
import { arcSegments, arcThrough, clickAt, drawStep, previewSegments, sketchDrawings, toolBusy, type ArcTool } from "../src/sketch-tool.ts";

function freshArc(doc?: DesignDocument) {
  const s = addSketch(doc ?? partDocument("box", 40, 30, 20));
  return { doc: s.doc, tool: { kind: "arc", sketch: s.id, start: null, end: null } as ArcTool };
}

function clicks(doc: DesignDocument, tool: ArcTool, at: SketchXY[]) {
  let drew = 0;
  let note: string | undefined;
  for (const p of at) {
    const r = clickAt(doc, tool, p);
    ({ doc, tool, note } = r);
    if (r.drew) drew++;
  }
  return { doc, tool, drew, note };
}

const dist = (a: SketchXY, b: SketchXY) => Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2);

test("hand-worked: ends (−4, 0) and (4, 0) through (0, −2) make the arc round (0, 3) of radius 5", () => {
  // The centre is on x = 0, the line midway between the ends, at (0, t).
  // Its distance to (−4, 0) and to (0, −2) are equal: 16 + t² = (t + 2)²
  // = t² + 4t + 4, so 4t = 12, t = 3, and the radius is √(16 + 9) = 5.
  // (0, −2) is below, on the right of (−4, 0) → (4, 0), and the arc that
  // runs counter-clockwise round (0, 3) from (−4, 0) to (4, 0) dips through
  // the bottom of the circle, through (0, −2): no swap.
  const f = freshArc();
  const r = clicks(f.doc, f.tool, [[-4, 0], [4, 0], [0, -2]]);
  assert.equal(r.drew, 1);
  assert.equal(r.note, undefined);
  const sketch = r.doc.sketches[0];
  // feature-1 and sketch-2 are taken: the start is point-3, the end point-4, the centre point-5, the arc arc-6.
  assert.deepEqual(sketch.points, [
    { id: "point-3", x: -4, y: 0 },
    { id: "point-4", x: 4, y: 0 },
    { id: "point-5", x: 0, y: 3 },
  ]);
  assert.deepEqual(sketch.curves, [{ id: "arc-6", kind: "arc", start: "point-3", end: "point-4", centre: "point-5" }]);
  assert.deepEqual(sketchCurves(sketch).arcs, [{ start: [-4, 0], end: [4, 0], centre: [0, 3] }]);
  assert.equal(drawStep(r.tool), "Draw arc", "one undo step, named for the tool");
  assert.deepEqual(r.tool, f.tool, "ready for the next arc");
});

test("hand-worked: the same ends through (0, 2) swap, so the arc still runs counter-clockwise, round (0, −3)", () => {
  // The mirror image of the last test in the x axis: centre (0, −3),
  // radius 5. (0, 2) is on the left of (−4, 0) → (4, 0); counter-clockwise
  // round (0, −3) the arc through the top of the circle runs from (4, 0) to
  // (−4, 0), so (4, 0) is the start: it takes the first id.
  const f = freshArc();
  const sketch = clicks(f.doc, f.tool, [[-4, 0], [4, 0], [0, 2]]).doc.sketches[0];
  assert.deepEqual(sketch.points, [
    { id: "point-3", x: 4, y: 0 },
    { id: "point-4", x: -4, y: 0 },
    { id: "point-5", x: 0, y: -3 },
  ]);
  assert.deepEqual(sketch.curves, [{ id: "arc-6", kind: "arc", start: "point-3", end: "point-4", centre: "point-5" }]);
});

test("hand-worked: a right angle at the third click puts the centre midway between the ends (Thales)", () => {
  // (0, 0), (10, 10) through (10, 0): the angle at (10, 0) is a right
  // angle, so the ends are a diameter apart and the centre is their
  // midpoint (5, 5), radius √50. The formula's k is (|p − m|² − |d|²/4) /
  // (2·cross) = (50 − 200/4) / … = 0: exactly the midpoint, no rounding.
  // (10, 0) is on the right of (0, 0) → (10, 10) (cross 10·0 − 10·10 =
  // −100 < 0), so the ends keep their order.
  assert.deepEqual(arcThrough([0, 0], [10, 10], [10, 0]), { start: [0, 0], end: [10, 10], centre: [5, 5] });
  // The other side, (0, 10): the same circle, the ends swapped.
  assert.deepEqual(arcThrough([0, 0], [10, 10], [0, 10]), { start: [10, 10], end: [0, 0], centre: [5, 5] });
});

test("an arc closing a rectangle's open side shares its corners; a centre exactly on a point shares it", () => {
  // A rectangle (0, 0)–(20, 10) takes point-3…point-6 and line-7…line-10 after sketch-2.
  const f = freshArc();
  const rect = drawRectangle(f.doc, f.tool.sketch, [0, 0], [20, 10]).doc;
  // Ends (0, 0) and (20, 0) through (10, −10): the centre is (10, t) with
  // 100 + t² = (t + 10)², t = 0: the centre (10, 0), not yet a point, so new.
  const r = clicks(rect, f.tool, [[0, 0], [20, 0], [10, -10]]);
  const sketch = r.doc.sketches[0];
  assert.equal(sketch.points.length, 5, "the four corners shared, one new centre");
  assert.deepEqual(sketch.points.at(-1), { id: "point-11", x: 10, y: 0 });
  assert.deepEqual(sketch.curves.at(-1), { id: "arc-12", kind: "arc", start: "point-3", end: "point-4", centre: "point-11" });
  // A second arc with ends (20, 10) and (0, 10) through (0, −10): the centre
  // is (10, t) with 100 + (t − 10)² = 100 + (t + 10)², so t = 0: (10, 0)
  // again, exactly, and shared.
  const again = clicks(r.doc, r.tool, [[20, 10], [0, 10], [0, -10]]).doc.sketches[0];
  assert.equal(again.points.length, 5, "no new point: both ends and the centre shared, the third click not kept");
  // (0, −10) is on the left of (20, 10) → (0, 10) (cross (−20)(−20) − 0·(−20) = 400 > 0), so the ends swap:
  // start (0, 10), point-8, end (20, 10), point-6.
  assert.deepEqual(again.curves.at(-1), { id: "arc-13", kind: "arc", start: "point-8", end: "point-6", centre: "point-11" });
});

test("clicks that make no arc draw nothing and say why; the tool keeps what it had", () => {
  const f = freshArc();
  const one = clickAt(f.doc, f.tool, [10, 10]);
  const same = clickAt(one.doc, one.tool, [10, 10]);
  assert.equal(same.drew, false);
  assert.match(same.note ?? "", /^An arc needs two ends/);
  assert.deepEqual(same.tool, one.tool, "still waiting for the end");
  const two = clickAt(one.doc, one.tool, [30, 10]);
  assert.equal(two.note, undefined);
  for (const p of [[10, 10], [30, 10], [20, 10], [50, 10], [-40, 10]] as SketchXY[]) {
    const r = clickAt(two.doc, two.tool, p);
    assert.equal(r.drew, false, `(${p}) makes no bend`);
    assert.match(r.note ?? "", /^An arc needs to bend/, `(${p})`);
    assert.deepEqual(r.tool, two.tool, "still waiting for the third click");
    assert.equal(r.doc, two.doc, "the document untouched");
  }
  assert.equal(toolBusy(two.tool), true);
  assert.equal(clickAt(two.doc, two.tool, [20, 11]).drew, true, "one step off the line bends");
});

test("hand-worked: three nodes of a 0.1 mm grid on one line are refused, though rounding leaves a cross product", () => {
  // The kernel snaps a 0.1 grid's nodes to k / 10: (0.1, 0.1), (0.2, 0.3)
  // and (0.3, 0.5) are on y = 2x − 0.1, but the doubles nearest them are
  // not, so the cross product comes out 1.39e-17, not 0.
  const [a, b, p]: SketchXY[] = [[1 / 10, 1 / 10], [2 / 10, 3 / 10], [3 / 10, 5 / 10]];
  const cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
  assert.notEqual(cross, 0, "rounding left something");
  assert.equal(arcThrough(a, b, p), null);
  // One node off the line, (0.3, 0.4): a cross product of about 0.1 × 0.3 − 0.2 × 0.2 = −0.01, far above rounding.
  assert.notEqual(arcThrough(a, b, [3 / 10, 4 / 10]), null);
});

test("the rounding bound at 0.9× (refused) and 1.1× (an arc)", () => {
  // Ends (0, 0) and (1, 0), third click (1, y) with y tiny: the
  // differences are (1, 0) and (1, y), the largest coordinate 1, so
  // η = 2ε and the bound is 2ε·(1 + 0 + 1 + y) + 2·(2ε)² + ε·(|1·y| + 0)
  // = 4ε + 3εy + 8ε². The cross product is 1·y − 0·1 = y. With y near 4ε,
  // 3εy + 8ε² is about 20ε², under a part in 10¹⁴ of the bound.
  const e = Number.EPSILON;
  const bound = 4 * e + 3 * e * (4 * e) + 8 * e * e;
  assert.equal(arcThrough([0, 0], [1, 0], [1, 0.9 * bound]), null, "0.9×: could be rounding");
  const arc = arcThrough([0, 0], [1, 0], [1, 1.1 * bound]);
  assert.notEqual(arc, null, "1.1×: an arc");
  // y > 0 is on the left of (0, 0) → (1, 0): the ends swap.
  assert.deepEqual([arc!.start, arc!.end], [[1, 0], [0, 0]]);
});

test("the preview: a line to the pointer, then the arc through it, the chord while it makes no bend; both ends drawn as points", () => {
  const f = freshArc();
  assert.deepEqual(previewSegments(f.doc, f.tool, [5, 5]), [], "nothing before the start");
  const one = clickAt(f.doc, f.tool, [-4, 0]);
  assert.deepEqual(previewSegments(one.doc, one.tool, [4, 0]), [[[-4, 0], [4, 0]]]);
  assert.deepEqual(previewSegments(one.doc, one.tool, [-4, 0]), [], "none on the start");
  const two = clickAt(one.doc, one.tool, [4, 0]);
  assert.deepEqual(previewSegments(two.doc, two.tool, [0, -2]), arcSegments({ start: [-4, 0], end: [4, 0], centre: [0, 3] }));
  assert.deepEqual(previewSegments(two.doc, two.tool, [8, 0]), [[[-4, 0], [4, 0]]]);
  const d = sketchDrawings(two.doc, { tool: two.tool, grid: 1, pointer: [0, -2] })[0];
  assert.deepEqual(d.editing?.points, [[-4, 0], [4, 0]], "the two ends before they are points");
  assert.deepEqual(d.editing?.preview, arcSegments({ start: [-4, 0], end: [4, 0], centre: [0, 3] }));
});

/** Mulberry32: a small seeded generator, so a failing session replays from its seed. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("seeded sessions of three clicks on whole and decimal grids match a model that works in whole grid steps", () => {
  // The kernel's nodes: k·s, or k / n when s = 1/n (sketch.rs snap_to_grid).
  const grids: { node: (k: number) => number; size: number }[] = [
    { node: (k) => k * 10, size: 10 },
    { node: (k) => k * 1, size: 1 },
    { node: (k) => k / 10, size: 0.1 },
    { node: (k) => k / 4, size: 0.25 },
    { node: (k) => k * 2.5, size: 2.5 },
    { node: (k) => k / 1000, size: 0.001 },
  ];
  let arcs = 0;
  let refused = 0;
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const random = rng(seed);
    for (const grid of grids) {
      const f = freshArc();
      let doc = f.doc;
      const points = new Map<string, number>(); // the model's points, by whole-step "i,j", with how many arcs use them
      for (let n = 0; n < 60; n++) {
        // Three nodes in a 9 × 9 patch somewhere within ±1000 steps, so the patch is often far from the origin.
        const [ox, oy] = [Math.floor(random() * 2001) - 1000, Math.floor(random() * 2001) - 1000];
        const k = () => [ox + Math.floor(random() * 9), oy + Math.floor(random() * 9)] as const;
        const [a, b, p] = [k(), k(), k()];
        const xy = (q: readonly [number, number]): SketchXY => [grid.node(q[0]), grid.node(q[1])];
        const where = `seed ${seed}, grid ${grid.size}, arc ${n}: (${a}) (${b}) (${p})`;
        let r = clicks(doc, f.tool, [xy(a), xy(b)]);
        if (a[0] === b[0] && a[1] === b[1]) {
          assert.match(r.note ?? "", /^An arc needs two ends/, where);
          continue;
        }
        r = clicks(r.doc, r.tool, [xy(p)]);
        // The model: the cross product in whole steps, exact in doubles at these sizes.
        const [dx, dy, vx, vy] = [b[0] - a[0], b[1] - a[1], p[0] - a[0], p[1] - a[1]];
        const cross = dx * vy - dy * vx;
        if (cross === 0) {
          assert.equal(r.drew, 0, where);
          assert.match(r.note ?? "", /^An arc needs to bend/, where);
          refused++;
          continue;
        }
        assert.equal(r.drew, 1, where);
        doc = r.doc;
        arcs++;
        // The model's centre in steps: m + d⊥·k with k = (|2p − a − b|² − |d|²) / (8·cross), whole numbers until the one division.
        const top = (2 * p[0] - a[0] - b[0]) ** 2 + (2 * p[1] - a[1] - b[1]) ** 2 - (dx * dx + dy * dy);
        const kk = top / (8 * cross);
        const centre: SketchXY = [grid.node(1) * ((a[0] + b[0]) / 2 - dy * kk), grid.node(1) * ((a[1] + b[1]) / 2 + dx * kk)];
        const [start, end] = cross < 0 ? [xy(a), xy(b)] : [xy(b), xy(a)];
        const drawn = sketchCurves(doc.sketches[0]).arcs.at(-1)!;
        assert.deepEqual([drawn.start, drawn.end], [start, end], `${where}: counter-clockwise through the third click`);
        const radius = dist(centre, start);
        const scale = Math.max(radius, ...[...start, ...end].map(Math.abs));
        assert.ok(dist(drawn.centre, centre) <= 1e-9 * scale, `${where}: the centre ${drawn.centre} vs ${centre}`);
        // On the line midway between the ends, as check_arcs asks, to far better than its LINEAR (1e-5 mm).
        const chord = dist(start, end);
        const off = ((drawn.centre[0] - (start[0] + end[0]) / 2) * (end[0] - start[0]) + (drawn.centre[1] - (start[1] + end[1]) / 2) * (end[1] - start[1])) / chord;
        assert.ok(Math.abs(off) <= 1e-9 * scale, `${where}: ${off} off the midway line`);
        // Counter-clockwise from start to end, the arc bulges to the right of start → end: the third click must be there.
        const side = (end[0] - start[0]) * (xy(p)[1] - start[1]) - (end[1] - start[1]) * (xy(p)[0] - start[0]);
        assert.ok(side < 0, `${where}: the third click on the arc's side`);
        for (const q of [a, b]) points.set(`${q}`, 1);
      }
      const sketch = doc.sketches[0];
      assert.equal(new Set(sketch.points.map((q) => `${q.x},${q.y}`)).size, sketch.points.length, `seed ${seed}, grid ${grid.size}: no two points in one place`);
      for (const key of points.keys()) {
        const [i, j] = key.split(",").map(Number);
        assert.ok(sketch.points.some((q) => q.x === grid.node(i) && q.y === grid.node(j)), `seed ${seed}: the end (${key}) is a point`);
      }
      assert.deepEqual(readDesignDocument(JSON.parse(JSON.stringify(doc))), doc, `seed ${seed}, grid ${grid.size}: the session opens as saved`);
    }
  }
  assert.ok(arcs >= 2000, `the sessions drew ${arcs} arcs`);
  assert.ok(refused >= 50, `the sessions refused ${refused} in-line clicks`);
});
