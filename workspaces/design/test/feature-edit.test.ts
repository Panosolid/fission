// Step 25a2: Edit feature (feature-edit.ts, feature-edit-panel.ts). The
// sizes each shape shows and how an edit lands, worked by hand; the
// kernel's refusal rules with a stand-in kernel whose answers are set by
// hand; 12 seeded sessions × 200 edits against a plain model of every
// item's sizes (an edit changes only its item, keeps its id, place, flags
// and profile id, and records nothing when nothing changes); the panel in
// a real DOM; and bugs planted in feature-edit.ts, each caught. The real
// kernel's answers are in packages/testing/journeys/feature-edit.journey.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { KernelError, type BodySpec, type KernelCalls } from "@fission/core";
import { insertPreset, partDocument, shapeOf, type DesignDocument, type PartSizes } from "../src/document.ts";
import { addSketch, drawRectangle } from "../src/sketch.ts";
import { extrudeSketch } from "../src/extrude.ts";
import { moveMarker, suppressItem } from "../src/timeline-edits.ts";
import * as edit from "../src/feature-edit.ts";
import { featureEditPanel } from "../src/feature-edit-panel.ts";

type Edit = typeof edit;

/** The box (feature-1), Sketch 1 (sketch-2, a 40 × 30 rectangle, ids 3 to 10), Extrude 1 of it by 10 (feature-11), a cylinder ⌀20 × 30 (feature-12), a sphere ⌀12 (feature-13), a 60 × 20 plate by 4 (feature-14, profile-15) and Extrude 2 of Sketch 1 by 15 (feature-16). */
function design(): DesignDocument {
  const s = addSketch(partDocument("box", 40, 30, 20));
  const rect = drawRectangle(s.doc, s.id, [0, 0], [40, 30]);
  let doc = extrudeSketch(rect.doc, s.id, 10).doc;
  doc = insertPreset(doc, "cylinder", 20, 20, 30).doc;
  doc = insertPreset(doc, "sphere", 12, 12, 12).doc;
  doc = insertPreset(doc, "plate", 60, 20, 4).doc;
  return extrudeSketch(doc, s.id, 15).doc;
}

test("hand-worked: each shape's boxes and sizes, as the main panel names them", () => {
  const d = design();
  const shown = (id: string) => {
    const f = edit.editableFeature(d, id);
    return [f.name, f.shape, f.keys, f.sizes];
  };
  assert.deepEqual(shown("feature-1"), ["Feature 1 (box)", "box", ["width", "depth", "height"], { width: 40, depth: 30, height: 20 }]);
  // An extrude of a sketch has one size, its distance, kept in the height box.
  assert.deepEqual(shown("feature-11"), ["Extrude 1", "sketch-extrude", ["height"], { height: 10 }]);
  // A cylinder: its diameter (the width box) and height, no depth.
  assert.deepEqual(shown("feature-12"), ["Feature 12 (cylinder)", "cylinder", ["width", "height"], { width: 20, height: 30 }]);
  // A sphere: its diameter alone.
  assert.deepEqual(shown("feature-13"), ["Feature 13 (sphere)", "sphere", ["width"], { width: 12 }]);
  assert.deepEqual(shown("feature-14"), ["Feature 14 (extrude)", "plate", ["width", "depth", "height"], { width: 60, depth: 20, height: 4 }]);
  assert.equal(edit.canEditFeature(d.timeline.features[1]), false, "a sketch is edited with Edit Sketch (25a3)");
  assert.throws(() => edit.editableFeature(d, "sketch-2"), { message: "Sketch 1 is a sketch: it has no sizes to edit" });
  assert.throws(() => edit.editableFeature(d, "feature-99"), { message: "there is no item feature-99 in the timeline" });
  assert.equal(edit.editStep(d, "feature-11"), "Edit Extrude 1");
  assert.deepEqual(shown("feature-16"), ["Extrude 2", "sketch-extrude", ["height"], { height: 15 }]);
});

