// Journey: Edit Sketch (step 25a3) in the real Design workspace on the real
// WASM kernel. The workspace is mounted as the app mounts it, in a real DOM
// (happy-dom), on one undo history that puts snapshots back by mounting it
// afresh (the shell's way); the viewport is a stand-in that keeps the last
// mesh it was asked to draw, whose volume is worked out here from its
// triangles (the divergence theorem: a sixth of the sum of a · (b × c) over
// each outward triangle), never from the kernel's own number. A sketch is
// opened again from its menu or by a double-click (the timeline bar's
// items, the browser's rows), drawn in with clicks on the view, and
// finished; Finish Sketch rebuilds everything after it, and nothing is
// rebuilt part way through drawing (the reference app's way). The owner's
// rule: an outline broken by the edit gives no question, the extrude keeps
// its last shape, and the warning shows after Finish Sketch, not while that
// sketch is open. Hand-worked volumes, then seeded sessions against a plain
// model, then bugs planted in the workspace, each caught. Run with
// `npm run journeys`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync, readFileSync, writeFileSync } from "node:fs";
import { ActionRegistry, ChangeNotes, createHistory, createSelection, DependencyGraph, DownstreamRegistry, emptyProject, projectFromJson, projectToJson, RepresentationRegistry, type DisplayMesh, type KernelCalls, type MountedWorkspace, type SharedViewport, type SketchPointer, type WorkspaceContext, type WorkspacePlugin } from "@fission/core";
import { addSketch, deleteCurve, designWorkspace, drawRectangle, extrudeSketch, insertPreset, movePoint, partDocument, settleKept, type DesignDocument } from "@fission/design";
import { nodeKernel } from "../src/node-kernel.ts";

const kernel = nodeKernel();
const { Window } = await import("happy-dom");

/** The volume inside a closed mesh, from its triangles: Σ a · (b × c) / 6 (each body's triangles face outward, so bodies side by side add up). */
export function meshVolume(mesh: DisplayMesh): number {
  const p = mesh.positions;
  const at = (i: number) => [p[3 * i], p[3 * i + 1], p[3 * i + 2]];
  let six = 0;
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const [a, b, c] = [at(mesh.indices[t]), at(mesh.indices[t + 1]), at(mesh.indices[t + 2])];
    six += a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
  }
  return six / 6;
}

/** Equal to a millionth: the kernel's meshes of flat-sided bodies are exact up to rounding. */
const close = (got: number, want: number) => Math.abs(got - want) <= 1e-6 * Math.max(1, Math.abs(want));

/**
 * The app around Design, as the shell runs it: slots in a real DOM, one
 * undo history over the project as JSON whose restore mounts the
 * workspace afresh, a viewport that keeps the last mesh, and a kernel that
 * counts its body_build calls. `plugin` is Design, or a planted copy.
 */
/** The app last made, put away before the next is made: a test that failed part way leaves it mounted, and Design keeps the open sketch in its module. */
let previous: { close(): Promise<boolean> } | null = null;

