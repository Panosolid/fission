import { test } from "node:test";
import assert from "node:assert/strict";
import { outline, type Loop } from "../src/profiles.ts";

/**
 * |area| of a loop, worked out here independently of the kernel: shoelace
 * over the corners plus, for each arc, the circular segment beyond its
 * chord, (r²/2)(φ − sin φ) with φ = 4·atan(bulge), r = chord / (2|sin(φ/2)|).
 */
function area(loop: Loop): number {
  if ("circle" in loop) return Math.PI * loop.circle.radius ** 2;
  const { corners: c, bulges } = loop.path;
  let twice = 0;
  for (let i = 0; i < c.length; i += 2) {
    const j = (i + 2) % c.length;
    twice += c[i] * c[j + 1] - c[j] * c[i + 1];
    const bulge = bulges[i / 2] ?? 0;
    if (bulge !== 0) {
      const phi = 4 * Math.atan(bulge);
      const r = Math.hypot(c[j] - c[i], c[j + 1] - c[i + 1]) / (2 * Math.abs(Math.sin(phi / 2)));
      twice += r * r * (phi - Math.sin(phi));
    }
  }
  return Math.abs(twice) / 2;
}

const close = (a: number, b: number) => assert.ok(Math.abs(a - b) <= 1e-9 * Math.abs(b), `${a} vs ${b}`);

test("L-bracket: rectangle minus the 0.7w × 0.7d notch", () => {
  // 40 × 30: 1200 − 28 × 21 = 612.
  const o = outline("l-bracket", 40, 30);
  close(area(o.outer), 612);
  assert.deepEqual(o.holes, []);
});

test("plate: rectangle minus two round holes", () => {
  // r = 0.15 × 30 = 4.5, centres (10, 15) and (30, 15): 1200 − 2π·4.5².
  const o = outline("plate", 40, 30);
  close(area(o.outer) - o.holes.reduce((s, h) => s + area(h), 0), 1200 - 2 * Math.PI * 4.5 ** 2);
  assert.deepEqual(o.holes, [
    { circle: { center: [10, 15], radius: 4.5 } },
    { circle: { center: [30, 15], radius: 4.5 } },
  ]);
});

test("slot: a 10 × 30 rectangle with two half discs of radius 15", () => {
  // 40 × 30: straight part (40 − 30) × 30 = 300, ends π·15² = 225π.
  close(area(outline("slot", 40, 30).outer), 300 + 225 * Math.PI);
});

test("star: ten triangles of area ½·R·r·sin 36°", () => {
  // R = 15, r = 6: neighbouring corners are 36° apart seen from the centre.
  const o = outline("star", 40, 30);
  close(area(o.outer), 5 * 15 * 6 * Math.sin(Math.PI / 5));
});

test("the area helper is right on its own: a unit half disc", () => {
  // Chord (−1, 0)→(1, 0) and back along the upper half circle (bulge 1):
  // π/2. Checks the helper's arc formula before trusting the tests above.
  close(area({ path: { corners: [-1, 0, 1, 0], bulges: [0, 1] } }), Math.PI / 2);
});
