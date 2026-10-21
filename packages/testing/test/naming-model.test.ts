// The naming model (src/naming-model.ts) on its own: it is the oracle for
// sketches on faces (26) and cuts (44/48) when earlier features change
// (25a), so its answers are checked here by hand, with the working next to
// each assertion. Ben's seven Fusion answers themselves are FUSION_CASES,
// run in test/naming-session.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { seeded } from "../src/index.ts";
import type { Point } from "../src/timeline-model.ts";
import {
  applyNaming,
  CLEAR_MM,
  clearance,
  clearCut,
  createNamingModel,
  discInsidePolygon,
  discMeetsPolygon,
  discPolygonArea,
  drawnFrame,
  frameNow,
  placeOn,
  pointInPolygon,
  rebuildNaming,
  turned,
  worldOf,
  type Drawn,
  type ModelFace,
  type NamingItem,
  type NamingModel,
  type NamingOp,
  pinAt,
} from "../src/naming-model.ts";
import { BEN, randomOutline, setupOps } from "../src/naming-session.ts";

const near = (a: number, b: number) => Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(a), Math.abs(b));
const PI = Math.PI;
const rect = (x0: number, y0: number, x1: number, y1: number): Point[] => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];
const run = (m: NamingModel, ...ops: NamingOp[]) => ops.map((op) => applyNaming(m, op));
/** A placement in the world's XY frame at height z, facing up (+1) or down (−1). */
const flat = (z: number, side: 1 | -1 = 1) => ({ origin: [0, 0, z], x: [1, 0, 0], normal: [0, 0, 1], side });
const ben = (cuts = true) => {
  const m = createNamingModel();
  run(m, ...setupOps(BEN, cuts));
  return m;
};

test("disc inside a polygon, by hand", () => {
  // Wholly inside the 40 × 30 rectangle: the whole disc, π · 5² = 25π.
  assert.ok(near(discPolygonArea([20, 15], 5, rect(0, 0, 40, 30)), 25 * PI));
  // The same rectangle walked clockwise: the same area.
  assert.ok(near(discPolygonArea([20, 15], 5, [...rect(0, 0, 40, 30)].reverse()), 25 * PI));
  // Centred on the corner (0, 0): the rectangle's right angle holds a quarter, 25π / 4.
  assert.ok(near(discPolygonArea([0, 0], 5, rect(0, 0, 40, 30)), (25 * PI) / 4));
  // The triangle (0, 0), (40, 0), (0, 30): its long side 3x + 4y = 120 runs
  // through (20, 15) (3 · 20 + 4 · 15 = 120), so half the disc, 25π / 2.
  assert.ok(near(discPolygonArea([20, 15], 5, [[0, 0], [40, 0], [0, 30]]), (25 * PI) / 2));
  // The L (40 wide, 40 tall, the top-right 20 × 20 taken out) has its inner
  // corner at (20, 20); there the inside spans three quarters of the turn: 75π / 4.
  const L: Point[] = [[0, 0], [40, 0], [40, 20], [20, 20], [20, 40], [0, 40]];
  assert.ok(near(discPolygonArea([20, 20], 5, L), (75 * PI) / 4));
  // Past the outline (the circle spans x 15 to 25, the rectangle stops at 10): nothing.
  assert.ok(near(discPolygonArea([20, 15], 5, rect(0, 0, 10, 30)), 0));
  // A segment of height h = 1 (the side x = 16, the circle reaching 15):
  // r² acos((r − h) / r) − (r − h) √(2rh − h²) = 25 acos(0.8) − 4 · 3.
  assert.ok(near(discPolygonArea([20, 15], 5, rect(0, 0, 16, 30)), 25 * Math.acos(0.8) - 12));
  // A 2 × 2 square inside a circle of radius 10: the square, 4.
  assert.ok(near(discPolygonArea([0, 0], 10, rect(-1, -1, 1, 1)), 4));
});

