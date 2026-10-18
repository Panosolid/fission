// Step 24f5: the rollback marker moved from the bar. The four playback
// buttons (`playbackButtons`, hand-worked; the seeded sessions in
// timeline-bar-session.ts check them against the plain model after every
// step), `chooseBarAction` through core's real undo history (one undo step
// each, or the refusal shown, or nothing), and the bar's wiring in a real
// DOM (happy-dom, with each item's place on screen set by hand, since
// happy-dom lays nothing out): the marker dragged, a press too small to be
// a drag, a drag the browser cancels, a tap between two items on a touch
// screen, and the buttons. Then seeded sessions of pointer gestures on
// random layouts against a plain model of what each must do, and bugs
// planted in the wiring, each caught.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHistory, type KernelCalls } from "@fission/core";
import { insertPreset, partDocument, type DesignDocument } from "../src/document.ts";
import { addSketch } from "../src/sketch.ts";
import { extrudeSketch } from "../src/extrude.ts";
import { deleteItem, moveMarker } from "../src/timeline-edits.ts";
import * as bar from "../src/timeline-bar.ts";
import { barEdit, DRAG_PIXELS, playbackButtons, timelineBarItems, type BarAction } from "../src/timeline-bar.ts";
import { chooseBarAction } from "../src/timeline-menu.ts";
import { rng } from "./timeline-bar-session.ts";

const { Window } = await import("happy-dom");

/** The box (feature-1), Sketch 1 (sketch-2) and its extrude (feature-3): a new project's counter starts at 2, each edit takes the next id. */
function threeItems(): DesignDocument {
  return extrudeSketch(addSketch(partDocument("box", 40, 30, 20)).doc, "sketch-2", 10).doc;
}
const withMarker = (doc: DesignDocument, marker: string | undefined): DesignDocument => ({ ...doc, timeline: { ...doc.timeline, marker } });
const offs = (doc: DesignDocument, editing: string | null = null) => playbackButtons(doc, editing).map((b) => [b.button, b.off]);

const AT_START = "The marker is already at the start";
const AT_END = "The marker is already at the end";
const EDITING = "The marker can't go before Sketch 1 while it is being edited: finish the sketch first";

test("hand-worked: the playback buttons are off exactly where they would leave the marker put, and say why", () => {
  // No marker: everything built, the marker at place 3 of 3. Forward and end would leave it there.
  assert.deepEqual(offs(threeItems()), [["start", null], ["back", null], ["forward", AT_END], ["end", AT_END]]);
  // The marker at the start (place 0): start and back would leave it there.
  assert.deepEqual(offs(withMarker(threeItems(), "start")), [["start", AT_START], ["back", AT_START], ["forward", null], ["end", null]]);
  // On Sketch 1 (place 2): every button moves it (to 0, 1, 3 and 3).
  assert.deepEqual(offs(withMarker(threeItems(), "sketch-2")), [["start", null], ["back", null], ["forward", null], ["end", null]]);
  // One item, the marker after it: start and back go to 0; forward and end stay at 1.
  assert.deepEqual(offs(partDocument("box", 1, 1, 1)), [["start", null], ["back", null], ["forward", AT_END], ["end", AT_END]]);
  // Every item deleted: nothing to move between.
  const empty = deleteItem(deleteItem(deleteItem(threeItems(), "feature-3"), "sketch-2"), "feature-1");
  assert.equal(empty.timeline.features.length, 0);
  const none = "The timeline is empty";
  assert.deepEqual(offs(empty), [["start", none], ["back", none], ["forward", none], ["end", none]]);
  // The labels, in the bar's order.
  assert.deepEqual(playbackButtons(threeItems()).map((b) => b.label), ["Go to the start", "Step back", "Step forward", "Go to the end"]);
});

