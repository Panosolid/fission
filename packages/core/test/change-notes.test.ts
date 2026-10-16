import { test } from "node:test";
import assert from "node:assert/strict";
import { DependencyGraph } from "../src/model/graph.ts";
import { ChangeNotes, noteText, type ChangeCause, type ChangeNoteState } from "../src/model/change-notes.ts";

/**
 * The example in integration.md: wall thickness (a Design parameter) feeds
 * the part; Slice's print plate and Simulate's stress result read the part.
 */
function sample() {
  const g = new DependencyGraph();
  g.set({ id: "thickness", label: "Wall thickness", workspace: "design", cost: "cheap" });
  g.set({ id: "part", label: "Part", workspace: "design", cost: "cheap" }, ["thickness"]);
  g.set({ id: "plate", label: "Print plate", workspace: "slice", cost: "cheap" }, ["part"]);
  g.set({ id: "stress", label: "Stress", workspace: "simulate", cost: "expensive" }, ["part"]);
  return g;
}
const thickness: ChangeCause = { node: "thickness", label: "Wall thickness", workspace: "design", change: "you changed wall thickness" };
const view = (notes: ChangeNotes, g: DependencyGraph) => notes.current(g).map((n) => [n.node, n.state, n.text]);

test("an edit in Design, worked out by hand: who gets a note, what it says, and its chain", () => {
  const g = sample();
  const notes = new ChangeNotes();
  // Wall thickness changes. Downstream of it: Part (Design), Print plate
  // (Slice, cheap) and Stress (Simulate, expensive). Part is in Design, where
  // the user just made the change, so it gets no note; the other two do.
  const made = notes.record(thickness, g.changed("thickness"), g);
  assert.equal(made.length, 2);
  // Print plate is cheap, so it is being rebuilt in the background: "updating".
  // Stress is expensive and waits for a rerun, which happens in Simulate.
  assert.deepEqual(view(notes, g), [
    ["plate", "updating", "Print plate updating: you changed wall thickness in Design."],
    ["stress", "needs-rerun", "Stress out of date: you changed wall thickness in Design. Rerun it in Simulate."],
  ]);
  // The chain: Print plate reads Part, which reads Wall thickness.
  assert.deepEqual(notes.current(g)[0].chain, ["Wall thickness in Design", "Part in Design", "Print plate in Slice"]);
  assert.deepEqual(notes.current(g)[1].chain, ["Wall thickness in Design", "Part in Design", "Stress in Simulate"]);
  // The rebuild finishes and the graph marks the plate fresh: the same note now says "updated".
  g.markFresh("plate");
  assert.deepEqual(view(notes, g)[0], ["plate", "updated", "Print plate updated: you changed wall thickness in Design."]);
  // Dismissed notes go; dismissing twice, or a made-up id, reports false.
  const plateNote = notes.current(g)[0].id;
  assert.equal(notes.dismiss(plateNote), true);
  assert.equal(notes.dismiss(plateNote), false);
  assert.equal(notes.dismiss("note-999"), false);
  assert.deepEqual(notes.current(g).map((n) => n.node), ["stress"]);
});

test("a change made in a downstream workspace notes results elsewhere, including Design's", () => {
  // Hypothetical reverse link: a Design hole reads a Circuit board outline.
  const g = new DependencyGraph();
  g.set({ id: "board", label: "Board outline", workspace: "circuit", cost: "cheap" });
  g.set({ id: "hole", label: "Mounting holes", workspace: "design", cost: "cheap" }, ["board"]);
  g.set({ id: "pcb-route", label: "Routing", workspace: "circuit", cost: "expensive" }, ["board"]);
  const notes = new ChangeNotes();
  notes.record({ node: "board", label: "Board outline", workspace: "circuit", change: "you moved a mounting hole" }, g.changed("board"), g);
  assert.deepEqual(view(notes, g), [["hole", "updating", "Mounting holes updating: you moved a mounting hole in Circuit."]]);
});