test("hand-worked: an edit changes its item alone and keeps its id, place, flags and profile", () => {
  const d = moveMarker(suppressItem(design(), "feature-12", true), "feature-13");
  // The cylinder (suppressed) made ⌀50: diameter 50 in both width and depth, height kept at 30.
  const cyl = edit.editFeature(d, "feature-12", { width: 50 });
  const f = cyl.timeline.features.find((x) => x.id === "feature-12")!;
  assert.deepEqual(f.intent.parameters, { diameter: 50, height: 30 });
  assert.equal(f.intent.summary, "Cylinder: ⌀50 × 30 mm");
  assert.equal(f.suppressed, true, "still suppressed");
  assert.equal(cyl.timeline.marker, "feature-13", "the marker stays");
  assert.equal(cyl.nextId, d.nextId, "no new ids");
  assert.deepEqual(cyl.timeline.features.map((x) => x.id), d.timeline.features.map((x) => x.id), "every item in its place");
  for (const [i, x] of cyl.timeline.features.entries()) if (x.id !== "feature-12") assert.equal(x, d.timeline.features[i], `${x.id} is the same object`);
  // A depth typed for a cylinder is not one of its boxes: ignored.
  assert.equal(edit.editFeature(d, "feature-12", { depth: 99 }), d);
  // The sphere made ⌀8: one diameter.
  assert.deepEqual(edit.editFeature(d, "feature-13", { width: 8 }).timeline.features.find((x) => x.id === "feature-13")!.intent.parameters, { diameter: 8 });
  // The plate made 25 deep: its profile keeps its id (profile-15) and takes the new sizes.
  const plate = edit.editFeature(d, "feature-14", { depth: 25 });
  assert.deepEqual(plate.profiles.map((p) => [p.id, p.width, p.depth]), [["profile-15", 60, 25]]);
  assert.equal(plate.timeline.features.find((x) => x.id === "feature-14")!.intent.parameters.distance, 4);
  // Extrude 1 made 25: its sketch and summary follow.
  const e = edit.editFeature(d, "feature-11", { height: 25 }).timeline.features.find((x) => x.id === "feature-11")!;
  assert.deepEqual(e.intent.parameters, { sketch: "sketch-2", distance: 25 });
  assert.equal(e.intent.summary, "Extrude Sketch 1 by 25 mm");
  assert.deepEqual(e.dependsOn, ["sketch-2"]);
  // The sizes it has already: the same document, so nothing is recorded.
  assert.equal(edit.editFeature(d, "feature-1", { width: 40, depth: 30, height: 20 }), d);
  assert.equal(edit.editFeature(d, "feature-1", {}), d);
});

test("typed boxes: empty or not a number names the box; spaces and exponents are numbers", () => {
  const keys = ["width", "depth", "height"] as const;
  assert.deepEqual(edit.readTyped(keys, { width: "40", depth: " 30 ", height: "2e1" }), { sizes: { width: 40, depth: 30, height: 20 } });
  assert.deepEqual(edit.readTyped(keys, { width: "40", depth: "", height: "20" }), { bad: "depth" });
  assert.deepEqual(edit.readTyped(keys, { width: "abc", depth: "1", height: "1" }), { bad: "width" });
  assert.deepEqual(edit.readTyped(["height"], { height: "Infinity" }), { bad: "height" });
  // Only the shown boxes are read.
  assert.deepEqual(edit.readTyped(["height"], { width: "junk", height: "7" }), { sizes: { height: 7 } });
  // Numbers that aren't finite never reach a document.
  assert.throws(() => edit.editFeature(design(), "feature-1", { width: Number.NaN }), { message: "Feature 1 (box): its width must be a number of mm, not NaN" });
});

/**
 * A kernel whose answers are set by hand: sketch_outline closes when
 * `closed`, and each build is refused by `refuse` (a KernelError with its
 * inputs) or taken.
 */