test("does the disc meet the outline, does it fit inside: decided exactly in whole numbers", () => {
  // Tangent: the side x = 15 is exactly r = 5 from (20, 15). cross² =
  // (0 · 15 − 30 · 5)² = 22500 = r² · |side|² = 25 · 900: touching only.
  assert.equal(discMeetsPolygon([20, 15], 5, rect(0, 0, 15, 30)), false);
  // One grid step further, x = 16, the side is 4 away: it meets.
  assert.equal(discMeetsPolygon([20, 15], 5, rect(0, 0, 16, 30)), true);
  // Well past: no.
  assert.equal(discMeetsPolygon([20, 15], 5, rect(0, 0, 10, 30)), false);
  // A corner exactly r away, the circle round (3, 4) and the corner (0, 0) 5 off: touching only.
  assert.equal(discMeetsPolygon([-3, -4], 5, rect(0, 0, 10, 10)), false);
  assert.equal(discMeetsPolygon([-3, -4], 6, rect(0, 0, 10, 10)), true);
  // The centre on the outline or at a corner: yes.
  assert.equal(discMeetsPolygon([0, 5], 1, rect(0, 0, 10, 10)), true);
  assert.equal(discMeetsPolygon([0, 0], 1, rect(0, 0, 10, 10)), true);
  // A circle holding the whole outline: yes.
  assert.equal(discMeetsPolygon([0, 0], 10, rect(-1, -1, 1, 1)), true);
  // Inside, touching the side x = 15 from inside (closed disc in a closed outline): fits.
  assert.equal(discInsidePolygon([20, 15], 5, rect(15, 0, 40, 30)), true);
  // One grid step tighter, x = 16: it pokes out.
  assert.equal(discInsidePolygon([20, 15], 5, rect(16, 0, 40, 30)), false);
  assert.equal(discInsidePolygon([20, 15], 5, rect(0, 0, 40, 30)), true);
  assert.equal(discInsidePolygon([50, 15], 5, rect(0, 0, 40, 30)), false);
  // The point test on a non-convex outline: the L's notch is outside, its arms inside, its edges count.
  const L: Point[] = [[0, 0], [40, 0], [40, 20], [20, 20], [20, 40], [0, 40]];
  assert.equal(pointInPolygon([30, 30], L), false);
  assert.equal(pointInPolygon([30, 10], L), true);
  assert.equal(pointInPolygon([10, 30], L), true);
  assert.equal(pointInPolygon([20, 30], L), true);
  assert.equal(pointInPolygon([30, 20], L), true);
});

// A second way to the same area, sharing nothing with the model's formula:
// clip the outline with regular n-gons inside and outside the circle
// (Sutherland–Hodgman; each n-gon is convex) and take each part's shoelace.
// The disc lies between them, so its overlap with the outline must too.
function clipArea(corners: readonly Point[], window: readonly (readonly [number, number])[]): number {
  let out: (readonly [number, number])[] = [...corners];
  for (let k = 0; k < window.length && out.length; k++) {
    const a = window[k];
    const b = window[(k + 1) % window.length];
    const side = (p: readonly [number, number]) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    const input = out;
    out = [];
    for (let j = 0; j < input.length; j++) {
      const p = input[j];
      const q = input[(j + 1) % input.length];
      const sp = side(p);
      const sq = side(q);
      if (sp >= 0) out.push(p);
      if ((sp >= 0) !== (sq >= 0)) {
        const t = sp / (sp - sq);
        out.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]);
      }
    }
  }
  let s = 0;
  for (let k = 0; k < out.length; k++) s += out[k][0] * out[(k + 1) % out.length][1] - out[(k + 1) % out.length][0] * out[k][1];
  return Math.abs(s) / 2;
}

test("self-consistency: the disc-polygon area lies between the overlaps of inscribed and circumscribed 4096-gons (400 seeded cases)", () => {
  const n = 4096;
  const r = seeded(25001n);
  for (let k = 0; k < 400; k++) {
    const corners = randomOutline(r);
    const centre: [number, number] = [Math.floor(r.next() * 91) - 45, Math.floor(r.next() * 91) - 45];
    const radius = 1 + Math.floor(r.next() * 15);
    const gon = (rr: number) => Array.from({ length: n }, (_, j): [number, number] => [centre[0] + rr * Math.cos((2 * PI * j) / n), centre[1] + rr * Math.sin((2 * PI * j) / n)]);
    const ccw = corners;
    const lo = clipArea(ccw, gon(radius));
    const hi = clipArea(ccw, gon(radius / Math.cos(PI / n)));
    const a = discPolygonArea(centre, radius, corners);
    assert.ok(lo - 1e-9 <= a && a <= hi + 1e-9, `case ${k}: ${a} not in [${lo}, ${hi}]`);
  }
});