async function app(start: DesignDocument, plugin: WorkspacePlugin = designWorkspace) {
  await previous?.close();
  const window = new Window({ width: 1280, height: 800 });
  const document = window.document as unknown as Document;
  const slot = () => {
    const el = document.createElement("div") as HTMLElement;
    document.body.append(el);
    return el;
  };
  let mesh: DisplayMesh | null = null;
  let builds = 0;
  const counted: KernelCalls = {
    call: ((op: string, ...args: unknown[]) => {
      if (op === "body_build") builds++;
      return (kernel.call as (op: string, ...a: unknown[]) => Promise<unknown>)(op, ...args);
    }) as KernelCalls["call"],
  };
  const element = slot();
  const viewport: SharedViewport = {
    element,
    showBody: (m) => void (mesh = m),
    bodyFraming: () => ({ centre: [0, 0, 0], radius: 0 }),
    fit: () => null,
    setView: () => null,
    fitSelection: () => null,
    lookAt: () => null,
    setOverlay() {},
    clearOverlay() {},
    showSelection() {},
    onPick: null,
    onSketchPointer: null,
    showImage() {},
    clearImage() {},
    showSketches() {},
    showPlanes() {},
  };
  let view: MountedWorkspace;
  let mounting = false;
  const mount = () => {
    mounting = true;
    try {
      view = plugin.mount(ctx);
    } finally {
      mounting = false;
    }
  };
  const ctx: WorkspaceContext = {
    project: { ...emptyProject("Edit Sketch"), workspaces: { design: start } },
    projectChanged(label = "Edit", mergeKey) {
      if (!mounting) history.record(label, mergeKey);
    },
    kernel: counted,
    selection: createSelection(),
    history: undefined as never,
    graph: new DependencyGraph(),
    toolbar: slot(),
    browser: slot(),
    properties: slot(),
    timeline: slot(),
    viewport,
    representations: new RepresentationRegistry(),
    actions: new ActionRegistry(),
    downstream: new DownstreamRegistry(),
    changeNotes: new ChangeNotes(),
    openWorkspace() {},
    workspaceTitle: (id) => id,
  };
  // The shell's restore: the snapshot read like an opened file, the workspace mounted afresh on it.
  const history = createHistory({
    capture: () => projectToJson(ctx.project),
    restore(text) {
      ctx.project = projectFromJson(text, [plugin]);
      view.unmount();
      mount();
    },
  });
  ctx.history = history;
  const startBodies = (await kernel.call("body_count")) as number;
  mount();
  const $ = (sel: string) => document.querySelector(sel) as HTMLElement | null;
  /** Every reply the kernel owes, and every rebuild, finished. */
  const settle = async () => {
    for (let i = 0; i < 40 || element.dataset.rebuilding === "true"; i++) await new Promise((r) => setImmediate(r));
  };
  await settle();
  const a = {
    history,
    window,
    $,
    settle,
    doc: () => ctx.project.workspaces.design as DesignDocument,
    volume: () => (mesh ? meshVolume(mesh) : 0),
    builds: () => builds,
    /** The sketch bar's Finish Sketch is on screen: a sketch is open. */
    sketching: () => $("#finish-sketch") !== null && $("#finish-sketch")!.closest("[hidden]") === null,
    warning: () => ($("#kept-warning")!.hidden ? null : $("#kept-warning")!.textContent),
    error: () => $("#error")!.textContent,
    /** Item `id`'s menu by a right-click on its bar item, then an entry. */
    async menu(id: string, entry: string) {
      $(`[data-item="${id}"]`)!.dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 300, clientY: 780 }) as unknown as Event);
      const button = $(`#row-menu-${entry}`) as HTMLButtonElement;
      assert.ok(button, `the menu has ${entry}`);
      // An off entry is greyed (disabled): a click on it does nothing, as in a browser.
      if (button.disabled) {
        $("#row-menu")!.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as Event);
        (button.closest("dialog") as HTMLDialogElement | null)?.close();
        return button.title;
      }
      button.click();
      await settle();
      return null;
    },
    /** A double-click on bar item `id` (two clicks 100 ms apart, the bar drawn again between them as a pick does). */
    async doubleClick(id: string) {
      for (const t of [1000, 1100]) {
        const e = new window.MouseEvent("click", { bubbles: true, cancelable: true });
        Object.defineProperty(e, "timeStamp", { value: t + doubleClicks * 10000 });
        $(`[data-item="${id}"]`)!.dispatchEvent(e as unknown as Event);
      }
      doubleClicks++;
      await settle();
    },
    /** A double-click on the browser's row `node` (its own dblclick event: rows are not redrawn by a click). */
    async rowDoubleClick(node: string) {
      const row = [...document.querySelectorAll<HTMLElement>(".tree-row")].find((r) => r.dataset.node === node);
      assert.ok(row, `a browser row ${node}`);
      row.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }) as unknown as Event);
      await settle();
    },
    /** A click on the view at sketch point (x, y), a pixel 0.1 mm wide (snaps reach 1 mm). */
    async click(x: number, y: number) {
      const pointer: SketchPointer = { kind: "click", at: [x, y], pixel: 0.1 };
      viewport.onSketchPointer?.(pointer);
      await settle();
    },
    async key(id: string) {
      view.shortcut?.(id);
      await settle();
    },
    /** Another workspace shown, then Design again (X7: asleep, then woken). */
    async away() {
      view.sleep?.();
      await settle();
      view.wake?.();
      await settle();
    },
    async finish() {
      $("#finish-sketch")!.click();
      await settle();
    },
    async undo() {
      const label = history.undo();
      await settle();
      return label;
    },
    async redo() {
      const label = history.redo();
      await settle();
      return label;
    },
    /** Puts Design away (as a page closed) and says whether every body it kept was freed. */
    async close() {
      if (previous === a) previous = null;
      view.unmount();
      await settle();
      return ((await kernel.call("body_count")) as number) === startBodies;
    },
  };
  let doubleClicks = 0;
  previous = a;
  return a;
}

