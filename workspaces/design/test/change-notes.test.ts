// Design's edits make change notes for results in other workspaces (X5b).
// Nothing in another workspace reads the design yet, so these tests stand
// in a Slice print plate, a Simulate stress result and a Laser cut, as the
// first cross-workspace links will.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ChangeNotes, DependencyGraph } from "@fission/core";
import { partDocument } from "../src/document.ts";
import { changeWords, PART_VIEW, syncGraph } from "../src/graph.ts";
import type { ShapeKind } from "../src/profiles.ts";

/** A box in the graph, built and fresh, with a plate reading the feature and a stress result reading the part's view. */
function linked() {
  const g = new DependencyGraph();
  const notes = new ChangeNotes();
  const doc = partDocument("box", 40, 30, 20);
  syncGraph(g, doc, null, notes);
  g.set({ id: "plate", label: "Print plate", workspace: "slice", cost: "cheap" }, ["feature-1"]);
  g.set({ id: "stress", label: "Stress", workspace: "simulate", cost: "expensive" }, [PART_VIEW]);
  for (const id of g.stale()) g.markFresh(id);
  return { g, notes, doc };
}
const view = (notes: ChangeNotes, g: DependencyGraph) => notes.current(g).map((n) => [n.node, n.workspace, n.state, n.text]);

test("the words: what the user did to each kind of thing", () => {
  assert.equal(changeWords("box"), "you changed the box");
  assert.equal(changeWords("extrude"), "you changed the extrusion");
  assert.equal(changeWords("profile", true), "you removed the profile");
});

test("an edit, worked out by hand: notes for Slice and Simulate, none for Design's own results", () => {
  const { g, notes, doc } = linked();
  assert.deepEqual(notes.current(g), [], "building the part names no cause");
  // Width 40 → 41 changes feature-1. Downstream of it: Design's part view
  // (no note: the user is looking at Design), the plate (reads feature-1,
  // cheap, so it is rebuilding: "updating") and stress (reads the view,
  // expensive, so it waits: "out of date … Rerun it in Simulate.").
  syncGraph(g, partDocument("box", 41, 30, 20), doc, notes);
  assert.deepEqual(view(notes, g), [
    ["plate", "slice", "updating", "Print plate updating: you changed the box in Design."],
    ["stress", "simulate", "needs-rerun", "Stress out of date: you changed the box in Design. Rerun it in Simulate."],
  ]);
  // Chains: plate reads feature-1 directly; stress reads the view, which reads feature-1.
  const [plate, stress] = notes.current(g);
  assert.deepEqual(plate.chain, ["Box: 41 × 30 × 20 mm in Design", "Print plate in Slice"]);
  assert.deepEqual(stress.chain, ["Box: 41 × 30 × 20 mm in Design", "Volume, area and mesh in Design", "Stress in Simulate"]);
});

test("an unchanged edit makes no note", () => {
  const { g, notes, doc } = linked();
  syncGraph(g, partDocument("box", 40, 30, 20), doc, notes);
  assert.deepEqual(notes.current(g), []);
});

test("a removed profile names the removal to the cut that read it", () => {
  const g = new DependencyGraph();
  const notes = new ChangeNotes();
  const bracket = partDocument("l-bracket", 40, 30, 20);
  syncGraph(g, bracket, null, notes);
  g.set({ id: "cut", label: "Cut path", workspace: "laser", cost: "cheap" }, ["profile-1"]);
  for (const id of g.stale()) g.markFresh(id);
  // Bracket → box: feature-1 changes (nothing outside Design reads it) and
  // profile-1 goes. The cut still reads profile-1, so the removal reaches it.
  syncGraph(g, partDocument("box", 40, 30, 20), bracket, notes);
  assert.deepEqual(view(notes, g), [["cut", "laser", "updating", "Cut path updating: you removed the profile in Design."]]);
  // The chain keeps the gone profile's name.
  assert.deepEqual(notes.current(g)[0].chain, ["Profile profile-1 in Design", "Cut path in Laser"]);
});

test("seeded random edits: Design's notes match a model of what each edit means", () => {
  // SplitMix64 inline (workspaces import only public packages).
  const rng = (seed: bigint) => {
    let s = seed;
    const M = (1n << 64n) - 1n;
    return () => {
      s = (s + 0x9e3779b97f4a7c15n) & M;
      let z = s;
      z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & M;
      z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & M;
      return Number((z ^ (z >> 31n)) >> 11n) / 2 ** 53;
    };
  };
  const kinds: ShapeKind[] = ["box", "cylinder", "sphere", "l-bracket", "plate", "slot", "star"];
  // The model, written from what the panel shows rather than from the
  // document: which numbers each shape uses, and what the user would call it.
  const used = (k: ShapeKind, w: number, d: number, h: number) =>
    JSON.stringify(k === "box" ? [k, w, d, h] : k === "cylinder" ? [k, w, h] : k === "sphere" ? [k, w] : [k, w, d, h]);
  const called = (k: ShapeKind) => (k === "box" || k === "cylinder" || k === "sphere" ? `the ${k}` : "the extrusion");
  for (const seed of [0x5eedn, 1n, 2n, 3n, 0xdeadbeefn]) {
    const next = rng(seed);
    const pick = <T>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)];
    const { g, notes } = linked();
    let doc = partDocument("box", 40, 30, 20);
    let shown = used("box", 40, 30, 20);
    /** The model's notes: result → [state, cause words]. */
    const model = new Map<string, { fresh: boolean; words: string }>();
    for (let step = 0; step < 1000; step++) {
      const at = `seed ${seed} step ${step}`;
      const r = next();
      if (r < 0.6) {
        const k = pick(kinds);
        const [w, d, h] = [pick([10, 20, 40, 41]), pick([10, 30, 31]), pick([5, 20, 21])];
        const after = partDocument(k, w, d, h);
        syncGraph(g, after, doc, notes);
        doc = after;
        // Any change the user can see reaches both results; the note names the shape it is now.
        if (used(k, w, d, h) !== shown) for (const id of ["plate", "stress"]) model.set(id, { fresh: false, words: `you changed ${called(k)}` });
        shown = used(k, w, d, h);
      } else if (r < 0.8) {
        const id = pick(["plate", "stress"]);
        g.markFresh(id);
        const m = model.get(id);
        if (m) m.fresh = true;
      } else {
        const note = pick(notes.current(g));
        if (note) {
          assert.equal(notes.dismiss(note.id), true, at);
          model.delete(note.node);
        }
      }
      const expected = [...model]
        .map(([id, m]) => {
          const [label, where, cost] = id === "plate" ? ["Print plate", "Slice", "cheap"] : ["Stress", "Simulate", "expensive"];
          const why = `${m.words} in Design.`;
          return [id, m.fresh ? `${label} updated: ${why}` : cost === "cheap" ? `${label} updating: ${why}` : `${label} out of date: ${why} Rerun it in ${where}.`];
        })
        .sort();
      const got = notes
        .current(g)
        .map((n) => [n.node, n.text])
        .sort();
      assert.deepEqual(got, expected, at);
      for (const n of notes.current(g)) {
        assert.notEqual(n.workspace, "design", `${at}: no note about Design's own results`);
        assert.equal(n.chain.at(-1), n.node === "plate" ? "Print plate in Slice" : "Stress in Simulate", at);
      }
    }
  }
});
