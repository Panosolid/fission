// The centre arc tool (centre-arc.ts, through sketch-tool.ts): hand-worked
// arcs (a quarter each way, three quarters by sweeping, an end projected
// onto the circle, a centre off the origin), the notes for clicks that make
// no arc, points shared, the preview, and seeded sessions of hovers and a
// click checked against a model that adds up the turns it made the pointer
// take and never unwraps an angle.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SketchXY } from "@fission/core";
import { partDocument, readDesignDocument, type DesignDocument } from "../src/document.ts";
import { addSketch, drawLine, sketchCurves } from "../src/sketch.ts";
import { arcSegments, clickAt, drawStep, hoverTool, previewSegments, sketchDrawings, startTool, switchTool, toolBusy, type CentreArcTool, type SketchTool } from "../src/sketch-tool.ts";
import { angleAt, centreArc, NO_DIRECTION, NO_RADIUS, NO_TURN, sweep } from "../src/centre-arc.ts";
import { snapTargets } from "../src/snap.ts";

function fresh(doc?: DesignDocument) {
  const s = addSketch(doc ?? partDocument("box", 40, 30, 20));
  return { doc: s.doc, tool: startTool("centre", s.id) as CentreArcTool };
}

/** Clicks and hovers in order: a point is a click, `{ hover }` moves the pointer there. */
type Step = SketchXY | { hover: SketchXY };

function run<T extends SketchTool>(doc: DesignDocument, tool: T, steps: Step[]) {
  let drew = 0;
  let note: string | undefined;
  for (const s of steps) {
    if ("hover" in s) {
      tool = hoverTool(tool, s.hover);
      continue;
    }
    const r = clickAt(doc, tool, s);
    ({ doc, tool, note } = r);
    if (r.drew) drew++;
  }
  return { doc, tool, drew, note };
}

const lastArc = (doc: DesignDocument) => sketchCurves(doc.sketches[0]).arcs.at(-1)!;
const idAt = (doc: DesignDocument, at: SketchXY) => doc.sketches[0].points.find((p) => p.x === at[0] && p.y === at[1])?.id;

test("hand-worked: centre (0, 0), start (10, 0), a tap at (0, 5) is the quarter counter-clockwise to (0, 10)", () => {
  // The radius is |(10, 0)| = 10. The ray from the centre through (0, 5)
  // meets the circle at (0, 10): (0, 5)·(10 / 5). With no hover the tap is
  // the shorter way round, here a quarter turn counter-clockwise (the
  // pointer is at +90° from the start), so the arc runs (10, 0) → (0, 10).
  const f = fresh();
  const r = run(f.doc, f.tool, [[0, 0], [10, 0], [0, 5]]);
  assert.equal(r.drew, 1);
  assert.deepEqual(lastArc(r.doc), { start: [10, 0], end: [0, 10], centre: [0, 0] });
  assert.equal(drawStep(r.tool), "Draw centre arc");
  assert.deepEqual([r.tool.centre, r.tool.start, r.tool.swept], [null, null, 0], "the tool starts again from a new centre");
  assert.equal(r.doc.sketches[0].points.length, 3, "centre, start and end are points");
});

test("hand-worked: the same tap at (0, −5) is the quarter clockwise, kept as counter-clockwise from (0, −10) to (10, 0)", () => {
  // (0, −5) is at −90°: the shorter way is clockwise, a quarter. The end is
  // (0, −10); clockwise from (10, 0) to (0, −10) is counter-clockwise from
  // (0, −10) to (10, 0), the way the document keeps every arc.
  const f = fresh();
  const r = run(f.doc, f.tool, [[0, 0], [10, 0], [0, -5]]);
  assert.deepEqual(lastArc(r.doc), { start: [0, -10], end: [10, 0], centre: [0, 0] });
});