/**
 * A box (feature-1, 10 × 10 × 10 = 1000 mm³), then per entry of `sketches`
 * a sketch (Sketch i+1) with a rectangle `width` × 30 from (100·i, 0),
 * extruded by `distance` (Extrude i+1); with `open` given, its left side
 * is deleted and its right corners moved to x = 100·i + `open`, so the
 * outline is a ⊐ of that width, open on the left, and the extrude keeps
 * the rectangle it was built from (settleKept on the real kernel). Then a
 * second box after them all (4 × 5 × 6 = 120 mm³; a box, since a
 * cylinder's mesh is faceted and holds a little less than its volume), so
 * there is an item after every sketch to rebuild.
 */
async function design(sketches: { width: number; distance: number; open?: number }[]) {
  let doc = partDocument("box", 10, 10, 10);
  const ids: { sketch: string; extrude: string; left: string; right: [string, string] }[] = [];
  for (const [i, s] of sketches.entries()) {
    const made = addSketch(doc);
    const x0 = 100 * i;
    const rect = drawRectangle(made.doc, made.id, [x0, 0], [x0 + s.width, 30]);
    const ex = extrudeSketch(rect.doc, made.id, s.distance);
    doc = ex.doc;
    const sketch = doc.sketches.find((k) => k.id === made.id)!;
    const at = (x: number, y: number) => sketch.points.find((p) => p.x === x && p.y === y)!.id;
    // The rectangle's lines run (x0,0)→(x1,0)→(x1,30)→(x0,30)→(x0,0): the last is the left side.
    const left = rect.ids[3];
    const right: [string, string] = [at(x0 + s.width, 0), at(x0 + s.width, 30)];
    if (s.open !== undefined) {
      const opened = await settleKept(kernel, doc, deleteCurve(doc, made.id, left));
      doc = await settleKept(kernel, opened, movePoint(movePoint(opened, made.id, right[0], x0 + s.open, 0), made.id, right[1], x0 + s.open, 30));
    }
    ids.push({ sketch: made.id, extrude: ex.id, left, right });
  }
  doc = insertPreset(doc, "box", 4, 5, 6).doc;
  return { doc, ids };
}

const BOX = 1000;
const LAST = 120; // the box after every sketch, 4 · 5 · 6

test("hand-worked: a ⊐ 60 wide whose extrude keeps its 40 × 30 rectangle is closed through Edit Sketch; Finish Sketch rebuilds it to 60 × 30 × 20 = 36000 mm³, and only it", async () => {
  // Sketch 1 was a 40 × 30 rectangle extruded by 20 (40 · 30 · 20 = 24000
  // mm³); its left side was deleted and its right side moved out to x = 60,
  // so it is open and Extrude 1 keeps the 40 × 30 rectangle, with the
  // warning. With the box (1000) and the last box (120) the view holds
  // 1000 + 24000 + 120.
  const { doc, ids } = await design([{ width: 40, distance: 20, open: 60 }]);
  const a = await app(doc);
  assert.ok(close(a.volume(), BOX + 24000 + LAST), `${a.volume()}`);
  assert.match(a.warning() ?? "", /^Extrude 1 keeps its last shape\. Sketch 1 has no closed outline/);
  assert.equal(a.error(), "");

  // Edit Sketch from Sketch 1's menu on the bar: it opens, nothing is recorded, nothing rebuilt, and its warning waits for Finish Sketch.
  const builds = a.builds();
  assert.equal(await a.menu(ids[0].sketch, "edit-sketch"), null);
  assert.equal(a.sketching(), true);
  assert.equal(a.history.canUndo(), false, "opening a sketch records nothing");
  assert.equal(a.warning(), null, "no warning while Sketch 1 is open");
  assert.equal(a.builds(), builds);

  // The left side drawn: a click on the ⊐'s top-left end (0, 30), then on its bottom-left end (0, 0), which closes it (60 × 30).
  await a.click(0, 30);
  await a.click(0, 0);
  assert.equal(a.history.undoLabel(), "Draw line", "one undo step for the line");
  // Still open and nothing rebuilt: the view keeps the old rectangle, no warning while drawing.
  assert.ok(close(a.volume(), BOX + 24000 + LAST), `while drawing ${a.volume()}`);
  assert.equal(a.builds(), builds);
  assert.equal(a.warning(), null);

  // Finish Sketch: Extrude 1 rebuilt from the 60 × 30 outline (60 · 30 · 20 = 36000), the warning gone; the two boxes reused, so one body built.
  await a.finish();
  assert.equal(a.sketching(), false);
  assert.ok(close(a.volume(), BOX + 36000 + LAST), `after Finish ${a.volume()}`);
  assert.equal(a.warning(), null);
  assert.equal(a.builds() - builds, 1, "only Extrude 1 was built again");
  assert.equal(a.history.undoLabel(), "Draw line", "Finish Sketch records nothing");

  // Undo takes the line back: the ⊐ again, Extrude 1 back to its kept rectangle with the warning. Redo: 36000 again.
  assert.equal(await a.undo(), "Draw line");
  assert.ok(close(a.volume(), BOX + 24000 + LAST), `undone ${a.volume()}`);
  assert.match(a.warning() ?? "", /^Extrude 1 keeps its last shape/);
  assert.equal(await a.redo(), "Draw line");
  assert.ok(close(a.volume(), BOX + 36000 + LAST), `redone ${a.volume()}`);
  assert.equal(a.warning(), null);
  assert.ok(await a.close(), "every body freed");
});