test("one note per result: a newer cause replaces the old note with a new id", () => {
  const g = sample();
  g.set({ id: "infill", label: "Infill", workspace: "design", cost: "cheap" });
  g.set({ id: "plate2", label: "Plate 2", workspace: "slice", cost: "cheap" }, ["part", "infill"]);
  const notes = new ChangeNotes();
  notes.record(thickness, g.changed("thickness"), g);
  const old = notes.current(g).find((n) => n.node === "plate2")!.id;
  notes.record({ node: "infill", label: "Infill", workspace: "design", change: "you changed infill" }, g.changed("infill"), g);
  const now = notes.current(g).filter((n) => n.node === "plate2");
  assert.equal(now.length, 1);
  assert.notEqual(now[0].id, old);
  assert.equal(now[0].text, "Plate 2 updating: you changed infill in Design.");
  assert.deepEqual(now[0].chain, ["Infill in Design", "Plate 2 in Slice"]);
  // The old id is gone, so dismissing it can't hide the newer note.
  assert.equal(notes.dismiss(old), false);
  assert.equal(notes.current(g).filter((n) => n.node === "plate2").length, 1);
  // Notes stay oldest first: plate and stress came from the first change, plate2 from the second.
  assert.deepEqual(notes.current(g).map((n) => n.node), ["plate", "stress", "plate2"]);
});

test("removing the cause: the note keeps its name, and the chain still reaches it", () => {
  const g = sample();
  const notes = new ChangeNotes();
  notes.record({ ...thickness, change: "you deleted wall thickness" }, g.remove("thickness"), g);
  assert.equal(g.has("thickness"), false);
  const plate = notes.current(g)[0];
  assert.equal(plate.text, "Print plate updating: you deleted wall thickness in Design.");
  assert.deepEqual(plate.chain, ["Wall thickness in Design", "Part in Design", "Print plate in Slice"]);
});

test("a note about a result that left the project is dropped", () => {
  const g = sample();
  const notes = new ChangeNotes();
  notes.record(thickness, g.changed("thickness"), g);
  g.remove("plate");
  assert.deepEqual(notes.current(g).map((n) => n.node), ["stress"]);
  // Putting a node with the same id back doesn't bring the old note back.
  g.set({ id: "plate", label: "Print plate", workspace: "slice", cost: "cheap" }, ["part"]);
  assert.deepEqual(notes.current(g).map((n) => n.node), ["stress"]);
});

test("refusals: a cause with no words, and a staleness list that isn't this graph's", () => {
  const g = sample();
  const notes = new ChangeNotes();
  const s = g.changed("thickness");
  assert.throws(() => notes.record({ ...thickness, change: "  " }, s, g), /needs to say what changed/);
  assert.throws(() => notes.record({ ...thickness, label: "" }, s, g), /needs a label/);
  assert.throws(() => notes.record(thickness, { updateNow: ["ghost"], awaitingRerun: [] }, g), /ghost is not in the project/);
  // Stress doesn't read Print plate, so a note blaming the plate is a mistake.
  assert.throws(() => notes.record({ node: "plate", label: "Print plate", workspace: "slice", change: "x" }, { updateNow: [], awaitingRerun: ["stress"] }, g), /Stress does not read Print plate/);
  // Nothing was recorded by the refused calls.
  assert.deepEqual(notes.current(g), []);
});

test("noteText for each state", () => {
  const r = { label: "Toolpath", workspace: "manufacture" as const };
  const c: ChangeCause = { node: "p", label: "P", workspace: "design", change: "you made the pocket deeper" };
  assert.equal(noteText(r, c, "updated"), "Toolpath updated: you made the pocket deeper in Design.");
  assert.equal(noteText(r, c, "updating"), "Toolpath updating: you made the pocket deeper in Design.");
  assert.equal(noteText(r, c, "needs-rerun"), "Toolpath out of date: you made the pocket deeper in Design. Rerun it in Manufacture.");
});