test("hand-worked: while Sketch 1 is edited, a button that would roll it back is off with barEdit's words", () => {
  // Sketch 1 is item 2 (index 1). The marker at place 3: start (to 0) rolls it back; back (to 2) keeps it built.
  assert.deepEqual(offs(threeItems(), "sketch-2"), [["start", EDITING], ["back", null], ["forward", AT_END], ["end", AT_END]]);
  // The marker on Sketch 1 (place 2): start (0) and back (1) both put it after the marker; forward and end (3) don't.
  assert.deepEqual(offs(withMarker(threeItems(), "sketch-2"), "sketch-2"), [["start", EDITING], ["back", EDITING], ["forward", null], ["end", null]]);
  // The words are barEdit's own.
  assert.deepEqual(barEdit(threeItems(), { kind: "button", button: "start" }, "sketch-2"), { kind: "refused", message: EDITING });
});

// ---- chooseBarAction on core's real undo history. ----

/** A host like workspace.ts's, on core's real undo history over the document as JSON. */
function host(start: DesignDocument) {
  let doc = start;
  const history = createHistory({ capture: () => JSON.stringify(doc), restore: (s) => (doc = JSON.parse(s)) });
  const log = { records: [] as string[], refused: [] as string[] };
  const h = {
    kernel: { call: async () => assert.fail("no kernel call is needed to move the marker") } as unknown as KernelCalls,
    current: () => doc,
    record(step: string, next: DesignDocument) {
      doc = next;
      log.records.push(step);
      history.record(step);
    },
    ask: () => assert.fail("moving the marker never asks"),
    refuse: (message: string) => void log.refused.push(message),
  };
  return { h, log, history, doc: () => doc };
}

test("hand-worked: each button and drop is one undo step named \"Move the rollback marker\"; Undo and Redo give the documents back byte for byte", () => {
  const t = host(threeItems());
  const json = (d: DesignDocument) => JSON.stringify(d);
  // Back from place 3: the marker onto Sketch 1 (place 2), so Extrude 1 is rolled back.
  const before = json(t.doc());
  chooseBarAction(t.h, { kind: "button", button: "back" });
  assert.deepEqual(t.log.records, ["Move the rollback marker"]);
  assert.equal(t.doc().timeline.marker, "sketch-2");
  assert.deepEqual(timelineBarItems(t.doc()).items.map((i) => i.rolledBack), [false, false, true]);
  const after = json(t.doc());
  t.history.undo();
  assert.equal(json(t.doc()), before, "one Undo gives back the design before");
  t.history.redo();
  assert.equal(json(t.doc()), after, "one Redo the one after");
  // The marker dropped at place 0: "start", everything rolled back.
  chooseBarAction(t.h, { kind: "marker", place: 0 });
  assert.equal(t.doc().timeline.marker, "start");
  // Go to the end: no marker in the data (everything built), as moveMarker(null) writes it.
  chooseBarAction(t.h, { kind: "button", button: "end" });
  assert.equal(json(t.doc()), json(moveMarker(withMarker(threeItems(), "start"), null)));
  assert.deepEqual(t.log.records, ["Move the rollback marker", "Move the rollback marker", "Move the rollback marker"]);
  // Already at the end: nothing recorded, nothing refused.
  chooseBarAction(t.h, { kind: "button", button: "forward" });
  chooseBarAction(t.h, { kind: "marker", place: 3 });
  assert.equal(t.log.records.length, 3);
  assert.deepEqual(t.log.refused, []);
  // Three Undos go back through each move to the start.
  for (let k = 0; k < 3; k++) t.history.undo();
  assert.equal(json(t.doc()), before);
});

test("hand-worked: a move that would roll back the sketch being edited records nothing and shows why", () => {
  const t = host(threeItems());
  chooseBarAction(t.h, { kind: "button", button: "start" }, "sketch-2");
  chooseBarAction(t.h, { kind: "marker", place: 1 }, "sketch-2");
  assert.deepEqual(t.log.records, []);
  assert.deepEqual(t.log.refused, [EDITING, EDITING]);
  // Back to place 2 keeps Sketch 1 built: recorded.
  chooseBarAction(t.h, { kind: "button", button: "back" }, "sketch-2");
  assert.deepEqual(t.log.records, ["Move the rollback marker"]);
});

// ---- The wiring, in happy-dom with the layout set by hand. ----

