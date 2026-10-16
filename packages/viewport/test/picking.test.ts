import { test } from "node:test";
import assert from "node:assert/strict";
import { CLICK_SLOP_PX, faceOfTriangle, isClick } from "../src/picking.ts";

test("a press and release under the slop is a click, over it is a camera drag", () => {
  const at = { x: 100, y: 200 };
  assert.equal(isClick(at, at), true);
  // A 3-4-5 triangle scaled to the slop: moved (0.6, 0.8) × slop is exactly the slop away.
  const moved = (f: number) => ({ x: 100 + 0.6 * CLICK_SLOP_PX * f, y: 200 + 0.8 * CLICK_SLOP_PX * f });
  assert.equal(isClick(at, moved(0.9)), true); // 0.9 × slop: a click
  assert.equal(isClick(at, moved(1.1)), false); // 1.1 × slop: a drag
  assert.equal(isClick(at, { x: 100 + CLICK_SLOP_PX, y: 200 }), false); // exactly the slop counts as a drag
  assert.equal(isClick(at, { x: 100, y: 200 - 0.9 * CLICK_SLOP_PX }), true); // any direction
  assert.equal(isClick(at, { x: 100 - 1.1 * CLICK_SLOP_PX, y: 200 }), false);
});

test("a hit triangle maps to its kernel face, a miss or a stale index to nothing", () => {
  // A box face is two triangles: six faces, twelve triangles, face k owning triangles 2k and 2k+1.
  const triangleFaces = [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5];
  assert.equal(faceOfTriangle(triangleFaces, 2), 1);
  assert.equal(faceOfTriangle(triangleFaces, 3), 1);
  assert.equal(faceOfTriangle(triangleFaces, 11), 5);
  assert.equal(faceOfTriangle(triangleFaces, 0), 0);
  assert.equal(faceOfTriangle(triangleFaces, undefined), null); // missed the body
  assert.equal(faceOfTriangle(triangleFaces, null), null);
  assert.equal(faceOfTriangle(triangleFaces, 12), null); // one past the end
  assert.equal(faceOfTriangle(triangleFaces, -1), null);
  assert.equal(faceOfTriangle(triangleFaces, 1.5), null);
  assert.equal(faceOfTriangle([], 0), null);
});
