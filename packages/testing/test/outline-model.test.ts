// The outline model (src/outline-model.ts) against answers worked out by
// hand, before it is trusted to check the kernel in
// journeys/sketch-mixed.journey.ts and the browser's long sketch session.
import { test } from "node:test";
import assert from "node:assert/strict";
import { compareOutline, modelOutline, notSimple, openWords, segmentsMeet, shoelace, type ModelLine, type XY } from "../src/outline-model.ts";

/** A closed chain of lines through these corners, the last joining back to the first. */
const ring = (pts: XY[]): ModelLine[] => pts.map((a, i) => ({ a, b: pts[(i + 1) % pts.length] }));

test("hand-worked: a 40 × 30 rectangle is closed with area 1200; the same lines reversed and shuffled too", () => {
  // 40 · 30 = 1200 mm².
  const m = modelOutline(ring([[0, 0], [40, 0], [40, 30], [0, 30]]), []);
  assert.equal(m.kind, "closed");
  assert.equal(m.kind === "closed" && m.area, 1200);
  const shuffled: ModelLine[] = [{ a: [40, 30], b: [40, 0] }, { a: [0, 0], b: [0, 30] }, { a: [40, 0], b: [0, 0] }, { a: [0, 30], b: [40, 30] }];
  const n = modelOutline(shuffled, []);
  assert.equal(n.kind === "closed" && n.area, 1200);
});

test("hand-worked: a house (rectangle plus a roof to (20, 50)) is 1200 + ½ · 40 · 20 = 1600", () => {
  const m = modelOutline(ring([[0, 0], [40, 0], [40, 30], [20, 50], [0, 30]]), []);
  assert.equal(m.kind === "closed" && m.area, 1600);
});

test("hand-worked: going straight on at a corner is fine; turning straight back is not", () => {
  // (40, 30) → (20, 30) → (0, 30) is one straight top side drawn as two lines: still the 1200 rectangle.
  const straight = modelOutline(ring([[0, 0], [40, 0], [40, 30], [20, 30], [0, 30]]), []);
  assert.equal(straight.kind === "closed" && straight.area, 1200);
  // (0, 0) → (40, 0) → (20, 0) → back to (0, 0) runs back over itself at (40, 0) (in +x, out −x) and at
  // (0, 0) (in from (20, 0) going −x, out +x); (20, 0) goes straight on. The first corner checked is (0, 0).
  const back = modelOutline(ring([[0, 0], [40, 0], [20, 0]]), []);
  assert.deepEqual([back.kind, back.kind === "not a profile" && back.why], ["not a profile", "turns back at (0,0)"]);
});

test("hand-worked: a roof whose peak lands on the floor touches it, so it is not an outline", () => {
  // Corners (0,0) (40,0) (40,30) (20,0) (0,30): the corner (20, 0) lies on side 0, (0,0)–(40,0).
  const m = modelOutline(ring([[0, 0], [40, 0], [40, 30], [20, 0], [0, 30]]), []);
  assert.deepEqual([m.kind, m.kind === "not a profile" && m.why], ["not a profile", "sides 0 and 2 meet"]);
  // A bow tie crosses itself: (0,0) (40,30) (40,0) (0,30); sides 0 and 2 cross at (20, 15).
  const bow = modelOutline(ring([[0, 0], [40, 30], [40, 0], [0, 30]]), []);
  assert.equal(bow.kind, "not a profile");
});

test("hand-worked: loose ends, branches and separate loops, each at the first end in drawing order", () => {
  // One line (0,0)–(10,0): end 0 at (0, 0) meets no other end.
  assert.deepEqual(modelOutline([{ a: [0, 0], b: [10, 0] }], []), { kind: "loose", at: [0, 0] });
  // A rectangle and a chain (40,30) → (60,30) → (60,0) → (40,0): end 1, (40, 0), has three ends there.
  const rect = ring([[0, 0], [40, 0], [40, 30], [0, 30]]);
  const chain: ModelLine[] = [{ a: [40, 30], b: [60, 30] }, { a: [60, 30], b: [60, 0] }, { a: [60, 0], b: [40, 0] }];
  assert.deepEqual(modelOutline([...rect, ...chain], []), { kind: "branch", at: [40, 0], ends: 3 });
  // A rectangle and a circle: two loops. Two rectangles apart and a circle: three.
  assert.deepEqual(modelOutline(rect, [{ centre: [20, 15], radius: 5 }]), { kind: "loops", loops: 2 });
  const far = ring([[100, 0], [110, 0], [110, 10], [100, 10]]);
  assert.deepEqual(modelOutline([...rect, ...far], [{ centre: [20, 15], radius: 5 }]), { kind: "loops", loops: 3 });
  // Nothing, one circle (π · 5² = 25π), two circles.
  assert.deepEqual(modelOutline([], []), { kind: "empty" });
  assert.deepEqual(modelOutline([], [{ centre: [0, 0], radius: 5 }]), { kind: "circle", area: 25 * Math.PI });
  assert.deepEqual(modelOutline([], [{ centre: [0, 0], radius: 5 }, { centre: [0, 0], radius: 6 }]), { kind: "loops", loops: 2 });
  // A line drawn twice between the same two points: one loop of two corners.
  const twice = modelOutline([{ a: [0, 0], b: [10, 0] }, { a: [10, 0], b: [0, 0] }], []);
  assert.deepEqual([twice.kind, twice.kind === "not a profile" && twice.why], ["not a profile", "2 corners"]);
});

