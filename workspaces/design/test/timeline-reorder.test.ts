// Step 24f6: an item dragged along the timeline bar to a new place. What a
// drop would do (`dropState`, hand-worked on the box, Sketch 1 and its
// extrude), where its line stands (`gapX`), each drop one undo step on
// core's real history (`chooseBarAction`), and the drag's wiring in a real
// DOM (happy-dom, each item's place on screen set by hand, since happy-dom
// lays nothing out): the line and the refusal's words while dragged, a
// press too small to be a drag, the right button, a finger on an item that
// isn't picked, a cancelled drag, the click after a drag. Then seeded
// sessions of drags on random designs and layouts against a plain model of
// the owner's rules, and bugs planted in the wiring, each caught.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHistory, type KernelCalls } from "@fission/core";
import { insertPreset, partDocument, type DesignDocument } from "../src/document.ts";
import { addSketch } from "../src/sketch.ts";
import { extrudeSketch } from "../src/extrude.ts";
import { itemName, moveMarker } from "../src/timeline-edits.ts";
import * as bar from "../src/timeline-bar.ts";
import { DRAG_PIXELS, type BarAction } from "../src/timeline-bar.ts";
import { dropState, gapX } from "../src/timeline-reorder.ts";
import { chooseBarAction } from "../src/timeline-menu.ts";
import { rng } from "./timeline-bar-session.ts";

const { Window } = await import("happy-dom");

/** The box (feature-1), Sketch 1 (sketch-2) and its extrude (feature-3, built from sketch-2): a new project's counter starts at 2. */
function threeItems(): DesignDocument {
  return extrudeSketch(addSketch(partDocument("box", 40, 30, 20)).doc, "sketch-2", 10).doc;
}
const order = (doc: DesignDocument) => doc.timeline.features.map((f) => f.id);

const BEFORE = "Extrude 1 can't go before Sketch 1: it is built from Sketch 1";
const AFTER = "Sketch 1 can't go after Extrude 1: Extrude 1 is built from it";

test("hand-worked: what each drop of each item would do on the box, Sketch 1 and Extrude 1", () => {
  const doc = threeItems();
  // Places count gaps: 0 before the box, 1 between the box and Sketch 1, 2 before Extrude 1, 3 past it.
  // The box (item 0) is built from nothing and nothing is built from it: places 0 and 1 are on either side of
  // itself (it stays), 2 and 3 move it after Sketch 1 or to the end.
  assert.deepEqual([0, 1, 2, 3].map((p) => dropState(doc, "feature-1", p)), [{ kind: "stays" }, { kind: "stays" }, { kind: "moves" }, { kind: "moves" }]);
  // Sketch 1 (item 1): to the front is fine (nothing it is built from); past Extrude 1 (place 3) would put it
  // after the extrude built from it.
  assert.deepEqual([0, 1, 2, 3].map((p) => dropState(doc, "sketch-2", p)), [{ kind: "moves" }, { kind: "stays" }, { kind: "stays" }, { kind: "refused", message: AFTER }]);
  // Extrude 1 (item 2): before the box or between the box and Sketch 1 both put it before its sketch.
  assert.deepEqual([0, 1, 2, 3].map((p) => dropState(doc, "feature-3", p)), [{ kind: "refused", message: BEFORE }, { kind: "refused", message: BEFORE }, { kind: "stays" }, { kind: "stays" }]);
});

test("hand-worked: a drop that would roll back the sketch being edited is refused", () => {
  // The marker on Sketch 1, Sketch 1 being edited. The box dropped past Extrude 1 gives Sketch 1, Extrude 1, box,
  // the marker still on Sketch 1 (now place 1): Sketch 1 at index 0 stays built, so it moves.
  const doc = moveMarker(threeItems(), "sketch-2");
  assert.deepEqual(dropState(doc, "feature-1", 3, "sketch-2"), { kind: "moves" });
  // Sketch 1 first (Sketch 1, box, Extrude 1), the marker on the box (place 2), Sketch 1 edited. The box dragged
  // to the front (place 0) gives box, Sketch 1, Extrude 1 with the marker still on the box, now place 1: Sketch 1
  // at index 1 would come after it, rolled back. Refused with the marker's words.
  const front = bar.barEdit(threeItems(), { kind: "item", id: "sketch-2", place: 0 });
  assert.equal(front.kind, "edit");
  const d2 = moveMarker((front as { doc: DesignDocument }).doc, "feature-1");
  assert.deepEqual(order(d2), ["sketch-2", "feature-1", "feature-3"]);
  assert.deepEqual(dropState(d2, "feature-1", 0, "sketch-2"), { kind: "refused", message: "The marker can't go before Sketch 1 while it is being edited: finish the sketch first" });
  // With no sketch edited the same drop just moves.
  assert.deepEqual(dropState(d2, "feature-1", 0), { kind: "moves" });
});

