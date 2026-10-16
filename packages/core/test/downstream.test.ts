import { test } from "node:test";
import assert from "node:assert/strict";
import { DependencyGraph } from "../src/model/graph.ts";
import { DownstreamRegistry, summarize, type DownstreamSource, type DownstreamState } from "../src/model/downstream.ts";

/** A summary whose value the test sets. */
function source(over: Partial<DownstreamSource> & Pick<DownstreamSource, "id" | "workspace" | "node">, value?: string): DownstreamSource & { set(v: string | undefined): void } {
  let v = value;
  return {
    label: over.id,
    value: () => v,
    preview: () => `preview of ${over.id}`,
    set(x) {
      v = x;
    },
    ...over,
  };
}

/** The graph integration.md describes: a part, a cheap print estimate and an expensive stress result read from it. */
function sample() {
  const g = new DependencyGraph();
  g.set({ id: "part", label: "Part", workspace: "design", cost: "cheap" });
  g.set({ id: "print", label: "Print estimate", workspace: "slice", cost: "cheap" }, ["part"]);
  g.set({ id: "stress", label: "Stress", workspace: "simulate", cost: "expensive" }, ["part"]);
  const print = source({ id: "slice.print-estimate", workspace: "slice", node: "print", label: "Print" }, "2 h 14 m · 38 g");
  const stress = source({ id: "simulate.safety-factor", workspace: "simulate", node: "stress", label: "Safety factor" }, "1.4");
  const r = new DownstreamRegistry();
  r.register(print);
  r.register(stress);
  return { g, r, print, stress };
}
const states = (r: DownstreamRegistry, g: DependencyGraph) => r.summaries("design", g).map((s) => [s.label, s.value, s.state]);

test("chip states through an edit, worked out by hand from the graph", () => {
  const { g, r, print } = sample();
  // Nothing changed yet: both results were worked out from this part, so both are current.
  assert.deepEqual(states(r, g), [
    ["Print", "2 h 14 m · 38 g", "fresh"],
    ["Safety factor", "1.4", "fresh"],
  ]);
  // The part changes: both read it, so both are out of date. The print
  // estimate is cheap (rebuilt in the background: "updating"); stress is
  // expensive (waits for a rerun). Both keep their old values, now marked.
  g.changed("part");
  assert.deepEqual(states(r, g), [
    ["Print", "2 h 14 m · 38 g", "updating"],
    ["Safety factor", "1.4", "needs-rerun"],
  ]);
  // The background rebuild finishes: a new value, and the graph marks it fresh. Stress still waits.
  print.set("2 h 20 m · 40 g");
  g.markFresh("print");
  assert.deepEqual(states(r, g), [
    ["Print", "2 h 20 m · 40 g", "fresh"],
    ["Safety factor", "1.4", "needs-rerun"],
  ]);
  // The workspace having a new value is not enough: only the graph says it is current.
  g.changed("part");
  print.set("2 h 30 m · 41 g");
  assert.equal(r.summaries("design", g)[0].state, "updating");
});

test("a result never worked out shows as waiting, not as current, even when the graph has no mark on it", () => {
  const { g, r, print, stress } = sample();
  print.set(undefined);
  stress.set(undefined);
  // Neither node is stale (nothing changed), but neither has a value: the cheap one is being worked out, the expensive one waits to be run.
  assert.deepEqual(states(r, g), [
    ["Print", undefined, "updating"],
    ["Safety factor", undefined, "needs-rerun"],
  ]);
});

test("a summary whose graph node is gone says so and shows no value", () => {
  const { g, r } = sample();
  g.remove("print");
  const [chip] = r.summaries("design", g);
  assert.deepEqual({ value: chip.value, cost: chip.cost, state: chip.state }, { value: undefined, cost: undefined, state: "missing" });
  // A node that was never added is the same.
  const lone = source({ id: "laser.cut-time", workspace: "laser", node: "nowhere" }, "6 min");
  assert.equal(summarize(lone, g).state, "missing");
});

test("a chip carries its label, preview, cost and the workspace a click goes to", () => {
  const { g, r } = sample();
  const [print, stress] = r.summaries("design", g);
  assert.deepEqual(print, { id: "slice.print-estimate", label: "Print", value: "2 h 14 m · 38 g", cost: "cheap", state: "fresh", preview: "preview of slice.print-estimate", target: "slice" });
  assert.equal(stress.cost, "expensive");
  assert.equal(stress.target, "simulate");
});