test("clearance: a cut's circle must stay 0.1 mm off the outline for the random sessions (0.9× refused, 1.1× kept)", () => {
  const box = rect(0, 0, 40, 30);
  for (const [f, clear] of [
    [0.9, false],
    [1.1, true],
  ] as const) {
    const gap = f * CLEAR_MM;
    // Inside, its edge `gap` short of the side x = 40: clearance `gap`.
    assert.ok(near(clearance([35 - gap, 15], 5, box), gap));
    assert.equal(clearCut([35 - gap, 15], 5, box), clear);
    // Poking `gap` past the side x = 40.
    assert.equal(clearCut([35 + gap, 15], 5, box), clear);
    // Past the corner (40, 30) on the diagonal, the circle `gap` short of it.
    const d = (5 + gap) / Math.SQRT2;
    assert.equal(clearCut([40 + d, 30 + d], 5, box), clear);
  }
  // A crossing that is steep enough is fine: the hole half over the side x = 40.
  assert.equal(clearCut([40, 15], 5, box), true);
  // A circle swallowing the whole outline is refused: every corner is inside it.
  assert.equal(clearCut([0, 0], 10, rect(-1, -1, 1, 1)), false);
});

test("a face sketch follows the one face with its name, and warns without guessing when there are none or two", () => {
  const s: Extract<NamingItem, { kind: "face-sketch" }> = {
    id: "sketch-3",
    kind: "face-sketch",
    face: { feature: "extrude-2", role: "end" },
    side: 1,
    centre: [20, 15],
    radius: 5,
    drawn: { outward: [0, 0, 1], x: [1, 0, 0], normal: [0, 0, 1], origin: [0, 0, 20], centroid: [20, 15] },
    kept: flat(20),
  };
  const cap = (z: number): ModelFace => ({ name: { feature: "extrude-2", role: "end" }, point: [0, 0, z], outward: [0, 0, 1], corners: rect(0, 0, 40, 30), centroid: [20, 15] });
  // One face named extrude-2/end at z = 35: the sketch is there, frame unmoved.
  assert.deepEqual(placeOn([cap(35)], s), { placement: flat(35), matches: 1 });
  // None: plane lost, held where it last was.
  assert.deepEqual(placeOn([], s), { placement: flat(20), matches: 0, warning: { cause: "plane-lost", face: { feature: "extrude-2", role: "end" } } });
  // Two faces with the name (a face split in two, from booleans on): ambiguous, held, never one of them.
  const two = placeOn([cap(35), cap(50)], s);
  assert.deepEqual(two, { placement: flat(20), matches: 2, warning: { cause: "plane-ambiguous", face: { feature: "extrude-2", role: "end" } } });
  // The planted guess takes the first, and that is caught right here.
  assert.deepEqual(placeOn([cap(35), cap(50)], s, new Set(["ambiguous-picks-first"])).placement, flat(35));
  // Another feature's end cap is not this one, however alike.
  assert.equal(placeOn([{ ...cap(20), name: { feature: "extrude-9", role: "end" } }], s).warning?.cause, "plane-lost");
});

test("Ben's part on the model, by hand: 24000 − 250π, the sketch on the top at 20", () => {
  const m = ben();
  const r = rebuildNaming(m.doc);
  assert.deepEqual(r.order, ["sketch-1", "extrude-2", "sketch-3", "cut-4"]);
  // 40 · 30 · 20 = 24000; the hole π · 5² · 10 = 250π.
  assert.deepEqual(r.results["extrude-2"], { kind: "solid", volume: 24000, centroid: [20, 15, 10] });
  assert.deepEqual(r.results["sketch-3"], { kind: "sketch", placement: flat(20) });
  const cut = r.results["cut-4"];
  assert.ok(cut.kind === "cut" && cut.status === "built" && near(cut.removed, 250 * PI));
  assert.ok(near(r.bodies["extrude-2"], 24000 - 250 * PI));
  // Drawn on the bottom cap (z = 0, facing −Z) the cut goes up from 0 to 10: the same hole.
  const b = createNamingModel();
  run(b, ...setupOps({ ...BEN, cap: "start" }, true));
  const rb = rebuildNaming(b.doc);
  assert.deepEqual(rb.results["sketch-3"], { kind: "sketch", placement: flat(0, -1) });
  assert.ok(near(rb.bodies["extrude-2"], 24000 - 250 * PI));
  // A cut deeper than the body (40 into 20) goes through: 250π · 20 removed.
  run(b, { op: "set-depth", item: "cut-4", value: 40 });
  assert.ok(near(rebuildNaming(b.doc).bodies["extrude-2"], 24000 - 500 * PI));
});