interface Edge {
  left: number;
  right: number;
}
const LIST_LEFT = 100; // where the row starts on screen (client px)
const rect = (left: number, right: number) => ({ left, right, x: left, y: 760, top: 760, bottom: 790, width: right - left, height: 30, toJSON: () => ({}) });

/** The bar for `doc` in a fresh window, with `onAction` (`record` may redraw it, as the app does). */
function barIn(doc: DesignDocument, wiring: Parameters<typeof bar.showTimelineBar>[2] = {}, b: typeof bar = bar) {
  const window = new Window({ width: 1280, height: 800 });
  const slot = window.document.createElement("div") as unknown as HTMLElement;
  window.document.body.append(slot as never);
  b.showTimelineBar(slot, doc, wiring);
  return { slot, window };
}

/** Puts the bar's items where `edges` say (row px, the row scrolled `scroll`), as a browser would lay them out. */
function lay(slot: HTMLElement, edges: readonly Edge[], scroll = 0) {
  const list = slot.querySelector(".timeline-bar") as HTMLElement;
  list.getBoundingClientRect = () => rect(LIST_LEFT, LIST_LEFT + 400) as DOMRect;
  Object.defineProperty(list, "scrollLeft", { value: scroll, configurable: true });
  const items = [...slot.querySelectorAll<HTMLElement>(".timeline-bar-item")];
  assert.equal(items.length, edges.length);
  items.forEach((li, i) => (li.getBoundingClientRect = () => rect(LIST_LEFT + edges[i].left - scroll, LIST_LEFT + edges[i].right - scroll) as DOMRect));
  return list;
}

type Win = InstanceType<typeof Window>;
const pointer = (w: Win, type: string, x: number, more: { pointerType?: string; button?: number; y?: number } = {}) =>
  new w.PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: more.pointerType ?? "mouse", button: more.button ?? 0, clientX: x, clientY: more.y ?? 775 }) as unknown as Event;

/** The marker's place in the DOM: how many items come before it. */
const markerPlace = (slot: HTMLElement) => {
  const lis = [...slot.querySelectorAll(".timeline-bar > li")];
  return lis.slice(0, lis.findIndex((li) => li.classList.contains("timeline-bar-marker"))).filter((li) => li.classList.contains("timeline-bar-item")).length;
};
const greyed = (slot: HTMLElement) => [...slot.querySelectorAll<HTMLElement>(".timeline-bar-item")].map((li) => li.dataset.rolledBack === "true");

/** Three items 24 px wide, 2 px apart, from 12 px (the row's padding): [12, 36], [38, 62], [64, 88]; their middles 24, 50 and 76. */
const THREE: Edge[] = [
  { left: 12, right: 36 },
  { left: 38, right: 62 },
  { left: 64, right: 88 },
];

test("wiring, hand-worked: the marker dragged onto the 2nd item's middle drops before it (place 1), shown there while dragged", () => {
  const acts: BarAction[] = [];
  const { slot, window } = barIn(threeItems(), { onAction: (a) => void acts.push(a) });
  const list = lay(slot, THREE);
  const marker = slot.querySelector(".timeline-bar-marker") as HTMLElement;
  assert.equal(markerPlace(slot), 3);
  marker.dispatchEvent(pointer(window, "pointerdown", 195));
  // To row x 50 (client 150), exactly the 2nd item's middle: only the 1st middle (24) is left of it, so place 1.
  list.dispatchEvent(pointer(window, "pointermove", 150));
  assert.equal(markerPlace(slot), 1, "the marker shown where it would drop");
  assert.deepEqual(greyed(slot), [false, true, true], "the items after it greyed while dragged");
  assert.equal(list.dataset.dragging, "true");
  list.dispatchEvent(pointer(window, "pointerup", 150));
  assert.deepEqual(acts, [{ kind: "marker", place: 1 }]);
  // Nothing recorded it (no app here): the bar is drawn again from the document, the marker back after the last item.
  assert.equal(markerPlace(slot), 3);
  assert.deepEqual(greyed(slot), [false, false, false]);
});

