// Step 24f3: the timeline's item menu wired (timeline-menu.ts), checked
// with core's real undo history: every entry of every item, on designs
// with and without a marker and a suppressed item, is refused with its
// words or recorded as exactly one undo step (one Undo gives back the
// document before it, byte for byte, one Redo the one after); a delete
// asks first exactly when something is built from the item; what is
// recorded is the edit's own document. From 24f4 an edit that leaves no
// body is on like any other (the app shows a design with no body). Bugs
// planted in the wiring (test plan point 3, "suppress recorded as two undo
// steps" among them) are each caught.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHistory, type KernelCalls } from "@fission/core";
import { partDocument, partFeature, type DesignDocument } from "../src/document.ts";
import { addSketch, drawRectangle } from "../src/sketch.ts";
import { extrudeSketch } from "../src/extrude.ts";
import { deleteItem, moveMarker, suppressItem } from "../src/timeline-edits.ts";
import * as menu from "../src/timeline-menu.ts";
import { planDelete, type DeleteQuestion } from "../src/delete-ask.ts";
import { barEdit, itemMenu } from "../src/timeline-bar.ts";

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

test("hand-worked (24f4): with the box suppressed, the edits that leave no body are on, and each records one step whose design has no body", async () => {
  const d = suppressItem(part(), "feature-1", true);
  // Extrude 1 is the only body. Suppressing it, suppressing Sketch 1 (its
  // extrude then fails), the marker after Sketch 1 (Extrude 1 rolled back)
  // or after the suppressed box (it builds nothing, Extrude 1 rolled back)
  // each leaves none. Until 24f4 these four were off; now every one is on.
  const leaving: [string, "suppress" | "marker", string][] = [
    ["feature-11", "suppress", "Suppress Extrude 1"],
    ["sketch-2", "suppress", "Suppress Sketch 1"],
    ["sketch-2", "marker", "Move the rollback marker"],
    ["feature-1", "marker", "Move the rollback marker"],
  ];
  for (const [id, action, step] of leaving) {
    assert.equal(menu.menuEntries(d, id).find((e) => e.action === action)!.off, null, `${action} on ${id}`);
    const t = host(menu, d);
    await t.run(id, action);
    assert.deepEqual(t.log.records, [step]);
    assert.deepEqual(t.log.refused, []);
    assert.equal(partFeature(t.doc()), null, `${step} leaves no body`);
    // One Undo gives the body back.
    t.history.undo();
    assert.equal(partFeature(t.doc())?.id, "feature-11");
  }
  // Unsuppressing the box brings a second body: on, as always.
  assert.deepEqual(menu.menuEntries(d, "feature-1")[1], { action: "unsuppress", label: "Unsuppress", off: null });
});

