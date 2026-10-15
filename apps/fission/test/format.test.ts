import { test } from "node:test";
import assert from "node:assert/strict";
import { formatQuantity, needsRefit } from "../src/format.ts";

test("everyday sizes use grouped digits", () => {
  // 26 × 30 × 20 = 15,600; 40 × 30 × 20 = 24,000.
  assert.equal(formatQuantity(15600), "15,600");
  assert.equal(formatQuantity(24000), "24,000");
  assert.equal(formatQuantity(0.5), "0.5");
  assert.equal(formatQuantity(1234.5678), "1,234.5678");
});

test("rounding noise past 10 figures is hidden", () => {
  // 0.1 + 0.2 = 0.30000000000000004 in doubles.
  assert.equal(formatQuantity(0.1 + 0.2), "0.3");
  assert.equal(formatQuantity(15600.000000001), "15,600");
});

test("tiny and huge values are never rounded away", () => {
  // A 1 µm cube: 0.001³ = 1e-9 mm³, area 6 · 0.001² = 6e-6 mm².
  assert.equal(formatQuantity(1e-9), "1 × 10⁻⁹");
  assert.equal(formatQuantity(6e-6), "6 × 10⁻⁶");
  // A 10 km cube: (1e7)³ = 1e21 mm³.
  assert.equal(formatQuantity(1e21), "1 × 10²¹");
  assert.equal(formatQuantity(-2.5e-4), "-2.5 × 10⁻⁴");
  assert.equal(formatQuantity(0), "0");
});

test("the switch to powers of ten is at 0.001 and 1e12", () => {
  assert.equal(formatQuantity(0.001), "0.001");
  assert.equal(formatQuantity(0.0009), "9 × 10⁻⁴");
  // Just below 1e12 with ≤ 10 significant figures, so no rounding.
  assert.equal(formatQuantity(999_900_000_000), "999,900,000,000");
  assert.equal(formatQuantity(1e12), "1 × 10¹²");
});

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