test("hand-worked: sweeping counter-clockwise past half a turn to (0, −5) draws three quarters, not the quarter a tap gives", () => {
  // Hovers at +90° (0, 5), 180° (−5, 0) and then the click at (0, −5),
  // −90° wrapped but 270° unwrapped: each step is a quarter turn
  // counter-clockwise, so the sweep is +3π/2 and the arc runs
  // counter-clockwise from (10, 0) to (0, −10), three quarters of a turn
  // (48 of the 64 segments a whole circle is drawn with).
  const f = fresh();
  const r = run(f.doc, f.tool, [[0, 0], [10, 0], { hover: [0, 5] }, { hover: [-5, 0] }, [0, -5]]);
  assert.deepEqual(lastArc(r.doc), { start: [10, 0], end: [0, -10], centre: [0, 0] });
  assert.equal(arcSegments(lastArc(r.doc)).length, 48);
  // And clockwise past half a turn to (0, 5): three quarters the other way,
  // kept as counter-clockwise from (0, 10) round to (10, 0).
  const g = run(f.doc, f.tool, [[0, 0], [10, 0], { hover: [0, -5] }, { hover: [-5, 0] }, [0, 5]]);
  assert.deepEqual(lastArc(g.doc), { start: [0, 10], end: [10, 0], centre: [0, 0] });
  assert.equal(arcSegments(lastArc(g.doc)).length, 48);
});

test("hand-worked: an end off the circle goes onto it along the ray: (3, 4) with radius 10 lands at (6, 8)", () => {
  // |(3, 4)| = 5 (a 3-4-5 triangle) and the radius is 10, so the end is
  // (3, 4)·(10 / 5) = (6, 8), exactly on the circle: 36 + 64 = 100. It is
  // at atan2(8, 6) ≈ 53.13° from the start, counter-clockwise, so the arc
  // is (10, 0) → (6, 8), drawn in ⌈64 × 0.9273 / 2π⌉ = ⌈9.44⌉ = 10 segments.
  const f = fresh();
  const r = run(f.doc, f.tool, [[0, 0], [10, 0], [3, 4]]);
  assert.deepEqual(lastArc(r.doc), { start: [10, 0], end: [6, 8], centre: [0, 0] });
  assert.equal(arcSegments(lastArc(r.doc)).length, 10);
});

test("hand-worked: centre (5, 5), start (5, 15), a click at (9, 8) is clockwise to (13, 11)", () => {
  // The radius is 10 (straight up). (9, 8) − (5, 5) = (4, 3), length 5, so
  // the end is (5, 5) + (4, 3)·2 = (13, 11). The start is at 90° and the
  // end at atan2(3, 4) ≈ 36.87°: going from the start to the click is
  // clockwise (u × v = 0·3 − 10·4 = −40 < 0), the shorter way, so the arc
  // is kept counter-clockwise from (13, 11) to (5, 15).
  const f = fresh();
  const r = run(f.doc, f.tool, [[5, 5], [5, 15], [9, 8]]);
  assert.deepEqual(lastArc(r.doc), { start: [13, 11], end: [5, 15], centre: [5, 5] });
});

test("the notes: a start on the centre, an end on the centre, an end that comes out on the start; nothing drawn and the clicks kept", () => {
  const f = fresh();
  let r = run(f.doc, f.tool, [[0, 0], [0, 0]]);
  assert.equal(r.note, NO_RADIUS);
  assert.deepEqual([r.tool.centre, r.tool.start, r.drew], [[0, 0], null, 0]);
  r = run(f.doc, f.tool, [[0, 0], [10, 0], [0, 0]]);
  assert.equal(r.note, NO_DIRECTION);
  assert.deepEqual([r.tool.centre, r.tool.start, r.drew], [[0, 0], [10, 0], 0]);
  // (3, 0) is on the start's own ray: the end would be (10, 0), the start.
  r = run(f.doc, f.tool, [[0, 0], [10, 0], [3, 0]]);
  assert.equal(r.note, NO_TURN);
  assert.equal(r.drew, 0);
  // Each refusal leaves the tool busy, so Escape drops its clicks.
  assert.equal(toolBusy(r.tool), true);
  assert.equal(toolBusy(startTool("centre", r.tool.sketch)), false);
});

