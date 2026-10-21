// Deleting a sketch from the browser (delete-ask.ts, step 24e4): what the
// box says, worked out by hand for each case, and the menu and box in a
// real DOM (happy-dom): Delete in the menu, Cancel, Escape and a click
// outside change nothing, keys never reach the app's shortcuts, Delete in
// the box confirms once. `planDelete` (the settled document the delete
// records) is checked on the real kernel in packages/testing
// (journeys/delete-ask.journey.ts); the real app in Chromium in
// apps/fission/e2e/extrude.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { partDocument, type DesignDocument } from "../src/document.ts";
import { addFaceSketch, addSketch, drawCircle, drawRectangle } from "../src/sketch.ts";
import { drawnFrame } from "../src/face-sketch.ts";
import { extrudeSketch } from "../src/extrude.ts";
import { deleteItem } from "../src/timeline-edits.ts";
import { deleteAsk, deleteWords, listWords } from "../src/delete-ask.ts";

/**
 * The box (feature-1), Sketch 1 (sketch-2: a 40 × 30 rectangle, ids 3 to
 * 10) and Extrude 1 of it (feature-11), as in timeline-edits.test.ts.
 */
function part(): DesignDocument {
  const s = addSketch(partDocument("box", 40, 30, 20));
  const rect = drawRectangle(s.doc, s.id, [0, 0], [40, 30]);
  return extrudeSketch(rect.doc, s.id, 10).doc;
}

/** The sketch's content kept for each extrude named, as settleKept leaves it after a delete that broke a closed outline. */
function keptFor(before: DesignDocument, after: DesignDocument, ids: string[]): DesignDocument {
  const s = before.sketches[0];
  return { ...after, kept: Object.fromEntries(ids.map((id) => [id, { points: s.points, curves: s.curves }])) };
}

const USED_KEPT = "Extrude 1 is built from Sketch 1. If you delete it, Extrude 1 keeps its last shape and shows a warning. Undo brings Sketch 1 back.";

test("listWords: one name, two with 'and', three with commas then 'and'", () => {
  assert.equal(listWords([]), "");
  assert.equal(listWords(["Extrude 1"]), "Extrude 1");
  assert.equal(listWords(["Extrude 1", "Extrude 2"]), "Extrude 1 and Extrude 2");
  assert.equal(listWords(["Extrude 1", "Extrude 2", "Extrude 3"]), "Extrude 1, Extrude 2 and Extrude 3");
});

test("a used sketch whose extrude keeps its shape: the box names the extrude, says it keeps its last shape with a warning, and that Undo brings it back", () => {
  const d = part();
  // Sketch 1 closed (a rectangle), so deleting it keeps the rectangle for Extrude 1 (feature-11): settleKept's rule.
  const after = keptFor(d, deleteItem(d, "sketch-2"), ["feature-11"]);
  assert.deepEqual(deleteWords(d, after, "sketch-2"), { heading: "Delete Sketch 1?", words: USED_KEPT });
});

test("a used sketch whose extrude has nothing to keep: the box says it fails, never that it keeps a shape", () => {
  const d = part();
  // No kept entry for feature-11 in the document the delete records (its sketch was never closed when lost).
  const after = deleteItem(d, "sketch-2");
  assert.equal(after.kept, undefined);
  assert.deepEqual(deleteWords(d, after, "sketch-2"), {
    heading: "Delete Sketch 1?",
    words: "Extrude 1 is built from Sketch 1. If you delete it, Extrude 1 has no shape to keep and fails. Undo brings Sketch 1 back.",
  });
});

test("two extrudes of one sketch, counted by hand: plural words, and each told apart when only one keeps a shape", () => {
  // Extrude 1 is feature-11 (counter 12), Extrude 2 is feature-12.
  const two = extrudeSketch(part(), "sketch-2", 5).doc;
  assert.deepEqual(two.timeline.features.map((f) => f.id), ["feature-1", "sketch-2", "feature-11", "feature-12"]);
  const gone = deleteItem(two, "sketch-2");
  assert.equal(
    deleteWords(two, keptFor(two, gone, ["feature-11", "feature-12"]), "sketch-2")!.words,
    "Extrude 1 and Extrude 2 are built from Sketch 1. If you delete it, Extrude 1 and Extrude 2 keep their last shapes and show a warning. Undo brings Sketch 1 back.",
  );
  assert.equal(
    deleteWords(two, keptFor(two, gone, ["feature-12"]), "sketch-2")!.words,
    "Extrude 1 and Extrude 2 are built from Sketch 1. If you delete it, Extrude 2 keeps its last shape and shows a warning, and Extrude 1 has no shape to keep and fails. Undo brings Sketch 1 back.",
  );
  assert.equal(
    deleteWords(two, gone, "sketch-2")!.words,
    "Extrude 1 and Extrude 2 are built from Sketch 1. If you delete it, Extrude 1 and Extrude 2 have no shapes to keep and fail. Undo brings Sketch 1 back.",
  );
});

