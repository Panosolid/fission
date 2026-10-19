import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MAX_PIXELS, MAX_SIDE, MAX_SIZE_MM, MIN_MM_PER_PIXEL, checkMmPerPixel, checkPixelSize } from "../src/limits.ts";
import { refusal } from "./helpers.ts";

test("the physical limits are the kernel's modelling range", () => {
  // tolerance.rs is the one place the kernel's epsilons live; ours must not drift from it.
  const rust = readFileSync(new URL("../../../kernel/src/tolerance.rs", import.meta.url), "utf8");
  const constant = (name: string) => Number(rust.match(new RegExp(`pub const ${name}: f64 = ([^;]+);`))![1]);
  assert.equal(MIN_MM_PER_PIXEL, constant("LINEAR"));
  assert.equal(MAX_SIZE_MM, constant("MAX_SIZE"));
});

test("smallest pixel: 0.9× is refused, 1.1× is allowed", () => {
  checkMmPerPixel(MIN_MM_PER_PIXEL * 1.1, 1, 1);
  checkMmPerPixel(MIN_MM_PER_PIXEL, 1, 1);
  assert.match(refusal(() => checkMmPerPixel(MIN_MM_PER_PIXEL * 0.9, 1, 1)).message, /smaller than the smallest size Panosolid models/);
});

test("largest image: 0.9× of 1 km is allowed, 1.1× is refused", () => {
  // 1000 pixels at 1000 mm each is exactly 1e6 mm = 1 km across: allowed.
  checkMmPerPixel(1000, 1000, 10);
  checkMmPerPixel(900, 1000, 10); // 0.9 km
  assert.match(refusal(() => checkMmPerPixel(1100, 1000, 10)).message, /1100000 mm across, larger than the largest/); // 1.1 km
  // The longer side decides: 10 × 1000 pixels is the same as 1000 × 10.
  assert.equal(refusal(() => checkMmPerPixel(1100, 10, 1000)).code, "invalid-size");
});

test("a pixel size must be a positive number", () => {
  for (const bad of [0, -0.1, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(refusal(() => checkMmPerPixel(bad, 1, 1)).code, "invalid-size");
});

test("pixel limits: 0.9× is allowed, 1.1× is refused", () => {
  checkPixelSize(Math.round(MAX_SIDE * 0.9), 1); // 14746 × 1
  assert.match(refusal(() => checkPixelSize(Math.round(MAX_SIDE * 1.1), 1)).message, /at most 16384 pixels along a side/);
  checkPixelSize(MAX_SIDE, 1);
  // 8192 × 7373 = 60.4 MP (0.9×) passes; 8192 × 9011 = 73.8 MP (1.1×) is refused although each side is allowed.
  checkPixelSize(8192, Math.round(8192 * 0.9));
  checkPixelSize(8192, 8192); // exactly MAX_PIXELS
  assert.equal(8192 * 8192, MAX_PIXELS);
  assert.deepEqual(refusal(() => checkPixelSize(8192, Math.round(8192 * 1.1))), { code: "too-large", message: "8192 × 9011 pixels (73.8 megapixels) is too large: at most 67.1 megapixels." });
});

test("an image must have whole, positive pixel counts", () => {
  for (const [w, h] of [[0, 1], [1, 0], [-3, 2], [1.5, 2], [Number.NaN, 2]]) assert.equal(refusal(() => checkPixelSize(w, h)).code, "damaged");
});
