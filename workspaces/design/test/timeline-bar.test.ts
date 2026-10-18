import { test } from "node:test";
import assert from "node:assert/strict";
import { insertPreset, partDocument, type DesignDocument } from "../src/document.ts";
import { addSketch } from "../src/sketch.ts";
import { extrudeSketch } from "../src/extrude.ts";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as bar from "../src/timeline-bar.ts";
import { barEdit, dropIndex, DRAG_PIXELS, isDrag, itemMenu, stepTarget, TAP_REACH, tapPlace, timelineBarItems } from "../src/timeline-bar.ts";
import { deleteWords } from "../src/delete-ask.ts";
import { OPS, randomSteps, runBarSession, shrink } from "./timeline-bar-session.ts";

/**
 * A box (feature-1), Sketch 1 (sketch-2) and its extrude (feature-3), built
 * by the document's own edits: a new project's counter starts at 2, each
 * edit takes the next id, and with no marker each goes in last.
 */
function threeItems(): DesignDocument {
  const box = partDocument("box", 40, 30, 20);
  const sketched = addSketch(box).doc;
  return extrudeSketch(sketched, "sketch-2", 10).doc;
}
const withMarker = (doc: DesignDocument, marker: string | undefined): DesignDocument => ({ ...doc, timeline: { ...doc.timeline, marker } });

test("the bar shows every item in build order, numbered and drawn by its kind", () => {
  const { items, marker } = timelineBarItems(threeItems());
  // Worked by hand: the items are the three edits above in the order made;
  // the numbers count from 1 like the browser's Timeline rows; with no
  // marker every item is built, so the marker stands after all 3.
  assert.deepEqual(
    items.map((i) => [i.id, i.label, i.icon]),
    [
      ["feature-1", "1. Box: 40 × 30 × 20 mm", "box"],
      ["sketch-2", "2. Sketch 1 on the XY plane", "sketch"],
      ["feature-3", "3. Extrude Sketch 1 by 10 mm", "extrude"],
    ],
  );
  assert.equal(marker, 3);
  assert.deepEqual(items.map((i) => [i.suppressed, i.rolledBack]), [[false, false], [false, false], [false, false]]);
});

test("the marker stands after the item it names, and the items after it are rolled back", () => {
  // Marker on sketch-2, the 2nd item: 2 items come before it; only the 3rd is after it.
  const on = timelineBarItems(withMarker(threeItems(), "sketch-2"));
  assert.equal(on.marker, 2);
  assert.deepEqual(on.items.map((i) => i.rolledBack), [false, false, true]);
  // "start": nothing before it, everything rolled back.
  const start = timelineBarItems(withMarker(threeItems(), "start"));
  assert.equal(start.marker, 0);
  assert.deepEqual(start.items.map((i) => i.rolledBack), [true, true, true]);
  // On the last item: the same as no marker.
  const last = timelineBarItems(withMarker(threeItems(), "feature-3"));
  assert.equal(last.marker, 3);
  assert.deepEqual(last.items.map((i) => i.rolledBack), [false, false, false]);
});

test("a suppressed item says so, apart from where the marker is", () => {
  const doc = threeItems();
  const suppressed = { ...doc, timeline: { features: doc.timeline.features.map((f) => (f.id === "feature-1" ? { ...f, suppressed: true } : f)) } };
  const { items, marker } = timelineBarItems(suppressed);
  assert.deepEqual(items.map((i) => [i.suppressed, i.rolledBack]), [[true, false], [false, false], [false, false]]);
  assert.equal(marker, 3, "suppressing an item never moves the marker");
});

test("a kind the bar has no drawing for gets the plain one, never another kind's", () => {
  const doc = threeItems();
  const odd = { ...doc, timeline: { features: [{ ...doc.timeline.features[0], intent: { ...doc.timeline.features[0].intent, type: "loft" } }] } };
  assert.equal(timelineBarItems(odd).items[0].icon, "feature");
  // An inherited name is not a kind: "constructor" must not find Object's.
  const proto = { ...doc, timeline: { features: [{ ...doc.timeline.features[0], intent: { ...doc.timeline.features[0].intent, type: "constructor" } }] } };
  assert.equal(timelineBarItems(proto).items[0].icon, "feature");
});

