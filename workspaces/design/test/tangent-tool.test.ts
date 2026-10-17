// Step 23c: the tangent arc tool (sketch-tool.ts `leaving`, `tangentArc`,
// the tangent arc's clicks, `switchTool`): hand-worked centres from a
// line's end, a line's start and an arc's ends, the notes for clicks that
// make no arc, the rounding bound at 0.9× and 1.1×, and seeded chains of
// lines and tangent arcs checked against an exact model in whole grid
// steps that never works out a centre to find the next direction.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SketchXY } from "@fission/core";
import { partDocument, readDesignDocument, type DesignDocument } from "../src/document.ts";
import { addSketch, drawArc, drawCircle, drawLine, drawRectangle, sketchCurves } from "../src/sketch.ts";
import { arcSegments, clickAt, drawStep, leaving, previewSegments, sketchDrawings, startTool, switchTool, tangentArc, toolBusy, type LineTool, type SketchTool, type TangentTool } from "../src/sketch-tool.ts";
import { snapTargets } from "../src/snap.ts";

function fresh(doc?: DesignDocument) {
  const s = addSketch(doc ?? partDocument("box", 40, 30, 20));
  return { doc: s.doc, sketch: s.id };
}

/** A sketch holding one line from `a` to `b`, and the tangent tool on it. */
function withLine(a: SketchXY, b: SketchXY) {
  const f = fresh();
  const doc = drawLine(f.doc, f.sketch, a, b).doc;
  return { doc, tool: startTool("tangent", f.sketch) as TangentTool };
}

function clicks<T extends SketchTool>(doc: DesignDocument, tool: T, at: SketchXY[]) {
  let drew = 0;
  let note: string | undefined;
  for (const p of at) {
    const r = clickAt(doc, tool, p);
    ({ doc, tool, note } = r);
    if (r.drew) drew++;
  }
  return { doc, tool, drew, note };
}

const lastArc = (doc: DesignDocument) => sketchCurves(doc.sketches[0]).arcs.at(-1)!;
const idAt = (doc: DesignDocument, at: SketchXY) => doc.sketches[0].points.find((p) => p.x === at[0] && p.y === at[1])?.id;
const dist = (a: SketchXY, b: SketchXY) => Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2);

test("hand-worked: from the end of (0, 0) → (10, 0), an end at (20, 10) is a quarter circle round (10, 10)", () => {
  // The line leaves (10, 0) along t = (10, 0); the centre is on the normal
  // there, x = 10, and as far from (20, 10) as from (10, 0): (10, c) with
  // c² = 10² + (10 − c)², so 0 = 100 + 100 − 20c and c = 10. Radius 10;
  // (10, 0) is straight below the centre and (20, 10) straight right of
  // it, a quarter turn counter-clockwise, so the arc runs from (10, 0).
  // (In the code: w = (10, 10), t × w = 10·10 − 0·10 = 100, k = 200/200 = 1,
  // centre = (10, 0) + (−0, 10)·1.)
  const f = withLine([0, 0], [10, 0]);
  const r = clicks(f.doc, f.tool, [[10, 0], [20, 10]]);
  assert.equal(r.drew, 1);
  assert.deepEqual(lastArc(r.doc), { start: [10, 0], end: [20, 10], centre: [10, 10] });
  // It shares the line's end and carries on from its own end, leaving it heading up, (0, 10).
  const arc = r.doc.sketches[0].curves.at(-1)!;
  assert.equal(arc.kind === "arc" && arc.start, idAt(r.doc, [10, 0]));
  assert.equal(r.tool.from, idAt(r.doc, [20, 10]));
  assert.deepEqual(leaving(r.doc.sketches[0], r.tool.from!), [-0, 10]);
  assert.equal(drawStep(r.tool), "Draw tangent arc");
});

test("hand-worked: an end at (10, 10) above the line's end is a half circle round (10, 5), a slot's end", () => {
  // The centre (10, c) is as far from (10, 10) as from (10, 0): c = 5.
  // From straight below the centre to straight above it is half a turn;
  // leaving east and coming round counter-clockwise, the arc arrives at
  // (10, 10) heading west, (−5, 0).
  const f = withLine([0, 0], [10, 0]);
  const r = clicks(f.doc, f.tool, [[10, 0], [10, 10]]);
  assert.deepEqual(lastArc(r.doc), { start: [10, 0], end: [10, 10], centre: [10, 5] });
  assert.deepEqual(leaving(r.doc.sketches[0], r.tool.from!), [-5, 0]);
});

