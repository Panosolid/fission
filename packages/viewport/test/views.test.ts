import { test } from "node:test";
import assert from "node:assert/strict";
import { VIEW_NAMES, viewBasis, type ViewBasis } from "../src/views.ts";

type Vec3 = [number, number, number];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a: Vec3) => a.map((x) => x / Math.hypot(...a)) as Vec3;

/**
 * Where a point lands in normalised device coordinates (−1…1, +y up) for a
 * square canvas and a 45° fov, worked out from the basis alone: forward is
 * camera → target, right = forward × up, the screen's up = right × forward.
 */
function ndc(view: ViewBasis, p: Vec3): [number, number] {
  const fwd = unit(view.target.map((t, i) => t - view.position[i]) as Vec3);
  const right = unit(cross(fwd, view.up));
  const up = cross(right, fwd);
  const v = p.map((x, i) => x - view.position[i]) as Vec3;
  const t = Math.tan(Math.PI / 8);
  return [dot(v, right) / (dot(v, fwd) * t), dot(v, up) / (dot(v, fwd) * t)];
}

// The default 40 × 30 × 20 box: centre (20, 15, 10), r = √(40² + 30² + 20²)/2 = √2900/2.
const box = { centre: [20, 15, 10] as Vec3, radius: Math.sqrt(2900) / 2 };
// fit()'s distance: r / sin(22.5°) = 26.9258 / 0.382683 = 70.3606.
const dist = 70.3606;

test("every view looks at the centre from fit()'s distance", () => {
  for (const name of VIEW_NAMES) {
    const v = viewBasis(name, box);
    assert.deepEqual(v.target, [20, 15, 10]);
    assert.ok(Math.abs(Math.hypot(...v.position.map((p, i) => p - v.target[i])) - dist) < 1e-3, name);
  }
});

test("home is the three-quarter view fit() always used, Z up", () => {
  // centre + 70.362 × (0.6, −0.8, 0.55)/|…|, |…| = √(0.36 + 0.64 + 0.3025) = 1.14127:
  // (20 + 36.991, 15 − 49.322, 10 + 33.910).
  const v = viewBasis("home", box);
  [56.991, -34.322, 43.91].forEach((x, i) => assert.ok(Math.abs(v.position[i] - x) < 1e-2, `position[${i}]`));
  assert.deepEqual(v.up, [0, 0, 1]);
});

test("front: looking along +Y, (20, 0, 10) at the centre and +X to the right", () => {
  const v = viewBasis("front", box);
  // The camera is at (20, 15 − 70.362, 10); (20, 0, 10) is on its line of sight through the centre.
  const [cx, cy] = ndc(v, [20, 0, 10]);
  assert.ok(Math.abs(cx) < 1e-12 && Math.abs(cy) < 1e-12);
  // (40, 0, 10) is 20 to the right at depth 70.362 − 15 = 55.362:
  // x = 20 / (55.362 × tan 22.5°) = 20 / 22.932 = 0.8722, y = 0.
  const [x, y] = ndc(v, [40, 0, 10]);
  assert.ok(Math.abs(x - 0.8722) < 1e-3, `x ${x}`);
  assert.ok(Math.abs(y) < 1e-12);
  // Z is up on screen: the top edge's middle (20, 0, 20) is above the centre.
  assert.ok(ndc(v, [20, 0, 20])[1] > 0);
});

test("top: looking down −Z with +Y up on screen and +X to the right", () => {
  const v = viewBasis("top", box);
  // The top face (z = 20) is at depth 70.362 − 10 = 60.362; its back edge's middle
  // (20, 30, 20) is 15 above: y = 15 / (60.362 × tan 22.5°) = 15 / 25.003 = 0.5999.
  const [x, y] = ndc(v, [20, 30, 20]);
  assert.ok(Math.abs(x) < 1e-12);
  assert.ok(Math.abs(y - 0.5999) < 1e-3, `y ${y}`);
  // The right edge's middle (40, 15, 20): x = 20 / 25.003 = 0.7999, y = 0.
  const [rx, ry] = ndc(v, [40, 15, 20]);
  assert.ok(Math.abs(rx - 0.7999) < 1e-3 && Math.abs(ry) < 1e-12);
  // 40 wide by 30 tall: the face's corners span 4 : 3 on screen.
  const [x0, y0] = ndc(v, [0, 0, 20]);
  const [x1, y1] = ndc(v, [40, 30, 20]);
  assert.ok(Math.abs((x1 - x0) / (y1 - y0) - 4 / 3) < 1e-9);
});

test("right: looking along −X with +Y to the right and Z up", () => {
  const v = viewBasis("right", box);
  // Depth of the x = 40 face: 70.362 − 20 = 50.362; (40, 30, 10) is 15 right of the centre:
  // x = 15 / (50.362 × tan 22.5°) = 15 / 20.861 = 0.7191.
  const [x, y] = ndc(v, [40, 30, 10]);
  assert.ok(Math.abs(x - 0.7191) < 1e-3, `x ${x}`);
  assert.ok(Math.abs(y) < 1e-12);
  assert.ok(ndc(v, [40, 15, 20])[1] > 0); // Z up
});

test("a mirrored view would fail these checks", () => {
  // Guard on the projection helper itself: looking from +Y instead (a back view)
  // puts +X on the left, so the front check above can fail.
  const back: ViewBasis = { position: [20, 15 + dist, 10], target: [20, 15, 10], up: [0, 0, 1] };
  assert.ok(ndc(back, [40, 0, 10])[0] < 0);
});