test("a marker naming no item is refused by name, never drawn at the start or the end", () => {
  assert.throws(() => timelineBarItems(withMarker(threeItems(), "feature-9")), /the timeline marker "feature-9" names no item in the timeline/);
});

// ---- Step 24f2: what the bar does, hand-worked. ----

/** Three items 20 px wide with 10 px gaps, from 0: [0, 20], [30, 50], [60, 80]; their middles 10, 40 and 70. */
const ROW = [
  { left: 0, right: 20 },
  { left: 30, right: 50 },
  { left: 60, right: 80 },
];

test("a drop lands before the first item whose middle is not left of the pointer", () => {
  // Middles 10, 40, 70: the place is how many of them are left of x.
  assert.equal(dropIndex(ROW, -5), 0, "before the first item: no middle to its left");
  assert.equal(dropIndex(ROW, 9), 0, "1 px left of the first middle (10)");
  assert.equal(dropIndex(ROW, 10), 0, "exactly on a middle goes before that item");
  assert.equal(dropIndex(ROW, 11), 1, "1 px right of the first middle: after item 1");
  assert.equal(dropIndex(ROW, 25), 1, "in the gap [20, 30]: middles left of it are 10 only");
  assert.equal(dropIndex(ROW, 40), 1, "on the second middle: still before item 2");
  assert.equal(dropIndex(ROW, 41), 2);
  assert.equal(dropIndex(ROW, 71), 3, "past the last middle (70): after all three");
  assert.equal(dropIndex(ROW, 500), 3, "far past the last");
  assert.equal(dropIndex([], 10), 0, "no items: the only place is 0");
});

test("a drop in a scrolled row counts from the row's start, not the visible edge", () => {
  // Scrolled 35 px: a pointer 6 px from the visible edge is at 6 + 35 = 41 in the row, past the middle 40 → place 2.
  assert.equal(dropIndex(ROW, 6, 35), 2);
  // Without the scroll it would be at 6, before the first middle → 0: the two must differ.
  assert.equal(dropIndex(ROW, 6), 0);
  // Scrolled 30: x = 10 is at 40, exactly on item 2's middle → before it, place 1.
  assert.equal(dropIndex(ROW, 10, 30), 1);
});

test("a press is a click below DRAG_PIXELS and a drag from it, at 0.9× and 1.1×", () => {
  assert.equal(DRAG_PIXELS, 5);
  assert.equal(isDrag(0.9 * DRAG_PIXELS, 0), false, "4.5 px: a click");
  assert.equal(isDrag(1.1 * DRAG_PIXELS, 0), true, "5.5 px: a drag");
  assert.equal(isDrag(0, -1.1 * DRAG_PIXELS), true, "upwards counts the same");
  // Diagonal, worked by hand: (3, 4) is √(9 + 16) = 5 px, exactly the threshold: a drag. (2.7, 3.6) is 0.9 × that, 4.5 px: a click.
  assert.equal(isDrag(3, 4), true);
  assert.equal(isDrag(2.7, 3.6), false);
  assert.equal(isDrag(0, 0), false);
});

test("a tap near a gap's middle puts the marker there; on an item it does not, at 0.9× and 1.1× of TAP_REACH", () => {
  assert.equal(TAP_REACH, 8);
  // Gaps' middles: place 0 at the first item's left edge, 0; place 1 at (20 + 30) / 2 = 25; place 2 at 55; place 3 at the last's right edge, 80.
  assert.equal(tapPlace(ROW, 25), 1);
  assert.equal(tapPlace(ROW, 25 + 0.9 * TAP_REACH), 1, "7.2 px right of the gap's middle: still the gap");
  assert.equal(tapPlace(ROW, 25 - 0.9 * TAP_REACH), 1, "7.2 px left of it");
  assert.equal(tapPlace(ROW, 25 + 1.1 * TAP_REACH), null, "8.8 px right of it, at 33.8 on item 2: a tap on the item");
  assert.equal(tapPlace(ROW, 25 - 1.1 * TAP_REACH), null, "8.8 px left, at 16.2 on item 1");
  assert.equal(tapPlace(ROW, 0), 0, "on the first item's left edge: the start");
  assert.equal(tapPlace(ROW, 80 + 0.9 * TAP_REACH), 3, "just past the last: the end");
  assert.equal(tapPlace(ROW, 40), null, "the middle of item 2, 15 px from both gaps");
  // Scrolled 30 px: x = 25 is at 55 in the row, the middle of the gap before item 3.
  assert.equal(tapPlace(ROW, 25, 30), 2);
  assert.equal(tapPlace([], 0), null, "no items: nothing to put the marker between");
});

