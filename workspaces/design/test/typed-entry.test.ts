// Sketch feel SF4: typed sizes while drawing (typed-entry.ts, the maths;
// typed-boxes.ts, the boxes). Hand-worked ends and corners with the working
// shown, the kernel's size limits at 0.9× and 1.1×, whole shapes typed
// through the real tools (a square closing exactly on its first corner),
// a seeded random check against a model written apart from the code, and
// the boxes' keys in a real DOM.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SketchXY } from "@fission/core";
import { partDocument } from "../src/document.ts";
import { addSketch, sketchLines } from "../src/sketch.ts";
import { clickAt, startTool, type LineTool, type RectangleTool, type SketchTool } from "../src/sketch-tool.ts";
import { aimOf, anchorOf, angleOf, direction, lineEnd, liveValues, MAX_TYPED, MIN_TYPED, readAngle, readLength, rectangleCorner, shownValue, turnDegrees, typedFields, type Locks } from "../src/typed-entry.ts";
import { FIELD_LABELS, typedBoxes } from "../src/typed-boxes.ts";
import { DESIGN_SHORTCUTS, typedSizeKey } from "../src/shortcuts.ts";
import { parseChord, ShortcutTable, SHELL_SHORTCUTS } from "@fission/core";

const value = (r: ReturnType<typeof readLength>) => ("value" in r ? r.value : r.error);
const refused = (r: ReturnType<typeof readLength>) => "error" in r;