test("hand-worked: an end on the right, (20, −10), turns clockwise, so the arc is stored from it, round (10, −10)", () => {
  // Mirror of the first case in the line: centre (10, −10), radius 10.
  // Clockwise from (10, 0) to (20, −10) is counter-clockwise from
  // (20, −10) (angle 0) to (10, 0) (angle 90°), so the ends swap.
  const f = withLine([0, 0], [10, 0]);
  const r = clicks(f.doc, f.tool, [[10, 0], [20, -10]]);
  assert.deepEqual(lastArc(r.doc), { start: [20, -10], end: [10, 0], centre: [10, -10] });
  // The chain carries on from (20, −10), the arc's stored start, heading down: r = (10, 0) turned right is (0, −10).
  assert.equal(r.tool.from, idAt(r.doc, [20, -10]));
  assert.deepEqual(leaving(r.doc.sketches[0], r.tool.from!), [0, -10]);
  // And on into an S: from (20, −10) heading down to (30, −20) turns left round (30, −10):
  // w = (10, −10), t × w = 0·(−10) − (−10)·10 = 100, k = 200/200 = 1, centre = (20, −10) + (10, 0).
  const s = clicks(r.doc, r.tool, [[30, -20]]);
  assert.deepEqual(lastArc(s.doc), { start: [20, -10], end: [30, -20], centre: [30, -10] });
});

test("hand-worked: from a line's start the arc leaves backwards along it", () => {
  // At (0, 0), the start of (0, 0) → (10, 0), the way out is (−10, 0),
  // west. An end at (−10, 10) is on the right of west, so the arc turns
  // clockwise round (0, 10): radius 10, from angle 270° at (0, 0) back to
  // 180° at (−10, 10), stored counter-clockwise from (−10, 10).
  const f = withLine([0, 0], [10, 0]);
  assert.deepEqual(leaving(f.doc.sketches[0], idAt(f.doc, [0, 0])!), [-10, 0]);
  const r = clicks(f.doc, f.tool, [[0, 0], [-10, 10]]);
  assert.deepEqual(lastArc(r.doc), { start: [-10, 10], end: [0, 0], centre: [0, 10] });
});

test("hand-worked: from an arc's end it leaves along the arc, and a closed slot is two lines and two tangent arcs", () => {
  // The half circle (10, 0) → (10, 10) round (10, 5) arrives heading west,
  // (−5, 0). An end at (0, 0): w = (−10, −10), t × w = (−5)(−10) − 0 = 50
  // above 0 (a left turn), k = 200/100 = 2, centre = (10, 10) + (−0, −5)·2
  // = (10, 0); radius 10 from angle 90° to 180°.
  const f = withLine([0, 0], [10, 0]);
  let r = clicks(f.doc, f.tool, [[10, 0], [10, 10]]);
  const s = clicks(r.doc, r.tool, [[0, 0]]);
  assert.deepEqual(lastArc(s.doc), { start: [10, 10], end: [0, 0], centre: [10, 0] });
  assert.equal(s.tool.from, null, "ending on the line's start ends the chain");
  // The slot: (0, 0) → (40, 0), a half circle up to (40, 20), a line back to (0, 20), a half circle down to (0, 0).
  const g = fresh();
  let tool: SketchTool = startTool("line", g.sketch);
  r = clicks(g.doc, tool, [[0, 0], [40, 0]]);
  tool = switchTool(r.doc, r.tool, "tangent");
  r = clicks(r.doc, tool, [[40, 20]]);
  tool = switchTool(r.doc, r.tool, "line");
  r = clicks(r.doc, tool, [[0, 20]]);
  tool = switchTool(r.doc, r.tool, "tangent");
  r = clicks(r.doc, tool, [[0, 0]]);
  // From (0, 20) heading west, (−40, 0), to (0, 0): w = (0, −20), t × w = (−40)(−20) = 800, k = 400/1600 = ¼,
  // centre = (0, 20) + (−0, −40)·¼ = (0, 10).
  assert.deepEqual(sketchCurves(r.doc.sketches[0]).arcs, [
    { start: [40, 0], end: [40, 20], centre: [40, 10] },
    { start: [0, 20], end: [0, 0], centre: [0, 10] },
  ]);
  assert.equal(r.doc.sketches[0].points.length, 6, "four corners and two centres");
  assert.equal(toolBusy(r.tool), false, "closed: the chain ended");
});