test("a tap between two close gaps goes to the nearer", () => {
  // Two 10 px items with 2 px gaps: [0, 10], [12, 22]. Gaps at 0, 11 and 22; x = 6 is 6 from 0 and 5 from 11 → place 1.
  const tight = [{ left: 0, right: 10 }, { left: 12, right: 22 }];
  assert.equal(tapPlace(tight, 6), 1);
  assert.equal(tapPlace(tight, 5), 0, "5 from 0, 6 from 11");
});

test("the playback buttons: start, back, forward and end, held at either end", () => {
  // 3 items, marker after the 2nd (place 2).
  assert.deepEqual((["start", "back", "forward", "end"] as const).map((b) => stepTarget(b, 2, 3)), [0, 1, 3, 3]);
  assert.equal(stepTarget("back", 0, 3), 0, "back from the start stays at the start, never -1");
  assert.equal(stepTarget("forward", 3, 3), 3, "forward from the end stays at the end");
  assert.equal(stepTarget("end", 3, 3), 3, "end with no marker (place 3 of 3) is where it is");
  assert.deepEqual((["start", "back", "forward", "end"] as const).map((b) => stepTarget(b, 0, 0)), [0, 0, 0, 0], "an empty timeline");
});

test("each item's menu: the marker here, suppress or unsuppress, delete, and why one is off", () => {
  const doc = threeItems();
  // No marker: it stands after feature-3, so "Move the marker here" on feature-3 is off.
  const offs = (id: string, editing: string | null = null) => itemMenu(doc, id, editing).map((e) => [e.label, e.off]);
  assert.deepEqual(offs("feature-3"), [["Move the marker here", "The marker is already here"], ["Suppress", null], ["Delete", null]]);
  assert.deepEqual(offs("feature-1"), [["Move the marker here", null], ["Suppress", null], ["Delete", null]]);
  // Editing Sketch 1 (sketch-2): its own suppress and delete are off; the marker on feature-1 would put Sketch 1 after it.
  assert.deepEqual(offs("sketch-2", "sketch-2"), [["Move the marker here", null], ["Suppress", "Sketch 1 is being edited: finish the sketch first"], ["Delete", "Sketch 1 is being edited: finish the sketch first"]]);
  assert.deepEqual(offs("feature-1", "sketch-2")[0], ["Move the marker here", "The marker can't go before Sketch 1 while it is being edited: finish the sketch first"]);
  assert.deepEqual(offs("feature-3", "sketch-2")[1], ["Suppress", null], "other items' entries stay on");
  // A suppressed item offers Unsuppress instead.
  const sup = { ...doc, timeline: { features: doc.timeline.features.map((f) => (f.id === "feature-1" ? { ...f, suppressed: true } : f)) } };
  assert.deepEqual(itemMenu(sup, "feature-1").map((e) => e.action), ["marker", "unsuppress", "delete"]);
  assert.throws(() => itemMenu(doc, "feature-9"), /there is no item feature-9 in the timeline/);
});