test(`wiring, hand-worked: a press on the marker that moves 0.9 × ${DRAG_PIXELS} px is no drag; 1.1 × is one`, () => {
  const acts: BarAction[] = [];
  const { slot, window } = barIn(threeItems(), { onAction: (a) => void acts.push(a) });
  let list = lay(slot, THREE);
  // From client 195 (row 95), 4.5 px left: no drag, nothing done.
  (slot.querySelector(".timeline-bar-marker") as HTMLElement).dispatchEvent(pointer(window, "pointerdown", 195));
  list.dispatchEvent(pointer(window, "pointermove", 195 - 0.9 * DRAG_PIXELS));
  list.dispatchEvent(pointer(window, "pointerup", 195 - 0.9 * DRAG_PIXELS));
  assert.deepEqual(acts, []);
  assert.equal(markerPlace(slot), 3);
  // 5.5 px: a drag, dropped at row 89.5, past every middle: place 3, where it is (the app records nothing for it).
  list = lay(slot, THREE);
  (slot.querySelector(".timeline-bar-marker") as HTMLElement).dispatchEvent(pointer(window, "pointerdown", 195));
  list.dispatchEvent(pointer(window, "pointermove", 195 - 1.1 * DRAG_PIXELS));
  list.dispatchEvent(pointer(window, "pointerup", 195 - 1.1 * DRAG_PIXELS));
  assert.deepEqual(acts, [{ kind: "marker", place: 3 }]);
  // A 3-4-5 move diagonally: 5 px, a drag (as isDrag: DRAG_PIXELS or more).
  list = lay(slot, THREE);
  (slot.querySelector(".timeline-bar-marker") as HTMLElement).dispatchEvent(pointer(window, "pointerdown", 195));
  list.dispatchEvent(pointer(window, "pointermove", 192, { y: 771 }));
  list.dispatchEvent(pointer(window, "pointerup", 192, { y: 771 }));
  assert.equal(acts.length, 2);
});

test("wiring, hand-worked: in a row scrolled 40 px, the pointer counts from the row's start", () => {
  const acts: BarAction[] = [];
  const { slot, window } = barIn(threeItems(), { onAction: (a) => void acts.push(a) });
  const list = lay(slot, THREE, 40);
  // Client 130 is row x 30 on screen, 70 from the row's start: the middles 24 and 50 are left of it, so place 2.
  (slot.querySelector(".timeline-bar-marker") as HTMLElement).dispatchEvent(pointer(window, "pointerdown", 155));
  list.dispatchEvent(pointer(window, "pointermove", 130));
  list.dispatchEvent(pointer(window, "pointerup", 130));
  assert.deepEqual(acts, [{ kind: "marker", place: 2 }]);
});

test("wiring: a drag the browser cancels, a right-button press, and a press elsewhere move nothing", () => {
  const acts: BarAction[] = [];
  const { slot, window } = barIn(threeItems(), { onAction: (a) => void acts.push(a) });
  let list = lay(slot, THREE);
  (slot.querySelector(".timeline-bar-marker") as HTMLElement).dispatchEvent(pointer(window, "pointerdown", 195));
  list.dispatchEvent(pointer(window, "pointermove", 110));
  assert.equal(markerPlace(slot), 0);
  list.dispatchEvent(pointer(window, "pointercancel", 110));
  assert.deepEqual(acts, []);
  assert.equal(markerPlace(slot), 3, "drawn again as the document has it");
  assert.equal((slot.querySelector(".timeline-bar") as HTMLElement).dataset.dragging, undefined);
  list = lay(slot, THREE);
  (slot.querySelector(".timeline-bar-marker") as HTMLElement).dispatchEvent(pointer(window, "pointerdown", 195, { button: 2 }));
  list.dispatchEvent(pointer(window, "pointermove", 110, { button: 2 }));
  list.dispatchEvent(pointer(window, "pointerup", 110, { button: 2 }));
  // A press on an item that moves is not the marker's drag (24f6 drags items).
  (slot.querySelector('[data-item="feature-1"]') as HTMLElement).dispatchEvent(pointer(window, "pointerdown", 124));
  list.dispatchEvent(pointer(window, "pointermove", 180));
  list.dispatchEvent(pointer(window, "pointerup", 180));
  assert.deepEqual(acts, []);
});

