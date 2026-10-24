// The empty design's hint (start-hint.ts, U0c): the rule worked out by
// hand over every case, and the card in a real DOM (happy-dom).
import { test } from "node:test";
import assert from "node:assert/strict";
import { partDocument } from "../src/document.ts";
import { addSketch } from "../src/sketch.ts";
import { freshDesign } from "../src/start-fresh.ts";
import { hintShown, START_HINT_WORDS, startHint } from "../src/start-hint.ts";

test("hand-worked: the hint shows only for an empty design, not while sketching, not once closed", () => {
  const empty = freshDesign();
  // All eight cases of (empty design, sketching, closed): shown only for (yes, no, no).
  for (const isEmpty of [true, false])
    for (const sketching of [true, false])
      for (const closed of [true, false]) assert.equal(hintShown(isEmpty ? empty : partDocument("box", 40, 30, 20), sketching, closed), isEmpty && !sketching && !closed, `${isEmpty} ${sketching} ${closed}`);
  assert.equal(hintShown(undefined, false, false), false, "no design yet (still mounting)");
  assert.equal(hintShown(addSketch(empty).doc, false, false), false, "an empty sketch is a start");
  assert.equal(hintShown({ ...empty, nextId: 7 }, false, false), true, "everything deleted: empty again");
});

const { Window } = await import("happy-dom");

function made(withOpen = true) {
  const window = new Window();
  const doc = window.document as unknown as Document;
  const host = doc.createElement("div");
  doc.body.append(host);
  const ran: string[] = [];
  const memory = { closed: false };
  const hint = startHint(host, { sketch: () => ran.push("sketch"), insert: () => ran.push("insert"), open: withOpen ? () => ran.push("open") : undefined }, memory);
  return { doc, host, hint, ran, memory, $: (id: string) => doc.getElementById(id) as HTMLElement };
}

test("the card: its words, three buttons doing what they say, ✕ closing it for good", () => {
  const { hint, ran, memory, $ } = made();
  assert.equal(hint.element.hidden, true, "hidden until told the design");
  hint.update(freshDesign(), false);
  assert.equal(hint.element.hidden, false);
  assert.equal($("start-hint-words").textContent, START_HINT_WORDS);
  assert.deepEqual([...hint.element.querySelectorAll(".start-hint-actions button")].map((b) => b.textContent), ["Create sketch", "Insert a preset", "Open a project"]);
  for (const id of ["start-hint-sketch", "start-hint-insert", "start-hint-open"]) $(id).click();
  assert.deepEqual(ran, ["sketch", "insert", "open"]);
  hint.update(freshDesign(), true);
  assert.equal(hint.element.hidden, true, "a sketch being started hides it");
  hint.update(freshDesign(), false);
  assert.equal(hint.element.hidden, false, "and leaving it shows it again");
  assert.equal($("start-hint-close").getAttribute("aria-label"), "Close this hint");
  $("start-hint-close").click();
  assert.equal(hint.element.hidden, true);
  assert.equal(memory.closed, true);
  hint.update(freshDesign(), false);
  assert.equal(hint.element.hidden, true, "closed stays closed");
  // A new card on the same memory (Design mounted again: Undo, switching) stays closed too.
  const again = startHint(hint.element.parentElement!, { sketch() {}, insert() {} }, memory);
  again.update(freshDesign(), false);
  assert.equal(again.element.hidden, true);
});

test("no Open button where the app can't open a file", () => {
  const { hint, $ } = made(false);
  hint.update(freshDesign(), false);
  assert.equal($("start-hint-open"), null);
  assert.equal(hint.element.querySelectorAll(".start-hint-actions button").length, 2);
});