test("switching: the line chain and the tangent arc hand over their last point; every other switch starts afresh", () => {
  const g = fresh();
  const line = clicks(g.doc, startTool("line", g.sketch) as LineTool, [[0, 0], [10, 0]]);
  const t = switchTool(line.doc, line.tool, "tangent");
  assert.deepEqual(t, { kind: "tangent", sketch: g.sketch, from: idAt(line.doc, [10, 0]) });
  // A first click not yet a point has no direction: the tangent arc starts afresh.
  const first = clicks(g.doc, startTool("line", g.sketch) as LineTool, [[0, 0]]);
  assert.deepEqual(switchTool(first.doc, first.tool, "tangent"), { kind: "tangent", sketch: g.sketch, from: null });
  // Back to the line from a tangent arc's start.
  assert.deepEqual(switchTool(line.doc, t, "line"), { kind: "line", sketch: g.sketch, from: idAt(line.doc, [10, 0]) });
  assert.deepEqual(switchTool(line.doc, t, "circle"), { kind: "circle", sketch: g.sketch, centre: null });
  assert.deepEqual(switchTool(line.doc, line.tool, "arc"), { kind: "arc", sketch: g.sketch, start: null, end: null });
  // A chain ending on a corner (two lines meet) has no single way out.
  const closed = clicks(g.doc, startTool("line", g.sketch) as LineTool, [[0, 0], [10, 0], [10, 10]]);
  const corner = { ...closed.tool, from: idAt(closed.doc, [10, 0])! };
  assert.deepEqual(switchTool(closed.doc, corner, "tangent"), { kind: "tangent", sketch: g.sketch, from: null });
});

test("clicks that make no arc draw nothing and say why; the tool keeps what it had", () => {
  const f = withLine([0, 0], [10, 0]);
  const empty = clicks(f.doc, f.tool, [[30, 30]]);
  assert.match(empty.note!, /^A tangent arc starts at the end of a line or arc/, "nothing there");
  assert.equal(empty.tool.from, null);
  // A corner: two lines end at (10, 0).
  const corner = drawLine(f.doc, f.doc.sketches[0].id, idAt(f.doc, [10, 0])!, [10, 10]).doc;
  assert.match(clicks(corner, f.tool, [[10, 0]]).note!, /^A tangent arc starts/, "a corner");
  // A circle's centre and an arc's centre are points no line or arc ends at.
  const circled = drawCircle(f.doc, f.doc.sketches[0].id, [50, 50], 5).doc;
  assert.match(clicks(circled, f.tool, [[50, 50]]).note!, /^A tangent arc starts/, "a circle's centre");
  const arced = drawArc(f.doc, f.doc.sketches[0].id, [60, 0], [60, 10], [60, 5]).doc;
  assert.match(clicks(arced, f.tool, [[60, 5]]).note!, /^A tangent arc starts/, "an arc's centre");
  assert.equal(clicks(arced, f.tool, [[60, 10]]).tool.from, idAt(arced, [60, 10]), "an arc's free end is fine");
  // Started: an end on the start, straight ahead, straight behind.
  const started = clicks(f.doc, f.tool, [[10, 0]]);
  for (const [at, why] of [[[10, 0], /^A tangent arc needs an end/], [[25, 0], /^A tangent arc needs to turn/], [[-5, 0], /^A tangent arc needs to turn/], [[5, 0], /^A tangent arc needs to turn/]] as const) {
    const r = clickAt(started.doc, started.tool, at as SketchXY);
    assert.equal(r.drew, false, `${at}`);
    assert.match(r.note!, why, `${at}`);
    assert.deepEqual(r.tool, started.tool, "still started");
    assert.equal(r.doc, started.doc, "nothing changed");
  }
});