test("hand-worked: a stray line breaks a closed 40 × 30 outline through Edit Sketch: no question, no warning until Finish Sketch, then Extrude 1 keeps its shape with it", async () => {
  // Sketch 1: a closed 40 × 30 rectangle extruded by 20 = 24000 mm³.
  const { doc, ids } = await design([{ width: 40, distance: 20 }]);
  const a = await app(doc);
  assert.ok(close(a.volume(), BOX + 24000 + LAST));
  assert.equal(a.warning(), null);
  // Opened by a double-click on its bar item.
  await a.doubleClick(ids[0].sketch);
  assert.equal(a.sketching(), true);
  // A line from (10, 60) to (30, 60), apart from the rectangle: a loose end, so the outline no longer closes. Escape ends the chain.
  await a.click(10, 60);
  await a.click(30, 60);
  await a.key("clear-selection");
  assert.equal(a.warning(), null, "no warning while drawing (the owner's rule)");
  assert.equal(a.window.document.querySelector("dialog[open]"), null, "nothing asks");
  assert.equal(a.doc().kept?.[ids[0].extrude] !== undefined, true, "the rectangle kept in the same step as the line");
  // Finish: the warning names the loose end; the shape is the rectangle still (24000).
  await a.finish();
  assert.match(a.warning() ?? "", /^Extrude 1 keeps its last shape\. Sketch 1 has no closed outline/);
  assert.ok(close(a.volume(), BOX + 24000 + LAST));
  // Opened again from the browser's Sketches row: the warning hides while it is open, and is back after Finish with nothing drawn.
  await a.rowDoubleClick(`sketches/${ids[0].sketch}`);
  assert.equal(a.sketching(), true);
  assert.equal(a.warning(), null);
  await a.finish();
  assert.match(a.warning() ?? "", /^Extrude 1 keeps its last shape/);
  assert.ok(await a.close());
});

test("hand-worked: Edit Sketch is refused with the menu's words for the sketch already open, a suppressed one and one after the marker; opening another sketch finishes the first and rebuilds it", async () => {
  // Sketch 1 a ⊐ 60 wide keeping 40 × 30 (24000 with distance 20), Sketch 2 a closed 20 × 30 by 10 = 6000.
  const { doc, ids } = await design([{ width: 40, distance: 20, open: 60 }, { width: 20, distance: 10 }]);
  const a = await app(doc);
  assert.ok(close(a.volume(), BOX + 24000 + 6000 + LAST));
  await a.menu(ids[0].sketch, "edit-sketch");
  // Open already: off, with why; nothing changes.
  assert.equal(await a.menu(ids[0].sketch, "edit-sketch"), "Sketch 1 is open: you are editing it");
  assert.equal(a.sketching(), true);
  // Close Sketch 1, then open Sketch 2 by a double-click: Sketch 1 is finished on the way, so Extrude 1 rebuilds to 60 · 30 · 20 = 36000.
  await a.click(0, 30);
  await a.click(0, 0);
  await a.doubleClick(ids[1].sketch);
  assert.equal(a.sketching(), true);
  assert.ok(close(a.volume(), BOX + 36000 + 6000 + LAST), `${a.volume()}`);
  await a.finish();
  // Suppressed: the menu's Suppress on Sketch 2, then Edit Sketch is off.
  await a.menu(ids[1].sketch, "suppress");
  assert.equal(await a.menu(ids[1].sketch, "edit-sketch"), "Sketch 2 is suppressed: unsuppress it first");
  assert.equal(a.sketching(), false);
  // A double-click is refused with the same words, shown as the error line.
  await a.doubleClick(ids[1].sketch);
  assert.equal(a.sketching(), false);
  assert.equal(a.error(), "Sketch 2 is suppressed: unsuppress it first");
  await a.menu(ids[1].sketch, "unsuppress");
  // After the marker: the marker moved just after the box rolls both sketches back.
  await a.menu("feature-1", "marker");
  assert.equal(await a.menu(ids[0].sketch, "edit-sketch"), "Sketch 1 is after the marker: move the marker past it first");
  assert.equal(a.sketching(), false);
  assert.ok(await a.close());
});

