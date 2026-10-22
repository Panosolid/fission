// Tests written to kill the mutants StrykerJS found surviving in the
// viewport's maths (2026-10-22; run it again with
// packages/testing/stryker/run.sh viewport). Each test names the change to
// the code it catches. Mutants that change nothing a caller can see are
// listed, with the reason, in packages/testing/stryker/explained.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Plane, SharedViewport } from "@fission/core";
import { needsRefit, selectionFraming } from "../src/framing.ts";
import { BASE_COLOUR, EDGE_COLOUR } from "../src/highlight.ts";
import { clampZoom, cubeDragAngles, NAV_MODES, orbitBy } from "../src/navigation.ts";
import { paneViewports, type PaneCamera } from "../src/pane.ts";
import { segmentsNear, unhidden, EDGE_DEPTH_SLACK } from "../src/picking.ts";
import { rayOnPlane, sketchGrid, gridSpacing, toWorld, yAxisOf } from "../src/sketch-view.ts";
import { cubeView, fitDistance, orbitSafeOffset, planeViewBasis, viewDirection } from "../src/views.ts";

const close = (a: readonly number[] | null | undefined, b: readonly number[], what: string, eps = 1e-12) => {
  assert.ok(a, `${what}: nothing`);
  assert.equal(a.length, b.length, what);
  a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) <= eps, `${what}: got ${a}, expected ${b}`));
};

// ---------- sketch-view.ts ----------

// A slanted plane with no zero in its axes, so every term of every cross and dot product counts.
// u = (1, -2, 2)/3 and n = (2, 2, 1)/3 are unit and square (u.n = (2 - 4 + 2)/9 = 0). By hand,
// y = n × u = ((2·2 − 1·(−2)), (1·1 − 2·2), (2·(−2) − 2·1))/9 = (6, −3, −6)/9 = (2, −1, −2)/3,
// and u × y = n again ((4 + 2, 4 + 2, −1 + 4)/9 = (2, 2, 1)/3), so (u, y, n) is right-handed.
const SLANT: Plane = { origin: [10, 20, 30], xAxis: [1 / 3, -2 / 3, 2 / 3], normal: [2 / 3, 2 / 3, 1 / 3] };

test("a slanted plane's y axis and a point of its frame, worked by hand", () => {
  // Kills both minus signs of cross() => plus, and toWorld's `+ y·v[0]` => `-` and `+ x·u[2]` => `-`.
  close(yAxisOf(SLANT), [2 / 3, -1 / 3, -2 / 3], "y axis");
  // (3, 6) is origin + 3u + 6y = (10, 20, 30) + (1, −2, 2) + (4, −2, −4) = (15, 16, 28).
  close(toWorld(SLANT, [3, 6]), [15, 16, 28], "toWorld", 1e-12);
});

test("a ray onto the slanted plane, worked by hand", () => {
  // Kills each `+ t·dir[i]` => `-` and `- o[i]` => `+` in the hit point. The ray starts 9 mm out
  // along the normal from (15, 16, 28): from = (15, 16, 28) + 9n = (21, 22, 31), heading
  // dir = (−2, −2, −1) (3 mm per step against n). n·dir = −(4 + 4 + 1)/3 = −3 and
  // n·(origin − from) = n·(−11, −2, −1) = (−22 − 4 − 1)/3 = −9, so t = 3 and the hit is
  // from + 3·dir = (15, 16, 28), which is (3, 6) in the plane's frame.
  close(rayOnPlane([21, 22, 31], [-2, -2, -1], SLANT), [3, 6], "hit");
});

test("a hit too far out to write as a number is no hit", () => {
  // Kills `Number.isFinite(x) && Number.isFinite(y)` => true and `||`. From (1.7e308, 0, 1)
  // down onto the ground plane along (1.7e308, 0, −1): t = 1, x = 1.7e308 + 1.7e308 = Infinity,
  // y = 0.
  const XY: Plane = { origin: [0, 0, 0], xAxis: [1, 0, 0], normal: [0, 0, 1] };
  assert.equal(rayOnPlane([1.7e308, 0, 1], [1.7e308, 0, -1], XY), null);
});

test("no grid spacing past the largest double, rather than an infinite one", () => {
  // Kills `Number.isFinite(spacing) && spacing > 0` => `||`. A pixel of 2e307 mm wants lines
  // 1.6e308 apart, so the spacing is 1e309, which is Infinity in a double.
  assert.equal(gridSpacing(2e307), null);
  assert.equal(gridSpacing(1e306), 1e307, "8e306 rounds up to the next power of ten");
});