/** Three items 24 px wide, 2 px apart, from 12 px (the row's padding): [12, 36], [38, 62], [64, 88]; their middles 24, 50 and 76. */
const THREE = [
  { left: 12, right: 36 },
  { left: 38, right: 62 },
  { left: 64, right: 88 },
];

test("hand-worked: the drop line stands in the middle of the gap, at the first item's left edge, or past the last", () => {
  // Place 1: the gap [36, 38], its middle 37. Place 2: [62, 64], 63. Place 0: the first item's left edge 12; place 3: 88.
  assert.deepEqual([0, 1, 2, 3].map((p) => gapX(THREE, p)), [12, 37, 63, 88]);
  assert.throws(() => gapX(THREE, 4), /no place 4 among 3 items/);
  assert.throws(() => gapX(THREE, 1.5), /no place 1.5/);
  assert.throws(() => gapX([], 0), /empty timeline/);
});

// ---- chooseBarAction on core's real undo history. ----

function host(start: DesignDocument) {
  let doc = start;
  const history = createHistory({ capture: () => JSON.stringify(doc), restore: (s) => (doc = JSON.parse(s)) });
  const log = { records: [] as string[], refused: [] as string[] };
  const h = {
    kernel: { call: async () => assert.fail("no kernel call is needed to move an item") } as unknown as KernelCalls,
    current: () => doc,
    record(step: string, next: DesignDocument) {
      doc = next;
      log.records.push(step);
      history.record(step);
    },
    ask: () => assert.fail("moving an item never asks"),
    refuse: (message: string) => void log.refused.push(message),
  };
  return { h, log, history, doc: () => doc };
}

test("hand-worked: a drop is one undo step \"Move … in the timeline\"; one Undo and one Redo give the documents back byte for byte; a refused drop records nothing and says why", () => {
  const t = host(threeItems());
  const json = (d: DesignDocument) => JSON.stringify(d);
  const before = json(t.doc());
  // The box dropped past Extrude 1: Sketch 1, Extrude 1, box.
  chooseBarAction(t.h, { kind: "item", id: "feature-1", place: 3 });
  assert.deepEqual(t.log.records, ["Move Feature 1 (box) in the timeline"]);
  assert.deepEqual(order(t.doc()), ["sketch-2", "feature-3", "feature-1"]);
  const after = json(t.doc());
  t.history.undo();
  assert.equal(json(t.doc()), before, "one Undo gives back the design before");
  t.history.redo();
  assert.equal(json(t.doc()), after, "one Redo the one after");
  // Extrude 1 (now item 1) dropped at the front, before its sketch: refused, nothing recorded.
  chooseBarAction(t.h, { kind: "item", id: "feature-3", place: 0 });
  assert.deepEqual(t.log.refused, [BEFORE]);
  // Dropped on either side of itself: nothing at all.
  chooseBarAction(t.h, { kind: "item", id: "feature-3", place: 1 });
  chooseBarAction(t.h, { kind: "item", id: "feature-3", place: 2 });
  assert.equal(t.log.records.length, 1);
  assert.equal(t.log.refused.length, 1);
  assert.equal(json(t.doc()), after);
});

// ---- The wiring, in happy-dom with the layout set by hand. ----

interface Edge {
  left: number;
  right: number;
}
const LIST_LEFT = 100; // where the item row starts on screen (client px); the whole row starts at 0
const rect = (left: number, right: number) => ({ left, right, x: left, y: 760, top: 760, bottom: 790, width: right - left, height: 30, toJSON: () => ({}) });
type Win = InstanceType<typeof Window>;
type Wiring = NonNullable<Parameters<typeof bar.showTimelineBar>[2]>;

function barIn(doc: DesignDocument, wiring: Wiring = {}, b: typeof bar = bar) {
  const window = new Window({ width: 1280, height: 800 });
  const slot = window.document.createElement("div") as unknown as HTMLElement;
  window.document.body.append(slot as never);
  b.showTimelineBar(slot, doc, wiring);
  return { slot, window };
}