test("a deleted outline sketch: the extrude keeps its last outline with a warning, and the hole still follows its top", () => {
  const m = ben();
  run(m, { op: "delete", item: "sketch-1" }, { op: "set-distance", item: "extrude-2", value: 35 });
  const r = rebuildNaming(m.doc);
  // The kept 40 × 30 at 35: 42000, the sketch on top at 35, the hole 250π.
  assert.deepEqual(r.results["extrude-2"], { kind: "solid", volume: 42000, centroid: [20, 15, 17.5], warning: { cause: "deleted-input", input: "sketch-1" } });
  assert.deepEqual(r.results["sketch-3"], { kind: "sketch", placement: flat(35) });
  assert.ok(near(r.bodies["extrude-2"], 42000 - 250 * PI));
});

test("a deleted circle sketch: the cut keeps its last circle and placement; a later flip leaves it with no target", () => {
  const m = ben();
  run(m, { op: "delete", item: "sketch-3" }, { op: "set-distance", item: "extrude-2", value: 35 });
  let r = rebuildNaming(m.doc);
  // Held at z = 20 facing +Z, the cut is 20 down to 10, inside 0 to 35: 250π from 42000.
  const cut = r.results["cut-4"];
  assert.ok(cut.kind === "cut" && cut.status === "built" && near(cut.removed, 250 * PI));
  assert.deepEqual(cut.warning, { cause: "deleted-input", input: "sketch-3" });
  assert.ok(near(r.bodies["extrude-2"], 42000 - 250 * PI));
  // Flipped to −20 the body is −20 to 0; the held cut, 10 to 20, misses it.
  run(m, { op: "set-distance", item: "extrude-2", value: -20 });
  r = rebuildNaming(m.doc);
  assert.deepEqual(r.results["cut-4"], { kind: "cut", status: "failed", cause: "no-target-body" });
  assert.equal(r.bodies["extrude-2"], 24000);
});

test("the plane-lost sketch keeps its last placement through undo and redo, and forgets it once the face is back", () => {
  const m = ben();
  run(m, { op: "set-distance", item: "extrude-2", value: 35 }, { op: "delete", item: "extrude-2" });
  const lost = m.doc.items.find((i) => i.id === "sketch-3");
  // It was last on the top at 35.
  assert.ok(lost?.kind === "face-sketch");
  assert.deepEqual(lost.kept, flat(35));
  run(m, { op: "undo" });
  const back = m.doc.items.find((i) => i.id === "sketch-3");
  assert.ok(back?.kind === "face-sketch" && back.kept === undefined);
  run(m, { op: "redo" });
  assert.deepEqual(rebuildNaming(m.doc).results["sketch-3"], { kind: "sketch", placement: flat(35), warning: { cause: "plane-lost", face: { feature: "extrude-2", role: "end" } } });
});

test("an edit that changes nothing records no undo step, and a refused one changes nothing", () => {
  const m = ben();
  const undo = m.undo.length;
  assert.deepEqual(run(m, { op: "set-distance", item: "extrude-2", value: 20 }), [{ kind: "unchanged" }]);
  assert.deepEqual(run(m, { op: "reorder", item: "cut-4", to: 0 }), [{ kind: "refused", cause: "before-dependency" }]);
  assert.equal(m.undo.length, undo);
  assert.deepEqual(rebuildNaming(m.doc).order, ["sketch-1", "extrude-2", "sketch-3", "cut-4"]);
});

