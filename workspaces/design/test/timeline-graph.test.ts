// Step 25c2: the dependency graph and change notes (X4, X5) on a real
// timeline. A result another workspace makes from an item goes out of date
// when the item changes, and also when whether it builds does (the marker
// moved past it, it or its sketch suppressed) or the shape it keeps for a
// lost sketch does; the note names the item, or the edit when the item
// itself is as it was. Nothing outside Design reads the design yet (P2),
// so these tests stand in results the way change-notes.test.ts does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ChangeNotes, DependencyGraph } from "@fission/core";
import { insertPreset, partDocument, type DesignDocument } from "../src/document.ts";
import { extrudeSketch } from "../src/extrude.ts";
import { editFeature } from "../src/feature-edit.ts";
import { itemCalled, PART_VIEW, syncGraph } from "../src/graph.ts";
import { addSketch, drawLine, drawRectangle, movePoint } from "../src/sketch.ts";
import { deleteItem, moveMarker, reorderItem, suppressItem } from "../src/timeline-edits.ts";

/**
 * A box (feature-1), Sketch 1 (sketch-2, a 40 × 30 rectangle), Extrude 1
 * (feature-11, Sketch 1 by 10) and a cylinder (feature-12), with three
 * results reading them from other workspaces: a print plate reading
 * Extrude 1, a laser cut reading Sketch 1 and a stress result reading the
 * part's view (the last body: the cylinder).
 */
function linked() {
  let doc = partDocument("box", 40, 30, 20);
  const s = addSketch(doc);
  doc = extrudeSketch(drawRectangle(s.doc, s.id, [0, 0], [40, 30]).doc, s.id, 10).doc;
  doc = insertPreset(doc, "cylinder", 20, 20, 5).doc;
  const g = new DependencyGraph();
  const notes = new ChangeNotes();
  syncGraph(g, doc, null, notes);
  g.set({ id: "plate", label: "Print plate", workspace: "slice", cost: "cheap" }, ["feature-11"]);
  g.set({ id: "cut", label: "Cut path", workspace: "laser", cost: "cheap" }, ["sketch-2"]);
  g.set({ id: "stress", label: "Stress", workspace: "simulate", cost: "expensive" }, [PART_VIEW]);
  for (const id of g.stale()) g.markFresh(id);
  let now = doc;
  /** Makes `next` the design; the results it put out of date, each with the words after its colon; then all fresh again. */
  const edit = (next: DesignDocument) => {
    syncGraph(g, next, now, notes);
    now = next;
    const out = Object.fromEntries(
      notes
        .current(g)
        .filter((n) => n.state !== "updated")
        .map((n) => [n.node, n.text.replace(/^[^:]*: /, "").replace(/ in Design\..*$/, "")]),
    );
    for (const id of g.stale()) g.markFresh(id);
    for (const n of notes.current(g)) notes.dismiss(n.id);
    return out;
  };
  return { doc, g, edit, now: () => now };
}

test("hand-worked: the ids and names the tests use", () => {
  const { doc } = linked();
  assert.deepEqual(doc.timeline.features.map((f) => `${f.id} ${itemCalled(f)}`), ["feature-1 the box", "sketch-2 Sketch 1", "feature-11 Extrude 1", "feature-12 the cylinder"]);
});

test("hand-worked: the marker moved past Extrude 1 puts its plate out of date, named as a marker move; and back again", () => {
  const { edit, now } = linked();
  // Marker on Sketch 1: Extrude 1 and the cylinder no longer build. The
  // plate's Extrude 1 is unchanged as data, but it builds no body now; the
  // part is the box now (it was the cylinder), so Stress hears too. The cut's
  // sketch still builds, unchanged: no note.
  assert.deepEqual(edit(moveMarker(now(), "sketch-2")), { plate: "you moved the timeline marker", stress: "you moved the timeline marker" });
  // Back to the end: the same two again.
  assert.deepEqual(edit(moveMarker(now(), null)), { plate: "you moved the timeline marker", stress: "you moved the timeline marker" });
  // The marker on the cylinder is the end already: everything builds as before, nothing is out of date.
  assert.deepEqual(edit(moveMarker(now(), "feature-12")), {});
});

test("hand-worked: suppressing names the item suppressed, for its own results and for what is built from it", () => {
  const { edit, now } = linked();
  // Extrude 1 suppressed: its plate. The part is still the cylinder: no Stress.
  assert.deepEqual(edit(suppressItem(now(), "feature-11", true)), { plate: "you suppressed Extrude 1" });
  assert.deepEqual(edit(suppressItem(now(), "feature-11", false)), { plate: "you unsuppressed Extrude 1" });
  // Sketch 1 suppressed: its cut, and Extrude 1's plate (Extrude 1 builds no body without it), both naming the sketch.
  assert.deepEqual(edit(suppressItem(now(), "sketch-2", true)), { plate: "you suppressed Sketch 1", cut: "you suppressed Sketch 1" });
  // The cylinder suppressed: the part is the box now (Extrude 1 still has its sketch suppressed), so Stress hears.
  assert.deepEqual(edit(suppressItem(now(), "feature-12", true)), { stress: "you suppressed the cylinder" });
});

