import { test } from "node:test";
import assert from "node:assert/strict";
import type { Plane } from "@fission/core";
import { GRID_REACH, gridLines, MAX_GRID_LINES, pixelSize, rayOnPlane, toWorld, yAxisOf } from "../src/sketch-view.ts";

const XY: Plane = { origin: [0, 0, 0], xAxis: [1, 0, 0], normal: [0, 0, 1] };
const XZ: Plane = { origin: [0, 0, 0], xAxis: [1, 0, 0], normal: [0, -1, 0] };
const YZ: Plane = { origin: [0, 0, 0], xAxis: [0, 1, 0], normal: [1, 0, 0] };
const close = (a: readonly number[] | null, b: readonly number[], what: string) => {
  assert.ok(a, `${what}: no point`);
  a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-9, `${what}: got ${a}, expected ${b}`));
};

test("each origin plane's frame, worked by hand: y = normal × xAxis", () => {
  // XY: Z × X = Y. XZ: (−Y) × X = −(Y × X) = −(−Z) = Z. YZ: X × Y = Z.
  assert.deepEqual(yAxisOf(XY), [0, 1, 0]);
  assert.deepEqual(yAxisOf(XZ).map((v) => v + 0), [0, 0, 1]);
  assert.deepEqual(yAxisOf(YZ), [0, 0, 1]);
  // (3, 4) on XZ is 3 along X and 4 along Z: (3, 0, 4). On YZ: 3 along Y, 4 along Z.
  assert.deepEqual(toWorld(XZ, [3, 4]).map((v) => v + 0), [3, 0, 4]);
  assert.deepEqual(toWorld(YZ, [3, 4]), [0, 3, 4]);
  // An offset origin moves every point by it.
  assert.deepEqual(toWorld({ ...XY, origin: [1, 2, 5] }, [3, 4]), [4, 6, 5]);
});

test("where a ray meets a plane, worked by hand", () => {
  // Straight down from (2, 3, 10): t = 10, the point (2, 3, 0).
  close(rayOnPlane([2, 3, 10], [0, 0, -1], XY), [2, 3], "straight down");
  // At 45° from (0, 0, 10) along (1, 0, −1)/√2: it drops 10 while moving 10 in x, so (10, 0).
  close(rayOnPlane([0, 0, 10], [Math.SQRT1_2, 0, -Math.SQRT1_2], XY), [10, 0], "oblique");
  // A plane 5 up: from (1, 1, 10) straight down lands on its origin's frame at (1, 1).
  close(rayOnPlane([1, 1, 10], [0, 0, -1], { ...XY, origin: [0, 0, 5] }), [1, 1], "offset plane");
  // YZ from (10, 2, 3) along −X lands at (0, 2, 3): x along Y is 2, y along Z is 3.
  close(rayOnPlane([10, 2, 3], [-1, 0, 0], YZ), [2, 3], "side plane");
  // XZ from (2, −10, 7) along +Y lands at (2, 0, 7): x 2, y (along Z) 7.
  close(rayOnPlane([2, -10, 7], [0, 1, 0], XZ), [2, 7], "front plane");
});

test("a ray that never meets the plane in front of it gives null", () => {
  assert.equal(rayOnPlane([0, 0, 10], [1, 0, 0], XY), null, "along the plane");
  assert.equal(rayOnPlane([0, 0, 10], [0, 0, 1], XY), null, "pointing away");
  assert.equal(rayOnPlane([0, 0, 0], [0, 0, -1], XY), null, "starting on it");
  assert.equal(rayOnPlane([0, 0, 10], [NaN, 0, -1], XY), null, "not a number");
  assert.equal(rayOnPlane([0, 0, 1e308], [1, 0, -1e-308], XY), null, "too far to be finite");
});

test("the grid's lines, counted by hand", () => {
  // Spacing 10: n = ceil(200 / 10) = 20 lines each side, 41 each way, 82 in all,
  // reaching ±200; majors at k = −20, −10, 0, 10, 20: 5 each way.
  const ten = gridLines(10);
  assert.equal(ten.length, 82);
  assert.equal(ten.filter((l) => l.major).length, 10);
  assert.deepEqual(ten[0], { a: [-200, -200], b: [-200, 200], major: true });
  assert.ok(ten.some((l) => l.a[0] === 0 && l.b[0] === 0 && l.major), "the y axis is a major line");
  // Spacing 3: ceil(66.7) = 67 lines each side, reaching 201 (at least GRID_REACH).
  const three = gridLines(3);
  assert.equal(three.length, 2 * (2 * 67 + 1));
  assert.equal(three.at(-1)!.b[0], 201);
  assert.ok(201 >= GRID_REACH);
  // Spacing 0.1 would need 2,000 each side: capped at 100, reaching 10 mm.
  const fine = gridLines(0.1);
  assert.equal(fine.length, 2 * (2 * MAX_GRID_LINES + 1));
  assert.ok(Math.abs(fine.at(-1)!.b[0] - 10) < 1e-9);
});

test("a grid spacing that is not a positive number draws no grid", () => {
  for (const s of [0, -10, NaN, Infinity]) assert.deepEqual(gridLines(s), [], `spacing ${s}`);
});

test("hand-worked: a pixel's size on the plane is the further of the steps to the pixel right and the pixel below", () => {
  // From (1, 1): the pixel right lands at (1.3, 1.4), (0.3, 0.4) away, √(0.09 + 0.16) = 0.5; the pixel below at
  // (1, 0.8), 0.2 away. Seen at a slant the longer step counts: 0.5 mm.
  assert.ok(Math.abs(pixelSize([1, 1], [1.3, 1.4], [1, 0.8])! - 0.5) < 1e-12);
  // Looking straight down at 0.25 mm a pixel both ways.
  assert.equal(pixelSize([0, 0], [0.25, 0], [0, -0.25]), 0.25);
});

test("a pixel's size is unknown when the pointer or a neighbour misses the plane, or the steps are nothing", () => {
  assert.equal(pixelSize(null, [1, 0], [0, 1]), undefined);
  assert.equal(pixelSize([0, 0], null, [0, 1]), undefined);
  assert.equal(pixelSize([0, 0], [1, 0], null), undefined);
  assert.equal(pixelSize([0, 0], [0, 0], [0, 0]), undefined);
  assert.equal(pixelSize([0, 0], [Infinity, 0], [0, 1]), undefined);
});

test("a pixel's size from real rays: a camera 100 mm above the ground plane, 1 mm right per pixel at the plane", () => {
  // Rays from (0, 0, 100) through the pixel and its neighbours, aimed so they meet z = 0 at (0, 0), (1, 0) and (0, −1).
  const from = [0, 0, 100];
  const hit = (x: number, y: number) => rayOnPlane(from, [x, y, -100], XY);
  assert.equal(pixelSize(hit(0, 0), hit(1, 0), hit(0, -1)), 1);
});
