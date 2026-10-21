// Step 24f6: an item dragged along the timeline bar, checked against the
// timeline model (src/timeline-model.ts, written apart from Design). Seeded
// sessions build the same timeline on both sides (boxes, sketches,
// extrudes of a sketch, suppress, delete, the marker), then drop items at
// random places through the bar's own answer (`barEdit` with an item drop,
// what the drag sends, and `dropState`, what the drag shows while dragged)
// and through the model's `reorder`: the same order, marker and suppressed
// flags after every step, and the same refusal with the same cause. Then a
// bug planted on either side is caught.

import { test } from "node:test";
import assert from "node:assert/strict";
import { addSketch, barEdit, deleteItem, dropState, extrudeSketch, insertPreset, moveMarker, partDocument, suppressItem, type DesignDocument } from "@fission/design";
import { applyOp, createModel, type ModelFault, type TimelineModel } from "../src/timeline-model.ts";

/** A seeded stream of numbers in [0, 1). */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TRIANGLE = { kind: "polygon" as const, corners: [[0, 0], [10, 0], [0, 10]] as [number, number][] };

/** A Design-side bug to plant: the bar's drop used as it is, or with its refusal ignored. */
type DropFault = "none" | "refusal-ignored" | "editing-ignored";

/** The bar's answer to an item drop, with `fault` planted. */
function drop(doc: DesignDocument, id: string, place: number, editing: string | null, fault: DropFault) {
  const r = barEdit(doc, { kind: "item", id, place }, fault === "editing-ignored" ? null : editing);
  if (fault !== "refusal-ignored" || r.kind !== "refused" || r.message.includes("while it is being edited")) return r;
  // Planted: the item moved anyway, the dependency's refusal ignored.
  const features = doc.timeline.features.filter((f) => f.id !== id);
  const k = doc.timeline.features.findIndex((f) => f.id === id);
  features.splice(place > k ? place - 1 : place, 0, doc.timeline.features[k]);
  return { kind: "edit" as const, step: "", doc: { ...doc, timeline: { ...doc.timeline, features } } };
}

/**
 * One session of `steps` steps on both sides. A drop of item k at place p
 * (the gap before item p of the order now) is the model's reorder to
 * place p of the order without it: p − 1 when the item came from before
 * p, else p. Now and then a sketch is being edited (one that is built), as
 * in the app: a drop that would put it after the marker is refused on the
 * bar's side; the model has no such rule, so there the model's reorder is
 * checked to roll it back. Returns the counts of each outcome, or throws
 * at the first difference.
 */