/** Puts the row and the bar's items where `edges` say (row px, the row scrolled `scroll`), as a browser would lay them out. */
function lay(slot: HTMLElement, edges: readonly Edge[], scroll = 0) {
  const row = slot.querySelector(".timeline-marker") as HTMLElement;
  row.getBoundingClientRect = () => rect(0, 600) as DOMRect;
  Object.defineProperty(row, "clientWidth", { value: 600, configurable: true });
  const list = slot.querySelector(".timeline-bar") as HTMLElement;
  list.getBoundingClientRect = () => rect(LIST_LEFT, LIST_LEFT + 400) as DOMRect;
  Object.defineProperty(list, "scrollLeft", { value: scroll, configurable: true });
  const items = [...slot.querySelectorAll<HTMLElement>(".timeline-bar-item")];
  assert.equal(items.length, edges.length);
  items.forEach((li, i) => (li.getBoundingClientRect = () => rect(LIST_LEFT + edges[i].left - scroll, LIST_LEFT + edges[i].right - scroll) as DOMRect));
  return list;
}

const pointer = (w: Win, type: string, x: number, more: { pointerType?: string; button?: number; y?: number } = {}) =>
  new w.PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: more.pointerType ?? "mouse", button: more.button ?? 0, clientX: x, clientY: more.y ?? 775 }) as unknown as Event;
const click = (w: Win, el: Element, x: number) => el.dispatchEvent(new w.MouseEvent("click", { bubbles: true, clientX: x, clientY: 775 }) as unknown as Event);
const itemEl = (slot: HTMLElement, id: string) => slot.querySelector(`[data-item="${id}"]`) as HTMLElement;
const lineOf = (slot: HTMLElement) => slot.querySelector<HTMLElement>(".timeline-reorder-line");
const noteOf = (slot: HTMLElement) => slot.querySelector<HTMLElement>(".timeline-reorder-note");
const barOrder = (slot: HTMLElement) => [...slot.querySelectorAll<HTMLElement>(".timeline-bar-item")].map((li) => li.dataset.item);

test("wiring, hand-worked: Extrude 1 dragged before Sketch 1 shows the red line and the refusal's words, and its drop goes to the app", () => {
  const acts: BarAction[] = [];
  const { slot, window } = barIn(threeItems(), { onAction: (a) => void acts.push(a) });
  lay(slot, THREE);
  const extrude = itemEl(slot, "feature-3");
  // Pressed on its middle (row 76, client 176), moved to row 37 (client 137), the gap between the box and Sketch 1:
  // only the box's middle (24) is left of it, so place 1.
  extrude.dispatchEvent(pointer(window, "pointerdown", 176));
  extrude.dispatchEvent(pointer(window, "pointermove", 137));
  const line = lineOf(slot)!;
  assert.ok(line, "a line stands where it would drop");
  assert.equal(line.dataset.place, "1");
  assert.equal(line.dataset.state, "refused");
  // The line's left: the item row's start (100 in the row) + the gap's middle 37, less 1 for its 2 px width.
  assert.equal(line.style.left, "136px");
  assert.equal(noteOf(slot)!.hidden, false);
  assert.equal(noteOf(slot)!.textContent, BEFORE);
  assert.equal(noteOf(slot)!.getAttribute("role"), "status");
  assert.ok(extrude.classList.contains("timeline-reorder-dragged"), "the dragged item dimmed");
  // On past every middle (row 95): place 3, its own place: the line blue, no words.
  extrude.dispatchEvent(pointer(window, "pointermove", 195));
  assert.equal(line.dataset.place, "3");
  assert.equal(line.dataset.state, "stays");
  assert.equal(noteOf(slot)!.hidden, true);
  // Back to place 1 and let go there: the drop is sent (the app refuses it, with the same words).
  extrude.dispatchEvent(pointer(window, "pointermove", 137));
  extrude.dispatchEvent(pointer(window, "pointerup", 137));
  assert.deepEqual(acts, [{ kind: "item", id: "feature-3", place: 1 }]);
  // Nothing recorded it: the bar drawn again, as the document has it, no line, nothing dimmed.
  assert.equal(lineOf(slot), null);
  assert.equal(noteOf(slot), null);
  assert.deepEqual(barOrder(slot), ["feature-1", "sketch-2", "feature-3"]);
  assert.equal(slot.querySelector(".timeline-reorder-dragged"), null);
});