test("hand-worked: three nodes of a 0.1 mm grid on one line are refused, though rounding leaves a cross product", () => {
  // As in 23b: (0.1, 0.1), (0.2, 0.3), (0.3, 0.5) are on y = 2x − 0.1,
  // but the doubles nearest them leave a cross product of 1.39e-17.
  const [a, b, e]: SketchXY[] = [[1 / 10, 1 / 10], [2 / 10, 3 / 10], [3 / 10, 5 / 10]];
  const t: SketchXY = [b[0] - a[0], b[1] - a[1]];
  assert.notEqual(t[0] * (e[1] - b[1]) - t[1] * (e[0] - b[0]), 0, "rounding left something");
  assert.equal(tangentArc(b, t, e, [a, b]), null);
  const f = withLine(a, b);
  assert.match(clicks(f.doc, f.tool, [b, e]).note!, /^A tangent arc needs to turn/);
  // One node off the line, (0.3, 0.4), turns right.
  assert.notEqual(tangentArc(b, t, [3 / 10, 4 / 10], [a, b]), null);
});

test("the rounding bound at 0.9× (refused) and 1.1× (an arc)", () => {
  // From (0, 0) along t = (1, 0) (a line from (−1, 0)), to (1, y): the
  // differences are t = (1, 0) and w = (1, y), the largest coordinate 1,
  // so η = 2ε and the bound is 2ε·(1 + 0 + 1 + y) + 2·(2ε)² + ε·(|1·y| + 0)
  // = 4ε + 3εy + 8ε², the 3-point arc's. The cross product is 1·y − 0·1 = y.
  const e = Number.EPSILON;
  const bound = 4 * e + 3 * e * (4 * e) + 8 * e * e;
  const along: SketchXY[] = [[-1, 0], [0, 0]];
  assert.equal(tangentArc([0, 0], [1, 0], [1, 0.9 * bound], along), null, "0.9×: could be rounding");
  const arc = tangentArc([0, 0], [1, 0], [1, 1.1 * bound], along);
  assert.notEqual(arc, null, "1.1×: an arc");
  // y > 0 is on the left of the way out: counter-clockwise from (0, 0), no swap.
  assert.deepEqual([arc!.start, arc!.end], [[0, 0], [1, 1.1 * bound]]);
  // The bound counts the points the direction came from: the same direction taken from far away refuses more.
  assert.equal(tangentArc([0, 0], [1, 0], [1, 1.1 * bound], [[1e6 - 1, 0], [1e6, 0]]), null, "the line was at x = 1e6");
});

test("the preview: nothing before the start, the arc to the pointer, the line while straight on; the start is not snapped to", () => {
  const f = withLine([0, 0], [10, 0]);
  assert.deepEqual(previewSegments(f.doc, f.tool, [20, 10]), []);
  const one = clicks(f.doc, f.tool, [[10, 0]]);
  assert.deepEqual(previewSegments(one.doc, one.tool, [20, 10]), arcSegments({ start: [10, 0], end: [20, 10], centre: [10, 10] }));
  assert.deepEqual(previewSegments(one.doc, one.tool, [30, 0]), [[[10, 0], [30, 0]]], "straight on");
  assert.deepEqual(previewSegments(one.doc, one.tool, [10, 0]), [], "on the start");
  const d = sketchDrawings(one.doc, { tool: one.tool, grid: 10, pointer: [20, 10] })[0];
  assert.deepEqual(d.editing?.preview, arcSegments({ start: [10, 0], end: [20, 10], centre: [10, 10] }));
  assert.equal(d.editing?.points.length, 2, "the line's two ends, no extra point");
  const targets = snapTargets(one.doc.sketches[0], one.tool);
  assert.deepEqual(targets.own, [10, 0]);
  assert.ok(!targets.points.some((p) => p.at[0] === 10 && p.at[1] === 0), "a click on the start draws nothing, so it is not offered");
  // A start that is no longer a free end (after an undo, say) is no start: the next click is a first click again.
  const corner = drawLine(one.doc, one.doc.sketches[0].id, idAt(one.doc, [10, 0])!, [10, 10]).doc;
  assert.deepEqual(previewSegments(corner, one.tool, [20, 10]), []);
  assert.match(clickAt(corner, one.tool, [20, 10]).note!, /^A tangent arc starts/);
});