test("graph.path: the shortest chain, ties to the first input, worked out by hand", () => {
  //   a → b → d        a → d is two steps either way (through b or c);
  //   a → c → d        b is d's first input, so the chain goes through b.
  //   a → e → f → g    and g also reads d: a → b → d → g (3 steps) beats a → e → f → g (3)? equal, so
  //   d → g            g's inputs are [f, d]: f first, so a → e → f → g.
  const g = new DependencyGraph();
  for (const id of ["a"]) g.set({ id, label: id, workspace: "design", cost: "cheap" });
  g.set({ id: "b", label: "b", workspace: "design", cost: "cheap" }, ["a"]);
  g.set({ id: "c", label: "c", workspace: "design", cost: "cheap" }, ["a"]);
  g.set({ id: "d", label: "d", workspace: "design", cost: "cheap" }, ["b", "c"]);
  g.set({ id: "e", label: "e", workspace: "design", cost: "cheap" }, ["a"]);
  g.set({ id: "f", label: "f", workspace: "design", cost: "cheap" }, ["e"]);
  g.set({ id: "g", label: "g", workspace: "design", cost: "cheap" }, ["f", "d"]);
  g.set({ id: "h", label: "h", workspace: "design", cost: "cheap" }, ["g", "a"]);
  assert.deepEqual(g.path("a", "d"), ["a", "b", "d"]);
  assert.deepEqual(g.path("a", "g"), ["a", "e", "f", "g"]);
  // h reads a directly: one step beats going through g.
  assert.deepEqual(g.path("a", "h"), ["a", "h"]);
  assert.deepEqual(g.path("c", "h"), ["c", "d", "g", "h"]);
  // Not reading it, the wrong way round, itself, or unknown ids: no chain.
  assert.equal(g.path("b", "c"), undefined);
  assert.equal(g.path("d", "a"), undefined);
  assert.equal(g.path("a", "a"), undefined);
  assert.equal(g.path("zz", "d"), undefined);
});

