import { test } from "node:test";
import assert from "node:assert/strict";
import { applyAdjustments, brightnessOffset, checkAdjustment } from "../src/adjust.ts";
import { refusal } from "./helpers.ts";

const brighten = (rgba: number[], amount: number) => {
  const out = new Uint8ClampedArray(rgba.length);
  applyAdjustments(new Uint8ClampedArray(rgba), [{ type: "brightness", amount }], out);
  return [...out];
};

test("brightness by hand", () => {
  // +20 %: offset round(0.2 × 255) = 51, so (100, 0, 250) → (151, 51, 255): 250 + 51 = 301 clips to 255.
  assert.deepEqual(brighten([100, 0, 250, 77], 0.2), [151, 51, 255, 77]);
  // +30 %: 0.3 × 255 = 76.5 rounds up to 77, and 200 + 77 = 277 clips to 255; 10 + 77 = 87.
  assert.deepEqual(brighten([200, 10, 128, 255], 0.3), [255, 87, 205, 255]);
  // -50 %: round(-127.5) = -127 (Math.round rounds halves towards +∞), so 128 → 1 and 100 → 0 (clipped).
  assert.equal(brightnessOffset(-0.5), -127);
  assert.deepEqual(brighten([128, 100, 255, 3], -0.5), [1, 0, 128, 3]);
  // ±100 % gives white and black whatever the start; alpha (the 4th value) never changes.
  assert.deepEqual(brighten([0, 37, 255, 9], 1), [255, 255, 255, 9]);
  assert.deepEqual(brighten([0, 37, 255, 9], -1), [0, 0, 0, 9]);
});

test("0 % leaves every pixel as it was, and the input is never changed", () => {
  const original = [1, 2, 3, 4, 250, 251, 252, 253];
  const input = new Uint8ClampedArray(original);
  const out = new Uint8ClampedArray(input.length);
  applyAdjustments(input, [{ type: "brightness", amount: 0 }], out);
  assert.deepEqual([...out], original);
  applyAdjustments(input, [{ type: "brightness", amount: 0.7 }], out);
  assert.deepEqual([...input], original);
});

test("brightness is between -100 % and +100 %", () => {
  checkAdjustment({ type: "brightness", amount: 1 });
  checkAdjustment({ type: "brightness", amount: -1 });
  for (const bad of [1.1, -1.1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.match(refusal(() => checkAdjustment({ type: "brightness", amount: bad })).message, /^Brightness must be between -100 % and \+100 %/);
  }
  assert.equal(refusal(() => checkAdjustment({ type: "blur", amount: 0 } as never)).message, 'Unknown adjustment "blur".');
  assert.equal(refusal(() => applyAdjustments(new Uint8ClampedArray(4), [], new Uint8ClampedArray(8))).code, "invalid-input");
});
