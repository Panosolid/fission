import { test } from "node:test";
import assert from "node:assert/strict";
import { seeded } from "@fission/testing";
import { lengthIn, numberText, randomSize, toMm, type Unit } from "../src/index.ts";

test("hand-worked conversions", () => {
  // 4 cm = 4 × 10 = 40 mm.
  assert.equal(toMm("4", "cm"), 40);
  // 1.5 in = 1.5 × 25.4 = 38.1 mm (1.5 × 254 = 381, over 10).
  assert.equal(toMm("1.5", "in"), 38.1);
  // 5.75 in = 5.75 × 25.4 = 146.05 mm. Done naively that is 146.04999999999998 in floating point; the answer must be the 146.05 a person writes.
  assert.notEqual(5.75 * 25.4, 146.05);
  assert.equal(toMm("5.75", "in"), 146.05);
  // 0.3 in = 7.62 mm (naively 7.619999999999999).
  assert.equal(toMm("0.3", "in"), 7.62);
  // 0.35 m = 350 mm.
  assert.equal(toMm("0.35", "m"), 350);
  // A bare number is mm, as the system prompt says.
  assert.equal(toMm("25", "none"), 25);
  // 7/4 in = 1.75 in = 44.45 mm.
  assert.equal(toMm("1.75", "in"), 44.45);
});

test("numbers are written as people write them", () => {
  assert.equal(numberText(0.1 + 0.2), "0.3");
  assert.equal(numberText(12.5), "12.5");
  assert.equal(numberText(40), "40");
  // One of a unit is singular.
  assert.equal(lengthIn("1", "in", { seed: 0n, next: () => 0 }).text, "1 inch");
  assert.equal(lengthIn("2", "cm", { seed: 0n, next: () => 0 }).text, "2 centimetres");
  assert.equal(lengthIn("25", "none").text, "25");
});

test("10,000 random sizes in every unit: positive, plain, in the maker's range", () => {
  const r = seeded(11n);
  for (const unit of ["mm", "cm", "in", "m", "none"] as Unit[]) {
    for (let i = 0; i < 2_000; i++) {
      const s = randomSize(r, unit);
      assert.match(s, /^\d+(\.\d{1,2})?$/, `${unit} ${s}`);
      const mm = toMm(s, unit);
      // 0.5 mm to 2 m: inside the kernel's range (1e-3 mm smallest feature, 1e6 mm largest size) with room to spare.
      assert.ok(mm >= 0.5 && mm <= 2_000, `${s} ${unit} = ${mm} mm`);
    }
  }
});
