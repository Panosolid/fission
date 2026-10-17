// png.mjs against PNG bytes built by hand: each row filter undone to
// values worked out in the comments, the encoder read back, and the
// comparer at 0.9× and 1.1× of both its thresholds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { compareImages, decodePng, encodePng } from "./png.mjs";

/** A PNG of RGB rows, each row given as [filter, ...bytes] already filtered; the CRCs are not checked by the reader. */
function rgbPng(width, rows) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(rows.length, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const chunk = (type, body) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    return Buffer.concat([len, Buffer.from(type, "latin1"), body, Buffer.alloc(4)]);
  };
  const raw = Buffer.from(rows.flat());
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

test("hand-worked: the five row filters of a 2 × 5 RGB image", () => {
  const png = rgbPng(2, [
    // None: the bytes are the pixels: (10, 20, 30) (40, 50, 60).
    [0, 10, 20, 30, 40, 50, 60],
    // Sub: each byte adds the one a pixel to the left: (1, 2, 3), then (1+4, 2+5, 3+6) = (5, 7, 9).
    [1, 1, 2, 3, 4, 5, 6],
    // Up: each byte adds the one above, the row (1, 2, 3) (5, 7, 9): (1+5, 2+6, 3+7) = (6, 8, 10) and (5+1, 7+1, 9+1) = (6, 8, 10).
    [2, 5, 6, 7, 1, 1, 1],
    // Average: floor((left + up) / 2) added. Pixel 0 (no left): up (6, 8, 10) → +3, +4, +5: bytes 1, 1, 1 give (4, 5, 6).
    // Pixel 1: left (4, 5, 6), up (6, 8, 10): floor(10/2)=5, floor(13/2)=6, floor(16/2)=8; bytes 0, 0, 0 give (5, 6, 8).
    [3, 1, 1, 1, 0, 0, 0],
    // Paeth, pixel 0: left 0, up (4, 5, 6), up-left 0: p = up, so up is nearest: bytes 1, 1, 1 give (5, 6, 7).
    // Pixel 1: left (5, 6, 7), up (5, 6, 8), up-left (4, 5, 6). Red: p = 5 + 5 − 4 = 6, |6−5| = 1 for left and up,
    // |6−4| = 2: ties go to left, 5; green likewise 6; blue: p = 7 + 8 − 6 = 9, left |2|, up |1|, up-left |3|: up, 8.
    // Bytes 10, 10, 10 give (15, 16, 18).
    [4, 1, 1, 1, 10, 10, 10],
  ]);
  const img = decodePng(png);
  assert.deepEqual([img.width, img.height], [2, 5]);
  const px = (x, y) => [...img.data.subarray(4 * (y * 2 + x), 4 * (y * 2 + x) + 4)];
  assert.deepEqual([px(0, 0), px(1, 0)], [[10, 20, 30, 255], [40, 50, 60, 255]]);
  assert.deepEqual([px(0, 1), px(1, 1)], [[1, 2, 3, 255], [5, 7, 9, 255]]);
  assert.deepEqual([px(0, 2), px(1, 2)], [[6, 8, 10, 255], [6, 8, 10, 255]]);
  assert.deepEqual([px(0, 3), px(1, 3)], [[4, 5, 6, 255], [5, 6, 8, 255]]);
  assert.deepEqual([px(0, 4), px(1, 4)], [[5, 6, 7, 255], [15, 16, 18, 255]]);
});

test("bytes wrap round 256 as the format says: Sub of 200 then 100 is 44", () => {
  // (200 + 100) mod 256 = 44.
  const img = decodePng(rgbPng(2, [[1, 200, 0, 0, 100, 0, 0]]));
  assert.equal(img.data[4], 44);
});

test("what is not an 8-bit RGB(A) PNG is refused by name", () => {
  assert.throws(() => decodePng(Buffer.from("GIF89a")), /not a PNG/);
  const png = rgbPng(1, [[0, 1, 2, 3]]);
  png[8 + 8 + 8] = 16; // IHDR's bit depth: 16
  assert.throws(() => decodePng(png), /only 8-bit non-interlaced RGB or RGBA PNGs, not depth 16/);
  const bad = rgbPng(1, [[5, 1, 2, 3]]);
  assert.throws(() => decodePng(bad), /unknown PNG row filter 5/);
});

test("the encoder's file reads back the same pixels (round trip)", () => {
  const data = Buffer.from(Array.from({ length: 3 * 2 * 4 }, (_, i) => (i * 37) & 0xff));
  const img = decodePng(encodePng({ width: 3, height: 2, data }));
  assert.deepEqual([img.width, img.height, [...img.data]], [3, 2, [...data]]);
});

const solid = (w, h, rgba) => ({ width: w, height: h, data: Buffer.from(Array.from({ length: w * h }, () => rgba).flat()) });

test("compareImages: a channel 0.9× of the threshold off is the same, 1.1× off differs", () => {
  // Threshold 30: 27 (0.9×) is within, 33 (1.1×) is past.
  const base = solid(4, 4, [100, 100, 100, 255]);
  assert.equal(compareImages(base, solid(4, 4, [127, 100, 100, 255]), { channel: 30, maxPixels: 0 }).differing, 0);
  assert.equal(compareImages(base, solid(4, 4, [100, 100, 133, 255]), { channel: 30, maxPixels: 0 }).differing, 16);
});

test("compareImages: 0.9× of the pixel allowance passes, 1.1× fails, and the diff image marks them red", () => {
  // 100 pixels allowed: 90 differing pass, 110 fail.
  const base = solid(20, 10, [0, 0, 0, 255]);
  const off = (n) => {
    const img = solid(20, 10, [0, 0, 0, 255]);
    for (let i = 0; i < n; i++) img.data[4 * i] = 255;
    return img;
  };
  const near = compareImages(base, off(90), { channel: 32, maxPixels: 100 });
  assert.deepEqual([near.differing, near.ok], [90, true]);
  const far = compareImages(base, off(110), { channel: 32, maxPixels: 100 });
  assert.deepEqual([far.differing, far.ok], [110, false]);
  assert.deepEqual([...far.diff.data.subarray(0, 4)], [255, 0, 0, 255]);
  assert.deepEqual([...far.diff.data.subarray(4 * 199, 4 * 200)], [0, 0, 0, 255]);
});

test("compareImages: different sizes differ everywhere", () => {
  const r = compareImages(solid(2, 2, [0, 0, 0, 255]), solid(3, 2, [0, 0, 0, 255]), { channel: 32, maxPixels: 100 });
  assert.deepEqual([r.ok, r.sizes], [false, "2×2 vs 3×2"]);
});

test("compareImages: pixels inside an ignored rectangle never count, those just outside do", () => {
  // A 10 × 10 image, every pixel off; ignoring x 2–5, y 3–6 (a 4 × 4 square) leaves 100 − 16 = 84.
  const r = compareImages(solid(10, 10, [0, 0, 0, 255]), solid(10, 10, [255, 0, 0, 255]), { channel: 32, maxPixels: 0, ignore: [{ x: 2, y: 3, width: 4, height: 4 }] });
  assert.equal(r.differing, 84);
  assert.deepEqual([...r.diff.data.subarray(4 * (3 * 10 + 2), 4 * (3 * 10 + 2) + 4)], [0, 0, 96, 255], "(2, 3) is ignored");
  assert.deepEqual([...r.diff.data.subarray(4 * (3 * 10 + 6), 4 * (3 * 10 + 6) + 4)], [255, 0, 0, 255], "(6, 3) is not");
});