test("odd orders: Edit feature, a delete, another workspace and a reload while a sketch with a new line is open each leave it rebuilt", async () => {
  const { doc, ids } = await design([{ width: 40, distance: 20 }]);
  const stray = async (a: Awaited<ReturnType<typeof app>>) => {
    await a.menu(ids[0].sketch, "edit-sketch");
    await a.click(10, 60);
    await a.click(30, 60);
  };
  // Edit feature on Extrude 1 while Sketch 1 is open with a stray line: the sketch is left (rebuilt: the warning shows) and the panel opens.
  const a = await app(doc);
  await stray(a);
  assert.equal(a.warning(), null);
  await a.menu(ids[0].extrude, "edit");
  assert.equal(a.sketching(), false);
  assert.equal(a.$("#feature-edit")!.hidden, false, "the Edit feature panel is open");
  assert.match(a.warning() ?? "", /^Extrude 1 keeps its last shape/);
  assert.ok(close(a.volume(), BOX + 24000 + LAST));
  assert.ok(await a.close());
  // Extrude 1 deleted from its menu while Sketch 1 is open with the line: one step, the sketch left, the box and the last box alone (1120).
  const b = await app(doc);
  await stray(b);
  await b.menu(ids[0].extrude, "delete");
  assert.equal(b.sketching(), false);
  assert.equal(b.history.undoLabel(), "Delete Extrude 1");
  assert.ok(close(b.volume(), BOX + LAST), `${b.volume()}`);
  assert.equal(b.warning(), null);
  // Undo: Extrude 1 back with the warning (its sketch has the line).
  await b.undo();
  assert.ok(close(b.volume(), BOX + 24000 + LAST));
  assert.match(b.warning() ?? "", /^Extrude 1 keeps its last shape/);
  assert.ok(await b.close());
  // Another workspace shown and back while the line is drawn: still open, nothing rebuilt; Finish rebuilds.
  const c = await app(doc);
  await stray(c);
  await c.away();
  assert.equal(c.sketching(), true);
  assert.equal(c.warning(), null);
  await c.finish();
  assert.match(c.warning() ?? "", /^Extrude 1 keeps its last shape/);
  assert.ok(await c.close());
  // A reload while the line is drawn: the line was already an undo step in the project, so the page opens with the sketch closed and Extrude 1 rebuilt (kept, warned).
  const d = await app(doc);
  await stray(d);
  const saved = projectToJson({ ...emptyProject("Edit Sketch"), workspaces: { design: d.doc() } });
  const e = await app(projectFromJson(saved, [designWorkspace]).workspaces.design as DesignDocument);
  assert.equal(e.sketching(), false);
  assert.match(e.warning() ?? "", /^Extrude 1 keeps its last shape/);
  assert.ok(close(e.volume(), BOX + 24000 + LAST), `${e.volume()}`);
  // A fresh page starts with no history: nothing to undo.
  assert.equal(e.history.undoLabel(), null);
  assert.ok(await e.close());
});

// ---- Seeded sessions against a plain model ----

/** A small seeded generator (mulberry32). */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The model: per sketch whether its left side is drawn (`closed`), how many
 * stray lines it holds, and the width of the rectangle its extrude keeps
 * (null when none). Its outline closes when the left side is there and no
 * stray is; the extrude is then its own ⊐'s width `open`, else its kept
 * width with the warning. An edit that breaks a closing outline keeps that
 * outline's width (settleKept); one that closes it forgets the kept shape.
 */
interface SketchState {
  closed: boolean;
  strays: number;
  kept: number | null;
}
interface Spec {
  width: number;
  distance: number;
  open: number;
}
const closes = (s: SketchState) => s.closed && s.strays === 0;

function volumeOf(specs: Spec[], states: SketchState[]): number {
  let v = BOX + LAST;
  states.forEach((s, i) => {
    const w = closes(s) ? specs[i].open : s.kept;
    if (w !== null) v += w * 30 * specs[i].distance;
  });
  return v;
}