test("the kernel's words for each open kind, as the app shows them", () => {
  assert.equal(openWords({ kind: "loose", at: [-10, 20] }), "the end at (-10, 20) is not joined to another line or arc");
  assert.equal(openWords({ kind: "branch", at: [40, 0], ends: 3 }), "3 ends meet at (40, 0); every corner of an outline joins exactly two");
  assert.equal(openWords({ kind: "loops", loops: 2 }), "the sketch makes 2 separate loops; for now a sketch makes one outline");
  assert.throws(() => openWords({ kind: "closed", corners: [], area: 0 }), /not open/);
});

test("segmentsMeet: crossing, touching at an end, overlapping in line, and one grid step apart", () => {
  assert.equal(segmentsMeet([0, 0], [10, 10], [0, 10], [10, 0]), true, "an X crosses at (5, 5)");
  assert.equal(segmentsMeet([0, 0], [10, 0], [10, 0], [10, 10]), true, "an L touches at (10, 0)");
  assert.equal(segmentsMeet([0, 0], [10, 0], [5, 0], [20, 0]), true, "in line, overlapping from 5 to 10");
  assert.equal(segmentsMeet([0, 0], [10, 0], [11, 0], [20, 0]), false, "in line, 1 apart");
  assert.equal(segmentsMeet([0, 0], [10, 0], [5, 1], [5, 10]), false, "a T one unit short of the bar");
  assert.equal(segmentsMeet([0, 0], [10, 0], [5, 0], [5, 10]), true, "a T on the bar");
});

test("shoelace and notSimple on a 3-4-5 triangle: ½ · 4 · 3 = 6, simple", () => {
  assert.equal(shoelace([[0, 0], [4, 0], [0, 3]]), 6);
  assert.equal(notSimple([[0, 0], [4, 0], [0, 3]]), null);
});

test("the model takes whole numbers only, so its tests stay exact", () => {
  assert.throws(() => modelOutline([{ a: [0, 0.5], b: [10, 0] }], []), /whole-number/);
});

test("compareOutline fails on each kind of disagreement (a check must be able to fail)", () => {
  const house = modelOutline(ring([[0, 0], [40, 0], [40, 30], [20, 50], [0, 30]]), []);
  const rectangle = { closed: { outer: { path: { corners: [0, 0, 40, 0, 40, 30, 0, 30], bulges: [] } }, holes: [] } };
  const houseKernel = { closed: { outer: { path: { corners: [40, 30, 20, 50, 0, 30, 0, 0, 40, 0], bulges: [] } }, holes: [] } };
  compareOutline(house, houseKernel); // the same corners from another start: agrees
  assert.throws(() => compareOutline(house, rectangle), /different corners/);
  assert.throws(() => compareOutline(house, { open: "the sketch has no lines, arcs or circles yet" }), /left it open/);
  assert.throws(() => compareOutline({ kind: "loose", at: [0, 0] }, houseKernel), /closed it/);
  assert.throws(() => compareOutline({ kind: "loose", at: [0, 0] }, { open: "the end at (10, 0) is not joined to another line or arc" }), /different reasons/);
  assert.throws(() => compareOutline({ kind: "circle", area: 1 }, rectangle), /made a path/);
  assert.throws(() => compareOutline(house, { closed: { outer: { circle: { center: [0, 0], radius: 1 } }, holes: [] } }), /made a circle/);
  compareOutline({ kind: "not a profile", corners: [], why: "x" }, { open: "the curves close up but are not a valid outline: anything" });
});