test("lengths read by hand: plain decimals of mm, with or without the unit", () => {
  assert.equal(value(readLength("25")), 25);
  assert.equal(value(readLength(" 12.5 mm ")), 12.5);
  assert.equal(value(readLength("12.5MM")), 12.5);
  assert.equal(value(readLength(".5")), 0.5);
  assert.equal(value(readLength("7.")), 7);
  assert.equal(value(readLength("+3")), 3);
  for (const bad of ["", " ", "abc", "1e3", "0x10", "Infinity", "NaN", "1.2.3", "--1", "5 cm", "1,5"]) assert.ok(refused(readLength(bad)), `"${bad}" is not a length`);
  assert.match((readLength("0") as { error: string }).error, /more than 0/);
  assert.match((readLength("-3") as { error: string }).error, /more than 0/);
  assert.match((readLength("abc") as { error: string }).error, /isn't a length/);
});

test("length limits at 0.9× and 1.1× of the kernel's smallest piece and largest size", () => {
  // kernel/src/tolerance.rs: MIN_FEATURE = 1e-3 mm, MAX_SIZE = 1e6 mm.
  assert.equal(MIN_TYPED, 1e-3);
  assert.equal(MAX_TYPED, 1e6);
  assert.match((readLength("0.0009") as { error: string }).error, /at least 0.001 mm/, "0.9 × MIN_FEATURE is refused");
  assert.equal(value(readLength("0.0011")), 0.0011, "1.1 × MIN_FEATURE is a length");
  assert.equal(value(readLength("0.001")), 0.001, "MIN_FEATURE itself is a length");
  assert.equal(value(readLength("900000")), 900000, "0.9 × MAX_SIZE is a length");
  assert.match((readLength("1100000") as { error: string }).error, /at most 1000000 mm/, "1.1 × MAX_SIZE is refused");
  assert.equal(value(readLength("1000000")), 1e6, "MAX_SIZE itself is a length");
});

test("angles read by hand: degrees from the x axis, turned into [0, 360)", () => {
  assert.equal(value(readAngle("30")), 30);
  assert.equal(value(readAngle("30°")), 30);
  assert.equal(value(readAngle("30 deg")), 30);
  assert.equal(value(readAngle("-90")), 270, "−90 + 360 = 270");
  assert.equal(value(readAngle("450")), 90, "450 − 360 = 90");
  assert.equal(value(readAngle("360")), 0);
  assert.equal(value(readAngle("-720")), 0);
  assert.ok(Object.is(value(readAngle("-0")), 0), "−0 is the angle +0");
  assert.ok(Object.is(turnDegrees(-1e-17), 0), "−1e-17 % 360 + 360 rounds to 360: that is 0");
  for (const bad of ["", "north", "1e2", "30 rad", "Infinity"]) assert.ok(refused(readAngle(bad)), `"${bad}" is not an angle`);
});

test("an angle too big to be a number is refused, not turned into NaN (security re-check N2)", () => {
  // The largest double is about 1.798e308: 308 nines (just under 1e308) is a
  // number, 309 nines (just under 1e309) reads as Infinity, and Infinity % 360 is NaN.
  const nines = (k: number) => "9".repeat(k);
  assert.ok(Number.isFinite(Number(nines(308))) && !Number.isFinite(Number(nines(309))), "where the doubles end");
  const near = value(readAngle(nines(308)));
  assert.ok(near >= 0 && near < 360, `308 nines turn into [0, 360): ${near}`);
  for (const k of [309, 400]) assert.match((readAngle(nines(k)) as { error: string }).error, /too big for an angle/, `${k} nines`);
  // A length that big was already refused by MAX_TYPED (Infinity > 1e6).
  assert.match((readLength(nines(400)) as { error: string }).error, /at most 1000000 mm/);
});

test("directions: the four quarter turns are exact, 30° is (√3/2, 1/2)", () => {
  assert.deepEqual(direction(0), [1, 0]);
  assert.deepEqual(direction(90), [0, 1]);
  assert.deepEqual(direction(180), [-1, 0]);
  assert.deepEqual(direction(270), [0, -1]);
  assert.deepEqual(direction(-90), [0, -1]);
  assert.deepEqual(direction(450), [0, 1]);
  // 30-60-90 triangle: the sides are 1 : √3 : 2, so the unit at 30° is (√3/2, 1/2).
  const [x, y] = direction(30);
  assert.ok(Math.abs(x - Math.sqrt(3) / 2) < 1e-15 && Math.abs(y - 0.5) < 1e-15);
});

test("a line's end by hand, for each kind of lock", () => {
  // Nothing locked: the pointer.
  assert.deepEqual(lineEnd([0, 0], [3, 4], {}), [3, 4]);
  // Length 10 toward (3, 4): |(3, 4)| = 5, so k = 10 / 5 = 2 and the end is (6, 8), exactly.
  assert.deepEqual(lineEnd([0, 0], [3, 4], { length: 10 }), [6, 8]);
  // Length 3 toward (3, 4): (3·3/5, 4·3/5) = (9/5, 12/5) = (1.8, 2.4), each the nearest double (one rounding, not two).
  assert.deepEqual(lineEnd([0, 0], [3, 4], { length: 3 }), [9 / 5, 12 / 5]);
  // Length 2.5 from (1, 1) toward (1, 7): straight up, so (1, 1 + 2.5) = (1, 3.5), x untouched.
  assert.deepEqual(lineEnd([1, 1], [1, 7], { length: 2.5 }), [1, 3.5]);
  // Length 4 from (2, 0) toward (−8, 0): left, so (2 − 4, 0) = (−2, 0).
  assert.deepEqual(lineEnd([2, 0], [-8, 0], { length: 4 }), [-2, 0]);
  // Length locked, pointer on the start: no direction.
  assert.equal(lineEnd([1, 1], [1, 1], { length: 5 }), null);
  // Angle 90 from (0, 0), pointer (5, 7): the pointer's distance along +y is 7, so (0, 7).
  assert.deepEqual(lineEnd([0, 0], [5, 7], { angle: 90 }), [0, 7]);
  // Angle 90, pointer (5, −1): behind the start, nothing.
  assert.equal(lineEnd([0, 0], [5, -1], { angle: 90 }), null);
  // Angle 180 from (10, 10), pointer (4, 99): 6 to the left, so (4, 10).
  assert.deepEqual(lineEnd([10, 10], [4, 99], { angle: 180 }), [4, 10]);
  // Both: length 10 at 30° from (0, 0) is (5√3, 5) ≈ (8.660254, 5), whatever the pointer, even none.
  for (const p of [null, [-50, -50] as SketchXY, [0, 0] as SketchXY]) {
    const e = lineEnd([0, 0], p, { length: 10, angle: 30 })!;
    assert.ok(Math.abs(e[0] - 5 * Math.sqrt(3)) < 1e-12 && Math.abs(e[1] - 5) < 1e-12, `${e}`);
  }
  // Both, a quarter turn: length 7 at 270° from (3, 3) is (3, −4), exactly.
  assert.deepEqual(lineEnd([3, 3], null, { length: 7, angle: 270 }), [3, -4]);
  // No pointer and not both locked: nothing.
  assert.equal(lineEnd([0, 0], null, { length: 7 }), null);
});

test("a rectangle's opposite corner by hand", () => {
  // Corner (10, 20). Width 30 with the pointer to the left at (0, 50): x = 10 − 30 = −20; y follows the pointer.
  assert.deepEqual(rectangleCorner([10, 20], [0, 50], { width: 30 }), [-20, 50]);
  // Height 5 with the pointer above: y = 20 + 5 = 25.
  assert.deepEqual(rectangleCorner([10, 20], [0, 50], { height: 5 }), [0, 25]);
  // Height 5 with the pointer below at y = 0: y = 20 − 5 = 15.
  assert.deepEqual(rectangleCorner([10, 20], [12, 0], { height: 5 }), [12, 15]);
  // Both, no pointer: up and right, (40, 25).
  assert.deepEqual(rectangleCorner([10, 20], null, { width: 30, height: 5 }), [40, 25]);
  // Both, pointer down-left at (0, 0): (−20, 15).
  assert.deepEqual(rectangleCorner([10, 20], [0, 0], { width: 30, height: 5 }), [-20, 15]);
  // Level with the corner counts as the right / upper side.
  assert.deepEqual(rectangleCorner([10, 20], [10, 20], { width: 30, height: 5 }), [40, 25]);
  assert.equal(rectangleCorner([10, 20], null, { width: 30 }), null);
});

test("the boxes each tool shows, its anchor, and the live values", () => {
  const s = addSketch(partDocument("box", 40, 30, 20));
  assert.deepEqual(typedFields(startTool("line", s.id)), [], "no boxes before the start");
  assert.deepEqual(typedFields({ kind: "line", sketch: s.id, from: [0, 0] }), ["length", "angle"]);
  assert.deepEqual(typedFields({ kind: "rectangle", sketch: s.id, corner: [0, 0] }), ["width", "height"]);
  for (const kind of ["circle", "arc", "tangent"] as const) assert.deepEqual(typedFields(startTool(kind, s.id)), []);
  assert.deepEqual(typedFields({ kind: "circle", sketch: s.id, centre: [0, 0] }), [], "circles come later");
  // After a line (0, 0) → (10, 0) the chain's start is the point id of (10, 0).
  const one = clickAt(clickAt(s.doc, startTool("line", s.id), [0, 0]).doc, clickAt(s.doc, startTool("line", s.id), [0, 0]).tool, [10, 0]);
  assert.equal(typeof (one.tool as LineTool).from, "string");
  assert.deepEqual(anchorOf(one.doc, one.tool), [10, 0]);
  assert.equal(anchorOf(s.doc, startTool("line", s.id)), null);
  // From (0, 0) to (−3, −3): length 3√2 ≈ 4.243, angle 225°.
  const live = liveValues([0, 0], [-3, -3], { kind: "line", sketch: s.id, from: [0, 0] });
  assert.equal(shownValue(live.length!), "4.243");
  assert.equal(live.angle, 225);
  assert.equal(angleOf([1, 1], [1, 1]), 0);
  assert.deepEqual(liveValues([5, 5], [2, 9], { kind: "rectangle", sketch: s.id, corner: [5, 5] }), { width: 3, height: 4 });
  assert.equal(shownValue(12.34567), "12.346");
  assert.equal(shownValue(-0.0001), "0");
  assert.equal(shownValue(1e6), "1000000");
});

/** Places each point where the locks put it with the pointer at `p`, as the workspace's Enter does. */
function typeIn<T extends SketchTool>(doc: ReturnType<typeof addSketch>["doc"], tool: T, steps: { p: SketchXY | null; locks: Locks }[]) {
  for (const { p, locks } of steps) {
    const aim = aimOf(doc, tool, p, locks);
    assert.ok(aim, "every step has an aim");
    const r = clickAt(doc, tool, aim);
    doc = r.doc;
    tool = r.tool;
  }
  return { doc, tool };
}

test("hand-worked: a 10 mm square typed side by side closes exactly on its first corner", () => {
  const s = addSketch(partDocument("box", 40, 30, 20));
  // Start at (0, 0), then 10 at 0°, 90°, 180° and 270°: (10, 0), (10, 10), (0, 10), (0, 0).
  // The quarter turns are exact, so the last end is (0, 0) bit for bit and joins the first point.
  const r = typeIn(s.doc, startTool("line", s.id), [
    { p: [0, 0], locks: {} },
    { p: [33, 5], locks: { length: 10, angle: 0 } },
    { p: null, locks: { length: 10, angle: 90 } },
    { p: null, locks: { length: 10, angle: 180 } },
    { p: [-7, 2], locks: { length: 10, angle: 270 } },
  ]);
  const sketch = r.doc.sketches.find((x) => x.id === s.id)!;
  assert.equal((r.tool as LineTool).from, null, "landing on the first point ends the chain");
  assert.deepEqual(sketch.points.map((p) => [p.x, p.y]), [[0, 0], [10, 0], [10, 10], [0, 10]]);
  assert.deepEqual(sketchLines(sketch).map((l) => [l.a, l.b]), [[[0, 0], [10, 0]], [[10, 0], [10, 10]], [[10, 10], [0, 10]], [[0, 10], [0, 0]]]);
});

test("hand-worked: a 3-4-5 triangle, two typed sides and a click to close", () => {
  const s = addSketch(partDocument("box", 40, 30, 20));
  // Length 4 toward a pointer straight right: (4, 0). Length 3 toward a pointer straight up from there: (4, 3).
  const r = typeIn(s.doc, startTool("line", s.id), [
    { p: [0, 0], locks: {} },
    { p: [100, 0], locks: { length: 4 } },
    { p: [4, 50], locks: { length: 3 } },
    { p: [0, 0], locks: {} },
  ]);
  const lines = sketchLines(r.doc.sketches.find((x) => x.id === s.id)!);
  // The closing side is √(4² + 3²) = 5.
  assert.deepEqual(lines.map((l) => Math.sqrt((l.b[0] - l.a[0]) ** 2 + (l.b[1] - l.a[1]) ** 2)), [4, 3, 5]);
  assert.equal((r.tool as LineTool).from, null);
});

test("hand-worked: a typed 30 × 20 rectangle drawn down and to the left", () => {
  const s = addSketch(partDocument("box", 40, 30, 20));
  // Corner (5, 5); pointer (−1, −1) is down-left, so the opposite corner is (5 − 30, 5 − 20) = (−25, −15).
  const r = typeIn(s.doc, startTool("rectangle", s.id) as RectangleTool, [
    { p: [5, 5], locks: {} },
    { p: [-1, -1], locks: { width: 30, height: 20 } },
  ]);
  const sketch = r.doc.sketches.find((x) => x.id === s.id)!;
  const xs = sketch.points.map((p) => p.x), ys = sketch.points.map((p) => p.y);
  assert.deepEqual([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)], [-25, 5, -15, 5]);
  assert.equal(sketchLines(sketch).length, 4);
});