test("wiring, hand-worked: a tap between two items on a touch screen puts the marker there; a mouse click there, or a tap on an item, does not", () => {
  const acts: BarAction[] = [];
  const picks: string[] = [];
  const { slot, window } = barIn(withMarker(threeItems(), "start"), { onAction: (a) => void acts.push(a), onPick: (id) => void picks.push(id) });
  const list = lay(slot, THREE);
  const tap = (target: Element, x: number, pointerType: string) => {
    target.dispatchEvent(pointer(window, "pointerdown", x, { pointerType }));
    target.dispatchEvent(pointer(window, "pointerup", x, { pointerType }));
    target.dispatchEvent(new window.MouseEvent("click", { bubbles: true, clientX: x, clientY: 775 }) as unknown as Event);
  };
  // The gap between items 2 and 3 is [62, 64], its middle 63 (client 163): place 2.
  tap(list, 163, "touch");
  assert.deepEqual(acts, [{ kind: "marker", place: 2 }]);
  // The same spot with a mouse: nothing (the mouse drags the marker instead).
  tap(lay(slot, THREE), 163, "mouse");
  assert.equal(acts.length, 1);
  // A tap on item 2 picks it and moves nothing.
  tap(slot.querySelector('[data-item="sketch-2"]')!, 150, "touch");
  assert.deepEqual(picks, ["sketch-2"]);
  assert.equal(acts.length, 1);
});

test("wiring: the click a drag's release makes is not a click on what is under the pointer then", async () => {
  const picks: string[] = [];
  let doc = threeItems();
  const wiring: Parameters<typeof bar.showTimelineBar>[2] = {
    onPick: (id) => void picks.push(id),
    // As the app does: the move recorded and the bar drawn again from the new document at once.
    onAction: (a) => {
      const r = barEdit(doc, a);
      if (r.kind === "edit") bar.showTimelineBar(slot, (doc = r.doc), wiring);
    },
  };
  const { slot, window } = barIn(doc, wiring);
  const list = lay(slot, THREE);
  (slot.querySelector(".timeline-bar-marker") as HTMLElement).dispatchEvent(pointer(window, "pointerdown", 195));
  list.dispatchEvent(pointer(window, "pointermove", 130));
  list.dispatchEvent(pointer(window, "pointerup", 130));
  assert.equal(doc.timeline.marker, "feature-1");
  // The browser's click lands on the item now under the pointer.
  (slot.querySelector('[data-item="sketch-2"]') as HTMLElement).click();
  assert.deepEqual(picks, []);
  // A later click is a click again.
  await new Promise((r) => window.setTimeout(r, 5));
  (slot.querySelector('[data-item="sketch-2"]') as HTMLElement).click();
  assert.deepEqual(picks, ["sketch-2"]);
});

test("wiring: the four buttons before the items, in order, each off greyed with why, each click sent to the app", () => {
  const acts: BarAction[] = [];
  const { slot } = barIn(withMarker(threeItems(), "start"), { onAction: (a) => void acts.push(a) });
  const buttons = [...slot.querySelectorAll<HTMLElement>(".timeline-bar-buttons [data-button]")];
  assert.deepEqual(
    buttons.map((b) => [b.dataset.button, b.getAttribute("aria-label"), b.getAttribute("aria-disabled"), b.title]),
    [
      ["start", "Go to the start", "true", `Go to the start: ${AT_START}`],
      ["back", "Step back", "true", `Step back: ${AT_START}`],
      ["forward", "Step forward", null, "Step forward"],
      ["end", "Go to the end", null, "Go to the end"],
    ],
  );
  // The buttons come before the row of items, outside it.
  assert.equal(slot.querySelector(".timeline-bar-row")!.firstElementChild!.className, "timeline-bar-buttons");
  assert.equal(slot.querySelector(".timeline-bar [data-button]"), null);
  for (const b of buttons) b.click();
  assert.deepEqual(acts.map((a) => a.kind === "button" && a.button), ["start", "back", "forward", "end"]);
  // While Sketch 1 is edited with everything built, Go to the start is off with the edit's words.
  const editing = barIn(threeItems(), { editing: "sketch-2" }).slot;
  assert.equal(editing.querySelector<HTMLElement>('[data-button="start"]')!.title, `Go to the start: ${EDITING}`);
  assert.equal(editing.querySelector<HTMLElement>('[data-button="back"]')!.getAttribute("aria-disabled"), null);
});

