// The timeline hunt's finding 7 (bug-hunts/timeline-2026-10-19.txt): a drag
// on the timeline bar couldn't be called off. Escape did nothing, letting
// go over the 3D view still dropped the item at the place under the
// pointer, and a right-click opened the item menu while the drag carried
// on. Now Escape (Design's clear-selection shortcut, from the shortcut table,
// which calls `callOffDrag`), a right-click, or letting go more than DROP_REACH px
// above or below the bar calls the drag off (nothing is sent, the bar is
// drawn again as it was), for an item's drag and the marker's. In
// happy-dom with the layout set by hand, as timeline-reorder.test.ts does.

import { test } from "node:test";
import assert from "node:assert/strict";
import { partDocument, type DesignDocument } from "../src/document.ts";
import { addSketch } from "../src/sketch.ts";
import { extrudeSketch } from "../src/extrude.ts";
import * as bar from "../src/timeline-bar.ts";
import { awayFromBar, callOffDrag, DROP_REACH, type BarAction } from "../src/timeline-bar.ts";
import { AWAY_WORDS } from "../src/timeline-reorder.ts";

const { Window } = await import("happy-dom");
type Win = InstanceType<typeof Window>;

/** The box (feature-1), Sketch 1 (sketch-2) and its extrude (feature-3). */
const threeItems = (): DesignDocument => extrudeSketch(addSketch(partDocument("box", 40, 30, 20)).doc, "sketch-2", 10).doc;
/** Three items 24 px wide, 2 px apart, from 12 px: their middles 24, 50 and 76 (row px). */
const THREE = [
  { left: 12, right: 36 },
  { left: 38, right: 62 },
  { left: 64, right: 88 },
];
const LIST_LEFT = 100;
// The row and the list both span screen heights 760 to 790.
const rect = (left: number, right: number) => ({ left, right, x: left, y: 760, top: 760, bottom: 790, width: right - left, height: 30, toJSON: () => ({}) });

function barIn(wiring: NonNullable<Parameters<typeof bar.showTimelineBar>[2]>) {
  const window = new Window({ width: 1280, height: 800 });
  const slot = window.document.createElement("div") as unknown as HTMLElement;
  window.document.body.append(slot as never);
  bar.showTimelineBar(slot, threeItems(), wiring);
  return { slot, window };
}
function lay(slot: HTMLElement) {
  const row = slot.querySelector(".timeline-marker") as HTMLElement;
  row.getBoundingClientRect = () => rect(0, 600) as DOMRect;
  Object.defineProperty(row, "clientWidth", { value: 600, configurable: true });
  const list = slot.querySelector(".timeline-bar") as HTMLElement;
  list.getBoundingClientRect = () => rect(LIST_LEFT, LIST_LEFT + 400) as DOMRect;
  Object.defineProperty(list, "scrollLeft", { value: 0, configurable: true });
  [...slot.querySelectorAll<HTMLElement>(".timeline-bar-item")].forEach((li, i) => (li.getBoundingClientRect = () => rect(LIST_LEFT + THREE[i].left, LIST_LEFT + THREE[i].right) as DOMRect));
  const marker = slot.querySelector<HTMLElement>(".timeline-bar-marker");
  if (marker) marker.getBoundingClientRect = () => rect(LIST_LEFT + 89, LIST_LEFT + 92) as DOMRect;
}
const pointer = (w: Win, type: string, x: number, y = 775, button = 0) =>
  new w.PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", button, clientX: x, clientY: y }) as unknown as Event;
const item = (slot: HTMLElement, id: string) => slot.querySelector(`[data-item="${id}"]`) as HTMLElement;
const lineOf = (slot: HTMLElement) => slot.querySelector<HTMLElement>(".timeline-reorder-line");
const noteOf = (slot: HTMLElement) => slot.querySelector<HTMLElement>(".timeline-reorder-note");

test("awayFromBar, worked by hand: a row from 760 to 790 drops up to DROP_REACH beyond either edge", () => {
  assert.equal(DROP_REACH, 72);
  assert.equal(awayFromBar(775, 760, 790), false, "on the bar");
  // 0.9 × 72 = 64.8 above the top (695.2) still drops; 1.1 × 72 = 79.2 above (680.8) is away. Exactly 72 above (688) drops.
  assert.equal(awayFromBar(760 - 0.9 * DROP_REACH, 760, 790), false);
  assert.equal(awayFromBar(760 - DROP_REACH, 760, 790), false);
  assert.equal(awayFromBar(760 - 1.1 * DROP_REACH, 760, 790), true);
  // Below the bottom the same: 790 + 64.8 drops, 790 + 79.2 doesn't.
  assert.equal(awayFromBar(790 + 0.9 * DROP_REACH, 760, 790), false);
  assert.equal(awayFromBar(790 + 1.1 * DROP_REACH, 760, 790), true);
});