test("hand-worked: editing an early item names it; a reorder that changes no build changes nothing outside the part", () => {
  const { edit, now } = linked();
  // Edit Sketch: a corner of Sketch 1 moved. The cut and, through Extrude 1, the plate.
  const sketch = now().sketches[0];
  assert.deepEqual(edit(movePoint(now(), "sketch-2", sketch.points[2].id, 50, 30)), { plate: "you changed Sketch 1", cut: "you changed Sketch 1" });
  // Edit feature: Extrude 1's distance 10 → 15. The plate only.
  assert.deepEqual(edit(editFeature(now(), "feature-11", { height: 15 })), { plate: "you changed Extrude 1" });
  // The cylinder moved to the front: every item still builds, but the part
  // (the last solid that builds) is Extrude 1 now, so Stress hears of it.
  const moved = reorderItem(now(), "feature-12", 0);
  if (!("doc" in moved)) return assert.fail(moved.message);
  assert.deepEqual(edit(moved.doc), { stress: "you reordered the timeline" });
  // A new body at the end is the part: Stress, named by what was added.
  assert.deepEqual(edit(insertPreset(now(), "sphere", 10, 10, 10).doc), { stress: "you added the sphere" });
});

test("hand-worked: a deleted sketch names the removal to its extrude's results, kept shape or not", () => {
  const { edit, now } = linked();
  const sketch = now().sketches[0];
  // Deleted with its last shape kept (what settleKept leaves): Extrude 1 still builds, from the kept shape, which is new.
  const keeping = { ...deleteItem(now(), "sketch-2"), kept: { "feature-11": { points: sketch.points, curves: sketch.curves } } };
  assert.deepEqual(edit(keeping), { plate: "you removed Sketch 1", cut: "you removed Sketch 1" });
});

test("hand-worked: a deleted sketch with no kept shape: Extrude 1 builds nothing, said as the removal", () => {
  const { edit, now } = linked();
  assert.deepEqual(edit(deleteItem(now(), "sketch-2")), { plate: "you removed Sketch 1", cut: "you removed Sketch 1" });
});

// ---- Seeded: random timeline edits against a model of what each one puts out of date ----

/** SplitMix64 inline (workspaces import only public packages). */
function rng(seed: bigint) {
  let s = seed;
  const M = (1n << 64n) - 1n;
  return () => {
    s = (s + 0x9e3779b97f4a7c15n) & M;
    let z = s;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & M;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & M;
    return Number((z ^ (z >> 31n)) >> 11n) / 2 ** 53;
  };
}

type Item = DesignDocument["timeline"]["features"][number];

/**
 * The model, written from the timeline rules (docs/progress/cad.md, decided
 * by the owner) rather than from Design's code: an item builds when it is at
 * or before the marker and not suppressed, and an extrude of a sketch also
 * needs its sketch to build or, with the sketch gone, a kept shape.
 */
function building(d: DesignDocument): Set<string> {
  const items = d.timeline.features;
  const marker = d.timeline.marker;
  const end = marker === undefined ? items.length : marker === "start" ? 0 : items.findIndex((f) => f.id === marker) + 1;
  const live = new Set(items.filter((f, i) => i < end && !f.suppressed).map((f) => f.id));
  const out = new Set<string>();
  for (const f of items) {
    if (!live.has(f.id)) continue;
    const sketch = f.intent.type === "extrude" ? (f.intent.parameters.sketch as string | undefined) : undefined;
    if (sketch !== undefined && !(items.some((x) => x.id === sketch) ? live.has(sketch) : d.kept?.[f.id] !== undefined)) continue;
    out.add(f.id);
  }
  return out;
}
/** The last solid item that builds: what the part's view reads. */
const partOf = (d: DesignDocument) => [...d.timeline.features].reverse().find((f) => f.intent.type !== "sketch" && building(d).has(f.id))?.id ?? null;
/** What a note calls an item: a sketch or an extrude of one by its label, a preset by its kind. */
const called = (f: Item) => (f.intent.type === "sketch" || "sketch" in f.intent.parameters ? f.provenance.self.label : f.intent.type === "extrude" ? "the extrusion" : `the ${f.intent.type}`);

