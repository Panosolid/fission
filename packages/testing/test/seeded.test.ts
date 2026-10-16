import { test } from "node:test";
import assert from "node:assert/strict";
import { seeded, splitmix64 } from "../src/index.ts";

test("SplitMix64 matches its published first output for seed 0", () => {
  // Reference value from the algorithm's reference implementation
  // (Vigna's splitmix64.c): seed 0 → 0xE220A8397B1DCDAF.
  assert.equal(splitmix64(0n)[0], 0xe220a8397b1dcdafn);
});

test("the same seed gives the same sequence, a different seed a different one", () => {
  const take = (seed: bigint) => {
    const r = seeded(seed);
    return Array.from({ length: 5 }, () => r.next());
  };
  assert.deepEqual(take(42n), take(42n));
  assert.notDeepEqual(take(42n), take(43n));
  assert.ok(take(7n).every((x) => x >= 0 && x < 1));
});