test("nothing built from it, nothing to ask: an unused sketch, the extrude itself, the box", () => {
  const d = part();
  const s2 = addSketch(d);
  assert.equal(deleteWords(s2.doc, deleteItem(s2.doc, s2.id), s2.id), null, "a second sketch no extrude uses");
  assert.equal(deleteWords(d, deleteItem(d, "feature-11"), "feature-11"), null, "the extrude: nothing is built from it");
  assert.equal(deleteWords(d, deleteItem(d, "feature-1"), "feature-1"), null, "the box");
});

test("a box with sketches on its faces: the box says each stays where it is with its plane lost, never that it fails (26c, Q1)", () => {
  // The box (feature-1), Sketch 1 on its top (sketch-2) with a circle
  // (point-3, circle-4), Extrude 1 of it (feature-5): deleting the box asks
  // first; the sketch stays, held where it is, and the extrude with it.
  const top = addFaceSketch(partDocument("box", 40, 30, 20), { plane: "face:feature-1/top", feature: "feature-1" }, drawnFrame([0, 0, 1], [20, 15, 20]));
  const one = extrudeSketch(drawCircle(top.doc, top.id, [20, 15], 5).doc, top.id, 10).doc;
  assert.deepEqual(deleteWords(one, deleteItem(one, "feature-1"), "feature-1"), {
    heading: "Delete Feature 1 (box)?",
    words: "Sketch 1 is drawn on a face of Feature 1 (box). If you delete it, Sketch 1 stays where it is and shows its plane is lost. Undo brings Feature 1 (box) back.",
  });
  // A second, on its front (sketch-6): plural words.
  const two = addFaceSketch(one, { plane: "face:feature-1/front", feature: "feature-1" }, drawnFrame([0, -1, 0], [20, 0, 10])).doc;
  assert.deepEqual(deleteWords(two, deleteItem(two, "feature-1"), "feature-1")!.words, "Sketch 1 and Sketch 2 are drawn on faces of Feature 1 (box). If you delete it, Sketch 1 and Sketch 2 stay where they are and show their planes are lost. Undo brings Feature 1 (box) back.");
});

test("an item that isn't there is refused by name", () => {
  const d = part();
  assert.throws(() => deleteWords(d, d, "sketch-99"), { message: "there is no item sketch-99 in the timeline" });
});

const { Window } = await import("happy-dom");

/** The menu and box in a real DOM, a listener on the document standing in for the app's shortcuts. */
function setup() {
  const window = new Window({ width: 1280, height: 800 });
  const doc = window.document as unknown as Document;
  const slot = doc.createElement("div");
  doc.body.append(slot);
  const shortcutKeys: string[] = [];
  doc.addEventListener("keydown", (e) => shortcutKeys.push((e as KeyboardEvent).key));
  const ask = deleteAsk(slot);
  const $ = (id: string) => doc.getElementById(id) as HTMLElement;
  const key = (target: HTMLElement, k: string) => target.dispatchEvent(new window.KeyboardEvent("keydown", { key: k, bubbles: true }) as unknown as Event);
  const runs = { deleted: 0, confirmed: 0 };
  return { doc, ask, $, key, shortcutKeys, runs, window };
}

/** The timeline's item menu (24f3): Delete runs `onDelete`; the other entries do nothing. */
const entries = (onDelete: () => void, off: Partial<Record<string, string>> = {}) =>
  [
    { action: "marker", label: "Move the marker here" },
    { action: "suppress", label: "Suppress" },
    { action: "delete", label: "Delete" },
  ].map((e) => ({ ...e, off: off[e.action] ?? null, run: e.action === "delete" ? onDelete : () => {} }));

test("the menu: each entry named for the row, at the pointer; Delete runs the delete once and closes", () => {
  const { ask, $, runs, doc } = setup();
  assert.equal(ask.open, null);
  ask.menu("Sketch 1", { x: 120, y: 200 }, entries(() => runs.deleted++));
  assert.equal(ask.open, "menu");
  assert.equal($("row-menu").getAttribute("aria-label"), "Sketch 1");
  assert.deepEqual(
    [...$("row-menu").querySelectorAll("button")].map((b) => [b.id, b.textContent, b.getAttribute("aria-label")]),
    [
      ["row-menu-marker", "Move the marker here", "Move the marker to just after Sketch 1"],
      ["row-menu-suppress", "Suppress", "Suppress Sketch 1"],
      ["row-menu-delete", "Delete", "Delete Sketch 1"],
    ],
  );
  assert.equal(doc.activeElement?.id, "row-menu-marker", "the keyboard lands on the first entry");
  assert.equal($("row-menu").style.left, "120px");
  assert.equal($("row-menu").style.top, "200px");
  $("row-menu-delete").click();
  assert.equal(runs.deleted, 1);
  assert.equal(ask.open, null);
});