test("the axes are drawn when the grid's edge lies exactly on them, and not when the grid is wholly off them", () => {
  // Kills `y0 <= 0` => `<`, `0 <= x1` => `<` and `0 <= y1` / `0 <= x1` => true. At 0.125 mm a
  // pixel the minor spacing is 1 mm (8 px), major 10 mm; reaching 10,000 px caps the grid at 300
  // lines each way. Centred on (−300, 300) the grid runs x −600..0 and y 0..600: both axes lie on
  // its edges, so both are drawn. Centred on (1000, −1000) it runs x 700..1300, y −1300..−700:
  // neither axis is in it.
  const edge = sketchGrid([-300, 300], 0.125, 10_000)!;
  assert.deepEqual(edge.bounds, [-600, 0, 0, 600]);
  assert.deepEqual(edge.axes, { x: [[-600, 0], [0, 0]], y: [[0, 0], [0, 600]] });
  const off = sketchGrid([1000, -1000], 0.125, 10_000)!;
  assert.deepEqual(off.bounds, [700, 1300, -1300, -700]);
  assert.deepEqual(off.axes, { x: null, y: null });
});

// ---------- views.ts ----------

test("each corner view's direction is its corner, as a copy the caller may change", () => {
  // Kills bottom-back-right's z −1 => +1 and viewDirection's body => {} and its copy => [].
  assert.deepEqual(viewDirection("bottom-back-right"), [1, 1, -1]);
  const d = viewDirection("top");
  d[2] = 5;
  assert.deepEqual(viewDirection("top"), [0, 0, 1]);
});

test("Look At from behind a back wall keeps Z up (worked by hand)", () => {
  // Kills dot's `a[1] * b[1]` => `/`. Normal +Y, x axis +X: y = n × x = (0, 0, −1). From side −1
  // the camera looks from −Y, the front view, whose up is +Z; y·(0, 0, 1) = −1 < 0, so up turns to
  // (0, 0, 1). With `/` the dot is 0·0 + 0/0 + ... = NaN, never below 0, and up would stay −Z.
  const wall: Plane = { origin: [0, 0, 0], xAxis: [1, 0, 0], normal: [0, 1, 0] };
  close(planeViewBasis(wall, { centre: [0, 0, 0], radius: 1 }, 45, 1, -1).up, [0, 0, 1], "up");
});

test("Look At from side −1 keeps y as up when y is square to the standard up", () => {
  // Kills `dot(...) < 0` => `<= 0`. Normal −Z, x axis +Y: y = n × x = (1, 0, 0). From side −1 the
  // camera looks down from +Z, the top view, whose up is +Y: y·(0, 1, 0) = 0, not below 0, so up
  // stays (1, 0, 0).
  const floor: Plane = { origin: [0, 0, 0], xAxis: [0, 1, 0], normal: [0, 0, -1] };
  close(planeViewBasis(floor, { centre: [0, 0, 0], radius: 1 }, 45, 1, -1).up, [1, 0, 0], "up");
});

test("orbitSafeOffset leaves a slanted offset alone and nudges a vertical one along any up (worked by hand)", () => {
  // Kills `hypot(x, y) !== 0 || dist === 0` => false, => `&&`, and its first half => false, and
  // each `+ s·up[i]` => `-` / `s·up[1]` => `s / up[1]`. Straight up 10 mm, s = −1e-6·10 = −1e-5:
  // with up (0.6, 0.8, 0) the offset becomes (−6e-6, −8e-6, 10); with up (0.6, 0, 0.8) it becomes
  // (−6e-6, 0, 10 − 8e-6).
  assert.deepEqual(orbitSafeOffset([3, 4, 5], [0, 0, 1]), [3, 4, 5]);
  close(orbitSafeOffset([0, 0, 10], [0.6, 0.8, 0]), [-6e-6, -8e-6, 10], "up in the plane", 1e-18);
  close(orbitSafeOffset([0, 0, 10], [0.6, 0, 0.8]), [-6e-6, 0, 10 - 8e-6], "up with z", 1e-15);
});

test("cubeView: a hit exactly CUBE_CORNER out on both other axes is the corner", () => {
  // Kills `abs[i] >= CUBE_CORNER` => `>`. (0.6, −1, 0.6) is on the front face, 0.6 out to the
  // right and up: the top-front-right corner.
  assert.equal(cubeView([0.6, -1, 0.6]), "top-front-right");
});