test("a panel shows other workspaces' summaries, in registration order, never its own", () => {
  const { g, r } = sample();
  assert.deepEqual(r.summaries("design", g).map((s) => s.id), ["slice.print-estimate", "simulate.safety-factor"]);
  assert.deepEqual(r.summaries("slice", g).map((s) => s.id), ["simulate.safety-factor"]);
  // An empty registry (today: no downstream workspace is real) gives Design no chips.
  assert.deepEqual(new DownstreamRegistry().summaries("design", g), []);
  assert.equal(r.size, 2);
});

test("each bad registration is refused with its own reason", () => {
  const { r } = sample();
  const ok = { id: "laser.cut-time", workspace: "laser" as const, node: "cut" };
  assert.throws(() => r.register(source({ ...ok, id: "slice.print-estimate", workspace: "slice" })), /slice\.print-estimate is already registered/);
  assert.throws(() => r.register(source({ ...ok, id: "slice.cut-time" })), /must be "laser\.<name>"/);
  assert.throws(() => r.register(source({ ...ok, id: "laser.Cut Time" })), /must be "laser\.<name>" in lower case/);
  assert.throws(() => r.register(source({ ...ok, id: "design.mass", workspace: "design" })), /Design is upstream of everything/);
  assert.throws(() => r.register(source({ ...ok, label: "  " })), /laser\.cut-time needs a label/);
  assert.throws(() => r.register(source({ ...ok, node: "" })), /laser\.cut-time needs the graph node it is/);
  // None of the refused ones got in; the good one does.
  assert.equal(r.size, 2);
  r.register(source(ok));
  assert.equal(r.size, 3);
});

test("graph.node gives a node's details, or undefined", () => {
  const { g } = sample();
  assert.equal(g.node("stress")?.cost, "expensive");
  assert.equal(g.node("nope"), undefined);
});

test("seeded random sessions: a chip is current exactly when its node exists, is unmarked and has a value", () => {
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
  for (const seed of [0x5eedn, 1n, 2n, 3n, 0xdeadbeefn]) {
    const next = rng(seed);
    const g = new DependencyGraph();
    g.set({ id: "part", label: "Part", workspace: "design", cost: "cheap" });
    const ids = ["a", "b", "c", "d"];
    const cost = (i: number) => (i % 2 === 0 ? "cheap" : "expensive") as const;
    const sources = ids.map((n) => source({ id: `slice.${n}`, workspace: "slice", node: n }, "1 h"));
    const r = new DownstreamRegistry();
    sources.forEach((s) => r.register(s));
    // The model, kept apart from the graph: which nodes exist and are marked.
    const exists = new Set<string>();
    const marked = new Set<string>();
    const values = new Map<string, string | undefined>(ids.map((n) => [n, "1 h"]));
    for (let step = 0; step < 2000; step++) {
      const at = `seed ${seed} step ${step}`;
      const i = Math.floor(next() * ids.length);
      const n = ids[i];
      const op = next();
      if (op < 0.25) {
        // (Re)add the node, reading the part and, for b/d, the node before it.
        const deps = ["part", ...(i % 2 === 1 && exists.has(ids[i - 1]) ? [ids[i - 1]] : [])];
        // Replacing a node others read would leave them reading a new one; the graph allows it.
        g.set({ id: n, label: n, workspace: "slice", cost: cost(i) }, deps);
        exists.add(n);
      } else if (op < 0.45) {
        g.changed("part");
        for (const x of exists) marked.add(x);
      } else if (op < 0.6) {
        g.markFresh(n);
        marked.delete(n);
      } else if (op < 0.7) {
        if (exists.has(n)) {
          const downstream = [...g.downstreamOf(n)];
          g.remove(n);
          exists.delete(n);
          marked.delete(n);
          for (const x of downstream) marked.add(x);
        }
      } else {
        const v = next() < 0.3 ? undefined : `${Math.floor(next() * 10)} h`;
        sources[i].set(v);
        values.set(n, v);
      }
      for (const [k, chip] of r.summaries("design", g).entries()) {
        const id = ids[k];
        const want: DownstreamState = !exists.has(id) ? "missing" : !marked.has(id) && values.get(id) !== undefined ? "fresh" : cost(k) === "cheap" ? "updating" : "needs-rerun";
        assert.equal(chip.state, want, `${at}: ${id}`);
        assert.equal(chip.value, exists.has(id) ? values.get(id) : undefined, `${at}: ${id} value`);
      }
    }
  }
});