test("points are shared: a centre and start on line ends, and an end exactly on an existing point", () => {
  // Lines (0, 0) → (10, 0) and (0, 0) → (0, 10): the centre on (0, 0), the
  // start on (10, 0) and a tap on (0, 10), which is on the circle, make a
  // quarter circle closing a pie slice with no new points.
  const s = addSketch(partDocument("box", 40, 30, 20));
  let doc = drawLine(s.doc, s.id, [0, 0], [10, 0]).doc;
  doc = drawLine(doc, s.id, [0, 0], [0, 10]).doc;
  const before = doc.sketches[0].points.length;
  const r = run(doc, startTool("centre", s.id), [[0, 0], [10, 0], [0, 10]]);
  assert.equal(r.doc.sketches[0].points.length, before, "no new points");
  const arc = r.doc.sketches[0].curves.at(-1)!;
  assert.ok(arc.kind === "arc");
  assert.deepEqual([arc.start, arc.end, arc.centre], [idAt(r.doc, [10, 0]), idAt(r.doc, [0, 10]), idAt(r.doc, [0, 0])]);
});

test("the preview: the radius line before the start, then both radius lines and the arc the click would draw", () => {
  const f = fresh();
  assert.deepEqual(previewSegments(f.doc, f.tool, [3, 3]), [], "nothing before the centre");
  let r = run(f.doc, f.tool, [[0, 0]]);
  assert.deepEqual(previewSegments(r.doc, r.tool, [10, 0]), [[[0, 0], [10, 0]]]);
  assert.deepEqual(previewSegments(r.doc, r.tool, [0, 0]), [], "nothing with the pointer on the centre");
  r = run(r.doc, r.tool, [[10, 0], { hover: [0, 5] }]);
  const quarter = arcSegments({ start: [10, 0], end: [0, 10], centre: [0, 0] });
  assert.deepEqual(previewSegments(r.doc, r.tool, [0, 5]), [[[0, 0], [10, 0]], ...quarter, [[0, 0], [0, 10]]]);
  // On the start's ray only the radius line: a click there draws nothing.
  assert.deepEqual(previewSegments(r.doc, r.tool, [4, 0]), [[[0, 0], [10, 0]]]);
  // The preview is what the click draws.
  const clicked = run(r.doc, r.tool, [[0, 5]]);
  assert.deepEqual(lastArc(clicked.doc), { start: [10, 0], end: [0, 10], centre: [0, 0] });
  // The centre and start show as points while the tool holds them.
  const d = sketchDrawings(r.doc, { tool: r.tool, grid: 10, pointer: [0, 5] })[0];
  assert.deepEqual(d.editing!.points, [[0, 0], [10, 0]]);
});

test("snapping skips the tool's own centre and start, and a tool switch drops them", () => {
  // A line (0, 0) → (10, 0): with the centre on its start and the arc's
  // start on its end, neither is a target (an end there draws nothing), but
  // the line's midpoint (5, 0) still is. Before the clicks both ends are.
  const s = addSketch(partDocument("box", 40, 30, 20));
  const doc = drawLine(s.doc, s.id, [0, 0], [10, 0]).doc;
  const targets = (tool: SketchTool) => snapTargets(doc.sketches[0], tool).points.map((t) => `${t.at}`);
  assert.deepEqual(targets(startTool("centre", s.id)), ["0,0", "10,0", "5,0"]);
  const r = run(doc, startTool("centre", s.id), [[0, 0], [10, 0]]);
  assert.deepEqual(targets(r.tool), ["5,0"]);
  assert.deepEqual(snapTargets(doc.sketches[0], r.tool).own, [[0, 0], [10, 0]]);
  const line = switchTool(r.doc, r.tool, "line");
  assert.deepEqual(line, startTool("line", r.tool.sketch));
  assert.deepEqual(switchTool(r.doc, line, "centre"), startTool("centre", r.tool.sketch));
});