// ---------- navigation.ts ----------

test("the navigation modes, in the bar's order", () => {
  // Kills NAV_MODES => [] and each name => "".
  assert.deepEqual(NAV_MODES, ["orbit", "pan", "zoom"]);
});

test("orbiting far past straight down stops just short of it, on the camera's own side (worked by hand)", () => {
  // Kills `Math.PI - POLE_EPS` => `+` and up's [0, 0, 1] => []. From (10, 0, 0) about the origin
  // (θ = 0, φ = π/2) tilted by 10 rad, φ is held at π − 1e-6: x = 10·sin(π − 1e-6) ≈ +1e-5,
  // z = 10·cos(π − 1e-6) ≈ −10. Past the pole (π + 1e-6) x would be −1e-5.
  const p = orbitBy({ position: [10, 0, 0], target: [0, 0, 0], up: [0, 0, 1] }, 0, 10);
  assert.ok(p.position[0] > 0 && Math.abs(p.position[0] - 1e-5) < 1e-12, `x ${p.position[0]}`);
  assert.ok(Math.abs(p.position[2] + 10) < 1e-9);
  assert.deepEqual(p.up, [0, 0, 1]);
});

test("a cube drag of 50 px down tilts a quarter turn up (worked by hand)", () => {
  // Kills `-dy * k` => `-dy / k` and `-dy` => `+dy`. Half a turn per 100 px: 50 px is π/2, and
  // down tilts toward the top (φ falls), so dPhi = −π/2.
  const { dTheta, dPhi } = cubeDragAngles(0, 50);
  assert.equal(dTheta, -0);
  assert.ok(Math.abs(dPhi + Math.PI / 2) < 1e-15, `dPhi ${dPhi}`);
});

// ---------- picking.ts ----------

test("a segment off the origin, worked by hand: the nearest point and its distance", () => {
  // Kills `p.x - ax` => `+` and `p.y - ay` => `+`. From (10, 0) to (20, 0), the pointer at
  // (15, 3): the nearest point is (15, 0), half way (t = 0.5), 3 px away. The same turned on its
  // side: (0, 10) to (0, 20) with the pointer at (3, 15).
  assert.deepEqual(segmentsNear([10, 0, 20, 0], { x: 15, y: 3 }), [{ segment: 0, t: 0.5, distance: 3 }]);
  assert.deepEqual(segmentsNear([0, 10, 0, 20], { x: 3, y: 15 }), [{ segment: 0, t: 0.5, distance: 3 }]);
});

test("a segment whose far end can't be drawn is skipped, even with its near end under the pointer", () => {
  // Kills `![...].every(Number.isFinite)` => false, its list => [] and every => some: with b NaN,
  // len2 is NaN, t falls back to 0 and the distance to a alone (1 px) would count.
  assert.deepEqual(segmentsNear([10, 10, NaN, 10], { x: 10, y: 11 }), []);
});

test("segments the same distance away keep their order", () => {
  // Kills the tie-break `a.segment - b.segment` => `+`. Two segments 2 px either side of the
  // pointer.
  assert.deepEqual(segmentsNear([0, 2, 10, 2, 0, -2, 10, -2], { x: 5, y: 0 }).map((n) => n.segment), [0, 1]);
});

test("a face hit exactly at the slack distance does not hide the edge", () => {
  // Kills `>=` => `>`.
  assert.equal(unhidden(100, 100 * (1 - EDGE_DEPTH_SLACK)), true);
  assert.equal(unhidden(100, 100 * (1 - 2 * EDGE_DEPTH_SLACK)), false);
});

// ---------- framing.ts, highlight.ts, pane.ts ----------

test("a body that shrank twentyfold is framed again (worked by hand)", () => {
  // Kills `0.1 * last.radius` => `0.1 / last.radius`: 5 < 0.1 × 100 = 10, so refit; with `/` it
  // would ask 5 < 0.001.
  assert.equal(needsRefit({ centre: [0, 0, 0], radius: 100 }, { centre: [0, 0, 0], radius: 5 }), true);
  assert.equal(needsRefit({ centre: [0, 0, 0], radius: 100 }, { centre: [0, 0, 0], radius: 11 }), false);
});