test("ids come from the counter and are never reused after a delete", () => {
  const m = createNamingModel();
  const made = run(m, { op: "add-sketch", corners: rect(0, 0, 10, 10) }, { op: "delete", item: "sketch-1" }, { op: "add-sketch", corners: rect(0, 0, 10, 10) });
  // An outline's lines are counted apart: line-1 to line-4, then line-5 to line-8, never reused either.
  assert.deepEqual(made, [{ kind: "done", ids: ["sketch-1", "line-1", "line-2", "line-3", "line-4"] }, { kind: "done", ids: [] }, { kind: "done", ids: ["sketch-2", "line-5", "line-6", "line-7", "line-8"] }]);
});

test("the model refuses what its callers must never ask: an invalid outline, a zero distance, a sketch on a face that isn't there", () => {
  const m = ben();
  assert.throws(() => run(m, { op: "set-corners", sketch: "sketch-1", corners: [[0, 0], [10, 10], [10, 0], [0, 10]] }), /not a valid outline/);
  assert.throws(() => run(m, { op: "set-distance", item: "extrude-2", value: 0 }), /no distance/);
  assert.throws(() => run(m, { op: "add-face-sketch", face: { feature: "extrude-9", role: "end" }, centre: [0, 0], radius: 1 }), /no single face/);
});

// ------------------------------------------------------------ step 26 (26a)

const r17 = Math.sqrt(17);
const vNear = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((x, k) => near(x, b[k]));

test("rule 8 by hand: the frame each face of a box gets is the nearest origin plane's, so sketch coordinates read as the world's", () => {
  // Outward normal → (frame x, frame normal, side). Top and bottom: the
  // ground plane (x = X, normal +Z), the bottom facing against it. Front
  // and back: the front plane (x = X, normal −Y, so y = −Y × X = Z). Right
  // and left: the side plane (x = Y, normal +X, y = X × Y = Z).
  const cases: [number[], number[], number[], 1 | -1][] = [
    [[0, 0, 7], [1, 0, 0], [0, 0, 1], 1],
    [[0, 0, -7], [1, 0, 0], [0, 0, 1], -1],
    [[0, -7, 0], [1, 0, 0], [0, -1, 0], 1],
    [[0, 7, 0], [1, 0, 0], [0, -1, 0], -1],
    [[7, 0, 0], [0, 1, 0], [1, 0, 0], 1],
    [[-7, 0, 0], [0, 1, 0], [1, 0, 0], -1],
  ];
  for (const [out, x, normal, side] of cases) {
    const f = drawnFrame(out as [number, number, number]);
    assert.deepEqual([f.x, f.normal, f.side], [x, normal, side], `facing ${out}`);
  }
});

test("rule 8 by hand: a slanted side and an exact 45° tie", () => {
  // Facing (3, −4, 0)/5: |· −Y| = 4 beats |· X| = 3, so the front plane,
  // the same way (side +1). Turning −Y onto (0.6, −0.8, 0) about Z is a turn
  // by θ with sin θ = 0.6, cos θ = 0.8, which takes X to (0.8, 0.6, 0):
  // along the side, square to the normal (0.8 · 0.6 − 0.6 · 0.8 = 0).
  const f = drawnFrame([3, -4, 0]);
  assert.ok(vNear(f.normal, [0.6, -0.8, 0]) && vNear(f.x, [0.8, 0.6, 0]) && f.side === 1);
  // Facing (1, 1, 0): |· −Y| = |· X| = 1, a tie in whole numbers, broken in
  // the order XY, XZ, YZ: the front plane, the other way (1 · −1 < 0), so
  // side −1 and the normal is −(1, 1, 0)/√2. Turning −Y onto it is a turn by
  // −45° about Z: X goes to (1, −1, 0)/√2.
  const t = drawnFrame([1, 1, 0]);
  assert.ok(vNear(t.normal, [-Math.SQRT1_2, -Math.SQRT1_2, 0]) && vNear(t.x, [Math.SQRT1_2, -Math.SQRT1_2, 0]) && t.side === -1);
  // Turning checked on its own: −Y onto (1, −4, 0)/√17 takes X to (4, 1, 0)/√17 (cos 4/√17, sin 1/√17), and the identity when from = to.
  assert.ok(vNear(turned([1, 0, 0], [0, -1, 0], [1 / r17, -4 / r17, 0]), [4 / r17, 1 / r17, 0]));
  assert.deepEqual(turned([1, 0, 0], [0, 0, 1], [0, 0, 1]), [1, 0, 0]);
});

