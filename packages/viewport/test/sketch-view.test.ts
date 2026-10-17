import { test } from "node:test";
import assert from "node:assert/strict";
import type { Plane } from "@fission/core";
import { GRID_MAJOR, GRID_MIN_PIXELS, gridSpacing, MAX_GRID_LINES, minorStrength, pixelSize, rayOnPlane, sketchGrid, toWorld, yAxisOf } from "../src/sketch-view.ts";

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

test("hand-worked: the minor spacing is the smallest power of ten at least 8 pixels apart", () => {
  // 0.5 mm a pixel: 8 px is 4 mm; 1 is too close, 10 is the first power of ten that far: 10.
  assert.equal(gridSpacing(0.5), 10);
  // 0.0125 mm a pixel: 8 px is exactly 0.1 mm, which is allowed (at least 8 px), so 0.1, written exactly.
  assert.equal(gridSpacing(0.0125), 0.1);
  // 2 mm a pixel (zoomed far out): 16 mm wanted, 100.
  assert.equal(gridSpacing(2), 100);
  // A micrometre a pixel (zoomed right in): 0.008 mm wanted, 0.01.
  assert.equal(gridSpacing(0.001), 0.01);
});

test("boundary: 8 pixels apart at 0.9× the switching pixel size stays, at 1.1× it goes ten times coarser", () => {
  // 1 mm lines are exactly 8 px apart at 0.125 mm a pixel.
  assert.equal(gridSpacing(0.125 * 0.9), 1, "0.9×: 1 mm lines are 8.9 px apart, kept");
  assert.equal(gridSpacing(0.125 * 1.1), 10, "1.1×: 1 mm lines would be 7.3 px apart, too close");
  // At every power of ten the switch is exact: 10^e is kept at exactly 8 px, and one ulp of pixel more makes it 10^(e+1).
  for (let e = -6; e <= 6; e++) {
    const p = Number(`1e${e}`) / GRID_MIN_PIXELS;
    assert.equal(gridSpacing(p), Number(`1e${e}`), `10^${e} at exactly 8 px`);
    const more = p * (1 + 2 ** -50);
    assert.equal(gridSpacing(more), Number(`1e${e + 1}`), `10^${e + 1} just past it`);
  }
});

test("hand-worked: with grid snap on the lines are the snap grid times a power of ten, never finer than it", () => {
  // Snap 2.5 mm at 0.1 mm a pixel: 0.8 mm wanted, the snap grid itself (25 px apart) is drawn, never 0.25.
  assert.equal(gridSpacing(0.1, 2.5), 2.5);
  // Zoomed out to 1 mm a pixel: 8 mm wanted, 2.5 is too close, 25 is drawn (every tenth snap line).
  assert.equal(gridSpacing(1, 2.5), 25);
  // Snap 3 at 0.5 mm a pixel: 4 wanted, 30 (3 is 6 px apart).
  assert.equal(gridSpacing(0.5, 3), 30);
  // Zoomed far in, 0.01 mm a pixel: 2.5 mm lines are 250 px apart, but 0.25 would be lines a click can't land on: 2.5.
  assert.equal(gridSpacing(0.01, 2.5), 2.5);
  // Snap 0.3 at 0.375 mm a pixel: 8 px is exactly 3 mm = 0.3 × 10, allowed (exactly 8 px apart counts).
  assert.equal(gridSpacing(0.375, 0.3), 3);
  // Boundary: 2.5 mm is 8 px apart at 0.3125 mm a pixel; at 0.9× it is kept, at 1.1× it becomes 25.
  assert.equal(gridSpacing(0.3125 * 0.9, 2.5), 2.5);
  assert.equal(gridSpacing(0.3125 * 1.1, 2.5), 25);
});

test("no spacing for a pixel or snap step that is not a positive finite number", () => {
  for (const bad of [0, -1, NaN, Infinity]) {
    assert.equal(gridSpacing(bad), null, `pixel ${bad}`);
    assert.equal(gridSpacing(0.1, bad), null, `step ${bad}`);
  }
  assert.equal(gridSpacing(1e308), null, "8 px is past the largest double");
});

/** A small seeded generator (mulberry32), so every run draws the same cases. */
function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("seeded: 5,000 pixel sizes and snap steps against the rule: at least 8 px, and a tenth of it would be too close", () => {
  const rand = seeded(20261017);
  for (let i = 0; i < 5000; i++) {
    const pixel = 10 ** (rand() * 10 - 6); // 1e-6 to 1e4 mm a pixel
    const step = i % 2 ? null : Number((10 ** (rand() * 4 - 2)).toPrecision(2)); // 0.01 to 100
    const s = gridSpacing(pixel, step)!;
    const what = `pixel ${pixel} step ${step}: ${s}`;
    assert.ok(s >= GRID_MIN_PIXELS * pixel * (1 - 1e-12), `${what} is closer than 8 px`);
    const ratio = s / (step ?? 1);
    const k = Math.round(Math.log10(ratio));
    assert.ok(Math.abs(ratio / 10 ** k - 1) < 1e-9, `${what} is not the base times a power of ten`);
    if (step !== null) assert.ok(k >= 0, `${what} is finer than the snap grid`);
    if (step !== null && k === 0) continue; // the snap grid itself: never finer, however far apart
    assert.ok(s / 10 < GRID_MIN_PIXELS * pixel * (1 + 1e-12), `${what}: a tenth of it would do`);
  }
});