function session(seed: number, steps: number, faults: { model?: ModelFault[]; design?: DropFault } = {}): Record<string, number> {
  const r = rng(seed);
  const model: TimelineModel = createModel(faults.model ?? []);
  let doc = partDocument("box", 10, 10, 10);
  applyOp(model, { op: "add-preset", kind: "box", sizes: [10, 10, 10] });
  // The model's id for each of Design's.
  const ids = new Map<string, string>([["feature-1", model.doc.items[0].id]]);
  const counts: Record<string, number> = {};
  const count = (k: string) => (counts[k] = (counts[k] ?? 0) + 1);
  const fail = (s: number, m: string): never => assert.fail(`seed ${seed} step ${s}: ${m}`);
  for (let s = 0; s < steps; s++) {
    const n = doc.timeline.features.length;
    const pick = r();
    const any = () => doc.timeline.features[Math.floor(r() * n)];
    if (n === 0 || pick < 0.12) {
      const made = addSketch(doc);
      doc = made.doc;
      const a = applyOp(model, { op: "add-sketch", shape: TRIANGLE });
      ids.set(made.id, (a as { ids: string[] }).ids[0]);
      count("sketch");
    } else if (pick < 0.22) {
      // A sketch before the marker, as Design asks (an extrude goes in at the marker, after its sketch).
      const sketches = doc.timeline.features.filter((f, i) => f.intent.type === "sketch" && i < placeOf(doc));
      if (sketches.length === 0) continue;
      const sk = sketches[Math.floor(r() * sketches.length)].id;
      const made = extrudeSketch(doc, sk, 5);
      doc = made.doc;
      const a = applyOp(model, { op: "add-extrude", sketch: ids.get(sk)!, distance: 5 });
      ids.set(made.id, (a as { ids: string[] }).ids[0]);
      count("extrude");
    } else if (pick < 0.27) {
      const made = insertPreset(doc, "box", 10, 10, 10);
      doc = made.doc;
      const a = applyOp(model, { op: "add-preset", kind: "box", sizes: [10, 10, 10] });
      ids.set(made.id, (a as { ids: string[] }).ids[0]);
      count("preset");
    } else if (pick < 0.32) {
      const f = any();
      doc = suppressItem(doc, f.id, !f.suppressed);
      applyOp(model, { op: "suppress", item: ids.get(f.id)!, on: !f.suppressed });
      count("suppress");
    } else if (pick < 0.36 && n > 2) {
      const f = any();
      doc = deleteItem(doc, f.id);
      applyOp(model, { op: "delete-item", item: ids.get(f.id)! });
      count("delete");
    } else if (pick < 0.5) {
      const p = Math.floor(r() * (n + 1));
      const at = p === 0 ? "start" : p === n ? null : doc.timeline.features[p - 1].id;
      doc = moveMarker(doc, at);
      applyOp(model, { op: "marker", at: at === null || at === "start" ? at : ids.get(at)! });
      count("marker");
    } else {
      // An item dropped at a place, perhaps while a built sketch is edited.
      const k = Math.floor(r() * n);
      const f = doc.timeline.features[k];
      const p = Math.floor(r() * (n + 1));
      const sketches = doc.timeline.features.filter((x, i) => x.intent.type === "sketch" && i < placeOf(doc));
      const editing = sketches.length > 0 && r() < 0.6 ? sketches[Math.floor(r() * sketches.length)].id : null;
      const shown = dropState(doc, f.id, p, editing);
      const res = drop(doc, f.id, p, editing, faults.design ?? "none");
      // What the drag shows while dragged is what the drop does.
      const kindOf = res.kind === "edit" ? "moves" : res.kind === "none" ? "stays" : "refused";
      if (faults.design === undefined && shown.kind !== kindOf) fail(s, `the drag shows ${shown.kind}, the drop ${kindOf}`);
      const before = JSON.stringify(model.doc);
      const a = applyOp(model, { op: "reorder", item: ids.get(f.id)!, to: p > k ? p - 1 : p });
      let rolledBack = false;
      if (editing !== null && a.kind === "done") {
        // The model's own rebuild order: the edited sketch after the model's marker once moved.
        const mk = model.doc.marker;
        const at = mk === null ? model.doc.items.length : mk === "start" ? 0 : model.doc.items.findIndex((i) => i.id === mk) + 1;
        rolledBack = model.doc.items.findIndex((i) => i.id === ids.get(editing)) >= at;
        if (rolledBack) model.doc = JSON.parse(before); // the bar refuses it: the model's undone to compare
      }
      if (a.kind === "refused") {
        if (res.kind !== "refused") fail(s, `the model refuses ${f.id} at place ${p} (${a.cause}), the bar gives ${res.kind}`);
        const cause = res.message.endsWith(" it") ? "after-dependent" : "before-dependency";
        if (cause !== a.cause) fail(s, `the model refuses with ${a.cause}, the bar says "${res.message}"`);
        count(`refused:${a.cause}`);
      } else if (rolledBack) {
        if (res.kind !== "refused" || !res.message.includes("while it is being edited")) fail(s, `the drop rolls back ${editing}, being edited, but the bar gives ${res.kind}`);
        count("refused:editing");
      } else if (a.kind === "unchanged" || JSON.stringify(model.doc) === before) {
        if (res.kind !== "none") fail(s, `the model is unchanged by ${f.id} at place ${p}, the bar gives ${res.kind}`);
        count("stays");
      } else {
        if (res.kind !== "edit") fail(s, `the model moves ${f.id} to place ${p}, the bar gives ${res.kind}${res.kind === "refused" ? `: ${res.message}` : ""}`);
        doc = res.doc;
        count("moves");
      }
    }
    // After every step: the same items in the same order, suppressed flags and marker.
    const got = doc.timeline.features.map((f) => `${ids.get(f.id)}${f.suppressed ? "/s" : ""}`);
    const want = model.doc.items.map((i) => `${i.id}${i.suppressed ? "/s" : ""}`);
    if (JSON.stringify(got) !== JSON.stringify(want)) fail(s, `Design's timeline is ${got}, the model's ${want}`);
    const m = doc.timeline.marker;
    const mm = m === undefined ? null : m === "start" ? "start" : ids.get(m)!;
    if (mm !== model.doc.marker) fail(s, `Design's marker is ${mm}, the model's ${model.doc.marker}`);
  }
  return counts;
}

/** Where the marker stands in Design's document: 0 for the start, the item count for none. */
function placeOf(doc: DesignDocument): number {
  const m = doc.timeline.marker;
  if (m === undefined) return doc.timeline.features.length;
  if (m === "start") return 0;
  return doc.timeline.features.findIndex((f) => f.id === m) + 1;
}

const SEEDS = 12;
const STEPS = 200;

test(`seeded: ${SEEDS} sessions × ${STEPS} steps of item drops through the bar match the timeline model, every outcome reached`, () => {
  const base = Number(process.env.FISSION_SEED ?? 2461);
  const total: Record<string, number> = {};
  for (let seed = base; seed < base + SEEDS; seed++) for (const [k, v] of Object.entries(session(seed, STEPS))) total[k] = (total[k] ?? 0) + v;
  if (process.env.FISSION_SEED === undefined)
    for (const k of ["moves", "stays", "refused:before-dependency", "refused:after-dependent", "refused:editing", "delete", "suppress", "marker"]) assert.ok((total[k] ?? 0) >= 5, `${k} reached ${total[k] ?? 0} times: ${JSON.stringify(total)}`);
});

test("a bug planted on either side is caught", () => {
  const caught = (faults: Parameters<typeof session>[2]) => {
    for (let seed = 2461; seed < 2461 + SEEDS; seed++)
      try {
        session(seed, STEPS, faults);
      } catch (e) {
        return (e as Error).message;
      }
    return null;
  };
  // The model's own planted bug: a reorder past a dependency allowed.
  assert.match(caught({ model: ["reorder-past-dependency"] }) ?? "not caught", /the model moves .* the bar gives refused/);
  // The bar's refusal ignored: the item moved before what it is built from.
  assert.match(caught({ design: "refusal-ignored" }) ?? "not caught", /the model refuses .* the bar gives edit/);
  // The sketch being edited not checked: a drop rolls it back.
  assert.match(caught({ design: "editing-ignored" }) ?? "not caught", /rolls back .* being edited, but the bar gives edit/);
});