test("rule 8 by hand: a turned face keeps its normal on the drawn side; exactly a right angle takes the outward side", () => {
  // Drawn on a front side facing (0, −40, 0): frame normal −Y, x = X, side +1.
  const drawn: Drawn = { outward: [0, -40, 0], x: [1, 0, 0], normal: [0, -1, 0], origin: [0, 0, 0], centroid: [20, 0] };
  // Turned to face (40, −10, 0) (75.96° round): 1 · (0 · 40 + −40 · −10) = 400 > 0, so the normal stays outward, (4, −1, 0)/√17.
  const a = frameNow(drawn, 1, [40, -10, 0], [0, 0, 0]);
  assert.ok(vNear(a.normal, [4 / r17, -1 / r17, 0]));
  // Exactly square, facing (40, 0, 0): the dot is 0, a tie: the outward side, +X, and X turned a quarter turn to Y.
  const b = frameNow(drawn, 1, [40, 0, 0], [40, 0, 0]);
  assert.ok(vNear(b.normal, [1, 0, 0]) && vNear(b.x, [0, 1, 0]) && vNear(b.origin, [40, 0, 0]));
  // Past square, facing (40, 10, 0): 1 · (−40 · 10) < 0, so the normal is the inward one, −(4, 1, 0)/√17, nearer the drawn −Y.
  const c = frameNow(drawn, 1, [40, 10, 0], [0, 0, 0]);
  assert.ok(vNear(c.normal, [-4 / r17, -1 / r17, 0]));
  // A cap flipped (drawn facing +Z, now −Z): the frame stays the world's XY; with the planted bug that never turns, a side's frame stays off its plane.
  const cap: Drawn = { outward: [0, 0, 1], x: [1, 0, 0], normal: [0, 0, 1], origin: [0, 0, 20], centroid: [20, 15] };
  assert.deepEqual(frameNow(cap, 1, [0, 0, -1], [0, 0, -20]), { origin: [0, 0, -20], x: [1, 0, 0], normal: [0, 0, 1] });
  assert.deepEqual(frameNow(drawn, 1, [40, -10, 0], [0, 0, 0], new Set(["frame-not-turned"])).normal, [0, -1, 0]);
});

test("a sketch's point in the world: origin + u x + v (normal × x)", () => {
  // The front plane at y = 0: (20, 10) is (20, 0, 10); the back face's frame at y = 30: (20, 30, 10).
  assert.deepEqual(worldOf({ origin: [0, 0, 0], x: [1, 0, 0], normal: [0, -1, 0], side: 1 }, 20, 10), [20, 0, 10]);
  assert.deepEqual(worldOf({ origin: [0, 30, 0], x: [1, 0, 0], normal: [0, -1, 0], side: -1 }, 20, 10), [20, 30, 10]);
});

test("regression: a clockwise outline is no smaller a body (the 25a model gave it a negative volume)", () => {
  // The triangle (0, 0), (0, 30), (40, 0) goes clockwise: shoelace −600,
  // but the body is 600 · 10 = 6000 mm³, its middle (40/3, 10, 5).
  const m = createNamingModel();
  run(m, { op: "add-sketch", corners: [[0, 0], [0, 30], [40, 0]] }, { op: "add-extrude", sketch: "sketch-1", distance: 10 });
  const r = rebuildNaming(m.doc);
  assert.equal(r.bodies["extrude-2"], 6000);
  const e = r.results["extrude-2"];
  assert.ok(e.kind === "solid" && vNear(e.centroid, [40 / 3, 10, 5]));
  // Its sides face out all the same: line 1, (0, 0) to (0, 30), faces −X, so a sketch on it has the side plane's frame facing against it.
  run(m, { op: "add-face-sketch", face: { feature: "extrude-2", role: "side", line: "line-1" }, centre: [0, 0], radius: 1 });
  assert.deepEqual(rebuildNaming(m.doc).results["sketch-3"], { kind: "sketch", placement: { origin: [0, 0, 0], x: [0, 1, 0], normal: [1, 0, 0], side: -1 } });
});

