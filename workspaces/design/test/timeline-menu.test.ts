// Step 24f3: the timeline's item menu wired (timeline-menu.ts), checked
// with core's real undo history: every entry of every item, on designs
// with and without a marker and a suppressed item, is refused with its
// words or recorded as exactly one undo step (one Undo gives back the
// document before it, byte for byte, one Redo the one after); a delete
// asks first exactly when something is built from the item; an edit that
// would leave no body is off. Bugs planted in the wiring (test plan point
// 3, "suppress recorded as two undo steps" among them) are each caught.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHistory, type KernelCalls } from "@fission/core";
import { partDocument, type DesignDocument } from "../src/document.ts";
import { addSketch, drawRectangle } from "../src/sketch.ts";
import { extrudeSketch } from "../src/extrude.ts";
import { deleteItem, moveMarker, suppressItem } from "../src/timeline-edits.ts";
import * as menu from "../src/timeline-menu.ts";
import type { DeleteQuestion } from "../src/delete-ask.ts";

/** The box (feature-1), Sketch 1 (sketch-2: a 40 × 30 rectangle, ids 3 to 10) and Extrude 1 of it (feature-11), as in delete-ask.test.ts. */
function part(): DesignDocument {
  const s = addSketch(partDocument("box", 40, 30, 20));
  const rect = drawRectangle(s.doc, s.id, [0, 0], [40, 30]);
  return extrudeSketch(rect.doc, s.id, 10).doc;
}
/** part() and an empty Sketch 2 (sketch-12) after it, built from nothing and used by nothing. */
const withSketch2 = (): DesignDocument => addSketch(part()).doc;

/** A kernel whose sketch_outline says every sketch closes (`closed`) or none does. */
function kernel(closed: boolean): KernelCalls {
  return {
    call: (async (op: string) => {
      if (op !== "sketch_outline") throw new Error(`unexpected kernel call ${op}`);
      return closed ? { closed: { loops: [] } } : { open: "Sketch has a loose end" };
    }) as KernelCalls["call"],
  };
}

type Menu = typeof menu;

/** A host like workspace.ts's, on core's real undo history over the document as JSON. */
function host(m: Menu, start: DesignDocument, closed = true) {
  let doc = start;
  const history = createHistory({ capture: () => JSON.stringify(doc), restore: (s) => (doc = JSON.parse(s)) });
  const log = { records: [] as string[], refused: [] as string[], asked: [] as DeleteQuestion[], confirm: null as null | (() => void) };
  const h = {
    kernel: kernel(closed),
    current: () => doc,
    record(step: string, next: DesignDocument) {
      doc = next;
      log.records.push(step);
      history.record(step);
    },
    ask(q: DeleteQuestion, go: () => void) {
      log.asked.push(q);
      log.confirm = go;
    },
    refuse: (message: string) => void log.refused.push(message),
  };
  return { h, log, history, doc: () => doc, set: (d: DesignDocument) => (doc = d), run: (id: string, action: Parameters<Menu["chooseEntry"]>[2], editing: string | null = null) => m.chooseEntry(h, id, action, editing) };
}

const json = (d: DesignDocument) => JSON.stringify(d);

test("hand-worked: the menu of each item of the box, Sketch 1 and Extrude 1, with nothing suppressed and no marker", () => {
  const d = part();
  // Every item builds and the marker stands after Extrude 1 (place 3).
  // Box: the marker after it rolls back Sketch 1 and Extrude 1 and leaves
  // the box, a body; suppressing the box leaves Extrude 1, a body.
  assert.deepEqual(menu.menuEntries(d, "feature-1"), [
    { action: "marker", label: "Move the marker here", off: null },
    { action: "suppress", label: "Suppress", off: null },
    { action: "delete", label: "Delete", off: null },
  ]);
  // Sketch 1 suppressed: Extrude 1 fails (its sketch is suppressed), the box still builds.
  assert.equal(menu.menuEntries(d, "sketch-2")[1].off, null);
  // Extrude 1: the marker is already just after it.
  assert.equal(menu.menuEntries(d, "feature-11")[0].off, "The marker is already here");
});

test("hand-worked: with the box suppressed, an edit that leaves nothing built is off with the reason, the rest stay on", () => {
  const d = suppressItem(part(), "feature-1", true);
  // Extrude 1 is the only body. Suppressing it, suppressing Sketch 1 (it
  // fails) or the marker after Sketch 1 (it is rolled back) leaves none.
  const off = (id: string, action: string) => menu.menuEntries(d, id).find((e) => e.action === action)!.off;
  assert.equal(off("feature-11", "suppress"), menu.NO_BODY);
  assert.equal(off("sketch-2", "suppress"), menu.NO_BODY);
  assert.equal(off("sketch-2", "marker"), menu.NO_BODY);
  // The marker after the suppressed box: it builds nothing and Extrude 1 is rolled back.
  assert.equal(off("feature-1", "marker"), menu.NO_BODY);
  // Unsuppressing the box brings a second body: on.
  assert.deepEqual(menu.menuEntries(d, "feature-1")[1], { action: "unsuppress", label: "Unsuppress", off: null });
  // Delete is judged when chosen (below), never here.
  assert.equal(off("feature-11", "delete"), null);
});