test("the menu stays on the screen near the right and bottom edges, and never goes past the left or top", () => {
  const { ask, $ } = setup();
  ask.menu("Sketch 1", { x: 5000, y: 5000 }, entries(() => {}));
  // happy-dom lays nothing out (the menu is 0 × 0), so it is pulled back to exactly the window's edge, 1280 × 800.
  assert.equal($("row-menu").style.left, "1280px");
  assert.equal($("row-menu").style.top, "800px");
  ask.menu("Sketch 1", { x: -40, y: -3 }, entries(() => {}));
  assert.equal($("row-menu").style.left, "0px");
  assert.equal($("row-menu").style.top, "0px");
});

test("an off entry is greyed with why under its words and as its title, never runs, and the keyboard skips it", () => {
  const { ask, $, runs, doc } = setup();
  const why = "Sketch 1 is being edited: finish the sketch first";
  ask.menu("Sketch 1", { x: 0, y: 0 }, entries(() => runs.deleted++, { marker: "The marker is already here", delete: why }));
  const del = $("row-menu-delete") as HTMLButtonElement;
  assert.equal(del.disabled, true);
  assert.equal(del.title, why);
  assert.equal(del.querySelector(".delete-ask-off")?.textContent, why);
  assert.equal(($("row-menu-suppress") as HTMLButtonElement).disabled, false);
  assert.equal(doc.activeElement?.id, "row-menu-suppress", "the first entry that is on");
  del.click();
  assert.equal(runs.deleted, 0);
  assert.equal(ask.open, "menu");
});

test("Escape closes the menu without deleting, and no key pressed in it reaches the app's shortcuts", () => {
  const { ask, $, key, shortcutKeys, runs } = setup();
  ask.menu("Sketch 1", { x: 10, y: 10 }, entries(() => runs.deleted++));
  key($("row-menu-delete"), "r"); // the rectangle tool's key
  key($("row-menu-delete"), "Escape"); // would clear the selection behind it
  assert.deepEqual(shortcutKeys, []);
  assert.equal(ask.open, null);
  assert.equal(runs.deleted, 0);
  // Outside the dialogs the keys do reach them: the listener itself works.
  key($("delete-ask-heading").ownerDocument.body, "r");
  assert.deepEqual(shortcutKeys, ["r"]);
});

test("the box asks with the words given; Cancel has the focus and closes it with nothing deleted", () => {
  const { ask, $, runs, doc } = setup();
  ask.ask({ heading: "Delete Sketch 1?", words: USED_KEPT }, () => runs.confirmed++);
  assert.equal(ask.open, "ask");
  assert.equal($("delete-ask-heading").textContent, "Delete Sketch 1?");
  assert.equal($("delete-ask-words").textContent, USED_KEPT);
  assert.equal(doc.activeElement?.id, "delete-ask-cancel", "Enter alone never deletes");
  $("delete-ask-cancel").click();
  assert.equal(ask.open, null);
  assert.equal(runs.confirmed, 0);
});

test("the box: Escape cancels, keys stay in it; Delete confirms exactly once", () => {
  const { ask, $, key, shortcutKeys, runs } = setup();
  ask.ask({ heading: "Delete Sketch 1?", words: USED_KEPT }, () => runs.confirmed++);
  key($("delete-ask-cancel"), "Escape");
  assert.deepEqual(shortcutKeys, []);
  assert.equal(ask.open, null);
  assert.equal(runs.confirmed, 0);
  ask.ask({ heading: "Delete Sketch 1?", words: USED_KEPT }, () => runs.confirmed++);
  $("delete-ask-confirm").click();
  assert.equal(runs.confirmed, 1);
  assert.equal(ask.open, null);
  // A later click on a closed box's button can't confirm a second time with an old callback: it is replaced on every ask.
  ask.ask({ heading: "Delete Sketch 2?", words: "…" }, () => (runs.confirmed += 10));
  $("delete-ask-confirm").click();
  assert.equal(runs.confirmed, 11);
});

test("a click on the backdrop, outside the box, cancels; a click inside it does not", () => {
  const { ask, $, runs, window } = setup();
  ask.ask({ heading: "Delete Sketch 1?", words: USED_KEPT }, () => runs.confirmed++);
  const box = $("delete-ask");
  // happy-dom gives the box a 0 × 0 rectangle at (0, 0): (0, 0) is inside its edge, (50, 50) outside.
  box.dispatchEvent(new window.MouseEvent("click", { bubbles: true, clientX: 0, clientY: 0 }) as unknown as Event);
  assert.equal(ask.open, "ask", "inside");
  box.dispatchEvent(new window.MouseEvent("click", { bubbles: true, clientX: 50, clientY: 50 }) as unknown as Event);
  assert.equal(ask.open, null, "outside");
  assert.equal(runs.confirmed, 0);
});

test("opening one closes the other, and close() shuts both", () => {
  const { ask } = setup();
  ask.menu("Sketch 1", { x: 0, y: 0 }, entries(() => {}));
  ask.ask({ heading: "h", words: "w" }, () => {});
  assert.equal(ask.open, "ask");
  ask.menu("Sketch 1", { x: 0, y: 0 }, entries(() => {}));
  assert.equal(ask.open, "menu");
  ask.close();
  assert.equal(ask.open, null);
});