function kernelWith(refuse: (spec: BodySpec) => KernelError | null, closed = true): KernelCalls & { builds: BodySpec[] } {
  const builds: BodySpec[] = [];
  const k = {
    builds,
    call: (async (op: string, ...args: unknown[]) => {
      if (op === "sketch_outline") return closed ? { closed: { outer: { path: { corners: [0, 0, 40, 0, 40, 30, 0, 30], bulges: [] } }, holes: [] }, pieces: [] } : { open: "a loose end", invalid: [] };
      const spec: BodySpec =
        op === "make_box" ? { box: { width: args[0] as number, depth: args[1] as number, height: args[2] as number } } : op === "make_cylinder" ? { cylinder: { radius: args[0] as number, height: args[1] as number } } : op === "make_sphere" ? { sphere: { radius: args[0] as number } } : { extrude: { profile: args[0] as never, distance: args[1] as number } };
      builds.push(spec);
      const no = refuse(spec);
      if (no) throw no;
      return {};
    }) as KernelCalls["call"],
  };
  return k;
}
const param = (name: string, message: string) => new KernelError({ kind: "invalid-input", inputs: [{ input: "param", name }], message });
const other = (message: string) => new KernelError({ kind: "invalid-input", inputs: [{ input: "loop", boundary: 0 }], message });

test("the kernel's refusals: a size it names is refused; another failure only when the item built before; an open sketch's distance on the stand-in square", async () => {
  const d = design();
  const tall = edit.editFeature(d, "feature-1", { height: 2e6 });
  // Refused naming the height: its words, as the kernel gave them.
  const sizes = kernelWith((s) => ("box" in s && s.box.height > 1e6 ? param("height", "height must be between 0.001 and 1000000 mm, got 2000000") : null));
  assert.equal(await edit.refusedSizes(sizes, d, tall, "feature-1"), "height must be between 0.001 and 1000000 mm, got 2000000");
  // Taken: null.
  assert.equal(await edit.refusedSizes(sizes, d, edit.editFeature(d, "feature-1", { height: 5 }), "feature-1"), null);
  // A failure naming no size (the outline) when it built before: refused; the old sizes were built to know.
  const narrow = edit.editFeature(d, "feature-14", { width: 1 });
  const outlineOnlyNarrow = kernelWith((s) => ("extrude" in s && JSON.stringify(s).includes('"corners":[0,0,1,0') ? other("the outline crosses itself") : null));
  assert.equal(await edit.refusedSizes(outlineOnlyNarrow, d, narrow, "feature-14"), "the outline crosses itself");
  assert.equal(outlineOnlyNarrow.builds.length, 2, "the edit, then the item as it was");
  // The same failure when it already failed before: taken (it keeps failing for that reason).
  const deeper = edit.editFeature(d, "feature-14", { width: 61 });
  assert.equal(await edit.refusedSizes(kernelWith(() => other("the outline crosses itself")), d, deeper, "feature-14"), null);
  // An extrude whose sketch makes no outline: its distance judged on the 10 mm stand-in square.
  const open = kernelWith((s) => ("extrude" in s && s.extrude.distance <= 0 ? param("distance", "extrude distance must be between 0.001 and 1000000 mm, got 0") : null), false);
  assert.equal(await edit.refusedSizes(open, d, edit.editFeature(d, "feature-11", { height: 25 }), "feature-11"), null);
  assert.deepEqual(open.builds.at(-1), { extrude: { profile: { outer: { path: { corners: [0, 0, 10, 0, 10, 10, 0, 10], bulges: [] } }, holes: [] }, distance: 25 } });
  assert.equal(await edit.refusedSizes(open, d, edit.editFeature(d, "feature-11", { height: 0 }), "feature-11"), "extrude distance must be between 0.001 and 1000000 mm, got 0");
  // A failure that isn't the kernel's (a crash) names no size: judged like any other failure.
  const crash = kernelWith((s) => ("box" in s ? new KernelError({ kind: "internal", inputs: [], message: "kernel worker crashed" }) : null));
  assert.equal(await edit.refusedSizes(crash, d, tall, "feature-1"), null, "it failed before too");
});