// ---- Seeded gesture sessions on random layouts, against a plain model. ----

type Gesture = "drag" | "touch-drag" | "small" | "cancel" | "tap" | "click" | "tap-item" | "button";
const GESTURES: Gesture[] = ["drag", "touch-drag", "small", "cancel", "tap", "click", "tap-item", "button"];

/**
 * One session: a design of `n` boxes, the marker somewhere, laid out with
 * random widths (16 to 40 px), gaps (2 to 14 px) and scroll, then random
 * gestures. The model, written from the owner's rules and not from the
 * code: a drag (5 px or more, mouse or finger) dropped between the middles
 * of items p − 1 and p is a marker drop at p; a press that moves less, a
 * cancelled drag, a mouse click and a tap on an item move nothing; a tap
 * inside the gap before item p (or before the first, or after the last) is
 * a drop at p; a button is that button. Half the actions are recorded as
 * the app would (`barEdit`, the bar drawn from the new document); after
 * every gesture the bar must show the document's marker and greying,
 * whatever was dragged on screen. Returns the first difference, or null.
 */
export function gestureSession(b: typeof bar, seed: number, count = 60): string | null {
  const r = rng(seed);
  const n = 1 + Math.floor(r() * 8);
  let doc = partDocument("box", 10, 10, 10);
  for (let i = 1; i < n; i++) doc = insertPreset(doc, "box", 10, 10, 10).doc;
  const p0 = Math.floor(r() * (n + 1));
  doc = moveMarker(doc, p0 === 0 ? "start" : p0 === n ? null : doc.timeline.features[p0 - 1].id);
  let acts: BarAction[] = [];
  const wiring: Parameters<typeof bar.showTimelineBar>[2] = {
    onAction: (a) => {
      acts.push(a);
      const res = b.barEdit(doc, a);
      if (res.kind === "edit" && r() < 0.5) b.showTimelineBar(slot, (doc = res.doc), wiring);
    },
  };
  const { slot, window } = barIn(doc, wiring, b);
  for (let s = 0; s < count; s++) {
    // A layout: widths, gaps (a phone's 12 px among them) and a scroll.
    const edges: Edge[] = [];
    let x = 12;
    for (let i = 0; i < n; i++) {
      const w = 16 + Math.floor(r() * 25);
      edges.push({ left: x, right: x + w });
      x += w + 2 + Math.floor(r() * 13);
    }
    const scroll = r() < 0.4 ? 0 : Math.floor(r() * x);
    const list = lay(slot, edges, scroll);
    const g = GESTURES[Math.floor(r() * GESTURES.length)];
    const p = Math.floor(r() * (n + 1));
    const mid = (i: number) => (edges[i].left + edges[i].right) / 2;
    const client = (rowX: number) => LIST_LEFT + rowX - scroll;
    const marker = slot.querySelector(".timeline-bar-marker") as HTMLElement;
    const start = client(r() * x);
    const fail = (m: string) => `seed ${seed} gesture ${s} (${g}, place ${p} of ${n}, scrolled ${scroll}): ${m}`;
    acts = [];
    let want: BarAction[] = [];
    if (g === "drag" || g === "touch-drag" || g === "cancel") {
      // Between the middles around place p, a drop on the next item's middle 1 time in 4 (it goes before that item).
      const lo = p === 0 ? mid(0) - 30 : mid(p - 1);
      const hi = p === n ? mid(n - 1) + 30 : mid(p);
      const f = r();
      const end = f < 0.25 && p < n ? hi : lo + Math.max(1e-6, f) * (hi - lo);
      const pointerType = g === "touch-drag" ? "touch" : "mouse";
      marker.dispatchEvent(pointer(window, "pointerdown", start, { pointerType }));
      // A few moves on the way, anywhere in the row; then one to the end point.
      for (let k = Math.floor(r() * 3); k > 0; k--) list.dispatchEvent(pointer(window, "pointermove", client(r() * x), { pointerType }));
      // The last move is DRAG_PIXELS below the press at least, so it is a drag wherever it ends.
      list.dispatchEvent(pointer(window, "pointermove", client(end), { pointerType, y: 775 + DRAG_PIXELS }));
      // While dragged: the marker drawn at p and the items from p on greyed.
      if (markerPlace(slot) !== p) return fail(`while dragged the marker is drawn at place ${markerPlace(slot)}`);
      if (JSON.stringify(greyed(slot)) !== JSON.stringify(edges.map((_, i) => i >= p))) return fail(`while dragged the greyed items are ${JSON.stringify(greyed(slot))}`);
      list.dispatchEvent(pointer(window, g === "cancel" ? "pointercancel" : "pointerup", client(end), { pointerType, y: 775 + DRAG_PIXELS }));
      if (g !== "cancel") want = [{ kind: "marker", place: p }];
    } else if (g === "small") {
      const dx = (r() * 2 - 1) * 0.6 * DRAG_PIXELS;
      const dy = (r() * 2 - 1) * 0.6 * DRAG_PIXELS;
      marker.dispatchEvent(pointer(window, "pointerdown", start));
      list.dispatchEvent(pointer(window, "pointermove", start + dx, { y: 775 + dy }));
      list.dispatchEvent(pointer(window, "pointerup", start + dx, { y: 775 + dy }));
    } else if (g === "tap" || g === "click") {
      // Inside the gap before item p: before the first, the 12 px of padding; after the last, 6 px past it.
      const [a, z] = p === 0 ? [edges[0].left - 6, edges[0].left] : p === n ? [edges[n - 1].right, edges[n - 1].right + 6] : [edges[p - 1].right, edges[p].left];
      const at = client(a + (0.05 + 0.9 * r()) * (z - a));
      const pointerType = g === "tap" ? "touch" : "mouse";
      list.dispatchEvent(pointer(window, "pointerdown", at, { pointerType }));
      list.dispatchEvent(pointer(window, "pointerup", at, { pointerType }));
      list.dispatchEvent(new window.MouseEvent("click", { bubbles: true, clientX: at, clientY: 775 }) as unknown as Event);
      if (g === "tap") want = [{ kind: "marker", place: p }];
    } else if (g === "tap-item") {
      const k = Math.min(p, n - 1);
      const item = slot.querySelector(`[data-item="${doc.timeline.features[k].id}"]`)!;
      const at = client(mid(k));
      item.dispatchEvent(pointer(window, "pointerdown", at, { pointerType: "touch" }));
      item.dispatchEvent(pointer(window, "pointerup", at, { pointerType: "touch" }));
      item.dispatchEvent(new window.MouseEvent("click", { bubbles: true, clientX: at, clientY: 775 }) as unknown as Event);
    } else {
      const button = (["start", "back", "forward", "end"] as const)[p % 4];
      const el = slot.querySelector(`[data-button="${button}"]`) as HTMLElement;
      el.dispatchEvent(pointer(window, "pointerdown", 20));
      el.dispatchEvent(pointer(window, "pointerup", 20));
      el.click();
      want = [{ kind: "button", button }];
    }
    if (JSON.stringify(acts) !== JSON.stringify(want)) return fail(`the bar sent ${JSON.stringify(acts)}, the model ${JSON.stringify(want)}`);
    const shown = timelineBarItems(doc);
    if (markerPlace(slot) !== shown.marker) return fail(`the marker is drawn at place ${markerPlace(slot)}, the document's is ${shown.marker}`);
    if (JSON.stringify(greyed(slot)) !== JSON.stringify(shown.items.map((i) => i.rolledBack))) return fail(`greyed ${JSON.stringify(greyed(slot))}, the document's ${JSON.stringify(shown.items.map((i) => i.rolledBack))}`);
    if ((slot.querySelector(".timeline-bar") as HTMLElement).dataset.dragging) return fail("still marked as dragging");
  }
  return null;
}