/** The designs every entry is tried on: no marker, the marker after Sketch 1 or the box or at the start (nothing built, 24f4), the box suppressed, Sketch 1 suppressed, both solids suppressed (nothing built), an unused Sketch 2 last, and only sketches left. */
const DESIGNS: [string, () => DesignDocument][] = [
  ["no marker", part],
  ["marker after Sketch 1", () => moveMarker(part(), "sketch-2")],
  ["marker after the box", () => moveMarker(part(), "feature-1")],
  ["marker at the start", () => moveMarker(part(), "start")],
  ["box suppressed", () => suppressItem(part(), "feature-1", true)],
  ["Sketch 1 suppressed", () => suppressItem(part(), "sketch-2", true)],
  ["both solids suppressed", () => suppressItem(suppressItem(part(), "feature-1", true), "feature-11", true)],
  ["unused Sketch 2 last", withSketch2],
  ["only sketches left", () => deleteItem(deleteItem(withSketch2(), "feature-11"), "feature-1")],
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
          const entry = m.menuEntries(t.doc(), id).find((e) => e.action === action);
          await t.run(id, action);
          t.log.confirm?.();
          const after = json(t.doc());
          if (!entry) {
            if (t.log.records.length > 0) return `${where}: recorded an entry the menu doesn't offer`;
            continue;
          }
          // An entry is off only for the bar's own reasons (24f2's itemMenu): never for leaving no body (24f4).
          const own = itemMenu(make(), id, null).find((e) => e.action === action)?.off ?? null;
          if (entry.off !== own) return `${where}: off with "${entry.off}", which the bar's menu doesn't say`;
          if (entry.off !== null) {
            if (t.log.records.length > 0 || after !== before) return `${where}: an off entry recorded ${t.log.records.join(", ")}`;
            if (t.log.refused[0] !== entry.off) return `${where}: refused with "${t.log.refused[0]}", not its words "${entry.off}"`;
            continue;
          }
          // What the edit makes: barEdit's document, or for a delete planDelete's settled one (the same before as the menu used).
          const r = barEdit(make(), { kind: "menu", id, action }, null);
          const want = action === "delete" ? json((await planDelete(kernel(closed), make(), id)).next) : r.kind === "edit" ? json(r.doc) : before;
          if (r.kind === "refused") {
            if (t.log.records.length > 0 || t.log.refused[0] !== r.message) return `${where}: a refused edit went "${t.log.refused[0]}" with ${t.log.records.length} records`;
            continue;
          }
          if (after !== want) return `${where}: did not record the edit's document (${t.log.records.length} records${t.log.refused.length ? `, refused "${t.log.refused[0]}"` : ""})`;
          if (after === before) {
            if (t.log.records.length > 0) return `${where}: recorded a step that changed nothing`;
            continue;
          }
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

test("every entry of every item on nine designs: refused with its words, or exactly one undo step; a delete asks exactly when something is built from the item", async () => {
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

test("hand-worked (24f4): deleting Sketch 1 with the box suppressed and an outline that never closed leaves no body: asked, then one step", async () => {
  // Extrude 1 is built from Sketch 1, so the box asks; the outline never
  // closed, so there is no last shape to keep and Extrude 1 fails: no body.
  // Until 24f4 this was refused without asking.
  const t = host(menu, suppressItem(part(), "feature-1", true), false);
  await t.run("sketch-2", "delete");
  assert.deepEqual(t.log.refused, []);
  assert.equal(t.log.asked.length, 1);
  assert.deepEqual(t.log.records, []);
  t.log.confirm!();
  assert.deepEqual(t.log.records, ["Delete Sketch 1"]);
  assert.deepEqual(t.doc().timeline.features.map((f) => f.id), ["feature-1", "feature-11"]);
  assert.equal(partFeature(t.doc()), null);
  // The same with the outline closed: Extrude 1 keeps its shape, a body.
  const u = host(menu, suppressItem(part(), "feature-1", true), true);
  await u.run("sketch-2", "delete");
  u.log.confirm!();
  assert.equal(partFeature(u.doc())?.id, "feature-11");
});

test("hand-worked (24f4): every item deleted one by one, last first, leaves an empty timeline, each delete one step", async () => {
  const t = host(menu, part());
  // Extrude 1 (built from by nothing: at once), Sketch 1 (now built from by nothing), the box.
  for (const id of ["feature-11", "sketch-2", "feature-1"]) await t.run(id, "delete");
  assert.deepEqual(t.log.asked, []);
  assert.deepEqual(t.log.records, ["Delete Extrude 1", "Delete Sketch 1", "Delete Feature 1 (box)"]);
  assert.deepEqual(t.doc().timeline.features, []);
  assert.deepEqual(t.doc().profiles, []);
  assert.deepEqual(t.doc().sketches, []);
  assert.equal(partFeature(t.doc()), null);
  // Three Undos give back the design, byte for byte.
  for (let i = 0; i < 3; i++) t.history.undo();
  assert.equal(json(t.doc()), json(part()));
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
  // "off-entry-run" (chooseEntry's own off check dropped) went with 24f4, and so did the check: every entry still
  // off is one barEdit itself refuses with the same words, so no test could tell it was gone. everyEntry still
  // proves an off entry records nothing and is refused with its words.
  // 24f4's two: the no-body refusals coming back, on a delete and on the menu's entries.
  {
    name: "no-body-delete-refused",
    edits: [["  if (host.current() !== before) return;\n", '  if (host.current() !== before) return;\n  if (!plan.next.timeline.features.some((f) => f.intent.type !== "sketch" && !f.suppressed && plan.next.timeline.marker !== "start")) return host.refuse("no body");\n']],
    caught: "did not record the edit's document",
  },
  {
    name: "no-body-entries-off",
    edits: [["  return itemMenu(doc, id, editing);", '  return itemMenu(doc, id, editing).map((e) => (e.off === null && e.action !== "delete" && ((r) => r.kind === "edit" && r.doc.timeline.marker === "start")(barEdit(doc, { kind: "menu", id, action: e.action }, editing)) ? { ...e, off: "no body" } : e));']],
    caught: "which the bar's menu doesn't say",
  },
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