/** A plain model of every solid item's kind and sizes (each key its shape uses), and how an edit changes them. */
type Model = Map<string, { kind: string; sizes: Required<PartSizes> }>;
const KEYS: Record<string, (keyof PartSizes)[]> = { box: ["width", "depth", "height"], plate: ["width", "depth", "height"], cylinder: ["width", "height"], sphere: ["width"], "sketch-extrude": ["height"] };
function modelOf(d: DesignDocument): Model {
  const m: Model = new Map();
  for (const f of d.timeline.features) {
    if (f.intent.type === "sketch") continue;
    const { shape, sizes } = shapeOf(d, f);
    m.set(f.id, { kind: shape, sizes: { width: 0, depth: 0, height: 0, ...sizes } });
  }
  return m;
}

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

/** 12 sessions × 200 random edits through `e` against the model; the first broken rule, or null. */
function sessions(e: Edit): string | null {
  for (let seed = 1; seed <= 12; seed++) {
    const rand = rng(seed);
    let doc = design();
    if (rand() < 0.5) doc = suppressItem(doc, "feature-12", true);
    if (rand() < 0.5) doc = moveMarker(doc, "feature-11");
    const model = modelOf(doc);
    const ids = [...model.keys()];
    for (let step = 0; step < 200; step++) {
      const where = `seed ${seed} step ${step}`;
      const id = ids[Math.floor(rand() * ids.length)];
      const item = model.get(id)!;
      // Some boxes typed, some not; a typed size its shape doesn't use is ignored; values repeat so some edits change nothing.
      const typed: PartSizes = {};
      for (const k of ["width", "depth", "height"] as const) if (rand() < 0.6) typed[k] = rand() < 0.3 ? item.sizes[k] : 1 + Math.floor(rand() * 30);
      const before = doc;
      const flags = JSON.stringify([doc.timeline.marker, doc.timeline.features.map((f) => [f.id, f.suppressed, f.dependsOn]), doc.nextId, doc.sketches, doc.profiles.map((p) => p.id)]);
      const next = e.editFeature(doc, id, typed);
      const want = { ...item.sizes };
      for (const k of KEYS[item.kind]) if (typed[k] !== undefined) want[k] = typed[k]!;
      if (item.kind === "cylinder") want.depth = want.width;
      if (item.kind === "sphere") want.depth = want.height = want.width;
      const changed = KEYS[item.kind].some((k) => want[k] !== item.sizes[k]);
      if (!changed) {
        if (next !== before) return `${where}: an edit of ${id} that changes nothing made a new document`;
        continue;
      }
      if (next === before) return `${where}: an edit of ${id} to ${JSON.stringify(typed)} changed nothing`;
      model.set(id, { ...item, sizes: want });
      // Every item's sizes as the model has them; every other item the same object.
      const now = modelOf(next);
      for (const [x, m] of model) {
        const got = now.get(x)!;
        if (got.kind !== m.kind || KEYS[m.kind].some((k) => got.sizes[k] !== m.sizes[k])) return `${where}: ${x} is ${JSON.stringify(got)}, the model ${JSON.stringify(m)}`;
      }
      for (const [i, f] of next.timeline.features.entries()) if (f.id !== id && f !== before.timeline.features[i]) return `${where}: editing ${id} changed ${f.id}`;
      const flagsAfter = JSON.stringify([next.timeline.marker, next.timeline.features.map((f) => [f.id, f.suppressed, f.dependsOn]), next.nextId, next.sketches, next.profiles.map((p) => p.id)]);
      if (flagsAfter !== flags) return `${where}: editing ${id} changed the timeline's order, flags, ids or sketches`;
      doc = next;
    }
  }
  return null;
}

test("seeded: 12 sessions × 200 edits of every kind of item match a plain model of their sizes", () => {
  assert.equal(sessions(edit), null);
});

interface Plant {
  name: string;
  find: string;
  replace: string;
  /** Text in the failure: which check caught it. */
  caught: string;
}

const SOURCE = new URL("../src/feature-edit.ts", import.meta.url);