test(`wiring, hand-worked: a press on an item that moves 0.9 × ${DRAG_PIXELS} px is a click that picks it; 1.1 × is a drag`, () => {
  const acts: BarAction[] = [];
  const picks: string[] = [];
  const { slot, window } = barIn(threeItems(), { onAction: (a) => void acts.push(a), onPick: (id) => void picks.push(id) });
  lay(slot, THREE);
  let box = itemEl(slot, "feature-1");
  box.dispatchEvent(pointer(window, "pointerdown", 124));
  box.dispatchEvent(pointer(window, "pointermove", 124 + 0.9 * DRAG_PIXELS));
  box.dispatchEvent(pointer(window, "pointerup", 124 + 0.9 * DRAG_PIXELS));
  click(window, box, 124 + 0.9 * DRAG_PIXELS);
  assert.deepEqual(acts, []);
  assert.deepEqual(picks, ["feature-1"]);
  assert.equal(lineOf(slot), null);
  // 5.5 px right: row 29.5, past the box's own middle (24) only: place 1, its own place (the app does nothing).
  lay(slot, THREE);
  box = itemEl(slot, "feature-1");
  box.dispatchEvent(pointer(window, "pointerdown", 124));
  box.dispatchEvent(pointer(window, "pointermove", 124 + 1.1 * DRAG_PIXELS));
  assert.equal(lineOf(slot)!.dataset.state, "stays");
  box.dispatchEvent(pointer(window, "pointerup", 124 + 1.1 * DRAG_PIXELS));
  assert.deepEqual(acts, [{ kind: "item", id: "feature-1", place: 1 }]);
  // A 3-4-5 move: 5 px exactly, a drag.
  lay(slot, THREE);
  box = itemEl(slot, "feature-1");
  box.dispatchEvent(pointer(window, "pointerdown", 124));
  box.dispatchEvent(pointer(window, "pointermove", 127, { y: 779 }));
  box.dispatchEvent(pointer(window, "pointerup", 127, { y: 779 }));
  assert.equal(acts.length, 2);
});

test("wiring: a right-button press, a finger on an item that isn't picked, and a cancelled drag move nothing; a finger drags the picked item", () => {
  const acts: BarAction[] = [];
  const wiring: Wiring = { onAction: (a) => void acts.push(a) };
  const { slot, window } = barIn(threeItems(), wiring);
  lay(slot, THREE);
  let box = itemEl(slot, "feature-1");
  box.dispatchEvent(pointer(window, "pointerdown", 124, { button: 2 }));
  box.dispatchEvent(pointer(window, "pointermove", 190, { button: 2 }));
  box.dispatchEvent(pointer(window, "pointerup", 190, { button: 2 }));
  // A finger on the box, not picked: it scrolls the row (the browser's), no drag.
  box.dispatchEvent(pointer(window, "pointerdown", 124, { pointerType: "touch" }));
  box.dispatchEvent(pointer(window, "pointermove", 190, { pointerType: "touch" }));
  assert.equal(lineOf(slot), null);
  box.dispatchEvent(pointer(window, "pointerup", 190, { pointerType: "touch" }));
  assert.deepEqual(acts, []);
  // A mouse drag the browser cancels: nothing sent, drawn again as it was.
  box.dispatchEvent(pointer(window, "pointerdown", 124));
  box.dispatchEvent(pointer(window, "pointermove", 190));
  assert.ok(lineOf(slot));
  box.dispatchEvent(pointer(window, "pointercancel", 190));
  assert.deepEqual(acts, []);
  assert.equal(lineOf(slot), null);
  // The box picked (its ⋯ shown): only it takes a finger's drag (touch-action none on it alone).
  bar.showTimelineBar(slot, threeItems(), { ...wiring, picked: "feature-1" });
  lay(slot, THREE);
  box = itemEl(slot, "feature-1");
  assert.ok(box.classList.contains("timeline-reorder-picked"));
  assert.equal(itemEl(slot, "sketch-2").classList.contains("timeline-reorder-picked"), false);
  box.dispatchEvent(pointer(window, "pointerdown", 124, { pointerType: "touch" }));
  box.dispatchEvent(pointer(window, "pointermove", 190, { pointerType: "touch" }));
  box.dispatchEvent(pointer(window, "pointerup", 190, { pointerType: "touch" }));
  assert.deepEqual(acts, [{ kind: "item", id: "feature-1", place: 3 }]);
});