test("an arc closing a rectangle's open side: the end shares the corner, the tangent arc makes the outline the kernel walks", () => {
  // Three sides of a 20 × 10 rectangle as a chain (0, 10) → (0, 0) →
  // (20, 0) → (20, 10), then a tangent arc from (20, 10), which leaves
  // heading up, t = (0, 10), to (0, 10): the centre is on y = 10 (the
  // normal there) and as far from (0, 10) as from (20, 10), so (10, 10),
  // a half circle of radius 10 over the top. (w = (−20, 0),
  // t × w = 0·0 − 10·(−20) = 200, k = 400/400 = 1.)
  const g = fresh();
  const r = clicks(g.doc, startTool("line", g.sketch) as LineTool, [[0, 10], [0, 0], [20, 0], [20, 10]]);
  const t = clicks(r.doc, switchTool(r.doc, r.tool, "tangent"), [[0, 10]]);
  assert.deepEqual(lastArc(t.doc), { start: [20, 10], end: [0, 10], centre: [10, 10] });
  assert.equal(t.doc.sketches[0].points.length, 5, "four corners and the centre");
  assert.equal(t.tool.from, null);
  // The rectangle tool's sides are lines too: a tangent arc can leave any free end, never a rectangle's corner.
  const box = drawRectangle(g.doc, g.sketch, [0, 0], [10, 10]).doc;
  assert.match(clicks(box, startTool("tangent", g.sketch), [[10, 10]]).note!, /^A tangent arc starts/);
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

/** The greatest common divisor of two BigInts, to keep the model's directions small. */
function gcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b) [a, b] = [b, a % b];
  return a;
}