test("a menu choice, button or drag becomes the 24e edit with its undo step's name", () => {
  const doc = threeItems();
  // Suppress Sketch 1: one edit, "Suppress Sketch 1"; the extrude built from it then fails (red).
  const s = barEdit(doc, { kind: "menu", id: "sketch-2", action: "suppress" });
  assert.equal(s.kind, "edit");
  if (s.kind !== "edit") return;
  assert.equal(s.step, "Suppress Sketch 1");
  assert.deepEqual(timelineBarItems(s.doc).items.map((i) => [i.suppressed, i.failed]), [[false, false], [true, false], [false, true]]);
  const u = barEdit(s.doc, { kind: "menu", id: "sketch-2", action: "unsuppress" });
  assert.deepEqual(u.kind === "edit" && [u.step, timelineBarItems(u.doc).items[2].failed], ["Unsuppress Sketch 1", false]);
  // Move the marker onto the box: place 1, the marker names feature-1, the other two rolled back (greyed, not red).
  const m = barEdit(doc, { kind: "menu", id: "feature-1", action: "marker" });
  assert.ok(m.kind === "edit");
  assert.equal(m.step, "Move the rollback marker");
  assert.equal(m.doc.timeline.marker, "feature-1");
  assert.deepEqual(timelineBarItems(m.doc).items.map((i) => [i.rolledBack, i.failed]), [[false, false], [true, false], [true, false]]);
  // The buttons from there: forward to place 2 (sketch-2), end leaves the marker out (everything built), start is "start".
  const f = barEdit(m.doc, { kind: "button", button: "forward" });
  assert.equal(f.kind === "edit" && f.doc.timeline.marker, "sketch-2");
  const e = barEdit(m.doc, { kind: "button", button: "end" });
  assert.ok(e.kind === "edit" && e.doc.timeline.marker === undefined && !("marker" in e.doc.timeline));
  const st = barEdit(m.doc, { kind: "button", button: "start" });
  assert.equal(st.kind === "edit" && st.doc.timeline.marker, "start");
  // Back from the start, forward from the end, the marker dropped where it is: nothing to record.
  assert.deepEqual(barEdit(st.kind === "edit" ? st.doc : doc, { kind: "button", button: "back" }), { kind: "none" });
  assert.deepEqual(barEdit(doc, { kind: "button", button: "forward" }), { kind: "none" });
  assert.deepEqual(barEdit(doc, { kind: "marker", place: 3 }), { kind: "none" });
  // A marker on the last item is the same place as no marker: dropping it at the end records nothing.
  assert.deepEqual(barEdit(withMarker(doc, "feature-3"), { kind: "marker", place: 3 }), { kind: "none" });
});