/** What `step` does to the model's sketch `i`, as Design's settleKept does. */
function drawn(specs: Spec[], s: SketchState, i: number, what: "close" | "stray"): SketchState {
  const next = what === "close" ? { ...s, closed: true } : { ...s, strays: s.strays + 1 };
  if (closes(next)) return { ...next, kept: null };
  if (closes(s)) return { ...next, kept: specs[i].open };
  return next;
}

type Step = { do: "open"; i: number; how: "menu" | "bar" | "row" } | { do: "close" } | { do: "stray"; x: number; y: number; len: number } | { do: "finish" } | { do: "undo" } | { do: "redo" } | { do: "escape" };

function randomSteps(seed: number, n: number, sketches: number): Step[] {
  const r = rng(seed);
  const steps: Step[] = [];
  for (let k = 0; k < n; k++) {
    const u = r();
    if (u < 0.2) steps.push({ do: "open", i: Math.floor(r() * sketches), how: (["menu", "bar", "row"] as const)[Math.floor(r() * 3)] });
    else if (u < 0.35) steps.push({ do: "close" });
    else if (u < 0.55) steps.push({ do: "stray", x: Math.floor(r() * 35), y: 50 + 5 * Math.floor(r() * 10), len: 3 + Math.floor(r() * 5) });
    else if (u < 0.7) steps.push({ do: "finish" });
    else if (u < 0.82) steps.push({ do: "undo" });
    else if (u < 0.9) steps.push({ do: "redo" });
    else steps.push({ do: "escape" });
  }
  return steps;
}

/** Specs for a session: 2 or 3 sketches, each a rectangle 10 to 40 wide, a ⊐ 45 to 90 wide, distance 5 to 20; some start closed (the ⊐ never closed yet... drawn below). */
function randomSpecs(seed: number): { specs: Spec[]; startClosed: boolean[] } {
  const r = rng(seed * 7919);
  const n = 2 + Math.floor(r() * 2);
  const specs = Array.from({ length: n }, () => ({ width: 10 + Math.floor(r() * 31), open: 45 + Math.floor(r() * 46), distance: 5 + Math.floor(r() * 16) }));
  return { specs, startClosed: specs.map(() => r() < 0.3) };
}

/**
 * Runs `steps` on the app and the model, checking after each: the drawn
 * volume, whether a sketch is open, the warning (hidden while its sketch
 * is open; else the last extrude in build order that keeps its shape), the
 * error line, and the undo label. Returns the first difference, or null.
 */