test("wiring: the click a drag's release makes is not a pick of the item; a later click is", async () => {
  const picks: string[] = [];
  let doc = threeItems();
  const wiring: Wiring = {
    onPick: (id) => void picks.push(id),
    // As the app does: the move recorded and the bar drawn again from the new document at once.
    onAction: (a) => {
      const r = bar.barEdit(doc, a);
      if (r.kind === "edit") bar.showTimelineBar(slot, (doc = r.doc), wiring);
    },
  };
  const { slot, window } = barIn(doc, wiring);
  lay(slot, THREE);
  const box = itemEl(slot, "feature-1");
  box.dispatchEvent(pointer(window, "pointerdown", 124));
  box.dispatchEvent(pointer(window, "pointermove", 190));
  box.dispatchEvent(pointer(window, "pointerup", 190));
  assert.deepEqual(order(doc), ["sketch-2", "feature-3", "feature-1"]);
  assert.deepEqual(barOrder(slot), ["sketch-2", "feature-3", "feature-1"]);
  click(window, itemEl(slot, "feature-1"), 190);
  assert.deepEqual(picks, []);
  await new Promise((r) => window.setTimeout(r, 5));
  click(window, itemEl(slot, "feature-1"), 190);
  assert.deepEqual(picks, ["feature-1"]);
});

// ---- Seeded drag sessions on random designs and layouts, against a plain model. ----

interface MItem {
  id: string;
  name: string;
  /** The item it is built from (an extrude's sketch), or null. */
  uses: string | null;
}

/**
 * What dropping item k at place p does, from the owner's rules (written
 * from them, not from the code): before or after itself it stays; else the
 * item goes to place p of the others (p − 1 when it came from before p);
 * refused when what it is built from would come after it ("X can't go
 * before Y: it is built from Y"), or an item built from it before it ("X
 * can't go after Y: Y is built from it"), or, while a sketch is edited,
 * when that sketch would come after the marker, which stays on the item it
 * names.
 */
function predict(items: readonly MItem[], marker: string | null, k: number, p: number, editing: string | null): { state: "stays" | "moves" | "refused"; message?: string; order?: string[] } {
  if (p === k || p === k + 1) return { state: "stays" };
  const item = items[k];
  const next = items.filter((_, j) => j !== k);
  const to = p > k ? p - 1 : p;
  next.splice(to, 0, item);
  const from = next.findIndex((i) => i.id === item.uses);
  if (from > to) return { state: "refused", message: `${item.name} can't go before ${next[from].name}: it is built from ${next[from].name}` };
  const user = next.findIndex((i, j) => j < to && i.uses === item.id);
  if (user >= 0) return { state: "refused", message: `${item.name} can't go after ${next[user].name}: ${next[user].name} is built from it` };
  if (editing !== null) {
    const m = marker === "start" ? 0 : marker === null ? next.length : next.findIndex((i) => i.id === marker) + 1;
    const e = next.findIndex((i) => i.id === editing);
    if (e >= m) return { state: "refused", message: `The marker can't go before ${next[e].name} while it is being edited: finish the sketch first` };
  }
  return { state: "moves", order: next.map((i) => i.id) };
}

type Gesture = "drag" | "touch-picked" | "touch-unpicked" | "small" | "cancel" | "right";
const GESTURES: Gesture[] = ["drag", "drag", "drag", "touch-picked", "touch-unpicked", "small", "cancel", "right"];

/** A random design of 1 to 8 items: boxes, sketches, and extrudes of an earlier sketch. */
function randomDesign(r: () => number): DesignDocument {
  let doc = partDocument("box", 10, 10, 10);
  const n = 1 + Math.floor(r() * 8);
  while (doc.timeline.features.length < n) {
    const sketches = doc.timeline.features.filter((f) => f.intent.type === "sketch");
    const pick = r();
    if (pick < 0.3) doc = insertPreset(doc, "box", 10, 10, 10).doc;
    else if (pick < 0.6 || sketches.length === 0) doc = addSketch(doc).doc;
    else doc = extrudeSketch(doc, sketches[Math.floor(r() * sketches.length)].id, 5).doc;
  }
  return doc;
}

/** A session's design and marker, and the sketch being edited (6 sessions in 10, one that is built, as in the app) or none. */
function sessionStart(r: () => number, b: typeof bar = bar): { doc: DesignDocument; editing: string | null } {
  let doc = randomDesign(r);
  const n = doc.timeline.features.length;
  // Half the time on an item with items after it, where a drag can roll something back.
  const p0 = n > 1 && r() < 0.5 ? 1 + Math.floor(r() * (n - 1)) : Math.floor(r() * (n + 1));
  doc = moveMarker(doc, p0 === 0 ? "start" : p0 === n ? null : doc.timeline.features[p0 - 1].id);
  // One the marker isn't on, when there is one: an edited sketch the marker stands on can't be rolled back by a drag.
  const sketches = b.timelineBarItems(doc).items.filter((i) => !i.rolledBack && i.icon === "sketch");
  const built = sketches.some((i) => i.id !== doc.timeline.marker) ? sketches.filter((i) => i.id !== doc.timeline.marker) : sketches;
  return { doc, editing: built.length > 0 && r() < 0.6 ? built[Math.floor(r() * built.length)].id : null };
}