/** Bugs planted in feature-edit.ts; each must be caught by the sessions or the refusal test's cases. */
const PLANTS: Plant[] = [
  {
    name: "edit-leaks",
    find: '  if (now.shape === "sketch-extrude") return setExtrudeDistance(doc, sizes.height!, id);',
    replace: '  if (now.shape === "sketch-extrude") return setExtrudeDistance(setExtrudeDistance(doc, sizes.height!, doc.timeline.features.find(isSketchExtrude)!.id), sizes.height!, id);',
    caught: "feature-11 is",
  },
  { name: "depth-from-width", find: '  const d = now.shape === "cylinder" || now.shape === "sphere" ? w : sizes.depth!;', replace: "  const d = w;", caught: "the model" },
  { name: "unchanged-recorded", find: "  if (now.keys.every((k) => sizes[k] === now.sizes[k])) return doc;\n", replace: "", caught: "changes nothing made a new document" },
  { name: "key-ignored", find: "    if (v === undefined) continue;", replace: '    if (v === undefined || key === "depth") continue;', caught: "changed nothing" },
  { name: "never-refused", find: "  if (e === null) return null;\n  if (namesASize(e)) return words(e);", replace: "  return null;", caught: "refused" },
  { name: "stand-in-skipped", find: "    return e !== null && namesASize(e) ? words(e) : null;", replace: "    return null;", caught: "refused" },
  { name: "already-failed-refused", find: "  return was === null ? words(e) : null;", replace: "  return words(e);", caught: "refused" },
];

async function planted(plant: Plant, dir: string): Promise<Edit> {
  const text = readFileSync(SOURCE, "utf8");
  const at = text.indexOf(plant.find);
  assert.ok(at >= 0 && text.indexOf(plant.find, at + 1) < 0, `${plant.name}: the text to replace must be in feature-edit.ts exactly once: ${plant.find}`);
  const out = (text.slice(0, at) + plant.replace + text.slice(at + plant.find.length)).replace(/from "\.\/([^"]+)"/g, (_, f) => `from "${new URL(f, SOURCE).href}"`).replace('from "@fission/core"', `from "${import.meta.resolve("@fission/core")}"`);
  const file = join(dir, `feature-edit-${plant.name}.ts`);
  writeFileSync(file, out);
  return import(pathToFileURL(file).href);
}

/** The refusal rules' cases on `e`: the first one it gets wrong, or null. */
async function refusals(e: Edit): Promise<string | null> {
  const d = design();
  const tall = e.editFeature(d, "feature-1", { height: 2e6 });
  const sizes = kernelWith((s) => ("box" in s && s.box.height > 1e6 ? param("height", "too tall") : null));
  if ((await e.refusedSizes(sizes, d, tall, "feature-1")) !== "too tall") return "a size the kernel names was not refused";
  const narrow = e.editFeature(d, "feature-14", { width: 1 });
  const k = kernelWith((s) => ("extrude" in s && JSON.stringify(s).includes('"corners":[0,0,1,0') ? other("crossed") : null));
  if ((await e.refusedSizes(k, d, narrow, "feature-14")) !== "crossed") return "a body that built and no longer does was not refused";
  if ((await e.refusedSizes(kernelWith(() => other("crossed")), d, e.editFeature(d, "feature-14", { width: 61 }), "feature-14")) !== null) return "an item that already failed was refused";
  const open = kernelWith((s) => ("extrude" in s && s.extrude.distance <= 0 ? param("distance", "zero") : null), false);
  if ((await e.refusedSizes(open, d, e.editFeature(d, "feature-11", { height: 0 }), "feature-11")) !== "zero") return "an open sketch's zero distance was not refused";
  return null;
}