test("seeded: random timeline edits put out of date exactly what the model says, each note naming the edit", () => {
  const reached = new Map<string, number>();
  for (const seed of [1n, 2n, 3n, 0x5eedn, 0xdeadbeefn]) {
    const next = rng(seed);
    const pick = <T>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)];
    // Start: a box, two sketches each extruded, a cylinder.
    let doc = partDocument("box", 40, 30, 20);
    for (const [x, y] of [[0, 0], [50, 0]]) {
      const s = addSketch(doc);
      doc = extrudeSketch(drawRectangle(s.doc, s.id, [x, y], [x + 10, y + 10]).doc, s.id, 5).doc;
    }
    doc = insertPreset(doc, "cylinder", 10, 10, 5).doc;
    const g = new DependencyGraph();
    const notes = new ChangeNotes();
    syncGraph(g, doc, null, notes);
    // A result in Slice for every item, and one in Simulate for the part's view.
    const results = new Map<string, string>();
    const watch = (d: DesignDocument) => {
      for (const f of d.timeline.features)
        if (!results.has(`r-${f.id}`)) {
          results.set(`r-${f.id}`, f.id);
          g.set({ id: `r-${f.id}`, label: `Result of ${f.id}`, workspace: "slice", cost: "cheap" }, [f.id]);
        }
    };
    watch(doc);
    g.set({ id: "r-view", label: "Stress", workspace: "simulate", cost: "expensive" }, [PART_VIEW]);
    for (const id of g.stale()) g.markFresh(id);
    for (let step = 0; step < 300; step++) {
      const at = `seed ${seed} step ${step}`;
      const items = doc.timeline.features;
      const solid = items.filter((f) => f.intent.type !== "sketch");
      const sketches = doc.sketches.filter((s) => items.some((f) => f.id === s.id));
      const r = next();
      let after: DesignDocument;
      let words: string;
      let kind: string;
      if (r < 0.2) {
        const to = pick([null, "start", ...items.map((f) => f.id)] as const);
        after = moveMarker(doc, to);
        [words, kind] = ["you moved the timeline marker", "marker"];
      } else if (r < 0.4) {
        const f = pick(items);
        after = suppressItem(doc, f.id, !f.suppressed);
        [words, kind] = [`you ${f.suppressed ? "unsuppressed" : "suppressed"} ${called(f)}`, "suppress"];
      } else if (r < 0.55 && sketches.length > 0) {
        const s = pick(sketches);
        const p = pick(s.points);
        after = movePoint(doc, s.id, p.id, p.x + pick([-1, 1]), p.y);
        [words, kind] = [`you changed ${called(items.find((f) => f.id === s.id)!)}`, "edit sketch"];
      } else if (r < 0.7 && solid.length > 0) {
        const f = pick(solid);
        const height = 1 + Math.floor(next() * 30);
        after = editFeature(doc, f.id, f.intent.type === "sphere" ? { width: height } : { height });
        [words, kind] = [`you changed ${called(f)}`, "edit feature"];
      } else if (r < 0.85) {
        const f = pick(items);
        const moved = reorderItem(doc, f.id, Math.floor(next() * items.length));
        if (!("doc" in moved)) continue;
        after = moved.doc;
        [words, kind] = ["you reordered the timeline", "reorder"];
      } else if (r < 0.93 && items.length > 2) {
        const f = pick(items);
        after = deleteItem(doc, f.id);
        [words, kind] = [`you removed ${called(f)}`, "delete"];
      } else {
        const k = pick(["box", "sphere", "cylinder"] as const);
        after = insertPreset(doc, k, 10 + Math.floor(next() * 10), 10, 10).doc;
        [words, kind] = [`you added the ${k}`, "add"];
      }
      // The model: an item's result is out of date when the item's own data
      // changed, or whether it builds, or its kept shape, or it is gone; or,
      // for an extrude, when its sketch is out of date that way. The part's
      // view: when the part is another item, or its item is out of date.
      const before = doc;
      const own = (d: DesignDocument, id: string) => JSON.stringify([d.timeline.features.find((f) => f.id === id) ?? null, d.sketches.find((s) => s.id === id) ?? null, d.kept?.[id] ?? null]);
      const [b0, b1] = [building(before), building(after)];
      const changed = (id: string) => own(before, id) !== own(after, id) || b0.has(id) !== b1.has(id);
      const out = new Set<string>();
      for (const f of before.timeline.features) {
        const sketch = f.intent.type === "extrude" ? (f.intent.parameters.sketch as string | undefined) : undefined;
        // An extrude reads its sketch only while the sketch is in the document after the edit.
        const reads = sketch !== undefined && after.timeline.features.some((x) => x.id === sketch);
        if (changed(f.id) || (reads && changed(sketch!))) out.add(`r-${f.id}`);
      }
      const part = partOf(after);
      if (partOf(before) !== part || (part !== null && out.has(`r-${part}`))) out.add("r-view");
      syncGraph(g, after, before, notes);
      doc = after;
      const stale = new Set(g.stale().filter((id) => id.startsWith("r-")));
      assert.deepEqual([...stale].sort(), [...out].sort(), `${at}: ${kind}`);
      for (const n of notes.current(g)) assert.equal(n.text.replace(/^[^:]*: /, "").replace(/ in Design\..*$/, ""), words, `${at}: ${kind}, ${n.node}`);
      if (out.size > 0) reached.set(kind, (reached.get(kind) ?? 0) + 1);
      for (const id of g.stale()) g.markFresh(id);
      for (const n of notes.current(g)) notes.dismiss(n.id);
      watch(doc);
      for (const id of g.stale()) g.markFresh(id);
    }
  }
  // Every kind of edit put something out of date at least ten times.
  for (const kind of ["marker", "suppress", "edit sketch", "edit feature", "reorder", "delete", "add"]) assert.ok((reached.get(kind) ?? 0) >= 10, `${kind}: ${reached.get(kind) ?? 0} (${JSON.stringify([...reached])})`);
});
