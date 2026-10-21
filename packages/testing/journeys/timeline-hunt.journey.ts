// Journey: regressions from the step 24-25 code bug hunt (2026-10-21), in
// the real Design workspace on the real WASM kernel (design-app.ts: a real
// DOM, one undo history that mounts the workspace afresh, a viewport that
// keeps the last mesh, whose volume is worked out from its triangles).
//
// 1. Another workspace shown while a rebuild was still being answered:
//    coming back built the document again from the size boxes, so a
//    design with no body (its only body suppressed or deleted) gained a
//    new box and an undo step "Edit" nobody made.
// 2. The Extrude panel offered sketches after the rollback marker and
//    suppressed ones, said "makes a closed outline", and its OK then did
//    nothing at all (the refusal was thrown where nothing showed it).
//
// Run with `npm run journeys`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { addSketch, drawRectangle, moveMarker, partDocument, suppressItem, type DesignDocument } from "@fission/design";
import { app, close } from "./design-app.ts";

type App = Awaited<ReturnType<typeof app>>;

/** Item `id`'s menu entry clicked, without waiting for the rebuild it starts (a quick user). */
function menuNow(a: App, id: string, entry: string) {
  a.$(`[data-item="${id}"]`)!.dispatchEvent(new a.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 300, clientY: 780 }) as unknown as Event);
  const button = a.$(`#row-menu-${entry}`) as HTMLButtonElement | null;
  assert.ok(button && !button.disabled, `the menu has ${entry}, on`);
  button.click();
}

/** Every undo step on the history, newest first (undone to the start). */
async function undoAll(a: App): Promise<string[]> {
  const labels: string[] = [];
  for (let label = a.history.undo(); label !== null && label !== undefined; label = a.history.undo()) {
    labels.push(label);
    await a.settle();
  }
  return labels;
}

const items = (doc: DesignDocument) => doc.timeline.features.map((f) => `${f.id}${f.suppressed ? " (suppressed)" : ""}`);

test("regression (hunt 2026-10-21): the only body suppressed, then another workspace shown before the rebuild answers: coming back adds no box and records no step", async () => {
  const a = await app(partDocument("box", 10, 10, 10));
  // 10 × 10 × 10 box: 1000 mm³ drawn before anything happens.
  assert.ok(close(a.volume(), 1000), `the box is drawn, ${a.volume()} mm³`);
  menuNow(a, "feature-1", "suppress");
  await a.away(); // asleep at once: the rebuild is answered while Design is not shown
  assert.deepEqual(items(a.doc()), ["feature-1 (suppressed)"], "the timeline holds only the suppressed box: no new item");
  // Nothing builds, so nothing is drawn: 0 mm³.
  assert.ok(close(a.volume(), 0), `nothing is drawn, ${a.volume()} mm³`);
  assert.deepEqual(await undoAll(a), ["Suppress Feature 1 (box)"], "one undo step, the user's");
  assert.ok(await a.close(), "every body freed");
});

test("regression (hunt 2026-10-21): the only body deleted, then another workspace shown before the rebuild answers: the design stays empty", async () => {
  const a = await app(partDocument("cylinder", 20, 20, 10));
  menuNow(a, "feature-1", "delete"); // used by nothing, so no question
  await a.away();
  await a.settle();
  assert.deepEqual(items(a.doc()), [], "the design is empty: no preset came back");
  assert.ok(close(a.volume(), 0), `nothing is drawn, ${a.volume()} mm³`);
  assert.deepEqual(await undoAll(a), ["Delete Feature 1 (cylinder)"], "one undo step, the user's");
  assert.ok(await a.close(), "every body freed");
});

test("regression (hunt 2026-10-21): with a body shown, a marker move and a quick switch away and back change nothing more", async () => {
  const a = await app(boxAndSketch());
  menuNow(a, "feature-1", "marker");
  await a.away();
  assert.deepEqual(items(a.doc()), ["feature-1", "sketch-2"]);
  assert.equal(a.doc().timeline.marker, "feature-1");
  // Only the box builds: 1000 mm³.
  assert.ok(close(a.volume(), 1000), `the box is drawn, ${a.volume()} mm³`);
  assert.deepEqual(await undoAll(a), ["Move the rollback marker"]);
  assert.ok(await a.close(), "every body freed");
});

/** The Extrude panel opened from the toolbar: the sketches it offers, its status and whether OK is on. */
async function openExtrude(a: App) {
  a.$("#extrude")!.click();
  await a.settle();
  const select = a.$("#extrude-sketch") as HTMLSelectElement;
  return { offered: [...select.options].map((o) => o.value), status: a.$("#extrude-status")!.textContent, ok: !(a.$("#extrude-ok") as HTMLButtonElement).disabled };
}

/** A box, then Sketch 1 holding a 40 × 30 rectangle (sketch-2), nothing extruded yet. */
function boxAndSketch(): DesignDocument {
  const s = addSketch(partDocument("box", 10, 10, 10));
  return drawRectangle(s.doc, s.id, [0, 0], [40, 30]).doc;
}

test("regression (hunt 2026-10-21): a sketch after the rollback marker is not offered by Extrude, and the panel says why", async () => {
  const a = await app(moveMarker(boxAndSketch(), "feature-1"));
  const panel = await openExtrude(a);
  assert.deepEqual(panel.offered, [], "Sketch 1 comes after the marker: an extrude put in at the marker can't use it");
  assert.equal(panel.ok, false, "OK is off");
  assert.match(panel.status, /after the rollback marker/, "the status says why");
  // The marker moved past the sketch: now it is offered, and OK makes the body.
  (a.$("#extrude-cancel") as HTMLButtonElement).click();
  await a.menu("sketch-2", "marker");
  const after = await openExtrude(a);
  assert.deepEqual(after.offered, ["sketch-2"]);
  assert.equal(after.ok, true, after.status);
  (a.$("#extrude-distance") as HTMLInputElement).value = "10";
  (a.$("#extrude-ok") as HTMLButtonElement).click();
  await a.settle();
  // The box, 10 × 10 × 10 = 1000 mm³, and the new extrude, 40 × 30 × 10 = 12000 mm³: 13000 mm³ drawn.
  assert.ok(close(a.volume(), 13000), `box and extrude drawn, ${a.volume()} mm³`);
  assert.ok(await a.close(), "every body freed");
});

test("regression (hunt 2026-10-21): a suppressed sketch is not offered by Extrude, and the panel says why", async () => {
  const a = await app(suppressItem(boxAndSketch(), "sketch-2", true));
  const panel = await openExtrude(a);
  assert.deepEqual(panel.offered, [], "Sketch 1 is suppressed: an extrude of it would only fail");
  assert.equal(panel.ok, false, "OK is off");
  assert.match(panel.status, /suppressed/, "the status says why");
  assert.ok(await a.close(), "every body freed");
});

test("regression (hunt 2026-10-21): the Extrude panel no longer says an extrude replaces the part", async () => {
  const a = await app(boxAndSketch());
  await openExtrude(a);
  assert.doesNotMatch(a.$("#extrude-panel")!.textContent ?? "", /replaces the part/);
  assert.doesNotMatch(a.$("#extrude")!.title, /replaces the part/);
  assert.ok(await a.close(), "every body freed");
});