test("leavesNoBody: true only when no solid feature builds", () => {
  const d = part();
  assert.equal(menu.leavesNoBody(d), false);
  assert.equal(menu.leavesNoBody(moveMarker(d, "start")), true);
  assert.equal(menu.leavesNoBody(moveMarker(d, "feature-1")), false);
  assert.equal(menu.leavesNoBody(suppressItem(suppressItem(d, "feature-1", true), "feature-11", true)), true);
  // A suppressed sketch fails its extrude: with the box suppressed too, nothing builds.
  assert.equal(menu.leavesNoBody(suppressItem(suppressItem(d, "feature-1", true), "sketch-2", true)), true);
});

/** The designs every entry is tried on: no marker, the marker after Sketch 1, the box suppressed, an unused Sketch 2 last, the marker at the start of a design with a box after it isn't possible (nothing built), so the marker on the box. */
const DESIGNS: [string, () => DesignDocument][] = [
  ["no marker", part],
  ["marker after Sketch 1", () => moveMarker(part(), "sketch-2")],
  ["marker after the box", () => moveMarker(part(), "feature-1")],
  ["box suppressed", () => suppressItem(part(), "feature-1", true)],
  ["Sketch 1 suppressed", () => suppressItem(part(), "sketch-2", true)],
  ["unused Sketch 2 last", withSketch2],
];
const ACTIONS = ["marker", "suppress", "unsuppress", "delete"] as const;

/** Runs every entry of every item of every design through `m`, confirming every ask; the first broken rule, or null. */
async function everyEntry(m: Menu): Promise<string | null> {
  for (const [name, make] of DESIGNS) {
    for (const closed of [true, false]) {
      const ids = make().timeline.features.map((f) => f.id);
      for (const id of ids) {
        for (const action of ACTIONS) {
          const t = host(m, make(), closed);
          const before = json(t.doc());
          const where = `${name}, outlines ${closed ? "closed" : "open"}, ${action} on ${id}`;
          const entry = menu.menuEntries(t.doc(), id).find((e) => e.action === action);
          await t.run(id, action);
          t.log.confirm?.();
          const after = json(t.doc());
          if (!entry) {
            if (t.log.records.length > 0) return `${where}: recorded an entry the menu doesn't offer`;
            continue;
          }
          if (entry.off !== null) {
            if (t.log.records.length > 0 || after !== before) return `${where}: an off entry recorded ${t.log.records.join(", ")}`;
            if (t.log.refused[0] !== entry.off) return `${where}: refused with "${t.log.refused[0]}", not its words "${entry.off}"`;
            continue;
          }
          if (after === before) {
            if (t.log.records.length > 0) return `${where}: recorded a step that changed nothing`;
            continue;
          }
          if (menu.leavesNoBody(t.doc())) return `${where}: recorded a design with no body`;
          const used = make().timeline.features.some((f) => f.dependsOn.includes(id));
          if (action === "delete" && (t.log.asked.length > 0) !== used) return `${where}: ${used ? "a used item deleted without asking" : "asked for an unused item"}`;
          if (t.history.undo() === null || json(t.doc()) !== before) return `${where}: one Undo did not give back the document before (${t.log.records.length} records)`;
          if (t.history.redo() === null || json(t.doc()) !== after) return `${where}: one Redo did not give back the document after`;
        }
      }
    }
  }
  return null;
}

test("every entry of every item on six designs: refused with its words, or exactly one undo step; a delete asks exactly when something is built from the item", async () => {
  assert.equal(await everyEntry(menu), null);
});

test("hand-worked: deleting Extrude 1, built from by nothing, goes at once as one step; deleting Sketch 1 asks first, then keeps the rectangle for Extrude 1", async () => {
  const t = host(menu, part());
  await t.run("feature-11", "delete");
  assert.deepEqual(t.log.records, ["Delete Extrude 1"]);
  assert.deepEqual(t.log.asked, []);
  assert.deepEqual(t.doc().timeline.features.map((f) => f.id), ["feature-1", "sketch-2"]);

  const u = host(menu, part());
  const before = u.doc();
  await u.run("sketch-2", "delete");
  // Asked, nothing recorded until the box's Delete.
  assert.deepEqual(u.log.records, []);
  assert.equal(u.doc(), before);
  assert.deepEqual(u.log.asked, [{ heading: "Delete Sketch 1?", words: "Extrude 1 is built from Sketch 1. If you delete it, Extrude 1 keeps its last shape and shows a warning. Undo brings Sketch 1 back." }]);
  u.log.confirm!();
  assert.deepEqual(u.log.records, ["Delete Sketch 1"]);
  // The rectangle's points and curves kept for Extrude 1, as settleKept keeps them.
  assert.deepEqual(u.doc().kept, { "feature-11": { points: before.sketches[0].points, curves: before.sketches[0].curves } });
  assert.deepEqual(u.doc().timeline.features.map((f) => f.id), ["feature-1", "feature-11"]);
});

