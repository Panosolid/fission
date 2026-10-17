// Free placement (sketch feel SF1): which kernel call rounds a sketch
// pointer (snap.ts `rounding`), grid snap off by default, and the panel's
// help no longer promising the grid. The rounding itself is the kernel's
// (sketch.rs `place_freely`, with its own hand-worked, boundary and model
// tests); the real kernel runs it in packages/testing's
// free-placement.journey.ts and the browser in apps/fission/e2e/free-placement.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rounding } from "../src/snap.ts";
import { DEFAULT_GRID, DEFAULT_GRID_SNAP } from "../src/sketch-tool.ts";
import { SNAP_HELP, TOOL_HELP } from "../src/sketch-panel.ts";

test("hand-worked: grid snap off rounds by the pixel (place_freely), on rounds to the grid (snap_to_grid)", () => {
  // Off, a pixel of 0.05 mm: the kernel gets the pointer and the pixel, and rounds to 0.01 mm.
  assert.deepEqual(rounding([12.3681944, -7.0449], 10, false, 0.05), { op: "place_freely", args: [12.3681944, -7.0449, 0.05] });
  // On, the same pointer: the kernel gets the grid size, 10 mm, and the pixel plays no part.
  assert.deepEqual(rounding([12.3681944, -7.0449], 10, true, 0.05), { op: "snap_to_grid", args: [12.3681944, -7.0449, 10] });
  assert.deepEqual(rounding([1, 2], 2.5, true, 0.05), { op: "snap_to_grid", args: [1, 2, 2.5] });
});

test("a pixel size the viewport can't give falls back to the grid, as snapPointer does", () => {
  for (const pixel of [undefined, 0, -0, -0.05, NaN, Infinity, -Infinity]) {
    assert.deepEqual(rounding([3, 4], 10, false, pixel), { op: "snap_to_grid", args: [3, 4, 10] }, String(pixel));
  }
  // The smallest positive pixel is a pixel: free.
  assert.equal(rounding([3, 4], 10, false, Number.MIN_VALUE).op, "place_freely");
});

test("grid snap starts off, with the 10 mm grid still there to turn on", () => {
  assert.equal(DEFAULT_GRID_SNAP, false);
  assert.equal(DEFAULT_GRID, 10);
});

test("the tools' help no longer says points snap to the grid; the snap help says where they go", () => {
  // Regression (SF1): every tool's help said "snapped to the grid", which stopped being true.
  for (const [kind, help] of Object.entries(TOOL_HELP)) assert.doesNotMatch(help, /grid/i, kind);
  assert.match(SNAP_HELP, /where you click/);
  assert.match(SNAP_HELP, /ends, midpoints and centres/);
});