test("hand-worked: the minor lines' strength, none at 8 px apart, full at 80, half way at 8√10", () => {
  assert.equal(minorStrength(8), 0);
  assert.equal(minorStrength(80), 1);
  // log10(8√10 / 8) / log10(10) = 0.5.
  assert.ok(Math.abs(minorStrength(8 * Math.sqrt(10)) - 0.5) < 1e-12);
  assert.equal(minorStrength(4), 0, "closer than 8 px clamps to none");
  assert.equal(minorStrength(800), 1, "further than 80 px clamps to full");
  assert.equal(minorStrength(NaN), 0);
});

test("hand-worked: the grid round the origin at 0.5 mm a pixel, 100 px each way", () => {
  // Minor 10, major 100. Reach 100 px × 0.5 = 50 mm, plus half a major 50: n = ceil(100 / 10) = 10 lines each way.
  const g = sketchGrid([0, 0], 0.5, 100)!;
  assert.equal(g.minor, 10);
  assert.equal(g.major, 100);
  assert.deepEqual(g.bounds, [-100, 100, -100, 100]);
  // 21 lines across and 21 up, less the two through the origin (the axes draw those): 40.
  assert.equal(g.lines.length, 40);
  // Majors at ±100 both ways: 4.
  assert.deepEqual(g.lines.filter((l) => l.major).map((l) => [...l.a, ...l.b]), [[-100, -100, -100, 100], [-100, -100, 100, -100], [100, -100, 100, 100], [-100, 100, 100, 100]]);
  assert.ok(!g.lines.some((l) => (l.a[0] === 0 && l.b[0] === 0) || (l.a[1] === 0 && l.b[1] === 0)), "no grid line on an axis");
  assert.deepEqual(g.axes, { x: [[-100, 0], [100, 0]], y: [[0, -100], [0, 100]] });
  // 10 mm at 0.5 mm a pixel is 20 px apart: log10(20 / 8) = 0.398.
  assert.ok(Math.abs(g.strength - Math.log10(2.5)) < 1e-12);
});

test("hand-worked: a panned view moves the grid's centre to the nearest major line", () => {
  // (149, −51) with majors every 100: the nearest are x = 100 (1.49 rounds to 1) and y = −100 (−0.51 to −1).
  const g = sketchGrid([149, -51], 0.5, 100)!;
  assert.deepEqual(g.bounds, [0, 200, -200, 0]);
  // The axes are at the grid's edge, still on it (the edges count).
  assert.deepEqual(g.axes, { x: [[0, 0], [200, 0]], y: [[0, -200], [0, 0]] });
  // Far from the origin neither axis is on the grid.
  assert.deepEqual(sketchGrid([1000, 1000], 0.5, 100)!.axes, { x: null, y: null });
  // Panning a little keeps the same lines (still nearest x = 100, y = −100).
  assert.deepEqual(sketchGrid([101, -99], 0.5, 100)!.bounds, g.bounds);
});

test("the grid stops at MAX_GRID_LINES each way, and draws nothing it can't place", () => {
  const huge = sketchGrid([0, 0], 0.5, 1e6)!;
  assert.deepEqual(huge.bounds, [-MAX_GRID_LINES * 10, MAX_GRID_LINES * 10, -MAX_GRID_LINES * 10, MAX_GRID_LINES * 10]);
  assert.equal(huge.lines.length, 2 * 2 * MAX_GRID_LINES);
  assert.equal(sketchGrid([NaN, 0], 0.5, 100), null);
  assert.equal(sketchGrid([0, 0], 0, 100), null);
  assert.equal(sketchGrid([0, 0], 0.5, 0), null);
  assert.equal(sketchGrid([1e300, 0], 1e-6, 100), null, "a centre too far out to count in lines");
});

test("seeded: 500 grids, every line on a whole minor step, majors every tenth, covering the view", () => {
  const rand = seeded(17);
  for (let i = 0; i < 500; i++) {
    const pixel = 10 ** (rand() * 6 - 4);
    const step = i % 3 === 0 ? 0.5 : null;
    const reach = 50 + rand() * 1500;
    const centre: [number, number] = [(rand() - 0.5) * 4000 * pixel, (rand() - 0.5) * 4000 * pixel];
    const g = sketchGrid(centre, pixel, reach, step)!;
    const what = `grid ${i} (pixel ${pixel}, centre ${centre}, reach ${reach})`;
    assert.equal(g.major, GRID_MAJOR * g.minor);
    for (const l of g.lines) {
      const vertical = l.a[0] === l.b[0];
      const at = vertical ? l.a[0] : l.a[1];
      const index = Math.round(at / g.minor);
      assert.ok(Math.abs(at - index * g.minor) <= 1e-9 * Math.abs(at), `${what}: line at ${at} is off the minor steps`);
      assert.equal(l.major, index % GRID_MAJOR === 0, `${what}: line at ${at}`);
      assert.notEqual(index, 0, `${what}: a grid line on an axis`);
    }
    // The view (reach pixels round the centre) is inside the grid, unless the line limit cut it short.
    const want = reach * pixel;
    const [x0, x1, y0, y1] = g.bounds;
    const n = Math.round((x1 - x0) / (2 * g.minor));
    if (n < MAX_GRID_LINES) assert.ok(x0 <= centre[0] - want && centre[0] + want <= x1 && y0 <= centre[1] - want && centre[1] + want <= y1, `${what} doesn't cover the view`);
  }
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