test("hand-worked: deleting Sketch 1 with the box suppressed and an outline that never closed would leave no body: refused, nothing asked", async () => {
  const t = host(menu, suppressItem(part(), "feature-1", true), false);
  await t.run("sketch-2", "delete");
  assert.deepEqual(t.log.refused, [menu.NO_BODY]);
  assert.deepEqual(t.log.asked, []);
  assert.deepEqual(t.log.records, []);
  // The same with the outline closed: Extrude 1 keeps its shape, a body, so it asks.
  const u = host(menu, suppressItem(part(), "feature-1", true), true);
  await u.run("sketch-2", "delete");
  assert.equal(u.log.asked.length, 1);
});

test("the design changing while the box asks: its Delete records nothing", async () => {
  const t = host(menu, part());
  await t.run("sketch-2", "delete");
  t.set(suppressItem(t.doc(), "feature-1", true));
  const now = t.doc();
  t.log.confirm!();
  assert.deepEqual(t.log.records, []);
  assert.equal(t.doc(), now);
});

test("while Sketch 1 is edited its own Suppress and Delete are refused with the menu's words, and the marker can't go before it", async () => {
  const t = host(menu, part());
  for (const action of ["suppress", "delete"] as const) await t.run("sketch-2", action, "sketch-2");
  await t.run("feature-1", "marker", "sketch-2");
  assert.deepEqual(t.log.refused, [
    "Sketch 1 is being edited: finish the sketch first",
    "Sketch 1 is being edited: finish the sketch first",
    "The marker can't go before Sketch 1 while it is being edited: finish the sketch first",
  ]);
  assert.deepEqual(t.log.records, []);
  // Other items' edits still go: Extrude 1 suppressed, one step.
  await t.run("feature-11", "suppress", "sketch-2");
  assert.deepEqual(t.log.records, ["Suppress Extrude 1"]);
});

// Bugs planted in timeline-menu.ts, one at a time, each caught by everyEntry
// with the words recorded for it. Each plant is an edit of the real source
// loaded as a copy from a temporary folder (its imports pointed back at
// src/), so src/ is never touched.
const SOURCE = new URL("../src/timeline-menu.ts", import.meta.url);
const MENU_PLANTS: { name: string; edits: [string, string][]; caught: string }[] = [
  {
    // Suppress done as two edits: the marker moved onto the item, then the item suppressed, each recorded.
    name: "suppress-two-steps",
    edits: [
      ['import { barEdit, itemMenu, type MenuEntry } from "./timeline-bar.ts";', 'import { barEdit, itemMenu, type MenuEntry } from "./timeline-bar.ts";\nimport { moveMarker, suppressItem } from "./timeline-edits.ts";'],
      ['  if (r.kind === "edit") return host.record(r.step, r.doc);', '  if (r.kind === "edit" && action === "suppress") return (host.record(r.step, moveMarker(before, id)), host.record(r.step, suppressItem(before, id, true)));\n  if (r.kind === "edit") return host.record(r.step, r.doc);'],
    ],
    caught: "one Undo did not give back the document before (2 records)",
  },
  { name: "delete-never-asks", edits: [["  if (plan.ask) host.ask(plan.ask, go);", "  if (plan.ask && false) host.ask(plan.ask, go);"]], caught: "a used item deleted without asking" },
  { name: "no-body-delete", edits: [["  if (leavesNoBody(plan.next)) return host.refuse(NO_BODY);", ""]], caught: "recorded a design with no body" },
  { name: "off-entry-run", edits: [["  if (entry?.off) return host.refuse(entry.off);", ""]], caught: "an off entry recorded" },
  { name: "no-body-entries-on", edits: [["return r.kind === \"edit\" && leavesNoBody(r.doc) ? { ...e, off: NO_BODY } : e;", "return e;"]], caught: "an off entry recorded" },
];