test("an item dropped at a place: before or after itself is nothing, a place it can't go is refused with the reorder's message", () => {
  const doc = threeItems(); // feature-1 (box), sketch-2 (Sketch 1), feature-3 (Extrude 1 of it)
  // The box (index 0) dropped at place 0 or 1 is where it is.
  assert.deepEqual(barEdit(doc, { kind: "item", id: "feature-1", place: 0 }), { kind: "none" });
  assert.deepEqual(barEdit(doc, { kind: "item", id: "feature-1", place: 1 }), { kind: "none" });
  // The box dropped at place 3 (past the last): to place 2 of the new order, so the order is sketch-2, feature-3, feature-1.
  const end = barEdit(doc, { kind: "item", id: "feature-1", place: 3 });
  assert.ok(end.kind === "edit");
  assert.equal(end.step, "Move Feature 1 (box) in the timeline");
  assert.deepEqual(end.doc.timeline.features.map((f) => f.id), ["sketch-2", "feature-3", "feature-1"]);
  // The box dropped at place 2 (between the sketch and its extrude): new order sketch-2, feature-1, feature-3.
  const mid = barEdit(doc, { kind: "item", id: "feature-1", place: 2 });
  assert.deepEqual(mid.kind === "edit" && mid.doc.timeline.features.map((f) => f.id), ["sketch-2", "feature-1", "feature-3"]);
  // The extrude dropped at place 0, before its own sketch: refused, nothing recorded.
  assert.deepEqual(barEdit(doc, { kind: "item", id: "feature-3", place: 0 }), { kind: "refused", message: "Extrude 1 can't go before Sketch 1: it is built from Sketch 1" });
  // The sketch dropped past its extrude.
  assert.deepEqual(barEdit(doc, { kind: "item", id: "sketch-2", place: 3 }), { kind: "refused", message: "Sketch 1 can't go after Extrude 1: Extrude 1 is built from it" });
  // With the marker on the box, Sketch 1 and its extrude are rolled back. The marker stays on the item it names,
  // so the box dropped at place 2 (after Sketch 1) brings Sketch 1 before the marker: built again; the extrude stays rolled back.
  const past = barEdit(withMarker(doc, "feature-1"), { kind: "item", id: "feature-1", place: 2 });
  assert.deepEqual(past.kind === "edit" && timelineBarItems(past.doc).items.map((i) => [i.id, i.rolledBack]), [["sketch-2", false], ["feature-1", false], ["feature-3", true]]);
  assert.throws(() => barEdit(doc, { kind: "item", id: "feature-1", place: 4 }), /can't go to place 4 of 3 items/);
  assert.throws(() => barEdit(doc, { kind: "item", id: "feature-1", place: 1.5 }), /can't go to place 1.5 of 3 items/);
  assert.throws(() => barEdit(doc, { kind: "marker", place: -1 }), /the marker can't go to place -1 of 3 items/);
});

test("a move that would roll back the sketch being edited is refused", () => {
  const words = "The marker can't go before Sketch 1 while it is being edited: finish the sketch first";
  // The marker on Extrude 1 (place 3) while Sketch 1 (index 1) is edited.
  const doc = withMarker(threeItems(), "feature-3");
  // To the start (place 0) or after the box (place 1): Sketch 1's index 1 is not before either place, so it would be rolled back.
  assert.deepEqual(barEdit(doc, { kind: "button", button: "start" }, "sketch-2"), { kind: "refused", message: words });
  assert.deepEqual(barEdit(doc, { kind: "marker", place: 1 }, "sketch-2"), { kind: "refused", message: words });
  // Back one, to place 2 (just after Sketch 1): allowed.
  const back = barEdit(doc, { kind: "button", button: "back" }, "sketch-2");
  assert.equal(back.kind === "edit" && back.doc.timeline.marker, "sketch-2");
  // A second box (feature-4) last, the marker on it. Dropping that box first (place 0) takes the marker with it to index 0,
  // so Sketch 1 would come after the marker: refused. Without a sketch being edited the same drop is allowed.
  const four = withMarker(insertPreset(threeItems(), "box", 10, 10, 10).doc, "feature-4");
  assert.deepEqual(barEdit(four, { kind: "item", id: "feature-4", place: 0 }, "sketch-2"), { kind: "refused", message: words });
  const free = barEdit(four, { kind: "item", id: "feature-4", place: 0 });
  assert.deepEqual(free.kind === "edit" && timelineBarItems(free.doc).items.map((i) => [i.id, i.rolledBack]), [["feature-4", false], ["feature-1", true], ["sketch-2", true], ["feature-3", true]]);
  // The marker on Sketch 1 itself: the box dropped after it (place 2) goes after the marker, rolled back; Sketch 1 stays built.
  const r = barEdit(withMarker(threeItems(), "sketch-2"), { kind: "item", id: "feature-1", place: 2 }, "sketch-2");
  assert.deepEqual(r.kind === "edit" && timelineBarItems(r.doc).items.map((i) => [i.id, i.rolledBack]), [["sketch-2", false], ["feature-1", true], ["feature-3", true]]);
});

test("a delete names its undo step, and asks first exactly when something is built from the item", () => {
  const doc = threeItems();
  const sketch = barEdit(doc, { kind: "menu", id: "sketch-2", action: "delete" });
  assert.ok(sketch.kind === "delete");
  assert.equal(sketch.step, "Delete Sketch 1");
  assert.equal(sketch.ask, true, "Extrude 1 is built from Sketch 1");
  // The same answer as 24e4's box: it has a question exactly when the bar says to ask.
  assert.notEqual(deleteWords(doc, sketch.doc, "sketch-2"), null);
  // The extrude left with no sketch and no kept shape (the app settles one through planDelete) can't build: red.
  assert.deepEqual(timelineBarItems(sketch.doc).items.map((i) => [i.id, i.failed]), [["feature-1", false], ["feature-3", true]]);
  const box = barEdit(doc, { kind: "menu", id: "feature-1", action: "delete" });
  assert.deepEqual(box.kind === "delete" && [box.step, box.ask, deleteWords(doc, box.doc, "feature-1")], ["Delete Feature 1 (box)", false, null]);
  // The item being edited can't be deleted or suppressed from the bar.
  assert.deepEqual(barEdit(doc, { kind: "menu", id: "sketch-2", action: "delete" }, "sketch-2"), { kind: "refused", message: "Sketch 1 is being edited: finish the sketch first" });
  assert.deepEqual(barEdit(doc, { kind: "menu", id: "sketch-2", action: "suppress" }, "sketch-2"), { kind: "refused", message: "Sketch 1 is being edited: finish the sketch first" });
  assert.deepEqual(barEdit(doc, { kind: "menu", id: "feature-3", action: "marker" }), { kind: "refused", message: "The marker is already here" });
  assert.deepEqual(barEdit(doc, { kind: "menu", id: "feature-1", action: "unsuppress" }), { kind: "refused", message: "Feature 1 (box) has no unsuppress in its menu" });
});

test("an item failed in the rebuild is red, unless it is rolled back or suppressed", () => {
  const doc = threeItems();
  const failed = new Set(["feature-3"]);
  assert.deepEqual(timelineBarItems(doc, failed).items.map((i) => i.failed), [false, false, true]);
  assert.deepEqual(timelineBarItems(withMarker(doc, "sketch-2"), failed).items.map((i) => i.failed), [false, false, false], "rolled back: greyed, not red");
  const sup = { ...doc, timeline: { features: doc.timeline.features.map((f) => (f.id === "feature-3" ? { ...f, suppressed: true } : f)) } };
  assert.deepEqual(timelineBarItems(sup, failed).items.map((i) => i.failed), [false, false, false], "suppressed: crossed out, not red");
});

// ---- Seeded sessions against the plain model (test plan point 2). ----

const SESSION_SEEDS = 12;
const SESSION_STEPS = 150;
const REGRESSIONS = new URL("./regressions/timeline-bar/", import.meta.url);

test(`seeded: ${SESSION_SEEDS} sessions × ${SESSION_STEPS} steps through the bar match the plain model`, () => {
  const base = Number(process.env.FISSION_SEED ?? 241);
  const seen = new Set<string>();
  for (let seed = base; seed < base + SESSION_SEEDS; seed++) {
    const steps = randomSteps(seed, SESSION_STEPS);
    const failure = runBarSession(bar, steps);
    if (failure) {
      const small = shrink(bar, steps);
      mkdirSync(REGRESSIONS, { recursive: true });
      const file = new URL(`seed-${seed}.json`, REGRESSIONS);
      writeFileSync(file, JSON.stringify({ seed, failure: runBarSession(bar, small)?.message, steps: small }, null, 1) + "\n");
      assert.fail(`seed ${seed} (FISSION_SEED=${seed} replays it), saved shrunk to ${small.length} steps in ${fileURLToPath(file)}: ${failure.message}`);
    }
    for (const s of steps) seen.add(s.op);
  }
  // Every kind of step was tried.
  assert.deepEqual([...seen].sort(), [...OPS].sort());
});

test("seeded: the sessions reach every outcome: nothing, each edit, a delete that asks and one that doesn't, and each refusal", () => {
  // A recording bar: the real one, noting each outcome's kind and words.
  const seen = new Set<string>();
  const spy: typeof bar = {
    ...bar,
    barEdit: (d, a, e) => {
      const r = bar.barEdit(d, a, e);
      seen.add(r.kind === "edit" ? r.step.split(" ")[0] : r.kind === "delete" ? `delete-${r.ask}` : r.kind === "refused" ? (["already here", " while it is being edited", "is being edited", "can't go before", "can't go after"].find((w) => r.message.includes(w)) ?? r.message) : "none");
      return r;
    },
  };
  for (let seed = 241; seed < 241 + SESSION_SEEDS; seed++) assert.equal(runBarSession(spy, randomSteps(seed, SESSION_STEPS)), null);
  for (const want of ["none", "Move", "Suppress", "Unsuppress", "delete-true", "delete-false", "already here", " while it is being edited", "is being edited", "can't go before", "can't go after"])
    assert.ok(seen.has(want), `no session reached "${want}"; reached: ${[...seen].join(", ")}`);
});

test("saved failing sessions replay clean", () => {
  if (!existsSync(REGRESSIONS)) return;
  for (const name of readdirSync(REGRESSIONS).filter((n) => n.endsWith(".json"))) {
    const { steps } = JSON.parse(readFileSync(new URL(name, REGRESSIONS), "utf8"));
    assert.equal(runBarSession(bar, steps)?.message ?? null, null, name);
  }
});