const GESTURE_SEEDS = 40;

test(`seeded: ${GESTURE_SEEDS} sessions of pointer gestures on random layouts match the plain model`, () => {
  const base = Number(process.env.FISSION_SEED ?? 501);
  for (let seed = base; seed < base + GESTURE_SEEDS; seed++) {
    const failure = gestureSession(bar, seed);
    assert.equal(failure, null, `FISSION_SEED=${seed} replays it`);
  }
});

// ---- Bugs planted in the wiring, each caught by the gesture sessions. ----

const SOURCE = new URL("../src/timeline-bar.ts", import.meta.url);
const WIRING_PLANTS: { name: string; find: string; replace: string; caught: string }[] = [
  // The items' edges measured without the scroll: a drop in a scrolled row lands off by the scroll.
  { name: "edges-ignore-scroll", find: "return { left: r.left - left + list.scrollLeft, right: r.right - left + list.scrollLeft };", replace: "return { left: r.left - left, right: r.right - left };", caught: "the bar sent" },
  // Every press on the marker a drag: a small slip moves it.
  { name: "every-press-a-drag", find: "if (place === null && !isDrag(e.clientX - down.clientX, e.clientY - down.clientY)) return;", replace: "", caught: "the bar sent" },
  // A cancelled drag dropped anyway.
  { name: "cancel-drops", find: 'if (e.type === "pointerup") act({ kind: "marker", place });', replace: 'if (e.type !== "") act({ kind: "marker", place });', caught: "the bar sent" },
  // A mouse click between items moving the marker, as a tap does.
  { name: "mouse-taps", find: 'if (pointer !== "touch" || (e.target as Element).closest', replace: 'if ((e.target as Element).closest', caught: "the bar sent" },
  // No redraw when the app records nothing: a dragged marker left where it was dropped.
  { name: "no-redraw", find: "if (list.isConnected) showTimelineBar(slot, doc, wiring);", replace: "", caught: "the marker is drawn at place" },
  // The drag's greying not following the marker.
  { name: "preview-off-by-one", find: "if (i >= place!) li.dataset.rolledBack", replace: "if (i > place!) li.dataset.rolledBack", caught: "while dragged the greyed items" },
  // The buttons' clicks crossed: back sent as forward.
  { name: "buttons-crossed", find: 'button.addEventListener("click", () => act({ kind: "button", button: b.button }));', replace: 'button.addEventListener("click", () => act({ kind: "button", button: b.button === "back" ? "forward" : b.button }));', caught: "the bar sent" },
];

