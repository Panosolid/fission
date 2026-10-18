// The dependency graph at the size of a big file (security audit S2):
// downstreamOf finds readers through an index instead of searching every
// node for each one it reaches, which took a 5,000-item design's length
// squared or worse. Its answers, order included, must be what the search
// gave: checked against that search, kept here as the model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DependencyGraph } from "../src/model/graph.ts";

const node = (id: string) => ({ id, label: id, workspace: "design" as const, cost: "cheap" as const });

/** The search downstreamOf did before the index, over a copy of the graph's inputs in their map order. */
function searched(inputs: Map<string, string[]>, id: string): string[] {
  const seen = new Set<string>();
  const walk = (x: string) => {
    for (const [n, ins] of inputs) if (ins.includes(x) && !seen.has(n)) (seen.add(n), walk(n));
  };
  walk(id);
  return [...seen];
}

test("downstream order worked by hand: depth first, readers in the order they entered", () => {
  // a ← b ← d, a ← c, then b set again (it keeps its place), then e reading a.
  // From a: b first (it entered before c), then b's reader d, then c, then e.
  const g = new DependencyGraph();
  for (const id of ["a"]) g.set(node(id));
  g.set(node("b"), ["a"]);
  g.set(node("c"), ["a"]);
  g.set(node("d"), ["b"]);
  g.set(node("b"), ["a"]);
  g.set(node("e"), ["a"]);
  assert.deepEqual([...g.downstreamOf("a")], ["b", "d", "c", "e"]);
  // b removed: d keeps its dangling input but is no longer reached from a.
  g.remove("b");
  assert.deepEqual([...g.downstreamOf("a")], ["c", "e"]);
  // b back: it enters last now, so it comes after e.
  g.set(node("b"), ["a"]);
  assert.deepEqual([...g.downstreamOf("a")], ["c", "e", "b", "d"]);
  // c re-pointed from a to e: a's readers are e and b; c is found through e.
  g.set(node("c"), ["e"]);
  assert.deepEqual([...g.downstreamOf("a")], ["e", "c", "b", "d"]);
});

/** splitmix64: the same seed gives the same graph. */
function rng(seed: bigint) {
  let s = seed;
  const M = (1n << 64n) - 1n;
  return (n: number) => {
    s = (s + 0x9e3779b97f4a7c15n) & M;
    let z = s;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & M;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & M;
    return Number((z ^ (z >> 31n)) % BigInt(n));
  };
}

test("seeded random graphs: downstreamOf gives exactly what the search gave, order included", () => {
  for (const seed of [1n, 2n, 3n, 0x5eedn, 0xdeadbeefn]) {
    const pick = rng(seed);
    const g = new DependencyGraph();
    const inputs = new Map<string, string[]>(); // the model: what set and remove leave, in map order
    const ids = Array.from({ length: 30 }, (_, i) => `n${i}`);
    let compared = 0;
    for (let step = 0; step < 600; step++) {
      const id = ids[pick(ids.length)];
      if (pick(5) === 0 && g.has(id)) {
        g.remove(id);
        inputs.delete(id);
      } else {
        const present = ids.filter((x) => g.has(x) && x !== id && !g.downstreamOf(id).has(x));
        const deps = Array.from({ length: pick(4) }, () => present[pick(Math.max(1, present.length))]).filter((x) => x !== undefined);
        g.set(node(id), deps);
        inputs.set(id, deps);
      }
      for (const x of ids) {
        if (!g.has(x)) continue;
        assert.deepEqual([...g.downstreamOf(x)], searched(inputs, x), `seed ${seed}, step ${step}, from ${x}`);
        compared++;
      }
    }
    assert.ok(compared > 5000, `seed ${seed}: ${compared} comparisons`);
  }
});

test("a chain of 100,000 is walked with no stack overflow, in time in proportion to it", () => {
  // The search recursed once per id and scanned every node at each: 100,000² = 10^10 steps.
  const g = new DependencyGraph();
  g.set(node("c0"));
  for (let i = 1; i < 100_000; i++) g.set(node(`c${i}`), [`c${i - 1}`]);
  const t = performance.now();
  const down = g.downstreamOf("c0");
  assert.equal(down.size, 99_999);
  assert.equal([...down].at(-1), "c99999");
  assert.ok(performance.now() - t < 2000, `${performance.now() - t} ms`);
});

test("each part of the index can fail: a reader left after re-pointing, or entry order lost, is caught", () => {
  // The two mistakes the index could make, shown on the hand-worked graph's answers above:
  // a stale reader would put c back under a after `set(c, [e])` (a, then c twice-reached as a reader of a first);
  // a Set without entry order would put b (set again) after c.
  const g = new DependencyGraph();
  g.set(node("a"));
  g.set(node("b"), ["a"]);
  g.set(node("c"), ["a"]);
  g.set(node("b"), ["a"]);
  assert.deepEqual([...g.downstreamOf("a")], ["b", "c"], "b set again keeps its place before c");
  g.set(node("e"), ["a"]);
  g.set(node("c"), ["e"]);
  assert.deepEqual([...g.downstreamOf("a")], ["b", "e", "c"], "c is no longer a's own reader");
  g.remove("e");
  assert.deepEqual([...g.downstreamOf("a")], ["b"], "nothing is reached through a removed node");
});
