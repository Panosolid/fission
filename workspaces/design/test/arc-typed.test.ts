// Typed sizes on the arc tools, as Fusion-style drawing has them: the
// 3-point arc's end by length and angle from its start (its third click,
// a point on the arc, has no boxes), the centre arc's start by radius and
// angle from its centre and its end by how far round it goes (the pointer
// picks which way), the tangent arc's end by length and angle. Hand-worked
// arcs with exact centres, radii and sweeps (working shown), the arc
// angle's limits at 0.9× and 1.1×, the hint by the pointer for each
// click, the boxes in a real DOM, and seeded sessions against a plain
// model (arc-typed-session.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SketchXY } from "@fission/core";
import { partDocument, type DesignDocument } from "../src/document.ts";
import { addSketch, drawLine, sketchCurves } from "../src/sketch.ts";
import { clickAt, hoverTool, previewSegments, startTool, type CentreArcTool, type SketchTool } from "../src/sketch-tool.ts";
import { aimOf, anchorOf, centreEnd, liveValues, readSweep, shownValue, typedFields, withLocks, type Locks } from "../src/typed-entry.ts";
import { FIELD_LABELS, typedBoxes } from "../src/typed-boxes.ts";
import { hintOf, pointerHint } from "../src/pointer-hint.ts";
import * as entry from "../src/typed-entry.ts";
import { randomEpisode, rng, runArcSession, runEpisode } from "./arc-typed-session.ts";

function fresh(kind: SketchTool["kind"]) {
  const s = addSketch(partDocument("box", 40, 30, 20));
  return { doc: s.doc, tool: startTool(kind, s.id), id: s.id };
}

/** Clicks as the workspace makes them: hovers move the tool; a click goes where the locks put it, the tool with the locks applied. */
type Step = { click: SketchXY; locks?: Locks } | { hover: SketchXY };
function run(doc: DesignDocument, tool: SketchTool, steps: Step[]) {
  let note: string | undefined;
  let drew = 0;
  for (const s of steps) {
    if ("hover" in s) {
      tool = hoverTool(tool, s.hover);
      continue;
    }
    const locks = s.locks ?? {};
    const aim = aimOf(doc, tool, s.click, locks);
    assert.ok(aim, `an aim for ${s.click} with ${JSON.stringify(locks)}`);
    const r = clickAt(doc, withLocks(tool, locks, s.click), aim);
    ({ doc, tool, note } = r);
    if (r.drew) drew++;
  }
  return { doc, tool, note, drew };
}
const lastArc = (doc: DesignDocument) => sketchCurves(doc.sketches[0]).arcs.at(-1)!;