test("an outline's lines: moved corners keep them, another number of corners makes new ones", () => {
  const m = ben(false);
  assert.deepEqual(run(m, { op: "move-corner", sketch: "sketch-1", corner: 2, to: [45, 30] }), [{ kind: "done", ids: [] }]);
  assert.deepEqual(run(m, { op: "set-corners", sketch: "sketch-1", corners: rect(0, 0, 50, 30) }), [{ kind: "done", ids: [] }]);
  const s = m.doc.items[0];
  assert.ok(s.kind === "sketch");
  assert.deepEqual(s.lines, ["line-1", "line-2", "line-3", "line-4"]);
  assert.deepEqual(run(m, { op: "set-corners", sketch: "sketch-1", corners: [[0, 0], [40, 0], [0, 30]] }), [{ kind: "done", ids: ["line-5", "line-6", "line-7"] }]);
  // The planted bug reuses the old lines by place, so a sketch on line 2 would follow the triangle's slanted side.
  const bad = createNamingModel(["side-by-index"]);
  run(bad, ...setupOps(BEN, false));
  assert.deepEqual(run(bad, { op: "set-corners", sketch: "sketch-1", corners: [[0, 0], [40, 0], [0, 30]] }), [{ kind: "done", ids: ["line-1", "line-2", "line-3"] }]);
});

test("rule 9: suppressing greys what is built on it, keeps nothing while greyed, and a delete keeps where it would have been", () => {
  const m = ben(false);
  run(m, { op: "suppress", item: "extrude-2", on: true });
  let r = rebuildNaming(m.doc);
  assert.deepEqual([r.results["extrude-2"], r.results["sketch-3"], r.results["extrude-4"], r.bodies], [{ kind: "suppressed" }, { kind: "greyed" }, { kind: "greyed" }, {}]);
  // Greyed is not lost: the sketch holds no placement.
  const s = m.doc.items.find((i) => i.id === "sketch-3");
  assert.ok(s?.kind === "face-sketch" && s.kept === undefined);
  // The sketch on the top deleted while greyed: the cylinder keeps the circle where it would be with nothing suppressed, the top at 20.
  run(m, { op: "delete", item: "sketch-3" }, { op: "suppress", item: "extrude-2", on: false });
  r = rebuildNaming(m.doc);
  const e = r.results["extrude-4"];
  assert.ok(e.kind === "solid" && vNear(e.centroid, [20, 15, 25]));
  assert.deepEqual(e.warning, { cause: "deleted-input", input: "sketch-3" });
  // The planted bug that lets dependents build: the sketch's face is off, so it says plane lost, which Ben's Q3 says it must not.
  const bad = createNamingModel(["suppress-keeps-dependents"]);
  run(bad, ...setupOps(BEN, false), { op: "suppress", item: "extrude-2", on: true });
  assert.equal(rebuildNaming(bad.doc, bad.faults).results["sketch-3"].warning?.cause, "plane-lost");
});

test("the model refuses what step 26 doesn't model: a cut from a side, suppressing a sketch", () => {
  const m = ben(false);
  run(m, { op: "add-face-sketch", face: { feature: "extrude-2", role: "side", line: "line-2" }, centre: [15, 10], radius: 3 });
  assert.throws(() => run(m, { op: "add-cut", sketch: "sketch-5", depth: 5 }), /not modelled until booleans/);
  assert.throws(() => run(m, { op: "suppress", item: "sketch-1", on: true }), /only a feature/);
  // A face that is off can't be sketched on.
  run(m, { op: "suppress", item: "extrude-2", on: true });
  assert.throws(() => run(m, { op: "add-face-sketch", face: { feature: "extrude-2", role: "end" }, centre: [0, 0], radius: 1 }), /no single face/);
});

