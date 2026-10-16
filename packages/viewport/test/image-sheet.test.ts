import { test } from "node:test";
import assert from "node:assert/strict";
import { checkTextureSize, imageSheet, imageZoomRange, SHEET_MARGIN, topDownDistance } from "../src/image-sheet.ts";

const corner = (s: ReturnType<typeof imageSheet>, i: number) => ({ xyz: [...s.positions.slice(3 * i, 3 * i + 3)], uv: [...s.uvs.slice(2 * i, 2 * i + 2)] });
const close = (a: number, b: number) => Math.abs(a - b) < 1e-5;

test("a 200 × 100 image at 0.1 mm per pixel is a 20 × 10 mm sheet centred on the origin, its top row at +Y", () => {
  // 200 × 0.1 = 20 mm wide, 100 × 0.1 = 10 mm tall, so the corners are at x = ±10, y = ±5.
  // Image row 0 is the top row and the texture is uploaded unflipped (row 0 at v = 0),
  // so the top-left corner (−10, +5) must carry uv (0, 0) and the bottom-right (10, −5) uv (1, 1).
  const s = imageSheet(200, 100, 0.1);
  assert.ok(close(s.widthMm, 20) && close(s.heightMm, 10));
  const tl = corner(s, 0);
  const br = corner(s, 2);
  assert.ok(close(tl.xyz[0], -10) && close(tl.xyz[1], 5) && tl.xyz[2] === 0, `${tl.xyz}`);
  assert.deepEqual(tl.uv, [0, 0]);
  assert.ok(close(br.xyz[0], 10) && close(br.xyz[1], -5), `${br.xyz}`);
  assert.deepEqual(br.uv, [1, 1]);
  // The other two: top-right (10, 5) uv (1, 0), bottom-left (−10, −5) uv (0, 1).
  assert.deepEqual(corner(s, 1).uv, [1, 0]);
  assert.deepEqual(corner(s, 3).uv, [0, 1]);
});

test("the two triangles face +Z (counter-clockwise from above) and cover the sheet exactly once", () => {
  const s = imageSheet(200, 100, 0.1);
  let area = 0;
  for (let t = 0; t < s.indices.length; t += 3) {
    const [a, b, c] = s.indices.slice(t, t + 3).map((i) => [s.positions[3 * i], s.positions[3 * i + 1]]);
    // z of (b − a) × (c − a): positive when a → b → c turns counter-clockwise seen from +Z.
    const z = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    assert.ok(z > 0, `triangle ${t / 3} faces down`);
    area += z / 2;
  }
  assert.ok(close(area, 200), `${area} mm² (20 × 10 = 200)`);
});

test("the top-down distance fits the sheet with its margin in the narrower direction", () => {
  // fov 90°: half-height seen at distance d is d·tan 45° = d.
  // 20 × 10 mm on a square canvas: the width needs half-height 10 → 10 × 1.1 = 11.
  assert.ok(close(topDownDistance(20, 10, 90, 1), 11));
  // On a canvas twice as wide, the width needs 10 / 2 = 5 and the height 5: 5.5.
  assert.ok(close(topDownDistance(20, 10, 90, 2), 5.5));
  // On a phone-shaped canvas (aspect 0.5) the width needs 10 / 0.5 = 20: 22.
  assert.ok(close(topDownDistance(20, 10, 90, 0.5), 22));
});

test("self-consistency: at that distance the sheet's corner lands 1 / margin of the way to the canvas edge", () => {
  for (const [w, h, fov, aspect] of [[20, 10, 45, 1.6], [3, 400, 45, 1.6], [50, 50, 30, 0.46]]) {
    const d = topDownDistance(w, h, fov, aspect);
    const t = Math.tan((fov * Math.PI) / 360);
    // Normalised device coordinates of the corner (w/2, h/2) seen from (0, 0, d).
    const ndcX = w / 2 / (d * t * aspect);
    const ndcY = h / 2 / (d * t);
    assert.ok(close(Math.max(ndcX, ndcY), 1 / SHEET_MARGIN), `${w} × ${h}: ${ndcX}, ${ndcY}`);
    assert.ok(ndcX <= 1 / SHEET_MARGIN + 1e-9 && ndcY <= 1 / SHEET_MARGIN + 1e-9);
  }
});

test("zoom limits and clip planes follow the framing distance", () => {
  // 100 / 1000 = 0.1 in, 100 × 20 = 2000 out; near and far ten times beyond: 0.01 and 20000.
  assert.deepEqual(imageZoomRange(100), { minDistance: 0.1, maxDistance: 2000, near: 0.01, far: 20000 });
});

test("an image wider or taller than the graphics card's largest texture is refused with a message (0.9× passes, 1.1× fails)", () => {
  const max = 16384;
  checkTextureSize(max, max, max);
  checkTextureSize(Math.floor(0.9 * max), 10, max);
  assert.throws(() => checkTextureSize(Math.ceil(1.1 * max), 10, max), { message: "This image is 18023 × 10 pixels, but this screen's graphics can show at most 16384 pixels along a side." });
  assert.throws(() => checkTextureSize(10, max + 1, max), /at most 16384 pixels along a side/);
});