test("the arc angle read by hand: more than 0° and less than 360°, no sign", () => {
  const v = (t: string) => {
    const r = readSweep(t);
    return "value" in r ? r.value : r.error;
  };
  assert.equal(v("90"), 90);
  assert.equal(v(" 270° "), 270);
  assert.equal(v("45 deg"), 45);
  assert.equal(v("359.999"), 359.999);
  assert.equal(v("0.001"), 0.001);
  assert.match(String(v("0")), /more than 0°/);
  assert.match(String(v("-90")), /more than 0°/, "no sign: the pointer picks the way");
  assert.match(String(v("360")), /less than 360°: a whole turn is a circle/);
  for (const bad of ["", "abc", "1e2", "Infinity", "90..", "ninety"]) assert.match(String(v(bad)), /isn't an angle/, bad);
});

test("the arc angle's 360° limit at 0.9× and 1.1×", () => {
  // 0.9 × 360 = 324 is an arc; 1.1 × 360 = 396 is more than a turn and refused.
  assert.deepEqual(readSweep("324"), { value: 324 });
  assert.ok("error" in readSweep("396"));
});

test("the boxes and hint for each click of each arc", () => {
  const { tool: arc, id } = fresh("arc");
  assert.deepEqual(typedFields(arc), []);
  assert.equal(hintOf(arc), "Place start point");
  const a1: SketchTool = { kind: "arc", sketch: id, start: [0, 0], end: null };
  assert.deepEqual(typedFields(a1), ["length", "angle"]);
  assert.equal(hintOf(a1), "Specify next point");
  const a2: SketchTool = { kind: "arc", sketch: id, start: [0, 0], end: [20, 0] };
  assert.deepEqual(typedFields(a2), [], "the point on the arc has no boxes");
  assert.equal(hintOf(a2), "Place point on arc");

  const c0 = startTool("centre", id);
  assert.deepEqual(typedFields(c0), []);
  assert.equal(hintOf(c0), "Place centre point");
  const c1: SketchTool = { kind: "centre", sketch: id, centre: [0, 0], start: null, swept: 0 };
  assert.deepEqual(typedFields(c1), ["radius", "angle"]);
  assert.equal(hintOf(c1), "Place start point");
  const c2: SketchTool = { ...c1, start: [10, 0] };
  assert.deepEqual(typedFields(c2), ["sweep"]);
  assert.equal(hintOf(c2), "Place end point");

  const t0 = startTool("tangent", id);
  assert.deepEqual(typedFields(t0), []);
  assert.equal(hintOf(t0), "Click the free end of a line or arc");
  assert.deepEqual(typedFields({ kind: "tangent", sketch: id, from: "p-1" }), ["length", "angle"]);
  assert.equal(hintOf({ kind: "tangent", sketch: id, from: "p-1" }), "Specify next point");

  // The other tools' hints.
  assert.equal(hintOf(startTool("line", id)), "Place start point");
  assert.equal(hintOf({ kind: "line", sketch: id, from: [0, 0] }), "Specify next point");
  assert.equal(hintOf(startTool("rectangle", id)), "Place first corner");
  assert.equal(hintOf({ kind: "rectangle", sketch: id, corner: [0, 0] }), "Place opposite corner");
  assert.equal(hintOf(startTool("circle", id)), "Place centre point");
  assert.equal(hintOf({ kind: "circle", sketch: id, centre: [0, 0] }), "Place point on circle");
  assert.deepEqual(typedFields({ kind: "circle", sketch: id, centre: [0, 0] }), [], "the circle's radius box is still to come");

  // Anchors: what the boxes measure from.
  const { doc } = fresh("arc");
  assert.deepEqual(anchorOf(doc, a1), [0, 0]);
  assert.equal(anchorOf(doc, a2), null, "no anchor for the point on the arc: the pointer goes where it is");
  assert.deepEqual(anchorOf(doc, c1), [0, 0]);
  assert.deepEqual(anchorOf(doc, c2), [0, 0], "the arc angle is measured round the centre");
  assert.equal(anchorOf(doc, { kind: "tangent", sketch: id, from: "gone" }), null, "a tangent start no longer in the sketch has no anchor");
});

test("hand-worked: a 3-point arc with its end typed 20 mm at 0°, through (10, 10): a half circle round (10, 0)", () => {
  // Start (0, 0); the end typed at length 20, angle 0 lands at (20, 0)
  // whatever the pointer. The chord's midpoint is (10, 0) and (10, 10) is
  // 10 from it, as are both ends, so the centre is (10, 0), radius 10. The
  // point is on the left of (0, 0) → (20, 0), so the arc through it runs
  // counter-clockwise from (20, 0) over the top to (0, 0): 180°.
  const { doc, tool } = fresh("arc");
  const r = run(doc, tool, [{ click: [0, 0] }, { click: [3, -7], locks: { length: 20, angle: 0 } }, { click: [10, 10] }]);
  assert.equal(r.drew, 1);
  assert.deepEqual(lastArc(r.doc), { start: [20, 0], end: [0, 0], centre: [10, 0] });
});

test("hand-worked: a 3-point arc with only the length typed, 10 mm towards (3, 4), through (−6, 12)", () => {
  // Length 10 along the pointer's way (3, 4)/5 from (0, 0) puts the end at
  // (6, 8). The centre is on the chord's perpendicular bisector, (3, 4) +
  // k(−8, 6): k = 1/2 gives (−1, 7), 50 = 1² + 7² from (0, 0), 7² + 1²
  // from (6, 8) and 5² + 5² from (−6, 12), so radius √50. (−6, 12) is on
  // the left of (0, 0) → (6, 8) (cross 6·12 − 8·(−6) = 120 > 0), so the arc
  // runs counter-clockwise from (6, 8) to (0, 0).
  const { doc, tool } = fresh("arc");
  const r = run(doc, tool, [{ click: [0, 0] }, { click: [3, 4], locks: { length: 10 } }, { click: [-6, 12] }]);
  assert.deepEqual(lastArc(r.doc), { start: [6, 8], end: [0, 0], centre: [-1, 7] });
});

test("hand-worked: a centre arc typed radius 10 at 0°, then 90° round: a quarter from (10, 0) to (0, 10)", () => {
  // The start is 10 along 0° from the centre (0, 0): (10, 0). With the
  // pointer moved a little counter-clockwise (to (9, 2)) and 90 typed, the
  // end is (10, 0) turned a quarter left, (0, 10), exactly.
  const { doc, tool } = fresh("centre");
  const r = run(doc, tool, [{ click: [0, 0] }, { click: [1, 1], locks: { radius: 10, angle: 0 } }, { hover: [9, 2] }, { click: [9, 2], locks: { sweep: 90 } }]);
  assert.equal(r.drew, 1);
  assert.deepEqual(lastArc(r.doc), { start: [10, 0], end: [0, 10], centre: [0, 0] });
});

test("hand-worked: a typed 270° goes 270° the way the pointer went, however little it went round", () => {
  // Pointer a little counter-clockwise from (10, 0), then 270 typed: three
  // quarters counter-clockwise, ending at (0, −10). The arc is stored
  // counter-clockwise from (10, 0) to (0, −10): angles 0° to 270°.
  const { doc, tool } = fresh("centre");
  const ccw = run(doc, tool, [{ click: [0, 0] }, { click: [10, 0] }, { hover: [10, 1] }, { click: [10, 1], locks: { sweep: 270 } }]);
  assert.deepEqual(lastArc(ccw.doc), { start: [10, 0], end: [0, -10], centre: [0, 0] });
  // The pointer a little clockwise instead: three quarters clockwise, ending
  // at (0, 10), so stored counter-clockwise from (0, 10) round to (10, 0).
  const cw = run(doc, tool, [{ click: [0, 0] }, { click: [10, 0] }, { hover: [10, -1] }, { click: [10, -1], locks: { sweep: 270 } }]);
  assert.deepEqual(lastArc(cw.doc), { start: [0, 10], end: [10, 0], centre: [0, 0] });
  // Without withLocks the click's own unwrap would take the pointer's
  // small turn and give the quarter the other way round: this is what it guards.
  const c: CentreArcTool = { kind: "centre", sketch: doc.sketches[0].id, centre: [0, 0], start: [10, 0], swept: 0.1 };
  const bare = clickAt(doc, c, centreEnd([0, 0], [10, 0], 270));
  assert.deepEqual(lastArc(bare.doc), { start: [0, -10], end: [10, 0], centre: [0, 0] }, "the quarter clockwise");
});

test("hand-worked: a centre arc round (5, 5), radius 5 at 90°, half a turn: (5, 10) to (5, 0)", () => {
  // Start 5 along 90° from (5, 5): (5, 10). Half a turn counter-clockwise
  // from straight up is straight down: (5, 0). Typed both: the pointer is
  // only for the way round.
  const { doc, tool } = fresh("centre");
  const r = run(doc, tool, [{ click: [5, 5] }, { click: [40, 40], locks: { radius: 5, angle: 90 } }, { hover: [4, 9] }, { click: [4, 9], locks: { sweep: 180 } }]);
  assert.deepEqual(lastArc(r.doc), { start: [5, 10], end: [5, 0], centre: [5, 5] });
});

test("hand-worked: centreEnd turns the start exactly at the quarter turns", () => {
  assert.deepEqual(centreEnd([0, 0], [10, 0], 90), [0, 10]);
  assert.deepEqual(centreEnd([0, 0], [10, 0], 180), [-10, 0]);
  assert.deepEqual(centreEnd([0, 0], [10, 0], -90), [0, -10]);
  assert.deepEqual(centreEnd([1, 2], [4, 6], 90), [-3, 5], "(3, 4) from (1, 2) turned left is (−4, 3)");
  // 60° from (2, 0) round the origin: (2 cos 60°, 2 sin 60°) = (1, √3).
  const p = centreEnd([0, 0], [2, 0], 60);
  assert.ok(Math.abs(p[0] - 1) < 1e-15 && Math.abs(p[1] - Math.sqrt(3)) < 1e-15, `${p}`);
});

test("hand-worked: a tangent arc from the end of (0, 0) → (10, 0), its end typed 10 mm at 90°: a half circle round (10, 5)", () => {
  // The end is 10 straight up from (10, 0): (10, 10). Leaving along +x and
  // turning left to (10, 10), the centre is on the normal at (10, 0), at
  // k = |w|²/(2·t × w) with t = (10, 0), w = (0, 10): 100/200 = 1/2 of
  // the normal (0, 10), so (10, 5), radius 5.
  const s = addSketch(partDocument("box", 40, 30, 20));
  const line = drawLine(s.doc, s.id, [0, 0], [10, 0]);
  const r = run(line.doc, startTool("tangent", s.id), [{ click: [10, 0] }, { click: [3, 3], locks: { length: 10, angle: 90 } }]);
  assert.equal(r.drew, 1);
  const arc = lastArc(r.doc);
  assert.deepEqual(arc, { start: [10, 0], end: [10, 10], centre: [10, 5] });
});

test("live values: the arc angle box shows how far round the pointer has gone, either way", () => {
  // Centre (0, 0), start (10, 0). Pointer to (0, 10): a quarter left, 90.
  // Swept on round through (−10, 0) to (0, −10): 270. Back the other way
  // from the start to (0, −10): a quarter right, 90 again.
  const { doc, id } = fresh("centre");
  let t: SketchTool = { kind: "centre", sketch: id, centre: [0, 0], start: [10, 0], swept: 0 };
  t = hoverTool(t, [0, 10]);
  assert.equal(shownValue(liveValues([0, 0], [0, 10], t).sweep!), "90");
  t = hoverTool(hoverTool(t, [-10, 0]), [0, -10]);
  assert.equal(shownValue(liveValues([0, 0], [0, -10], t).sweep!), "270");
  const back = hoverTool({ kind: "centre", sketch: id, centre: [0, 0], start: [10, 0], swept: 0 } as SketchTool, [0, -10]);
  assert.equal(shownValue(liveValues([0, 0], [0, -10], back).sweep!), "90");
  // The radius and angle before the start: (−3, −3) from the centre is 3√2 ≈ 4.243 at 225°.
  const live = liveValues([0, 0], [-3, -3], { kind: "centre", sketch: id, centre: [0, 0], start: null, swept: 0 });
  assert.equal(shownValue(live.radius!), "4.243");
  assert.equal(live.angle, 225);
  assert.equal(aimOf(doc, t, null, {}), null, "no pointer, nothing typed: no aim");
});

test("the preview with a typed arc angle is the arc a click would draw", () => {
  // The workspace draws the preview from withLocks(tool) at aimOf's point, the same tool the click uses.
  const { doc, id } = fresh("centre");
  const t = hoverTool({ kind: "centre", sketch: id, centre: [0, 0], start: [10, 0], swept: 0 } as SketchTool, [10, 1]);
  const locks = { sweep: 270 };
  const aim = aimOf(doc, t, [10, 1], locks)!;
  assert.deepEqual(aim, [0, -10]);
  const seg = previewSegments(doc, withLocks(t, locks, [10, 1]), aim);
  // Radius line, then 48 arc segments (⌈64 × 3/4⌉), then the radius line to the end.
  assert.equal(seg.length, 1 + 48 + 1);
  assert.deepEqual(seg[1][0], [10, 0], "from the start");
  assert.deepEqual(seg[48][1], [0, -10], "round to the end");
  const mid = seg[24][1];
  assert.ok(Math.abs(mid[0] + 10 * Math.SQRT1_2) < 1e-12 && Math.abs(mid[1] - 10 * Math.SQRT1_2) < 1e-12, `the middle of 270° from 0° is 135°: ${mid}`);
});

test("a click behind a typed angle places nothing, for the arcs as for lines", () => {
  // Start (0, 0) with angle 0 typed and the pointer at (−5, 3): behind, no aim.
  const { doc, id } = fresh("arc");
  assert.equal(aimOf(doc, { kind: "arc", sketch: id, start: [0, 0], end: null }, [-5, 3], { angle: 0 }), null);
  assert.equal(aimOf(doc, { kind: "centre", sketch: id, centre: [0, 0], start: null, swept: 0 }, [-5, 3], { angle: 0 }), null);
  // The radius typed with the pointer on the centre: no direction.
  assert.equal(aimOf(doc, { kind: "centre", sketch: id, centre: [0, 0], start: null, swept: 0 }, [0, 0], { radius: 5 }), null);
});

test("the smallest arc angle at the largest coordinates still moves the end off the start", () => {
  // The worst case the boxes allow: a 0.001 mm radius (MIN_TYPED) at
  // 1,000,000 mm (MAX_TYPED) from the origin, 0.001° round. The end moves
  // 0.001 × 0.001 × π/180 ≈ 1.7e-8 mm, while doubles near 1e6 are 1.2e-10
  // apart, so it never rounds back onto the start: a typed arc angle can't
  // reach centre-arc.ts's "no turn" note (the outline check judges pieces
  // under 1 µm, as for any arc).
  const { doc, tool } = fresh("centre");
  const r = run(doc, tool, [{ click: [1e6, 1e6] }, { click: [1e6 + 1, 1e6], locks: { radius: 0.001, angle: 0 } }, { hover: [1e6 + 1, 1e6 + 1] }, { click: [1e6 + 1, 1e6 + 1], locks: { sweep: 0.001 } }]);
  assert.equal(r.drew, 1);
  const arc = lastArc(r.doc);
  assert.notDeepEqual(arc.start, arc.end);
  assert.ok(Math.abs(arc.end[1] - arc.start[1] - 0.001 * (0.001 * Math.PI) / 180) < 1e-9, `${arc.end[1] - arc.start[1]}`);
});

test("seeded: 4,000 arcs, each point clicked or typed, against a plain model", () => {
  const seed = Number(process.env.FISSION_SEED ?? 20261018);
  const failure = runArcSession(entry, seed, 4000);
  assert.equal(failure, null, failure?.message);
  // The episodes cover every kind and lock, so a pass means something.
  const r = rng(seed);
  const seen = new Set<string>();
  for (let i = 0; i < 4000; i++) {
    const e = randomEpisode(r);
    if (!e) continue;
    const locks = e.kind === "centre" ? { ...e.start.locks, ...e.end.locks } : e.end.locks;
    seen.add(`${e.kind}:${Object.keys(locks).sort().join("+")}`);
  }
  for (const want of ["arc:", "arc:length", "arc:angle", "arc:angle+length", "centre:", "centre:radius", "centre:angle", "centre:angle+radius", "centre:sweep", "centre:radius+sweep", "centre:angle+radius+sweep", "tangent:", "tangent:length", "tangent:angle+length"]) assert.ok(seen.has(want), `the session covers ${want}`);
});

test("the session's checks can fail: a wrong model end is reported", () => {
  const r = rng(7);
  let e = randomEpisode(r);
  while (!e || e.kind !== "centre") e = randomEpisode(r);
  const wrong = { ...e, model: { ...e.model, end: [e.model.end[0] + 1, e.model.end[1]] as SketchXY } };
  assert.match(runEpisode(entry, wrong)?.message ?? "", /^end:/);
});

const { Window } = await import("happy-dom");

test("boxes: Radius and Arc angle read their own way, with a padlock or the reason", () => {
  const window = new Window();
  const doc = window.document as unknown as Document;
  const host = doc.createElement("div");
  doc.body.append(host);
  let last: Locks = {};
  const b = typedBoxes(host, { locks: (l) => (last = l), enter: () => {}, escape: () => {} });
  const type = (f: string, text: string) => {
    const input = doc.getElementById(`typed-${f}`) as HTMLInputElement;
    input.value = text;
    input.dispatchEvent(new window.Event("input") as unknown as Event);
  };
  b.show(["radius", "angle"], { radius: 4.2426, angle: 225 }, 10, 10);
  assert.deepEqual([...doc.querySelectorAll(".typed-entry-name")].map((e) => e.textContent), ["Radius", "Angle"]);
  assert.equal((doc.getElementById("typed-radius") as HTMLInputElement).placeholder, "4.243");
  type("radius", "12.5 mm");
  assert.deepEqual(last, { radius: 12.5 });
  type("radius", "0.0009");
  assert.match(doc.querySelector("label[data-field=radius] .typed-entry-error")!.textContent!, /at least 0.001 mm/);
  b.show(["sweep"], { sweep: 90 }, 10, 10);
  assert.equal(FIELD_LABELS.sweep, "Arc angle");
  assert.equal((doc.getElementById("typed-sweep") as HTMLInputElement).getAttribute("aria-label"), "Arc angle (°)");
  type("sweep", "270");
  assert.deepEqual(last, { sweep: 270 });
  assert.equal(doc.querySelector("label[data-field=sweep] .typed-entry-lock")!.hasAttribute("hidden"), false, "the padlock shows");
  type("sweep", "360");
  assert.deepEqual(last, {});
  assert.match(doc.querySelector("label[data-field=sweep] .typed-entry-error")!.textContent!, /a whole turn is a circle/);
});

test("the pointer hint shows, moves and hides", () => {
  const window = new Window();
  const doc = window.document as unknown as Document;
  const host = doc.createElement("div");
  doc.body.append(host);
  const h = pointerHint(host);
  assert.equal(h.element.id, "sketch-hint");
  assert.equal(h.element.hidden, true);
  h.show("Place point on arc", 120.4, 80.6);
  assert.equal(h.element.hidden, false);
  assert.equal(h.element.textContent, "Place point on arc");
  assert.equal(h.element.style.left, "120px");
  assert.equal(h.element.style.top, "81px");
  h.show("", 0, 0);
  assert.equal(h.element.hidden, true, "no words, no hint");
});