/** A seeded generator (mulberry32), so a failure replays from its seed. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("seeded: 5,000 locked lines against a model in polar terms", () => {
  // The model knows only polar geometry: with the length locked, the end is
  // at distance L along the pointer's bearing (atan2, Math.hypot); with the
  // angle locked, at the pointer's distance times cos(bearing − θ); with
  // both, at L along θ. It shares no code with typed-entry.ts.
  const seed = Number(process.env.FISSION_SEED ?? 20261018);
  const r = rng(seed);
  const span = () => (r() - 0.5) * 10 ** (1 + Math.floor(r() * 4));
  for (let i = 0; i < 5000; i++) {
    const s: SketchXY = [span(), span()];
    const p: SketchXY = [s[0] + span(), s[1] + span()];
    const L = Number((MIN_TYPED + r() * 500).toFixed(3));
    const deg = Math.floor(r() * 8) === 0 ? 90 * Math.floor(r() * 4) : Number((r() * 720 - 360).toFixed(2));
    const kind = i % 3;
    const locks: Locks = kind === 0 ? { length: L } : kind === 1 ? { angle: deg } : { length: L, angle: deg };
    const bearing = Math.atan2(p[1] - s[1], p[0] - s[0]);
    const th = (deg * Math.PI) / 180;
    const dist = Math.hypot(p[0] - s[0], p[1] - s[1]);
    const along = dist * Math.cos(bearing - th);
    const model: SketchXY | null =
      kind === 0 ? [s[0] + L * Math.cos(bearing), s[1] + L * Math.sin(bearing)]
      : kind === 1 ? (along > 1e-9 * dist ? [s[0] + along * Math.cos(th), s[1] + along * Math.sin(th)] : null)
      : [s[0] + L * Math.cos(th), s[1] + L * Math.sin(th)];
    const got = lineEnd(s, p, locks);
    if (kind === 1 && Math.abs(along) <= 1e-9 * dist) continue; // on the perpendicular: either answer is right
    const where = `seed ${seed} case ${i}: start ${s}, pointer ${p}, locks ${JSON.stringify(locks)}`;
    if (model === null) {
      assert.equal(got, null, where);
      continue;
    }
    assert.ok(got, where);
    const scale = Math.max(1, Math.abs(s[0]), Math.abs(s[1]), Math.abs(p[0]), Math.abs(p[1]), L);
    assert.ok(Math.abs(got[0] - model[0]) <= 1e-12 * scale && Math.abs(got[1] - model[1]) <= 1e-12 * scale, `${where}: got ${got}, model ${model}`);
    if (locks.length !== undefined) assert.ok(Math.abs(Math.hypot(got[0] - s[0], got[1] - s[1]) - L) <= 1e-12 * scale, `${where}: length`);
  }
});

const { Window } = await import("happy-dom");

/** The boxes in a real DOM (happy-dom stands in for the browser), with every event they report recorded. */
function boxes() {
  const window = new Window();
  const doc = window.document as unknown as Document;
  const host = doc.createElement("div");
  doc.body.append(host);
  const seen: string[] = [];
  let last: Locks = {};
  const b = typedBoxes(host, { locks: (l) => ((last = l), seen.push(`locks ${JSON.stringify(l)}`)), enter: () => seen.push("enter"), escape: () => seen.push("escape") });
  const input = (f: string) => doc.getElementById(`typed-${f}`) as HTMLInputElement;
  const type = (f: string, text: string) => {
    input(f).value = text;
    input(f).dispatchEvent(new window.Event("input") as unknown as Event);
  };
  const key = (f: string, k: string, shiftKey = false) => {
    const e = new window.KeyboardEvent("keydown", { key: k, shiftKey, bubbles: true, cancelable: true });
    input(f).dispatchEvent(e as unknown as Event);
    return e;
  };
  return { window, doc, host, b, seen, input, type, key, last: () => last };
}