test("seeded chains of lines and tangent arcs on whole and decimal grids match an exact model in whole grid steps", () => {
  // The model keeps each chain's last point in whole grid steps and its
  // way out as a whole-number direction, exactly (BigInt). A tangent arc
  // from s along t to e turns by the cross product's sign, its centre is
  // s + t⊥·|w|²/(2·t × w) (a fraction), and it arrives at e heading along
  // t reflected in the chord w (a circle's two tangents to one chord make
  // equal angles with it): t' = 2(t·w)w − |w|²t, whole numbers, no centre
  // needed. The code instead works out the next direction from the arc's
  // stored end and centre (`leaving`), so the two paths are independent.
  const grids: { node: (k: number) => number; size: number }[] = [
    { node: (k) => k * 10, size: 10 },
    { node: (k) => k * 1, size: 1 },
    { node: (k) => k / 10, size: 0.1 },
    { node: (k) => k / 4, size: 0.25 },
    { node: (k) => k * 2.5, size: 2.5 },
    { node: (k) => k / 1000, size: 0.001 },
  ];
  let arcs = 0;
  let straight = 0;
  let closed = 0;
  let close = 0;
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const random = rng(seed);
    for (const grid of grids) {
      const g = fresh();
      let doc = g.doc;
      const xy = (q: readonly [number, number]): SketchXY => [grid.node(q[0]), grid.node(q[1])];
      for (let chain = 0; chain < 6; chain++) {
        // A line somewhere within ±1000 steps, then up to twelve tangent arcs, now and then a line between.
        const [ox, oy] = [Math.floor(random() * 2001) - 1000, Math.floor(random() * 2001) - 1000];
        let s: [number, number] = [ox, oy];
        let e: [number, number] = [ox + 1 + Math.floor(random() * 8), oy + Math.floor(random() * 9) - 4];
        if (idAt(doc, xy(s)) || idAt(doc, xy(e))) continue;
        let r = clicks(doc, startTool("line", g.sketch) as LineTool, [xy(s), xy(e)]);
        let tool: SketchTool = switchTool(r.doc, r.tool, "tangent");
        doc = r.doc;
        let t: [bigint, bigint] = [BigInt(e[0] - s[0]), BigInt(e[1] - s[1])];
        s = e;
        for (let n = 0; n < 12; n++) {
          const where = `seed ${seed}, grid ${grid.size}, chain ${chain}, arc ${n} from (${s})`;
          const next: [number, number] = [s[0] + Math.floor(random() * 13) - 6, s[1] + Math.floor(random() * 13) - 6];
          if (next[0] === s[0] && next[1] === s[1]) continue;
          if (random() < 0.15) {
            // A line in between, from the chain's last point: the model's way out becomes the line's.
            if (idAt(doc, xy(next))) continue;
            r = clicks(doc, switchTool(doc, tool, "line"), [xy(next)]);
            assert.equal(r.drew, 1, where);
            doc = r.doc;
            tool = switchTool(doc, r.tool, "tangent");
            t = [BigInt(next[0] - s[0]), BigInt(next[1] - s[1])];
            s = next;
            continue;
          }
          const w = [BigInt(next[0] - s[0]), BigInt(next[1] - s[1])] as const;
          const cross = t[0] * w[1] - t[1] * w[0];
          const existed = idAt(doc, xy(next)) !== undefined; // an end, or a centre that fell on a node
          r = clicks(doc, tool, [xy(next)]);
          if (cross === 0n) {
            assert.equal(r.drew, 0, `${where}: (${next}) is straight on`);
            assert.match(r.note ?? "", /^A tangent arc needs to turn/, where);
            straight++;
            continue;
          }
          // How far off straight it is, sin θ = |t × w| / (|t||w|): below 1e-9 the doubles can't promise to tell.
          const [tf, wf] = [[Number(t[0]), Number(t[1])], [Number(w[0]), Number(w[1])]];
          const sin = Math.abs(Number(cross)) / (Math.sqrt(tf[0] ** 2 + tf[1] ** 2) * Math.sqrt(wf[0] ** 2 + wf[1] ** 2));
          if (sin < 1e-9) {
            close++;
            if (!r.drew) continue;
          }
          assert.equal(r.drew, 1, `${where}: to (${next})`);
          doc = r.doc;
          arcs++;
          // The model's centre: s + t⊥·k with k = |w|²/(2·cross), in grid steps, then in mm.
          const ww = w[0] * w[0] + w[1] * w[1];
          const k = Number(ww) / (2 * Number(cross));
          const centre: SketchXY = [grid.node(1) * (s[0] - Number(t[1]) * k), grid.node(1) * (s[1] + Number(t[0]) * k)];
          const [start, end] = cross > 0n ? [xy(s), xy(next)] : [xy(next), xy(s)];
          const drawn = lastArc(doc);
          assert.deepEqual([drawn.start, drawn.end], [start, end], `${where}: counter-clockwise, turning the model's way`);
          const radius = dist(centre, start);
          const scale = Math.max(radius, ...[...start, ...end].map(Math.abs));
          assert.ok(dist(drawn.centre, centre) <= 1e-9 * scale, `${where}: the centre ${drawn.centre} vs ${centre}`);
          // On the line midway between the ends, as check_arcs asks, to far better than its LINEAR (1e-5 mm).
          const chord = dist(start, end);
          const off = ((drawn.centre[0] - (start[0] + end[0]) / 2) * (end[0] - start[0]) + (drawn.centre[1] - (start[1] + end[1]) / 2) * (end[1] - start[1])) / chord;
          assert.ok(Math.abs(off) <= 1e-9 * scale, `${where}: ${off} off the midway line`);
          // Tangent where it starts: the radius at s is square to the way out, to within rounding.
          const rs: SketchXY = [xy(s)[0] - drawn.centre[0], xy(s)[1] - drawn.centre[1]];
          const tn = Math.sqrt(tf[0] ** 2 + tf[1] ** 2);
          assert.ok(Math.abs(rs[0] * tf[0] + rs[1] * tf[1]) / (radius * tn) <= 1e-9, `${where}: square to the way out at the start`);
          // The model's way out at e: t reflected in the chord.
          const dot = t[0] * w[0] + t[1] * w[1];
          let t2: [bigint, bigint] = [2n * dot * w[0] - ww * t[0], 2n * dot * w[1] - ww * t[1]];
          const div = gcd(t2[0], t2[1]);
          t2 = [t2[0] / div, t2[1] / div];
          if (existed) {
            // Landing on a point already there shares it and ends the chain.
            assert.equal(r.tool.from, null, `${where}: ended on (${next})`);
            closed++;
            break;
          }
          assert.equal(r.tool.from, idAt(doc, xy(next)), `${where}: carries on from (${next})`);
          const out = leaving(doc.sketches[0], r.tool.from!)!;
          const [mx, my] = [Number(t2[0]), Number(t2[1])];
          const across = (out[0] * my - out[1] * mx) / (Math.sqrt(out[0] ** 2 + out[1] ** 2) * Math.sqrt(mx * mx + my * my));
          assert.ok(Math.abs(across) <= 1e-9 && out[0] * mx + out[1] * my > 0, `${where}: leaves (${next}) along ${out}, the model's ${t2}`);
          tool = r.tool;
          t = t2;
          s = next;
        }
      }
      const sketch = doc.sketches[0];
      assert.equal(new Set(sketch.points.map((q) => `${q.x},${q.y}`)).size, sketch.points.length, `seed ${seed}, grid ${grid.size}: no two points in one place`);
      assert.deepEqual(readDesignDocument(JSON.parse(JSON.stringify(doc))), doc, `seed ${seed}, grid ${grid.size}: the session opens as saved`);
    }
  }
  if (process.env.TANGENT_COUNTS) console.log({ arcs, straight, closed, close });
  assert.ok(arcs >= 2000, `the sessions drew ${arcs} arcs`);
  assert.ok(straight >= 20, `the sessions refused ${straight} straight-on clicks`);
  assert.ok(closed >= 10, `${closed} chains ended on a point`);
  assert.equal(close, 0, "no click was within 1e-9 of straight on without being on it");
});