/**
 * One session: a random design, its marker somewhere, now and then a
 * sketch being edited (one that is built, as in the app), then random
 * gestures on random layouts (item widths, gaps, scroll). After a drag to
 * place p (between the middles of items p − 1 and p, or on item p's middle
 * 1 time in 4), while dragged the line must stand at p with the model's
 * state and words, and the release must send that drop; a small press, the
 * right button, a finger on an item not picked and a cancel send nothing.
 * Most moves are recorded as the app would; after every gesture the bar
 * must show the document's order with no line left. Returns the first
 * difference, or null.
 */
export function dragSession(b: typeof bar, seed: number, count = 40, seen?: Set<string>): string | null {
  const r = rng(seed);
  let { doc, editing } = sessionStart(r, b);
  const n = doc.timeline.features.length;
  let acts: BarAction[] = [];
  let picks: string[] = [];
  const window = new Window({ width: 1280, height: 800 });
  const slot = window.document.createElement("div") as unknown as HTMLElement;
  window.document.body.append(slot as never);
  for (let s = 0; s < count; s++) {
    const g = GESTURES[Math.floor(r() * GESTURES.length)];
    const k = Math.floor(r() * n);
    const id = doc.timeline.features[k].id;
    const wiring: Wiring = {
      editing,
      picked: g === "touch-picked" ? id : null,
      onPick: (x) => void picks.push(x),
      onAction: (a) => {
        acts.push(a);
        const res = b.barEdit(doc, a, editing);
        if (res.kind === "edit" && r() < 0.7) b.showTimelineBar(slot, (doc = res.doc), wiring);
      },
    };
    b.showTimelineBar(slot, doc, wiring);
    const edges: Edge[] = [];
    let x = 12;
    for (let i = 0; i < n; i++) {
      const w = 18 + Math.floor(r() * 23);
      edges.push({ left: x, right: x + w });
      x += w + 2 + Math.floor(r() * 13);
    }
    const scroll = r() < 0.4 ? 0 : Math.floor(r() * x);
    lay(slot, edges, scroll);
    const mid = (i: number) => (edges[i].left + edges[i].right) / 2;
    const client = (rowX: number) => LIST_LEFT + rowX - scroll;
    const p = Math.floor(r() * (n + 1));
    const items: MItem[] = doc.timeline.features.map((f) => ({ id: f.id, name: itemName(f), uses: f.dependsOn[0] ?? null }));
    const marker = doc.timeline.marker === undefined ? null : doc.timeline.marker;
    const li = slot.querySelector(`[data-item="${id}"]`) as HTMLElement;
    const fail = (m: string) => `seed ${seed} gesture ${s} (${g}, item ${k} to place ${p} of ${n}, scrolled ${scroll}${editing ? `, ${editing} edited` : ""}): ${m}`;
    acts = [];
    picks = [];
    let want: BarAction[] = [];
    let wantPicks: string[] = [];
    const pointerType = g === "touch-picked" || g === "touch-unpicked" ? "touch" : "mouse";
    const at = client(mid(k));
    if (g === "small") {
      const dx = (r() * 2 - 1) * 0.6 * DRAG_PIXELS;
      li.dispatchEvent(pointer(window, "pointerdown", at));
      li.dispatchEvent(pointer(window, "pointermove", at + dx));
      li.dispatchEvent(pointer(window, "pointerup", at + dx));
      click(window, li, at + dx);
      wantPicks = [id];
    } else {
      const lo = p === 0 ? mid(0) - 30 : mid(p - 1);
      const hi = p === n ? mid(n - 1) + 30 : mid(p);
      const f = r();
      const end = f < 0.25 && p < n ? hi : lo + Math.max(1e-6, f) * (hi - lo);
      const button = g === "right" ? 2 : 0;
      li.dispatchEvent(pointer(window, "pointerdown", at, { pointerType, button }));
      for (let j = Math.floor(r() * 3); j > 0; j--) li.dispatchEvent(pointer(window, "pointermove", client(r() * x), { pointerType, button }));
      // The last move is DRAG_PIXELS below the press at least, so it is a drag wherever it ends.
      li.dispatchEvent(pointer(window, "pointermove", client(end), { pointerType, button, y: 775 + DRAG_PIXELS }));
      const line = slot.querySelector<HTMLElement>(".timeline-reorder-line");
      const dragging = g === "drag" || g === "touch-picked" || g === "cancel";
      if (!dragging && line) return fail("a line shows, but this is no drag");
      if (dragging) {
        if (!line) return fail("no line while dragged");
        const m = predict(items, marker, k, p, editing);
        seen?.add(m.state !== "refused" ? m.state : m.message!.includes("while it is being edited") ? "editing" : m.message!.includes("is built from it") ? "after-dependent" : "before-dependency");
        if (line.dataset.place !== String(p)) return fail(`the line stands at place ${line.dataset.place}`);
        if (line.dataset.state !== m.state) return fail(`the line says ${line.dataset.state}, the model ${m.state} (${m.message ?? ""})`);
        const wantLeft = `${LIST_LEFT + gapX(edges, p) - scroll - 1}px`;
        if (line.style.left !== wantLeft) return fail(`the line is drawn at ${line.style.left}, not ${wantLeft}`);
        const note = slot.querySelector<HTMLElement>(".timeline-reorder-note")!;
        if (note.hidden !== (m.state !== "refused") || (m.state === "refused" && note.textContent !== m.message)) return fail(`the words say ${note.hidden ? "nothing" : note.textContent}, the model ${m.message ?? "nothing"}`);
        if (!li.classList.contains("timeline-reorder-dragged")) return fail("the dragged item is not dimmed");
        if (m.state === "moves") {
          const res = b.barEdit(doc, { kind: "item", id, place: p }, editing);
          if (res.kind !== "edit" || JSON.stringify(order(res.doc)) !== JSON.stringify(m.order)) return fail(`the drop gives ${res.kind === "edit" ? order(res.doc) : res.kind}, the model ${m.order}`);
        }
      }
      li.dispatchEvent(pointer(window, g === "cancel" ? "pointercancel" : "pointerup", client(end), { pointerType, button, y: 775 + DRAG_PIXELS }));
      // The click a left-button release makes (a finger that moved, a cancelled pointer and the right button make none).
      // It lands on the item as it is drawn now (the bar is drawn again when the app recorded nothing).
      if (g === "drag") click(window, slot.querySelector(`[data-item="${id}"]`)!, client(end));
      if (g === "drag" || g === "touch-picked") want = [{ kind: "item", id, place: p }];
    }
    if (JSON.stringify(acts) !== JSON.stringify(want)) return fail(`the bar sent ${JSON.stringify(acts)}, the model ${JSON.stringify(want)}`);
    if (JSON.stringify(picks) !== JSON.stringify(wantPicks)) return fail(`picked ${JSON.stringify(picks)}, the model ${JSON.stringify(wantPicks)}`);
    if (JSON.stringify(barOrder(slot)) !== JSON.stringify(order(doc))) return fail(`the bar shows ${barOrder(slot)}, the document ${order(doc)}`);
    if (slot.querySelector(".timeline-reorder-line, .timeline-reorder-note, .timeline-reorder-dragged")) return fail("the drag's line, words or dimming left behind");
  }
  return null;
}