async function runSession(seed: number, steps: Step[], plugin: WorkspacePlugin = designWorkspace, reached = new Set<string>()): Promise<string | null> {
  const { specs, startClosed } = randomSpecs(seed);
  // A sketch that starts closed is the ⊐ already closed by its left side (drawn here as data: settleKept forgets the kept shape).
  const made = await design(specs.map((s) => ({ width: s.width, distance: s.distance, open: s.open })));
  let doc = made.doc;
  let states: SketchState[] = specs.map((s) => ({ closed: false, strays: 0, kept: s.width }));
  for (const [i, c] of startClosed.entries()) {
    if (!c) continue;
    const sketch = doc.sketches.find((k) => k.id === made.ids[i].sketch)!;
    const p = (x: number, y: number) => sketch.points.find((q) => q.x === x && q.y === y)!.id;
    const { drawLine } = await import("@fission/design");
    const next = drawLine(doc, sketch.id, p(100 * i, 30), p(100 * i, 0)).doc;
    doc = await settleKept(kernel, doc, next);
    states[i] = { closed: true, strays: 0, kept: null };
  }
  const a = await app(doc, plugin);
  let shown = states;
  let editing: number | null = null;
  const undo: SketchState[][] = [];
  const redo: SketchState[][] = [];
  const labels: string[] = [];
  /** Where the line tool is: a chain started (its last point) or not. */
  let chain = false;
  const done: string[] = [];
  const check = (what: string): string | null => {
    const want = volumeOf(specs, shown);
    if (!close(a.volume(), want)) return `${what}: the view holds ${a.volume()} mm³, the model ${want}`;
    if (a.sketching() !== (editing !== null)) return `${what}: ${a.sketching() ? "a sketch is open" : "no sketch is open"}, the model says ${editing === null ? "none" : `Sketch ${editing + 1}`}`;
    // The warning: the last extrude, in build order, built from a kept shape at the last rebuild; hidden while its own sketch is open.
    let last: number | null = null;
    shown.forEach((s, i) => {
      if (!closes(s) && s.kept !== null) last = i;
    });
    const wantWarning = last === null || last === editing ? null : `Extrude ${(last as number) + 1} keeps its last shape. Sketch ${(last as number) + 1}`;
    const warning = a.warning();
    if (wantWarning === null ? warning !== null : !warning?.startsWith(wantWarning)) return `${what}: the warning is ${JSON.stringify(warning)}, the model's ${JSON.stringify(wantWarning)}`;
    if (a.error() !== errorLine) return `${what}: the error line says ${JSON.stringify(a.error())}, the model ${JSON.stringify(errorLine)}`;
    if (a.history.undoLabel() !== (labels.at(-1) ?? null)) return `${what}: Undo is ${JSON.stringify(a.history.undoLabel())}, the model's ${JSON.stringify(labels.at(-1) ?? null)}`;
    return null;
  };
  const record = (next: SketchState[], label: string) => {
    undo.push(states);
    labels.push(label);
    redo.length = 0;
    redoLabels.length = 0;
    states = next;
    dirty = true;
  };
  const redoLabels: string[] = [];
  /** A record since the last rebuild: leaving the sketch rebuilds. */
  let dirty = false;
  /** The error line: a refusal's words, until the next rebuild clears it. */
  let errorLine = "";
  const rebuilt = () => {
    shown = states;
    dirty = false;
    errorLine = "";
  };
  let failure = check("at the start");
  for (const [k, step] of steps.entries()) {
    if (failure) break;
    const what = `seed ${seed} step ${k} ${JSON.stringify(step)} after ${done.slice(-6).join("; ")}`;
    done.push(JSON.stringify(step));
    if (step.do === "open") {
      const id = made.ids[step.i].sketch;
      if (step.how === "menu") await a.menu(id, "edit-sketch");
      else if (step.how === "bar") await a.doubleClick(id);
      else await a.rowDoubleClick(`sketches/${id}`);
      // The sketch already open is refused: a double-click shows why on the error line, the menu's entry is greyed with it.
      // Any other is opened, the one open first finished (rebuilt when something was drawn).
      reached.add(`open by ${step.how}`);
      if (editing === step.i) {
        reached.add("refused: already open");
        if (step.how !== "menu") errorLine = `Sketch ${step.i + 1} is open: you are editing it`;
      } else {
        if (editing !== null) reached.add(dirty ? "switch after drawing" : "switch with nothing drawn");
        if (editing !== null && dirty) rebuilt();
        editing = step.i;
        chain = false;
      }
    } else if (step.do === "close") {
      if (editing === null) continue;
      const s = states[editing];
      if (s.closed) continue;
      // The chain must not be running: Escape first, as a user would.
      if (chain) await a.key("clear-selection");
      chain = false;
      const x0 = 100 * editing;
      await a.click(x0, 30);
      await a.click(x0, 0);
      const next = [...states];
      next[editing] = drawn(specs, s, editing, "close");
      reached.add(closes(next[editing]) ? "closed: builds" : "closed: strays still there");
      record(next, "Draw line");
    } else if (step.do === "stray") {
      if (editing === null) continue;
      if (chain) await a.key("clear-selection");
      const x0 = 100 * editing;
      await a.click(x0 + step.x, step.y);
      await a.click(x0 + step.x + step.len, step.y);
      chain = true;
      const next = [...states];
      next[editing] = drawn(specs, states[editing], editing, "stray");
      reached.add(closes(states[editing]) ? "stray: breaks a closing outline" : "stray: on an open outline");
      record(next, "Draw line");
    } else if (step.do === "escape") {
      await a.key("clear-selection");
      chain = false;
    } else if (step.do === "finish") {
      if (editing === null) continue;
      await a.finish();
      reached.add(dirty ? "finish after drawing" : "finish with nothing drawn");
      editing = null;
      chain = false;
      if (dirty) rebuilt();
    } else if (step.do === "undo" || step.do === "redo") {
      const from = step.do === "undo" ? undo : redo;
      const to = step.do === "undo" ? redo : undo;
      const label = step.do === "undo" ? await a.undo() : await a.redo();
      const back = from.pop();
      if (back === undefined) {
        if (label !== null) return `${what}: ${step.do} did ${label}, the model has nothing`;
        continue;
      }
      reached.add(`${step.do} ${editing === null ? "outside" : "inside"} a sketch`);
      if (step.do === "undo") redoLabels.push(labels.pop()!);
      else labels.push(redoLabels.pop()!);
      to.push(states);
      states = back;
      // Undo and Redo mount Design afresh: everything is rebuilt, and an open sketch stays open with its chain ended.
      rebuilt();
      chain = false;
    }
    failure = check(what);
  }
  if (failure) return failure;
  if (!(await a.close())) return `seed ${seed}: bodies left in the kernel's store`;
  return null;
}

