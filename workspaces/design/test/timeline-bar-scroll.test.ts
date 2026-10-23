// The timeline hunt's findings 2 and 4 (bug-hunts/timeline-2026-10-19.txt),
// in the bar's own code. Finding 2: the bar is drawn new on every edit, so
// at 375 px it went back to its start, taking the picked item and its ⋯ (a
// phone's only way to the menu) off the screen; it now keeps its scroll and
// brings the ⋯, or a marker that moved, into view (`inView`, hand-worked
// below). Finding 4: a refused bar action wrote its words only to the error
// line, far below a phone's screen; the bar now shows them beside itself
// until it is drawn again. The browser check is timeline.mjs's "timeline
// hunt's leftovers" (real layout at 1280 and 375 px).

import { test } from "node:test";
import assert from "node:assert/strict";
import { partDocument } from "../src/document.ts";
import { addSketch } from "../src/sketch.ts";
import { extrudeSketch } from "../src/extrude.ts";
import { inView, showTimelineBar, type BarWiring } from "../src/timeline-bar.ts";

const { Window } = await import("happy-dom");

const threeItems = () => extrudeSketch(addSketch(partDocument("box", 40, 30, 20)).doc, "sketch-2", 10).doc;

test("inView: the least scroll that shows a span, worked by hand", () => {
  // A view 100 wide scrolled to 200 shows 200..300.
  // Already in view (220..250): unchanged.
  assert.equal(inView(200, 100, 220, 250), 200);
  // Exactly filling it (200..300): unchanged, both edges count as in view.
  assert.equal(inView(200, 100, 200, 300), 200);
  // Past the right edge (280..330): scroll so its right edge is the view's, 330 − 100 = 230.
  assert.equal(inView(200, 100, 280, 330), 230);
  // Before the left edge (150..180): scroll to its start, 150.
  assert.equal(inView(200, 100, 150, 180), 150);
  // Wider than the view (150..400, 250 wide): its start shown first, 150.
  assert.equal(inView(200, 100, 150, 400), 150);
  // One pixel past either edge moves by that pixel: 201..301 → 201; 199..299 → 199.
  assert.equal(inView(200, 100, 201, 301), 201);
  assert.equal(inView(200, 100, 199, 299), 199);
  // Never below 0.
  assert.equal(inView(50, 100, -10, 20), 0);
});

function barIn(wiring: BarWiring) {
  const window = new Window({ width: 375, height: 800 });
  const slot = window.document.createElement("div") as unknown as HTMLElement;
  window.document.body.append(slot as never);
  showTimelineBar(slot, threeItems(), wiring);
  return slot;
}
const note = (slot: HTMLElement) => slot.querySelector<HTMLElement>(".timeline-bar-note");

test("a refused bar action's words show beside the bar, as a status, until the bar is drawn again", () => {
  const words = "The marker can't go before Sketch 1 while it is being edited: finish the sketch first";
  const slot = barIn({ onAction: () => words });
  assert.equal(note(slot), null, "no words before anything is refused");
  slot.querySelector<HTMLElement>('[data-button="start"]')!.click();
  assert.equal(note(slot)?.textContent, words);
  assert.equal(note(slot)?.getAttribute("role"), "status");
  // An action that records nothing and says nothing: the words go.
  showTimelineBar(slot, threeItems(), { onAction: () => undefined });
  slot.querySelector<HTMLElement>('[data-button="back"]')!.click();
  assert.equal(note(slot), null);
});

test("the bar drawn again keeps its sideways scroll", () => {
  const slot = barIn({});
  const list = () => slot.querySelector<HTMLElement>(".timeline-bar")!;
  list().scrollLeft = 120;
  const before = list();
  showTimelineBar(slot, threeItems(), {});
  assert.notEqual(list(), before, "a new list");
  assert.equal(list().scrollLeft, 120);
});
