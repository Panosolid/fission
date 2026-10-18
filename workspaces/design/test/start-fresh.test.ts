// Start fresh (start-fresh.ts): the fresh design worked out by hand, what
// the dialog says goes, when the button is off, and the dialog itself in a
// real DOM (happy-dom): it asks first, Cancel and Escape change nothing,
// its keys never reach the app's shortcuts. That it is one undo step that
// Undo takes back, in the real app on the real kernel, is the Chromium
// test (apps/fission/e2e/start-fresh.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyProject, projectFromJson, projectToJson } from "@fission/core";
import { insertPreset, partDocument, readDesignDocument, withPart, type DesignDocument } from "../src/document.ts";
import { addSketch, drawCircle, drawRectangle } from "../src/sketch.ts";
import { extrudeSketch } from "../src/extrude.ts";
import { documentFor } from "../src/commands.ts";
import { ALREADY_FRESH_TITLE, clearedWords, FRESH_SIZES, freshDesign, isFresh, START_FRESH_STEP, START_FRESH_TITLE, startFresh } from "../src/start-fresh.ts";

const DESIGN = [{ id: "design" as const, readData: readDesignDocument }];
const reopen = (d: DesignDocument) => projectFromJson(projectToJson({ ...emptyProject("Fresh"), workspaces: { design: d } }), DESIGN).workspaces.design as DesignDocument;

/** The box (feature-1), Sketch 1 (sketch-2, a 40 × 30 rectangle) and Extrude 1 of it (feature-11): two features and one sketch. */
function part(): DesignDocument {
  const s = addSketch(partDocument("box", 40, 30, 20));
  return extrudeSketch(drawRectangle(s.doc, s.id, [0, 0], [40, 30]).doc, s.id, 10).doc;
}

test("the fresh design, written out by hand: one box feature-1 of 40 × 30 × 20 mm, nothing else, the counter at 2", () => {
  const d = freshDesign();
  // The panel's default sizes are width 40, depth 30, height 20 (properties.ts); a box needs no profile,
  // so the counter has given only feature-1 and stands at 2.
  assert.equal(d.version, 3);
  assert.equal(d.nextId, 2);
  assert.deepEqual(d.profiles, []);
  assert.deepEqual(d.sketches, []);
  assert.equal(d.timeline.features.length, 1);
  const [box] = d.timeline.features;
  assert.equal(box.id, "feature-1");
  assert.deepEqual(box.intent, { type: "box", parameters: { width: 40, depth: 30, height: 20 }, summary: "Box: 40 × 30 × 20 mm" });
  assert.equal(box.suppressed, false);
  assert.deepEqual(box.dependsOn, []);
  assert.equal(Object.hasOwn(d.timeline, "marker"), false, "everything built: no marker");
  assert.equal(Object.hasOwn(d, "kept"), false);
  assert.equal(FRESH_SIZES, "40 × 30 × 20");
  assert.equal(START_FRESH_STEP, "Start fresh");
});

test("the fresh design is the one a new project opens with (the panel's set_part on no design) and opens cleanly from a file", () => {
  // Self-consistency, two paths agreeing: a new project's Design data is made by documentFor on no document.
  assert.deepEqual(freshDesign(), documentFor({ op: "set_part", shape: "box", width: 40, depth: 30, height: 20 }, undefined));
  assert.deepEqual(freshDesign(), withPart(undefined, "box", 40, 30, 20));
  assert.deepEqual(reopen(freshDesign()), freshDesign());
  // Each call is a new document, so nothing the workspace changes later can reach the next fresh one.
  assert.notEqual(freshDesign(), freshDesign());
});

test("what the dialog says goes, counted by hand", () => {
  // part(): the box and Extrude 1 are features, Sketch 1 a sketch.
  assert.equal(clearedWords(part()), "1 sketch and 2 features");
  // A second sketch (sketch-12) with a circle in it: two sketches.
  const s2 = addSketch(part());
  assert.equal(clearedWords(drawCircle(s2.doc, s2.id, [0, 0], 5).doc), "2 sketches and 2 features");
  // The fresh box alone: one feature, no sketch named.
  assert.equal(clearedWords(freshDesign()), "1 feature");
  // A plate added (feature-2 with profile-3): two features, still no sketch.
  assert.equal(clearedWords(insertPreset(freshDesign(), "plate", 60, 40, 5).doc), "2 features");
  // An empty sketch counts: it is in the timeline.
  assert.equal(clearedWords(addSketch(freshDesign()).doc), "1 sketch and 1 feature");
});