test("each bug planted in feature-edit.ts is caught, by the check recorded for it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "feature-edit-planted-"));
  try {
    // The copy unplanted passes, so a catch below is the plant's.
    const clean = await planted({ name: "none", find: "export const STAND_IN = 10;", replace: "export const STAND_IN = 10;", caught: "" }, dir);
    assert.equal(sessions(clean), null);
    assert.equal(await refusals(clean), null);
    for (const plant of PLANTS) {
      const e = await planted(plant, dir);
      let caught: string | null = null;
      try {
        caught = sessions(e) ?? (await refusals(e));
      } catch (err) {
        caught = `threw: ${err instanceof Error ? err.message : String(err)}`;
      }
      assert.ok(caught !== null, `${plant.name} was not caught`);
      assert.ok(caught.includes(plant.caught), `${plant.name} was caught by another check than "${plant.caught}": ${caught}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const { Window } = await import("happy-dom");

function panelSetup() {
  const window = new Window({ width: 1280, height: 800 });
  const doc = window.document as unknown as Document;
  const slot = doc.createElement("div");
  doc.body.append(slot);
  const log = { ok: [] as Partial<Record<string, string>>[], cancel: 0 };
  const panel = featureEditPanel(slot, { ok: (t) => void log.ok.push(t), cancel: () => void log.cancel++ });
  const $ = (id: string) => doc.getElementById(id) as HTMLInputElement;
  const key = (target: HTMLElement, k: string) => target.dispatchEvent(new window.KeyboardEvent("keydown", { key: k, bubbles: true }) as unknown as Event);
  return { panel, $, key, log, doc };
}

test("the panel: a box per size its shape uses with its value, Enter or OK reports what was typed, busy turns OK off, Cancel and hide close it", () => {
  const { panel, $, key, log, doc } = panelSetup();
  assert.equal(panel.editing, null);
  assert.equal($("feature-edit").hidden, true);
  const d = design();
  panel.show(edit.editableFeature(d, "feature-12"));
  assert.equal(panel.editing, "feature-12");
  assert.equal($("feature-edit").hidden, false);
  assert.equal($("feature-edit-title").textContent, "Edit Feature 12 (cylinder)");
  // A cylinder: Diameter and Height, filled with ⌀20 and 30; no depth box.
  assert.deepEqual(
    [...doc.querySelectorAll(".feature-edit-row")].map((r) => [r.textContent!.trim(), (r.querySelector("input") as HTMLInputElement).id, (r.querySelector("input") as HTMLInputElement).value]),
    [
      ["Diameter  mm", "edit-width", "20"],
      ["Height  mm", "edit-height", "30"],
    ],
  );
  assert.equal($("edit-depth"), null);
  assert.equal(doc.activeElement, $("edit-width"), "the first box takes the keys");
  $("edit-height").value = "45";
  key($("edit-height"), "Enter");
  assert.deepEqual(log.ok, [{ width: "20", height: "45" }]);
  // While the kernel checks, OK is off and Enter does nothing.
  panel.busy(true);
  assert.equal(($("feature-edit-ok") as unknown as HTMLButtonElement).disabled, true);
  key($("edit-height"), "Enter");
  assert.equal(log.ok.length, 1);
  panel.busy(false);
  ($("feature-edit-ok") as unknown as HTMLButtonElement).click();
  assert.equal(log.ok.length, 2);
  panel.showError("height must be between 0.001 and 1000000 mm, got 0");
  assert.equal($("feature-edit-error").hidden, false);
  assert.equal($("feature-edit-error").textContent, "height must be between 0.001 and 1000000 mm, got 0");
  panel.showError("");
  assert.equal($("feature-edit-error").hidden, true);
  ($("feature-edit-cancel") as unknown as HTMLButtonElement).click();
  assert.equal(log.cancel, 1);
  // An extrude: one Distance box.
  panel.show(edit.editableFeature(d, "feature-11"));
  assert.deepEqual([...doc.querySelectorAll(".feature-edit-row")].map((r) => r.textContent!.trim()), ["Distance  mm"]);
  assert.equal($("edit-height").value, "10");
  panel.hide();
  assert.equal(panel.editing, null);
  assert.equal($("feature-edit").hidden, true);
  assert.equal(doc.querySelectorAll(".feature-edit-row").length, 0);
});