test("seeded random sessions: notes match a model of the graph, and every chain is a real chain", () => {
  // SplitMix64 inline (core can't import packages/testing, which imports core).
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
  const workspaces = ["design", "slice", "simulate"] as const;
  for (const seed of [0x5eedn, 1n, 2n, 3n, 0xdeadbeefn]) {
    const next = rng(seed);
    const pick = <T>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)];
    const g = new DependencyGraph();
    const notes = new ChangeNotes();
    // Fixed layout so every node has a known workspace and cost: n0..n7, each reading some earlier ones.
    const ids = Array.from({ length: 8 }, (_, i) => `n${i}`);
    const ws = new Map(ids.map((id, i) => [id, workspaces[i % 3]]));
    const cost = new Map(ids.map((id, i) => [id, (i % 4 === 3 ? "expensive" : "cheap") as "cheap" | "expensive"]));
    // The model: node → {cause workspace, cause label} of its live note, or absent.
    const model = new Map<string, { causeWs: string; change: string }>();
    // The test's own copy of who reads whom (kept even after removal, like the graph's dangling inputs).
    const reads = new Map<string, string[]>();
    // Shortest number of steps from `from` to `to`, by plain breadth-first search over the test's copy.
    const steps = (from: string, to: string) => {
      let frontier = [from];
      for (let d = 1; frontier.length; d++) {
        const nextFrontier = ids.filter((x) => (reads.get(x) ?? []).some((r) => frontier.includes(r)));
        if (nextFrontier.includes(to)) return d;
        frontier = nextFrontier;
        if (d > ids.length) return Infinity;
      }
      return Infinity;
    };
    const byLabel = (line: string) => line.split(" in ")[0].toLowerCase();
    for (let step = 0; step < 2000; step++) {
      const at = `seed ${seed} step ${step}`;
      const id = pick(ids);
      const op = next();
      if (op < 0.3) {
        if (g.has(id) && g.downstreamOf(id).size > 0) continue; // replacing a node others read is allowed but keeps the model simple to skip
        const i = ids.indexOf(id);
        const deps = ids.slice(0, i).filter((d) => g.has(d) && next() < 0.4);
        g.set({ id, label: id.toUpperCase(), workspace: ws.get(id)!, cost: cost.get(id)! }, deps);
        reads.set(id, deps);
      } else if (op < 0.6) {
        if (!g.has(id)) continue;
        const change = `edit ${step}`;
        const remove = next() < 0.15;
        const s = remove ? g.remove(id) : g.changed(id);
        notes.record({ node: id, label: id.toUpperCase(), workspace: ws.get(id)!, change }, s, g);
        for (const x of [...s.updateNow, ...s.awaitingRerun]) if (ws.get(x) !== ws.get(id)) model.set(x, { causeWs: ws.get(id)!, change });
        // Just recorded, so each new chain must be a real chain in the graph as it is now: from the cause,
        // each entry read directly by the next, as short as possible, ending at the result.
        for (const n of notes.current(g).filter((n) => n.text.includes(`${change} in `))) {
          const chain = n.chain.map(byLabel);
          assert.equal(chain[0], id, `${at}: chain starts at the cause`);
          assert.equal(chain.at(-1), n.node, `${at}: chain ends at the result`);
          for (let k = 1; k < chain.length; k++) assert.ok(reads.get(chain[k])!.includes(chain[k - 1]), `${at}: ${chain[k]} reads ${chain[k - 1]}`);
          assert.equal(chain.length - 1, steps(id, n.node), `${at}: chain ${chain.join(">")} is the shortest`);
        }
        if (remove) model.delete(id);
      } else if (op < 0.85) {
        g.markFresh(id);
      } else {
        const shown = notes.current(g);
        if (shown.length === 0) continue;
        const n = pick(shown);
        assert.equal(notes.dismiss(n.id), true, at);
        model.delete(n.node);
      }
      const shown = notes.current(g);
      for (const k of [...model.keys()]) if (!g.has(k)) model.delete(k);
      assert.deepEqual(shown.map((n) => n.node).sort(), [...model.keys()].sort(), `${at}: which results have notes`);
      for (const n of shown) {
        const m = model.get(n.node)!;
        const want: ChangeNoteState = !g.isStale(n.node) ? "updated" : cost.get(n.node) === "cheap" ? "updating" : "needs-rerun";
        assert.equal(n.state, want, `${at}: ${n.node} state`);
        assert.notEqual(m.causeWs, ws.get(n.node), `${at}: same-workspace note`);
        assert.ok(n.text.startsWith(`${n.node.toUpperCase()} `) && n.text.includes(`${m.change} in `), `${at}: ${n.text}`);
        assert.ok(n.chain.length >= 2, `${at}: chain`);
        assert.ok(n.chain.at(-1)!.startsWith(`${n.node.toUpperCase()} in `), `${at}: chain ends at the result`);
      }
    }
  }
});

test("onChange: told when a note is made or dismissed, not when a record makes none", () => {
  const g = sample();
  const notes = new ChangeNotes();
  let calls = 0;
  const stop = notes.onChange(() => calls++);
  // Part changing reaches only Slice and Simulate results: one call for the batch.
  notes.record({ ...thickness, node: "part", label: "Part" }, g.changed("part"), g);
  assert.equal(calls, 1);
  // A change with no readers outside Design makes no note and no call.
  notes.record(thickness, { updateNow: ["part"], awaitingRerun: [] }, g);
  assert.equal(calls, 1);
  const [first] = notes.current(g);
  notes.dismiss(first.id);
  assert.equal(calls, 2);
  notes.dismiss(first.id); // already gone
  assert.equal(calls, 2);
  stop();
  notes.record(thickness, g.changed("thickness"), g);
  assert.equal(calls, 2);
});
