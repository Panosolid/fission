import { test } from "node:test";
import assert from "node:assert/strict";
import { outline, HOLE_SIDES } from "../src/profiles.ts";

/** |shoelace area| of a flat [x0, y0, …] polygon. */
function area(flat: number[]): number {
  let twice = 0;
  for (let i = 0; i < flat.length; i += 2) {
    const j = (i + 2) % flat.length;
    twice += flat[i] * flat[j + 1] - flat[j] * flat[i + 1];
  }
  return Math.abs(twice) / 2;
}

const close = (a: number, b: number) => assert.ok(Math.abs(a - b) <= 1e-9 * Math.abs(b), `${a} vs ${b}`);

test("L-bracket: rectangle minus the 0.7w × 0.7d notch", () => {
  // 40 × 30: 1200 − 28 × 21 = 612.
  const o = outline("l-bracket", 40, 30);
  assert.equal(o.outer.length, 12);
  close(area(o.outer), 612);
});

test("plate: rectangle minus two regular 24-gons", () => {
  // r = 0.15 × 30 = 4.5. A regular n-gon of circumradius r has area
  // (n/2) r² sin(2π/n) = 12 × 20.25 × sin 15° ≈ 62.89 each.
  const o = outline("plate", 40, 30);
  assert.deepEqual(o.holeCorners, [HOLE_SIDES, HOLE_SIDES]);
  const hole = 12 * 4.5 ** 2 * Math.sin(Math.PI / 12);
  close(area(o.outer) - area(o.holes.slice(0, 48)) - area(o.holes.slice(48)), 1200 - 2 * hole);
  // Holes centred at (10, 15) and (30, 15): first corners at x = 14.5 and 34.5.
  close(o.holes[0], 14.5);
  close(o.holes[48], 34.5);
});

test("star: five kites of area R·r·sin(36°)", () => {
  // R = 15, r = 6: each pair of neighbouring corners spans 36° from the
  // centre, a triangle of area ½ R r sin 36°; ten of them = 5 R r sin 36°.
  const o = outline("star", 40, 30);
  assert.equal(o.outer.length, 20);
  close(area(o.outer), 5 * 15 * 6 * Math.sin(Math.PI / 5));
});
