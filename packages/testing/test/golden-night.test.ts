// The golden models' nightly run without the kernel (step 28b,
// golden/night.ts, baseline/golden.ts): the shuffle, hand-worked and
// against every order counted over seeded shuffles; where two answers
// first differ; the failed percent; and the report file_issues.py reads.
// The run itself, on the real kernel with planted bugs, is
// journeys/golden-night.journey.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { firstDifference } from "../golden/rebuild.ts";
import { goldenReport, replay, shuffled, type GoldenNight } from "../golden/night.ts";
import { failedPercent, goldenMetric } from "../baseline/golden.ts";
import { seeded } from "../src/index.ts";

test("the shuffle, worked by hand", () => {
  // Fisher–Yates from the end: i = 2 swaps with j = floor(next · 3), then i = 1 with floor(next · 2).
  // next always 0: i = 2 swaps a and c, [c, b, a]; i = 1 swaps c and b, [b, c, a].
  assert.deepEqual(shuffled(["a", "b", "c"], () => 0), ["b", "c", "a"]);
  // next always 0.999: j = i each time, nothing moves.
  assert.deepEqual(shuffled(["a", "b", "c"], () => 0.999), ["a", "b", "c"]);
  // 0.5: i = 2, j = floor(1.5) = 1, swap b and c, [a, c, b]; i = 1, j = floor(1) = 1, stays.
  assert.deepEqual(shuffled(["a", "b", "c"], () => 0.5), ["a", "c", "b"]);
  // The input is left alone; one item and none shuffle to themselves.
  const input = ["a", "b"];
  shuffled(input, () => 0);
  assert.deepEqual(input, ["a", "b"]);
  assert.deepEqual(shuffled(["a"], () => 0), ["a"]);
  assert.deepEqual(shuffled([], () => 0), []);
});

test("seeded shuffles are permutations, the same for the same seed, and each of the 3! orders comes up about equally often", () => {
  for (const seed of [1n, 2n, 3n]) {
    const r = seeded(seed);
    const counts = new Map<string, number>();
    for (let i = 0; i < 6000; i++) {
      const o = shuffled(["a", "b", "c"], r.next);
      assert.deepEqual([...o].sort(), ["a", "b", "c"]);
      counts.set(o.join(""), (counts.get(o.join("")) ?? 0) + 1);
    }
    // 6 orders, 1000 each expected; the count is binomial(6000, 1/6), σ = √(6000 · 1/6 · 5/6) ≈ 28.9, so ±150 is over 5σ.
    assert.equal(counts.size, 6, `seed ${seed}`);
    for (const [o, n] of counts) assert.ok(Math.abs(n - 1000) < 150, `seed ${seed}: ${o} came up ${n} times`);
    const again = seeded(seed);
    const s = seeded(seed);
    assert.deepEqual(shuffled([1, 2, 3, 4, 5, 6], again.next), shuffled([1, 2, 3, 4, 5, 6], s.next));
  }
});

test("where two answers first differ", () => {
  assert.equal(firstDifference({ a: 1, b: [1, 2] }, { a: 1, b: [1, 2] }), null);
  assert.equal(firstDifference({ a: 1, b: [1, 2] }, { a: 1, b: [1, 3] }), "b[1]: 2 then 3");
  assert.equal(firstDifference({ bodies: [{ volume: 1 }] }, { bodies: [{ volume: 1 + 2 ** -52 }] }), `bodies[0].volume: 1 then ${1 + 2 ** -52}`);
  // -0 and 0 are different answers (a normal's sign); NaN is the same answer as NaN.
  assert.equal(firstDifference({ x: -0 }, { x: 0 }), "x: -0 then 0");
  assert.equal(firstDifference({ x: NaN }, { x: NaN }), null);
  // A key one side lacks, an array that got longer, and no answer at all (a rebuild that threw).
  assert.equal(firstDifference({ a: 1 }, { a: 1, c: 2 }), "c: undefined then 2");
  assert.equal(firstDifference([1], [1, 2]), "[1]: undefined then 2");
  assert.equal(firstDifference({ a: 1 }, null), 'the whole answer: {"a":1} then null');
});

test("the failed percent and the metric names", () => {
  // One of six models wrong: 1 / 6 · 100 = 16.666…, kept to 4 decimals as 16.6667.
  assert.equal(failedPercent(1, 6), 16.6667);
  assert.equal(failedPercent(0, 6), 0);
  assert.equal(failedPercent(6, 6), 100);
  // Nothing ran: nothing failed (not 0 / 0).
  assert.equal(failedPercent(0, 0), 0);
  assert.equal(goldenMetric("l-bracket"), "golden_l_bracket");
  assert.equal(goldenMetric("thirty-features"), "golden_thirty_features");
});

test("the report file_issues.py reads: a first line naming the night, then one line per failing model", () => {
  const night: GoldenNight = {
    seed: 7n,
    rounds: 20,
    models: 2,
    lines: [],
    orders: [["gear", "l-bracket"], ["l-bracket", "gear"]],
    steps: [],
    failures: [
      { model: "l-bracket", round: 1, problems: ["Body 1 (feature-15): volume 2, not 1 (1)", "a save and reopen changed it"] },
      { model: "gear", round: 2, problems: ["rebuilt differently in round 2 than in round 1: bodies[0].volume:\n  1 then 2"] },
    ],
  };
  const lines = goldenReport(night).split("\n");
  assert.deepEqual(lines, [
    "Golden models, seed 7: 20 rounds of 2 models (tests/golden), 2 failed",
    `failure: l-bracket: Body 1 (feature-15): volume 2, not 1 (1) | also: a save and reopen changed it; first in round 1 (order: gear, l-bracket); replay: ${replay(night)}`,
    // A problem's own line break is folded, so the report stays one line per model.
    `failure: gear: rebuilt differently in round 2 than in round 1: bodies[0].volume: 1 then 2 | first in round 2 (order: l-bracket, gear); replay: ${replay(night)}`,
    "",
  ]);
  assert.equal(replay(night), "FISSION_SEED=7 FISSION_GOLDEN_ROUNDS=20 npm run golden -w @fission/testing (after npm run kernel -w @fission/app)");
  // Nothing failed: no report, so no folder and no issue.
  assert.equal(goldenReport({ ...night, failures: [] }), "");
});