const DRAG_SEEDS = 40;

test(`seeded: ${DRAG_SEEDS} sessions of item drags on random designs and layouts match the plain model, every outcome reached`, () => {
  const base = Number(process.env.FISSION_SEED ?? 601);
  const seen = new Set<string>();
  for (let seed = base; seed < base + DRAG_SEEDS; seed++) {
    const failure = dragSession(bar, seed, 40, seen);
    assert.equal(failure, null, `FISSION_SEED=${seed} replays it`);
  }
  // Every outcome is reached while dragged: stays, moves, and each of the three refusals.
  if (process.env.FISSION_SEED === undefined) assert.deepEqual([...seen].sort(), ["after-dependent", "before-dependency", "editing", "moves", "stays"]);
});

// ---- Bugs planted in the drag's wiring, each caught by the drag sessions. ----

const SRC = new URL("../src/", import.meta.url);
const PLANTS: { name: string; file: "timeline-reorder.ts" | "timeline-bar.ts"; find: string; replace: string; caught: string }[] = [
  // The pointer measured from the visible edge, the scroll left out.
  { name: "drop-ignores-scroll", file: "timeline-reorder.ts", find: "place = dropIndex(barEdges(list), e.clientX - list.getBoundingClientRect().left, list.scrollLeft);", replace: "place = dropIndex(barEdges(list), e.clientX - list.getBoundingClientRect().left);", caught: "the line stands at place" },
  // Every press a drag: a click's small slip moves the item.
  { name: "every-press-a-drag", file: "timeline-reorder.ts", find: "if (!isDrag(e.clientX - down.clientX, e.clientY - down.clientY)) return;", replace: "", caught: "the bar sent" },
  // A cancelled drag dropped anyway.
  { name: "cancel-drops", file: "timeline-reorder.ts", find: 'if (e.type === "pointerup") o.act({ kind: "item", id: o.id, place });', replace: 'if (e.type !== "") o.act({ kind: "item", id: o.id, place });', caught: "the bar sent" },
  // A finger drags any item, so the row can't be scrolled with a finger on an item.
  { name: "touch-drags-unpicked", file: "timeline-reorder.ts", find: 'if (down.pointerType === "touch" && !o.picked) return;', replace: "", caught: "a line shows, but this is no drag" },
  // The right button drags too.
  { name: "right-button-drags", file: "timeline-reorder.ts", find: "if (down.button !== 0) return;\n    if (down.pointerType", replace: "if (down.button > 2) return;\n    if (down.pointerType", caught: "a line shows, but this is no drag" },
  // The line says "moves" wherever it stands: a place it can't go not shown refused.
  { name: "refusal-not-shown", file: "timeline-reorder.ts", find: 'if (r.kind === "refused") return { kind: "refused", message: r.message };', replace: 'if (r.kind === "refused") return { kind: "moves" };', caught: "the line says" },
  // The line drawn at the gap after the place.
  { name: "line-off-by-one", file: "timeline-reorder.ts", find: "const x = listLeft + gapX(barEdges(list), p) - list.scrollLeft;", replace: "const x = listLeft + gapX(barEdges(list), Math.min(p + 1, barEdges(list).length)) - list.scrollLeft;", caught: "the line is drawn at" },
  // The drop sent one place on.
  { name: "drop-off-by-one", file: "timeline-reorder.ts", find: 'o.act({ kind: "item", id: o.id, place });', replace: 'o.act({ kind: "item", id: o.id, place: place + 1 });', caught: "the bar sent" },
  // The click after a drag not dropped: the item is picked as well.
  { name: "click-after-drag", file: "timeline-reorder.ts", find: "      swallowClick(list);\n", replace: "", caught: "picked" },
  // The bar's items not wired to be dragged at all.
  { name: "items-not-dragged", file: "timeline-bar.ts", find: "dragItem(row, list, li, {", replace: "void (0 as unknown as typeof dragItem) && dragItem(row, list, li, {", caught: "no line while dragged" },
];