test("an item's drag let go 1.1 × DROP_REACH above the bar is called off, saying so while there; 0.9 × still drops", () => {
  const acts: BarAction[] = [];
  const { slot, window } = barIn({ onAction: (a) => void acts.push(a) });
  lay(slot);
  // The box pressed on its middle (client 124) and dragged past Extrude 1's middle (client 195): place 3.
  let box = item(slot, "feature-1");
  box.dispatchEvent(pointer(window, "pointerdown", 124));
  box.dispatchEvent(pointer(window, "pointermove", 195));
  assert.equal(lineOf(slot)!.dataset.state, "moves");
  box.dispatchEvent(pointer(window, "pointermove", 195, 760 - 1.1 * DROP_REACH));
  assert.equal(lineOf(slot)!.dataset.state, "away");
  assert.equal(noteOf(slot)!.hidden, false);
  assert.equal(noteOf(slot)!.textContent, AWAY_WORDS);
  box.dispatchEvent(pointer(window, "pointerup", 195, 760 - 1.1 * DROP_REACH));
  assert.deepEqual(acts, [], "nothing sent");
  assert.equal(lineOf(slot), null, "drawn again as it was");
  // The same drag let go 0.9 × DROP_REACH above: dropped at place 3.
  lay(slot);
  box = item(slot, "feature-1");
  box.dispatchEvent(pointer(window, "pointerdown", 124));
  box.dispatchEvent(pointer(window, "pointermove", 195, 760 - 0.9 * DROP_REACH));
  assert.equal(lineOf(slot)!.dataset.state, "moves");
  box.dispatchEvent(pointer(window, "pointerup", 195, 760 - 0.9 * DROP_REACH));
  assert.deepEqual(acts, [{ kind: "item", id: "feature-1", place: 3 }]);
});

test("Escape during an item's drag calls it off: nothing sent, the later release drops nothing; before a drag and after it, Escape is the app's", () => {
  const acts: BarAction[] = [];
  const { slot, window } = barIn({ onAction: (a) => void acts.push(a) });
  lay(slot);
  const box = item(slot, "feature-1");
  assert.equal(callOffDrag(), false, "no press: nothing to call off, so Escape does what it always did");
  box.dispatchEvent(pointer(window, "pointerdown", 124));
  assert.equal(callOffDrag(), false, "a press that isn't a drag yet: the same");
  box.dispatchEvent(pointer(window, "pointermove", 195));
  assert.equal(lineOf(slot)!.dataset.state, "moves");
  assert.equal(callOffDrag(), true, "a drag: called off, and the key goes nowhere else");
  assert.equal(lineOf(slot), null);
  box.dispatchEvent(pointer(window, "pointerup", 195));
  assert.deepEqual(acts, []);
  assert.equal(callOffDrag(), false, "once the drag is over, Escape is the app's again");
});

test("a right-click during an item's drag calls it off and opens no menu; before the press is a drag, the menu opens as ever", () => {
  const acts: BarAction[] = [];
  const menus: string[] = [];
  const { slot, window } = barIn({ onAction: (a) => void acts.push(a), onMenu: (id) => void menus.push(id) });
  lay(slot);
  let box = item(slot, "feature-1");
  box.dispatchEvent(pointer(window, "pointerdown", 124));
  box.dispatchEvent(pointer(window, "pointermove", 195));
  const menu = new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 195, clientY: 775 });
  box.dispatchEvent(menu as unknown as Event);
  assert.equal(menu.defaultPrevented, true);
  assert.deepEqual(menus, [], "no item menu");
  assert.equal(lineOf(slot), null);
  box.dispatchEvent(pointer(window, "pointerup", 195));
  assert.deepEqual(acts, []);
  // A press that hasn't moved (a finger's long press, say): its menu opens.
  lay(slot);
  box = item(slot, "feature-1");
  box.dispatchEvent(pointer(window, "pointerdown", 124));
  box.dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 124, clientY: 775 }) as unknown as Event);
  assert.deepEqual(menus, ["feature-1"]);
});

test("the marker's drag: let go far from the bar, Escape, or a right-click each move nothing; let go on it, it moves", () => {
  const acts: BarAction[] = [];
  const { slot, window } = barIn({ onAction: (a) => void acts.push(a) });
  const list = () => slot.querySelector<HTMLElement>(".timeline-bar")!;
  const marker = () => slot.querySelector<HTMLElement>(".timeline-bar-marker")!;
  // The marker past Extrude 1 (client 190), dragged to client 137, the gap between the box and Sketch 1: place 1.
  const drag = (y: number) => {
    lay(slot);
    marker().dispatchEvent(pointer(window, "pointerdown", 190));
    list().dispatchEvent(pointer(window, "pointermove", 137, y));
  };
  drag(760 - 1.1 * DROP_REACH);
  list().dispatchEvent(pointer(window, "pointerup", 137, 760 - 1.1 * DROP_REACH));
  drag(775);
  assert.equal(callOffDrag(), true);
  list().dispatchEvent(pointer(window, "pointerup", 137));
  drag(775);
  list().dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 137, clientY: 775 }) as unknown as Event);
  list().dispatchEvent(pointer(window, "pointerup", 137));
  assert.deepEqual(acts, [], "called off three ways");
  drag(760 - 0.9 * DROP_REACH);
  list().dispatchEvent(pointer(window, "pointerup", 137, 760 - 0.9 * DROP_REACH));
  assert.deepEqual(acts, [{ kind: "marker", place: 1 }]);
});