test("sweep by hand: a quarter at a time round and on past the start adds up; the pointer on the centre changes nothing", () => {
  const c: SketchXY = [0, 0];
  const s: SketchXY = [10, 0];
  // Quarter steps counter-clockwise: π/2, π, 3π/2, then 2π back on the
  // start's ray and on to 5π/2: the sweep keeps growing past a whole turn.
  let a = 0;
  const path: SketchXY[] = [[0, 1], [-1, 0], [0, -1], [1, 0], [0, 1]];
  const want = [1, 2, 3, 4, 5].map((k) => (k * Math.PI) / 2);
  path.forEach((p, i) => {
    a = sweep(c, s, a, p);
    assert.ok(Math.abs(a - want[i]) < 1e-12, `step ${i}: ${a} vs ${want[i]}`);
  });
  assert.equal(sweep(c, s, a, [0, 0]), a);
  assert.equal(angleAt(c, s, [0, 0]), null);
  // Back the other way: three quarters clockwise from 0 is −3π/2.
  a = 0;
  for (const p of [[0, -1], [-1, 0], [0, 1]] as SketchXY[]) a = sweep(c, s, a, p);
  assert.ok(Math.abs(a + (3 * Math.PI) / 2) < 1e-12, `${a}`);
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

test("seeded sessions: hovers that turn by known amounts, then a click, match a model that adds the turns up", () => {
  // The model picks each hover as a turn of less than half a turn from the
  // last one, and keeps the total it turned (no wrapping, no atan2). The
  // arc must then go the way the total says, its end on the circle on the
  // click's ray, and its counter-clockwise turn from start to end must be
  // the total's angle the right way round (mod a whole turn).
  const TURN = 2 * Math.PI;
  const mod = (x: number) => ((x % TURN) + TURN) % TURN;
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    const random = rng(seed);
    for (let n = 0; n < 40; n++) {
      const c: SketchXY = [Math.floor(random() * 2001) - 1000, Math.floor(random() * 2001) - 1000];
      const r0 = 1 + Math.floor(random() * 200);
      const a0 = random() * TURN;
      const s: SketchXY = [c[0] + r0 * Math.cos(a0), c[1] + r0 * Math.sin(a0)];
      const r = Math.sqrt((s[0] - c[0]) ** 2 + (s[1] - c[1]) ** 2);
      let total = 0;
      const steps: Step[] = [c, s];
      const hovers = 1 + Math.floor(random() * 12);
      let p: SketchXY = s;
      for (let h = 0; h < hovers; h++) {
        total += (random() * 2 - 1) * 0.9 * Math.PI;
        const rho = 0.2 + random() * 3 * r;
        p = [c[0] + rho * Math.cos(a0 + total), c[1] + rho * Math.sin(a0 + total)];
        steps.push(h === hovers - 1 ? p : { hover: p });
      }
      const where = `seed ${seed}, session ${n}: centre (${c}), start (${s}), turned ${total}`;
      if (Math.abs(mod(total + 1e-9) - 1e-9) < 1e-6) continue; // back on the start's ray: no arc (the notes test covers it)
      const f = fresh();
      const out = run(f.doc, f.tool, steps);
      assert.equal(out.drew, 1, where);
      const arc = lastArc(out.doc);
      const ccw = total > 0;
      const [from, to] = ccw ? [arc.start, arc.end] : [arc.end, arc.start];
      assert.deepEqual(from, s, `${where}: starts at the start`);
      assert.deepEqual(arc.centre, c, where);
      const re = Math.sqrt((to[0] - c[0]) ** 2 + (to[1] - c[1]) ** 2);
      assert.ok(Math.abs(re - r) <= 8 * Number.EPSILON * 2000, `${where}: end ${re} from the centre vs radius ${r}`);
      const ray = Math.atan2(p[1] - c[1], p[0] - c[0]);
      const endAngle = Math.atan2(to[1] - c[1], to[0] - c[0]);
      assert.ok(Math.abs(mod(endAngle - ray + Math.PI) - Math.PI) < 1e-9, `${where}: end on the click's ray`);
      const turned = mod(Math.atan2(arc.end[1] - c[1], arc.end[0] - c[0]) - Math.atan2(arc.start[1] - c[1], arc.start[0] - c[0]));
      const want = mod(ccw ? total : -total);
      assert.ok(Math.abs(mod(turned - want + Math.PI) - Math.PI) < 1e-9, `${where}: turns ${turned}, want ${want}`);
    }
  }
});

test("a session of centre arcs saves and opens as it was", () => {
  const f = fresh();
  const r = run(f.doc, f.tool, [[0, 0], [10, 0], [0, 5], [20, 20], [30, 20], { hover: [20, 30] }, { hover: [10, 20] }, [20, 10]]);
  assert.equal(r.drew, 2);
  assert.deepEqual(readDesignDocument(JSON.parse(JSON.stringify(r.doc))), r.doc);
  assert.deepEqual(centreArc([20, 20], [30, 20], [20, 10], true), lastArc(r.doc), "three quarters counter-clockwise to (20, 10)");
});
