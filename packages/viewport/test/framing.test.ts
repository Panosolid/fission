import { test } from "node:test";
import assert from "node:assert/strict";
import { needsRefit } from "../src/framing.ts";

test("camera re-frames when the body stops fitting or becomes a speck", () => {
  const at = (x: number, y: number, z: number, radius: number) => ({ centre: [x, y, z] as [number, number, number], radius });
  assert.equal(needsRefit(null, at(0, 0, 0, 25)), true); // first body
  // 40×30×20 box (r = √2900/2 ≈ 26.93, centre (20, 15, 10)) widened to 45:
  // r = √3325/2 ≈ 28.83, centre moves 2.5; 2.5 + 28.83 < 1.5 × 26.93.
  assert.equal(needsRefit(at(20, 15, 10, Math.sqrt(2900) / 2), at(22.5, 15, 10, Math.sqrt(3325) / 2)), false);
  // Boundary on the fit rule, framed r = 10: reach 15 is kept, just past re-frames.
  assert.equal(needsRefit(at(0, 0, 0, 10), at(3, 4, 0, 10)), false); // 5 + 10 = 15
  assert.equal(needsRefit(at(0, 0, 0, 10), at(3, 4, 0, 10.0001)), true);
  assert.equal(needsRefit(at(0, 0, 0, 10), at(0, 0, 0, 15)), false); // grew 1.5×
  assert.equal(needsRefit(at(0, 0, 0, 10), at(0, 0, 0, 15.0001)), true);
  // Boundary on shrinking: a tenth is kept, just under re-frames.
  assert.equal(needsRefit(at(0, 0, 0, 1), at(0, 0, 0, 0.1)), false);
  assert.equal(needsRefit(at(0, 0, 0, 1), at(0, 0, 0, 0.0999)), true);
  // 40 mm box → 1 µm box: radius ratio ~3e-5.
  assert.equal(needsRefit(at(20, 15, 10, 29), at(0.0005, 0.0005, 0.0005, 0.00087)), true);
  assert.equal(needsRefit(at(0, 0, 0, 5), at(0, 0, 0, 0)), false); // nothing to frame
});