test("a selection that is a single point frames that point", () => {
  // Kills `lo[0] <= hi[0]` => `<`: an edge of zero length at (5, 6, 7) has lo = hi.
  const mesh = { positions: new Float32Array(0), indices: new Uint32Array(0), triangle_faces: new Uint32Array(0), edge_lines: new Float32Array([5, 6, 7, 5, 6, 7]), edge_line_edges: new Uint32Array([3]) };
  assert.deepEqual(selectionFraming(mesh as never, [], [3]), { centre: [5, 6, 7], radius: 0 });
});

test("the base and edge colours, from their hex codes by hand", () => {
  // Kills each `/ 255` => `* 255` and EDGE_COLOUR => []. 0x9aa7b8 is (154, 167, 184) and 0x0b0c0e
  // is (11, 12, 14), each over 255.
  assert.deepEqual(BASE_COLOUR, [154 / 255, 167 / 255, 184 / 255]);
  assert.deepEqual(EDGE_COLOUR, [11 / 255, 12 / 255, 14 / 255]);
});

test("a pane reads back the sketch pointer handler it set, and null once it is cleared", () => {
  // Kills the getter's body => {} (undefined, not null) and `?? null` => `&& null`.
  const scene = { onSketchPointer: null } as unknown as SharedViewport;
  const pane = paneViewports(scene)({ element: {} } as unknown as PaneCamera);
  assert.equal(pane.onSketchPointer, null);
  const handler = () => {};
  pane.onSketchPointer = handler;
  assert.equal(pane.onSketchPointer, handler);
  pane.onSketchPointer = null;
  assert.equal(pane.onSketchPointer, null);
});

test("leftovers from the second run: an x too large with a finite y, the y axis off a grid left of it, every corner", () => {
  // Kills rayOnPlane's `isFinite(x) && isFinite(y)` => `||`: on a ground plane whose x axis is
  // (1, 1, 0)/√2, the hit at (1.5e308, 1.5e308) has x = 3e308/√2, past the largest double, and y = 0.
  const diagonal: Plane = { origin: [0, 0, 0], xAxis: [Math.SQRT1_2, Math.SQRT1_2, 0], normal: [0, 0, 1] };
  assert.equal(rayOnPlane([1.5e308, 1.5e308, 1], [0, 0, -1], diagonal), null);
  // Kills `0 <= x1` => true: centred on (−1000, 0) the grid runs x −1300..−700, left of the y axis.
  assert.equal(sketchGrid([-1000, 0], 0.125, 10_000)!.axes.y, null);
  // Kills each corner's signs => their opposite.
  const corners = { "top-front-left": [-1, -1, 1], "top-front-right": [1, -1, 1], "top-back-left": [-1, 1, 1], "top-back-right": [1, 1, 1], "bottom-front-left": [-1, -1, -1], "bottom-front-right": [1, -1, -1], "bottom-back-left": [-1, 1, -1], "bottom-back-right": [1, 1, -1] } as const;
  for (const [name, d] of Object.entries(corners)) assert.deepEqual(viewDirection(name as keyof typeof corners), d, name);
});

test("a zoom that lands exactly on a limit keeps its own factor, not one worked back from the limit", () => {
  // Kills `wanted < min` => `<=` and `wanted > max` => `>=`: at the limit the mutant returns
  // limit / distance, which rounding can make differ from the factor. Worked by hand in
  // doubles: 3 × 0.1 = 0.30000000000000004 and that / 3 = 0.10000000000000002;
  // 3 × 0.7 = 2.0999999999999996 and that / 3 = 0.6999999999999998.
  assert.equal(clampZoom(3, 0.1, 3 * 0.1, 100), 0.1);
  assert.equal(clampZoom(3, 0.7, 0, 3 * 0.7), 0.7);
});

test("a square canvas fits with the vertical half-angle itself, not one sent through tan and atan", () => {
  // Kills `aspect < 1` => `<=`: at aspect 1 the mutant uses atan(tan(h)), which for a 2.26°
  // field of view is one step off h = 2.26π/360, and there the distance r / sin(h) changes in
  // its last digit: 50.70751684352266 against the mutant's 50.707516843522654 (no whole-degree
  // field of view shows it, so this odd one is used).
  const h = (2.26 * Math.PI) / 360;
  assert.notEqual(Math.atan(Math.tan(h)), h);
  assert.equal(fitDistance(1, 2.26, 1), 50.70751684352266);
  assert.equal(fitDistance(1, 2.26, 1), 1 / Math.sin(h));
});