/** The bar and its drag, copied to `dir` with `p` planted (both files, so the bar uses the planted drag), imported. */
async function planted(dir: string, p: { name: string; file: string; find: string; replace: string }): Promise<typeof bar> {
  const sub = join(dir, p.name);
  for (const file of ["timeline-bar.ts", "timeline-reorder.ts"]) {
    let text = readFileSync(new URL(file, SRC), "utf8");
    if (file === p.file) {
      const at = text.indexOf(p.find);
      assert.ok(at >= 0 && text.indexOf(p.find, at + 1) < 0, `${p.name}: the text to replace must be in ${file} exactly once: ${p.find}`);
      text = text.slice(0, at) + p.replace + text.slice(at + p.find.length);
    }
    // The two files import each other from the copy; everything else from the source.
    text = text.replace(/from "\.\/([^"]+)"/g, (whole, f) => (f === "timeline-bar.ts" || f === "timeline-reorder.ts" ? whole : `from "${new URL(f, SRC).href}"`));
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, file), text);
  }
  return import(pathToFileURL(join(sub, "timeline-bar.ts")).href);
}

function firstFailure(b: typeof bar): string | null {
  for (let seed = 601; seed < 601 + DRAG_SEEDS; seed++) {
    const f = dragSession(b, seed);
    if (f) return f;
  }
  return null;
}

test("each bug planted in the drag's wiring is caught by the drag sessions, by the check recorded for it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "timeline-reorder-planted-"));
  try {
    assert.equal(firstFailure(await planted(dir, { name: "none", file: "none", find: "", replace: "" })), null, "the unplanted copy passes");
    for (const p of PLANTS) {
      const caught = firstFailure(await planted(dir, p));
      assert.ok(caught !== null, `${p.name} was not caught`);
      assert.ok(caught.includes(p.caught), `${p.name} was caught by another check than "${p.caught}": ${caught}`);
      if (process.env.FISSION_PLANTED_REPORT) console.log(`${p.name}: ${caught}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