test("seeded: straight on or behind from an arc's end is refused, though the arc's centre was rounded", () => {
  // The way out of an arc's end comes from its stored centre, which is a
  // rounded double (midway between two decimal nodes, say, far from the
  // origin). A half turn (end at s + t⊥) arrives heading along −t, a
  // quarter turn (end at s + t + t⊥) along t⊥; a click straight on or
  // behind from there must be refused, not drawn as a huge arc.
  const grids = [(k: number) => k / 10, (k: number) => k / 1000, (k: number) => k / 4, (k: number) => k * 2.5, (k: number) => k / 3];
  let refused = 0;
  for (const seed of [11, 12, 13, 14]) {
    const random = rng(seed);
    for (const node of grids) {
      for (let n = 0; n < 60; n++) {
        const far = Math.floor(random() * 2e5) - 1e5;
        const s: [number, number] = [far, Math.floor(random() * 2e5) - 1e5];
        const t: [number, number] = [1 + Math.floor(random() * 5), Math.floor(random() * 9) - 4];
        const xy = (q: readonly number[]): SketchXY => [node(q[0]), node(q[1])];
        const half = random() < 0.5;
        const e = half ? [s[0] - t[1], s[1] + t[0]] : [s[0] + t[0] - t[1], s[1] + t[1] + t[0]];
        const out = half ? [-t[0], -t[1]] : [-t[1], t[0]];
        const f = withLine(xy([s[0] - t[0], s[1] - t[1]]), xy(s));
        const r = clicks(f.doc, f.tool, [xy(s), xy(e)]);
        assert.equal(r.drew, 1, `seed ${seed}, ${half ? "half" : "quarter"} turn from (${s}) along (${t})`);
        for (const j of [1, 2, 3, -1, -2]) {
          const q = xy([e[0] + j * out[0], e[1] + j * out[1]]);
          const ahead = clickAt(r.doc, r.tool, q);
          assert.equal(ahead.drew, false, `seed ${seed}, ${half ? "half" : "quarter"} turn from (${s}) along (${t}): ${j} steps on is straight, not an arc of radius ${ahead.drew ? dist(lastArc(ahead.doc).centre, q) : 0}`);
          refused++;
        }
      }
    }
  }
  assert.equal(refused, 4 * 5 * 60 * 5);
});