test("hand-worked: a pin finds its cap's corner by the two lines it sits between, and a side's middle by its line (rule 10, Q4)", () => {
  const m = createNamingModel();
  for (const op of setupOps(BEN, false)) applyNaming(m, op);
  const top = { feature: "extrude-2", role: "end" as const };
  // Ben's rectangle (0, 0), (40, 0), (40, 30), (0, 30): line k + 1 runs
  // from corner k to corner k + 1, so corner 2, (40, 30), is where line 2
  // ends and line 3 starts; corner 0, (0, 0), where line 4 ends and line 1
  // starts (round the end). Line 2's middle is ((40 + 40) / 2, (0 + 30) / 2).
  assert.deepEqual(pinAt(m.doc, top, { at: "corner", before: "line-2", after: "line-3" }), [40, 30]);
  assert.deepEqual(pinAt(m.doc, top, { at: "corner", before: "line-4", after: "line-1" }), [0, 0]);
  assert.deepEqual(pinAt(m.doc, top, { at: "middle", line: "line-2" }), [40, 15]);
  // The order matters: no corner has line 3 ending and line 2 starting.
  assert.equal(pinAt(m.doc, top, { at: "corner", before: "line-3", after: "line-2" }), null);
  // Lines that never met, a line not there, a side face: nothing.
  assert.equal(pinAt(m.doc, top, { at: "corner", before: "line-1", after: "line-3" }), null);
  assert.equal(pinAt(m.doc, top, { at: "middle", line: "line-9" }), null);
  assert.equal(pinAt(m.doc, { feature: "extrude-2", role: "side", line: "line-2" }, { at: "middle", line: "line-2" }), null);
  // The bottom cap's corner is the same (x, y): a cap's frame is the world's XY (rule 8).
  assert.deepEqual(pinAt(m.doc, { feature: "extrude-2", role: "start" }, { at: "corner", before: "line-2", after: "line-3" }), [40, 30]);
  // Planted: the corner at the other end of line 3, (0, 30).
  assert.deepEqual(pinAt(m.doc, top, { at: "corner", before: "line-2", after: "line-3" }, new Set(["pin-wrong-end"])), [0, 30]);
  // With the outline's sketch deleted, the extrude keeps its shape and its lines, so the pin still finds its corner.
  applyNaming(m, { op: "delete", item: "sketch-1" });
  assert.deepEqual(pinAt(m.doc, top, { at: "corner", before: "line-2", after: "line-3" }), [40, 30]);
});

test("hand-worked: a pinned centre goes with its corner, stays when the corner is gone, and is let go when the circle is moved (rule 10)", () => {
  const m = createNamingModel();
  const pin = { at: "corner" as const, before: "line-2", after: "line-3" };
  for (const op of setupOps({ ...BEN, pin }, false)) applyNaming(m, op);
  const circle = () => m.doc.items.find((i) => i.id === "sketch-3") as Extract<NamingItem, { kind: "face-sketch" }>;
  // Snapped on: the centre is the corner whatever the op's centre said.
  assert.deepEqual(circle().centre, [40, 30]);
  // Corner 2 moved to (55, 35): the centre with it, no warning.
  applyNaming(m, { op: "move-corner", sketch: "sketch-1", corner: 2, to: [55, 35] });
  assert.deepEqual(circle().centre, [55, 35]);
  assert.equal(rebuildNaming(m.doc).results["sketch-3"].warning, undefined);
  // A triangle is a new outline (lines 5, 6, 7): the corner is gone, the centre stays at (55, 35), the sketch says so.
  applyNaming(m, { op: "set-corners", sketch: "sketch-1", corners: [[0, 0], [40, 0], [0, 30]] });
  assert.deepEqual(circle().centre, [55, 35]);
  assert.deepEqual(rebuildNaming(m.doc).results["sketch-3"].warning, { cause: "point-lost", pin });
  // Planted: silent, or sent back to the origin.
  assert.equal(rebuildNaming(m.doc, new Set(["lost-pin-silent"])).results["sketch-3"].warning, undefined);
  applyNaming(m, { op: "undo" });
  assert.deepEqual(circle().centre, [55, 35]);
  // Moved by hand, the pin goes: the corner's next move leaves the circle alone.
  applyNaming(m, { op: "set-circle", sketch: "sketch-3", centre: [10, 10], radius: 5 });
  assert.equal(circle().pin, undefined);
  applyNaming(m, { op: "move-corner", sketch: "sketch-1", corner: 2, to: [40, 30] });
  assert.deepEqual(circle().centre, [10, 10]);
  // A pin asked for where there is no such corner is refused, not guessed.
  assert.throws(() => applyNaming(m, { op: "add-face-sketch", face: { feature: "extrude-2", role: "end" }, centre: [0, 0], radius: 1, pin: { at: "corner", before: "line-1", after: "line-3" } }), /no corner:line-1>line-3/);
});