async function planted(edits: [string, string][], dir: string, name: string): Promise<Menu> {
  let text = readFileSync(SOURCE, "utf8");
  for (const [find, replace] of edits) {
    const at = text.indexOf(find);
    assert.ok(at >= 0 && text.indexOf(find, at + 1) < 0, `${name}: the text to replace must be in timeline-menu.ts exactly once: ${find}`);
    text = text.slice(0, at) + replace + text.slice(at + find.length);
  }
  const file = join(dir, `timeline-menu-${name}.ts`);
  writeFileSync(file, text.replace(/from "\.\/([^"]+)"/g, (_, f) => `from "${new URL(f, SOURCE).href}"`));
  return import(pathToFileURL(file).href);
}

test("each bug planted in the menu's wiring is caught, by the check recorded for it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "timeline-menu-planted-"));
  try {
    // The copy unplanted passes, so each catch is the plant's.
    assert.equal(await everyEntry(await planted([], dir, "none")), null);
    for (const p of MENU_PLANTS) {
      const caught = await everyEntry(await planted(p.edits, dir, p.name));
      assert.ok(caught !== null, `${p.name} was not caught`);
      assert.ok(caught.includes(p.caught), `${p.name} was caught by another check than "${p.caught}": ${caught}`);
      if (process.env.FISSION_PLANTED_REPORT) console.log(`${p.name}: ${caught}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deleteItem's document and the recorded one differ only by the kept shapes (the delete records planDelete's settled document)", async () => {
  const t = host(menu, part());
  await t.run("sketch-2", "delete");
  t.log.confirm!();
  const { kept, ...rest } = t.doc();
  assert.ok(kept);
  assert.deepEqual(rest, deleteItem(part(), "sketch-2"));
});

// The bar's items wired (showTimelineBar's BarWiring), in a real DOM (happy-dom stands in for the browser).
const { Window } = await import("happy-dom");
const { showTimelineBar } = await import("../src/timeline-bar.ts");

function barIn(doc: DesignDocument, wiring: Parameters<typeof showTimelineBar>[2]) {
  const window = new Window({ width: 1280, height: 800 });
  const slot = window.document.createElement("div") as unknown as HTMLElement;
  window.document.body.append(slot as never);
  showTimelineBar(slot, doc, wiring);
  return { slot, window };
}

test("the bar: a right-click on an item opens its menu at the pointer; a click picks it; the picked item alone shows its ⋯, which opens the menu by it", () => {
  const calls: string[] = [];
  const wiring = { onPick: (id: string) => calls.push(`pick ${id}`), onMenu: (id: string, at: { x: number; y: number }) => calls.push(`menu ${id} ${at.x},${at.y}`) };
  const { slot, window } = barIn(part(), { ...wiring, picked: "feature-11" });
  const item = (id: string) => slot.querySelector(`[data-item="${id}"]`) as HTMLElement;
  item("sketch-2").dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 300, clientY: 780 }) as unknown as Event);
  item("feature-1").click();
  // Only the picked item has a ⋯, straight after it (before the marker, which stands after the last item).
  assert.deepEqual([...slot.querySelectorAll("[data-more]")].map((b) => (b as HTMLElement).dataset.more), ["feature-11"]);
  assert.deepEqual([...slot.querySelectorAll(".timeline-bar > li")].map((li) => (li as HTMLElement).dataset.item ?? li.className), ["feature-1", "sketch-2", "feature-11", "timeline-bar-more-slot", "timeline-bar-marker"]);
  (slot.querySelector('[data-more="feature-11"]') as HTMLElement).click();
  // happy-dom lays nothing out: the ⋯'s rectangle is at (0, 0).
  assert.deepEqual(calls, ["menu sketch-2 300,780", "pick feature-1", "menu feature-11 0,0"]);
  // A right-click is never the page's own menu.
  const e = new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 });
  item("feature-1").dispatchEvent(e as unknown as Event);
  assert.equal(e.defaultPrevented, true);
});

test("the bar: an item the rebuild failed, and one built from a suppressed sketch, are marked failed and say so", () => {
  // Hand-worked: with Sketch 1 suppressed, Extrude 1 can't build (`builds`); with the failed set naming the box, the box is red too.
  const { slot } = barIn(suppressItem(part(), "sketch-2", true), { failed: new Set(["feature-1"]) });
  const flags = [...slot.querySelectorAll("[data-item]")].map((li) => [(li as HTMLElement).dataset.item, (li as HTMLElement).dataset.failed ?? "", (li as HTMLElement).title]);
  assert.deepEqual(flags, [
    ["feature-1", "true", "1. Box: 40 × 30 × 20 mm (failed)"],
    ["sketch-2", "", "2. Sketch 1 on the XY plane (suppressed)"],
    ["feature-11", "true", "3. Extrude Sketch 1 by 10 mm (failed)"],
  ]);
  // No picked item: no ⋯ anywhere.
  assert.equal(slot.querySelector("[data-more]"), null);
});