const SEEDS = Number(process.env.FISSION_SESSIONS ?? 16);
const STEPS = Number(process.env.FISSION_SESSION_STEPS ?? 80);

test(`seeded: ${SEEDS} sessions × ${STEPS} steps of Edit Sketch, drawing, Finish, Undo and Redo match the model after every step, reaching every case`, async () => {
  const reached = new Set<string>();
  for (let seed = 1; seed <= SEEDS; seed++) assert.equal(await runSession(seed, randomSteps(seed, STEPS, randomSpecs(seed).specs.length), designWorkspace, reached), null);
  const every = ["open by menu", "open by bar", "open by row", "refused: already open", "switch after drawing", "switch with nothing drawn", "closed: builds", "closed: strays still there", "stray: breaks a closing outline", "stray: on an open outline", "finish after drawing", "finish with nothing drawn", "undo inside a sketch", "undo outside a sketch", "redo inside a sketch", "redo outside a sketch"];
  assert.deepEqual(every.filter((c) => !reached.has(c)), [], `reached: ${[...reached].join(", ")}`);
});

// ---- Bugs planted in workspace.ts, each caught ----

const WORKSPACE = new URL("../../../workspaces/design/src/workspace.ts", import.meta.url);

/** The planted bugs: each a text edit of workspace.ts. */
const PLANTS: { name: string; find: string; replace: string }[] = [
  // The plan's own: Finish Sketch rebuilds nothing.
  { name: "finish-skips-rebuild", find: "    if (drew) void show(designDoc(), shape);\n", replace: "" },
  // Opening another sketch leaves the first without rebuilding it.
  { name: "switch-skips-rebuild", find: "    leaveEdit();\n    if (mode.kind !== \"none\") leaveSketch();\n    editingSketch = { id, grid", replace: "    leaveEdit();\n    if (mode.kind !== \"none\") leaveSketch(false);\n    editingSketch = { id, grid" },
  // The warning stays up while its sketch is open again.
  { name: "warning-while-open", find: "    if (mode.kind !== \"edit\") return;\n    showKept();\n    lookAtSketch();", replace: "    if (mode.kind !== \"edit\") return;\n    lookAtSketch();" },
  // The old live link: every drawn line rebuilds what is built from the sketch, part way through the outline.
  { name: "live-rebuild", find: "    showKept(); // the rows are new: mark them again until the rebuild says otherwise\n    markStale();\n  }", replace: "    showKept(); // the rows are new: mark them again until the rebuild says otherwise\n    markStale();\n    void show(next, shape);\n  }" },
];

/** Design with `plant` made: a copy of workspace.ts beside it (so its imports resolve), loaded, then deleted. */
async function planted(plant: { name: string; find: string; replace: string }): Promise<WorkspacePlugin> {
  const text = readFileSync(WORKSPACE, "utf8");
  const at = text.indexOf(plant.find);
  assert.ok(at >= 0 && text.indexOf(plant.find, at + 1) < 0, `${plant.name}: the text to replace must be in workspace.ts exactly once`);
  const file = new URL(`workspace.planted-${plant.name}.ts`, WORKSPACE);
  writeFileSync(file, text.slice(0, at) + plant.replace + text.slice(at + plant.find.length));
  try {
    return (await import(file.href)).designWorkspace;
  } finally {
    rmSync(file);
  }
}

test("each bug planted in workspace.ts is caught by the seeded sessions", async () => {
  // The copy unplanted passes, so a catch is the plant's and not the copying's.
  const clean = await planted({ name: "none", find: "let fits = 0;", replace: "let fits = 0;" });
  for (let seed = 1; seed <= 4; seed++) assert.equal(await runSession(seed, randomSteps(seed, STEPS, randomSpecs(seed).specs.length), clean), null);
  for (const plant of PLANTS) {
    const design = await planted(plant);
    let caught: string | null = null;
    for (let seed = 1; seed <= SEEDS && caught === null; seed++) caught = await runSession(seed, randomSteps(seed, STEPS, randomSpecs(seed).specs.length), design);
    assert.ok(caught !== null, `${plant.name} was not caught by ${SEEDS} sessions`);
    if (process.env.FISSION_PLANTED_REPORT) console.log(`${plant.name}: ${caught}`);
  }
});