async function plantedBar(find: string, replace: string, dir: string, name: string): Promise<typeof bar> {
  const text = readFileSync(SOURCE, "utf8");
  const at = text.indexOf(find);
  assert.ok(at >= 0 && text.indexOf(find, at + 1) < 0, `${name}: the text to replace must be in timeline-bar.ts exactly once: ${find}`);
  const planted = (text.slice(0, at) + replace + text.slice(at + find.length)).replace(/from "\.\/([^"]+)"/g, (_, f) => `from "${new URL(f, SOURCE).href}"`);
  const file = join(dir, `timeline-bar-wiring-${name}.ts`);
  writeFileSync(file, planted);
  return import(pathToFileURL(file).href);
}

/** The first seed's failure in sessions on `b`, or null. */
function firstFailure(b: typeof bar): string | null {
  for (let seed = 501; seed < 501 + GESTURE_SEEDS; seed++) {
    const f = gestureSession(b, seed);
    if (f) return f;
  }
  return null;
}

test("each bug planted in the bar's wiring is caught by the gesture sessions, by the check recorded for it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "timeline-marker-planted-"));
  try {
    assert.equal(firstFailure(await plantedBar("export const DRAG_PIXELS = 5;", "export const DRAG_PIXELS = 5;", dir, "none")), null, "the unplanted copy passes");
    for (const p of WIRING_PLANTS) {
      const caught = firstFailure(await plantedBar(p.find, p.replace, dir, p.name));
      assert.ok(caught !== null, `${p.name} was not caught`);
      assert.ok(caught.includes(p.caught), `${p.name} was caught by another check than "${p.caught}": ${caught}`);
      if (process.env.FISSION_PLANTED_REPORT) console.log(`${p.name}: ${caught}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