test("isFresh: only the fresh design itself; any change at all, even one millimetre or an empty sketch, is something to clear", () => {
  assert.equal(isFresh(freshDesign()), true);
  // Saved and opened again, still fresh, though the reader can list its keys in another order (this caught a JSON.stringify comparison).
  assert.equal(isFresh(reopen(freshDesign())), true, "saved and opened again, still fresh");
  const reordered = Object.fromEntries(Object.entries(freshDesign()).reverse()) as unknown as DesignDocument;
  assert.equal(isFresh(reordered), true, "the same keys in another order");
  assert.equal(isFresh({ ...freshDesign(), sketches: {} } as unknown as DesignDocument), false, "an object where the list was");
  const { profiles: _, ...noProfiles } = freshDesign();
  assert.equal(isFresh(noProfiles as unknown as DesignDocument), false, "a key of the fresh design missing");
  assert.equal(isFresh(partDocument("box", 41, 30, 20)), false, "one millimetre wider");
  assert.equal(isFresh(partDocument("box", 40, 30, 21)), false, "one millimetre taller");
  assert.equal(isFresh(partDocument("cylinder", 40, 30, 20)), false, "another shape at the same sizes");
  assert.equal(isFresh(addSketch(freshDesign()).doc), false, "an empty sketch");
  assert.equal(isFresh(part()), false);
  // The counter moved on (a sketch added, then all of it taken back by hand) is not fresh: the ids would not restart.
  assert.equal(isFresh({ ...freshDesign(), nextId: 3 }), false);
});

const { Window } = await import("happy-dom");

/** A toolbar slot with Start fresh in a real DOM, a listener on the document standing in for the app's shortcuts. */
function setup(design: DesignDocument) {
  const window = new Window();
  const doc = window.document as unknown as Document;
  const slot = doc.createElement("div");
  doc.body.append(slot);
  let current = design;
  let confirmed = 0;
  const shortcutKeys: string[] = [];
  doc.addEventListener("keydown", (e) => shortcutKeys.push((e as KeyboardEvent).key));
  const f = startFresh(slot, { current: () => current, confirm: () => confirmed++ });
  f.showFor(current);
  const $ = (id: string) => doc.getElementById(id) as HTMLElement;
  const key = (target: HTMLElement, k: string) => target.dispatchEvent(new window.KeyboardEvent("keydown", { key: k, bubbles: true }) as unknown as Event);
  const set = (d: DesignDocument) => ((current = d), f.showFor(d));
  return { doc, slot, f, $, key, set, confirmed: () => confirmed, shortcutKeys };
}

test("the button: its own Design group, hidden while a sketch is edited, off with its reason on a fresh design", () => {
  const { $, set } = setup(freshDesign());
  const button = $("start-fresh") as HTMLButtonElement;
  const group = button.closest<HTMLElement>(".tool-group")!;
  assert.equal(group.getAttribute("aria-label"), "Design");
  assert.equal(group.hasAttribute("data-modelling"), true, "the sketch toolbar stands in for it while sketching");
  assert.equal(button.textContent, "Start fresh");
  assert.equal(button.disabled, true);
  assert.equal(button.title, ALREADY_FRESH_TITLE);
  set(part());
  assert.equal(button.disabled, false);
  assert.equal(button.title, START_FRESH_TITLE);
  set(freshDesign());
  assert.equal(button.disabled, true, "back off once fresh again");
});

test("the dialog asks first and says what goes; Cancel closes it and clears nothing", () => {
  const { f, $, confirmed } = setup(part());
  assert.equal(f.open, false);
  $("start-fresh").click();
  assert.equal(f.open, true);
  assert.equal($("start-fresh-heading").textContent, "Start fresh?");
  assert.equal(
    $("start-fresh-words").textContent,
    "This clears everything in the design (1 sketch and 2 features) and starts again from the 40 × 30 × 20 mm box a new design opens with. Undo brings it all back.",
  );
  assert.equal($("start-fresh-cancel").ownerDocument.activeElement?.id, "start-fresh-cancel", "Cancel has the focus: Enter alone never clears");
  $("start-fresh-cancel").click();
  assert.equal(f.open, false);
  assert.equal(confirmed(), 0);
});

test("the dialog's words are for the design when the button is pressed, not when it was last drawn", () => {
  const { $, set } = setup(part());
  const s2 = addSketch(part());
  set(s2.doc);
  $("start-fresh").click();
  assert.match($("start-fresh-words").textContent!, /\(2 sketches and 2 features\)/);
});

test("Escape closes the dialog without clearing, and no key pressed in it reaches the app's shortcuts", () => {
  const { f, $, key, confirmed, shortcutKeys } = setup(part());
  $("start-fresh").click();
  // R would choose the rectangle tool and Escape would clear the selection, behind the dialog.
  key($("start-fresh-cancel"), "r");
  key($("start-fresh-cancel"), "Escape");
  assert.deepEqual(shortcutKeys, []);
  assert.equal(f.open, false);
  assert.equal(confirmed(), 0);
  // Outside the dialog the keys do reach them: the listener itself works.
  key($("start-fresh"), "r");
  assert.deepEqual(shortcutKeys, ["r"]);
});

test("Start fresh in the dialog confirms exactly once and closes it", () => {
  const { f, $, confirmed } = setup(part());
  $("start-fresh").click();
  $("start-fresh-confirm").click();
  assert.equal(confirmed(), 1);
  assert.equal(f.open, false);
});

test("pressing the button on a fresh design opens nothing, even if it was left on", () => {
  const { f, $, confirmed } = setup(freshDesign());
  const button = $("start-fresh") as HTMLButtonElement;
  button.disabled = false; // as if drawn for an older design
  button.click();
  assert.equal(f.open, false);
  assert.equal(confirmed(), 0);
});