test("boxes: the live size as placeholder, a typed size locks with a padlock, a bad one says why", () => {
  const { doc, b, input, type, last } = boxes();
  assert.equal(doc.getElementById("typed-entry")!.hidden, true, "hidden until a tool needs it");
  b.show(["length", "angle"], { length: 42.37419, angle: 30 }, 100, 50);
  assert.equal(doc.getElementById("typed-entry")!.hidden, false);
  assert.equal(input("length").placeholder, "42.374");
  assert.equal(input("angle").placeholder, "30");
  assert.equal(input("length").value, "");
  assert.deepEqual([...doc.querySelectorAll(".typed-entry-name")].map((e) => e.textContent), [FIELD_LABELS.length, FIELD_LABELS.angle]);
  const lock = (f: string) => input(f).closest("label")!.querySelector(".typed-entry-lock") as HTMLElement;
  assert.equal(lock("length").hidden, true);
  type("length", "25");
  assert.equal(lock("length").hidden, false, "a typed length shows its padlock");
  assert.deepEqual(last(), { length: 25 });
  assert.deepEqual(b.locks, { length: 25 });
  type("angle", "north");
  assert.equal(lock("angle").hidden, true, "no padlock for a size it can't take");
  assert.equal(input("angle").getAttribute("aria-invalid"), "true");
  assert.match(input("angle").closest("label")!.querySelector(".typed-entry-error")!.textContent!, /isn't an angle/);
  assert.deepEqual(last(), { length: 25 }, "the bad angle locks nothing");
  type("angle", "-90");
  assert.deepEqual(last(), { length: 25, angle: 270 });
  // New live values move the placeholders, never the typed text.
  b.show(["length", "angle"], { length: 1, angle: 2 }, 0, 0);
  assert.equal(input("length").value, "25");
  assert.equal(input("length").placeholder, "1");
  b.clear();
  assert.deepEqual(b.locks, {});
  assert.equal(lock("length").hidden, true);
});

test("boxes: Tab and Shift+Tab go round, Enter places, Escape empties them and stops there", () => {
  const { doc, b, input, type, key, seen } = boxes();
  b.show(["width", "height"], {}, 0, 0);
  let shellSaw = 0;
  doc.addEventListener("keydown", () => shellSaw++);
  b.start("3");
  assert.equal(doc.activeElement, input("width"), "a digit starts typing in the first box");
  assert.equal(input("width").value, "3");
  assert.ok(b.focused);
  assert.ok(key("width", "Tab").defaultPrevented);
  assert.equal(doc.activeElement, input("height"), "Tab goes to the next box");
  key("height", "Tab");
  assert.equal(doc.activeElement, input("width"), "and wraps round");
  key("width", "Tab", true);
  assert.equal(doc.activeElement, input("height"), "Shift+Tab goes back, wrapping");
  type("height", "4");
  key("height", "Enter");
  assert.equal(seen.at(-1), "enter");
  const esc = key("height", "Escape");
  assert.ok(esc.defaultPrevented);
  assert.equal(seen.at(-1), "escape");
  assert.equal(input("width").value, "");
  assert.equal(input("height").value, "");
  assert.equal(b.focused, false, "Escape leaves the boxes");
  // Tab and Enter bubble (nothing else uses them in a box); Escape and Enter never reach the shell's keys.
  assert.equal(shellSaw, 3, "the shell saw the three Tabs, not Enter or Escape");
  b.hide();
  assert.equal(doc.getElementById("typed-entry")!.hidden, true);
  assert.equal(doc.querySelectorAll(".typed-entry-row").length, 0);
});

test("boxes: a new tool's fields replace the old and keep the keys; clear can keep them in the first box", () => {
  const { doc, b, input, type } = boxes();
  b.show(["length", "angle"], {}, 0, 0);
  b.start("9");
  type("length", "9");
  b.show(["width", "height"], {}, 0, 0);
  assert.equal(input("length"), null, "the line's boxes are gone");
  assert.equal(doc.activeElement, input("width"));
  assert.deepEqual(b.locks, {}, "nothing carried over");
  type("width", "5");
  b.clear(true);
  assert.equal(doc.activeElement, input("width"), "Enter's clear keeps typing going for the next point");
  assert.equal(input("width").value, "");
});

test("boxes: what Enter took is given back only into boxes still all empty (hunt 26h)", () => {
  const { b, input, type, last } = boxes();
  b.show(["length", "angle"], {}, 0, 0);
  type("length", "12.5");
  type("angle", "north");
  const took = b.texts();
  assert.deepEqual(took, { length: "12.5", angle: "north" }, "as typed, junk too");
  b.clear(true);
  assert.equal(b.restore(took), true);
  assert.equal(input("length").value, "12.5");
  assert.equal(input("angle").value, "north");
  assert.deepEqual(last(), { length: 12.5 }, "the locks told again: the length locks, the junk angle doesn't");
  // Something typed since in any box: nothing is put back, not even into the other box.
  b.clear(true);
  type("angle", "7");
  assert.equal(b.restore(took), false);
  assert.equal(input("length").value, "");
  assert.equal(input("angle").value, "7");
  // Nothing taken: nothing to give back.
  b.clear(true);
  assert.equal(b.restore({}), false);
});

test("only a digit, a point or a minus starts typing, through the one shortcut table", () => {
  for (const k of [..."0123456789", ".", "-"]) {
    const entry = DESIGN_SHORTCUTS.find((e) => parseChord(e.keys) === k);
    assert.ok(entry, `${k} is a Design shortcut`);
    assert.equal(typedSizeKey(entry.id), k);
    assert.ok(!entry.inText, `${k} never fires while typing in a text box`);
  }
  for (const id of ["sketch-line", "clear-selection", "copy-svg", "type-size-", "type-size-12", "type-size-e", "type-size-+"]) assert.equal(typedSizeKey(id), null, id);
  const table = new ShortcutTable(SHELL_SHORTCUTS, [{ id: "design", shortcuts: DESIGN_SHORTCUTS }]);
  assert.deepEqual(table.clashes(), [], "no key clashes with the shell's or the browser's");
});
