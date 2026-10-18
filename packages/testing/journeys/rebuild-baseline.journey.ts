// The rebuild baseline's scenario on the real kernel (step 24d3c,
// baseline/rebuild.ts): "20 features with arcs, edit the first" builds the
// shapes worked out by hand, makes exactly the kernel calls worked out by
// hand (what tests/baseline.json holds for it), and each planted bug
// leaves the shapes alone but changes what the baseline measures, so only
// the baseline can catch it (.github/scripts/test_baseline.py checks the
// file's margins fail these counts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { nodeKernel } from "../src/node-kernel.ts";
import { BodyCache, countingKernel, editFirst, FEATURES, REBUILD_FAULTS, rebuildPart, showEdit, type RebuildFault } from "../baseline/rebuild.ts";

const close = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));

/** One edit of the scenario, as baseline/app.ts measures it: the counts and the volumes shown after it. */
async function oneEdit(fault?: RebuildFault) {
  const real = nodeKernel();
  const start = await real.call("body_count");
  const kernel = countingKernel(real);
  const cache = new BodyCache(kernel);
  const part = rebuildPart();
  const first = await showEdit(kernel, cache, part.doc, part.doc);
  const [calls, builds] = [kernel.calls, kernel.builds];
  const edited = await showEdit(kernel, cache, first.doc, editFirst(part, 2), fault);
  const counts = { kernel_calls: kernel.calls - calls, body_builds: kernel.builds - builds };
  await cache.clear();
  return { counts, before: first.views.map((v) => v.volume), after: edited.views.map((v) => v.volume), leftOver: (await real.call("body_count")) - start };
}

test("20 extrudes with arcs: every body's volume by hand, before and after the first sketch's corner moves", async () => {
  const { before, after, leftOver } = await oneEdit();
  // 21 bodies: the starting box, then the 20 extrudes in build order.
  assert.equal(before.length, FEATURES + 1);
  assert.equal(after.length, FEATURES + 1);
  // The box: 40 × 30 × 20 = 24000 mm³.
  assert.ok(close(before[0], 24000) && close(after[0], 24000), `${before[0]} ${after[0]}`);
  // Each outline is a 20 × 10 rectangle with three corners rounded to r = 3:
  // a rounded corner takes away the square r² less the quarter disc πr²/4,
  // so 200 - 3 × (9 - 9π/4) = 194.2057504... mm², extruded by 10:
  // 1942.057504... mm³.
  const rounded = (200 - 3 * (9 - (9 * Math.PI) / 4)) * 10;
  for (const v of before.slice(1)) assert.ok(close(v, rounded), `${v} vs ${rounded}`);
  // The edit moves the first sketch's square corner from (0, 0) to (-2, 0):
  // the outline gains the triangle (0, 7), (0, 0), (-2, 0), ½ × 2 × 7 = 7 mm²,
  // so 201.2057504... mm², 2012.057504... mm³. The other 19 are unchanged.
  assert.ok(close(after[1], rounded + 70), `${after[1]} vs ${rounded + 70}`);
  for (const v of after.slice(2)) assert.ok(close(v, rounded), `${v} vs ${rounded}`);
  assert.equal(leftOver, 0, "every body freed");
});

test("the edit makes exactly the kernel calls worked out by hand, and tests/baseline.json holds them", async () => {
  const { counts } = await oneEdit();
  // settleKept asks each of the 20 sketches for its outline (20), the rebuild
  // asks each again for its extrude's spec (20); only the first extrude's
  // spec changed, so one body is built (1) and its old one freed (1), and
  // only the new body's view is asked for (1; the other 20 are kept):
  // 20 + 20 + 1 + 1 + 1 = 43 calls, 1 build.
  assert.deepEqual(counts, { kernel_calls: 43, body_builds: 1 });
  const metrics = JSON.parse(readFileSync(new URL("../../../tests/baseline.json", import.meta.url), "utf8")).metrics;
  assert.equal(metrics["app.rebuild_20_arcs_edit_first.kernel_calls"], 43);
  assert.equal(metrics["app.rebuild_20_arcs_edit_first.body_builds"], 1);
});

test("each planted bug leaves every shape as it was, but not what the baseline counts or times", async () => {
  const good = await oneEdit();
  // Full replay: the cache emptied first frees all 21 bodies, then 20 + 20
  // outlines, 21 builds and 21 views: 103 calls, 21 builds.
  // Outline twice: 20 more outlines than the 43, 63 calls, still 1 build.
  // Slow: the same 43 calls and 1 build; only the time shows it (checked by
  // hand with FISSION_BASELINE_FAULT=slow, since a timed test would be flaky).
  const want: Record<RebuildFault, { kernel_calls: number; body_builds: number }> = {
    "full-replay": { kernel_calls: 103, body_builds: 21 },
    "outline-twice": { kernel_calls: 63, body_builds: 1 },
    slow: { kernel_calls: 43, body_builds: 1 },
  };
  for (const fault of REBUILD_FAULTS) {
    const bad = await oneEdit(fault);
    assert.deepEqual(bad.after, good.after, `${fault}: the shapes are the same`);
    assert.deepEqual(bad.counts, want[fault], fault);
    assert.equal(bad.leftOver, 0, `${fault}: every body freed`);
  }
});
