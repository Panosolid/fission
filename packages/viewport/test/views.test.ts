import { test } from "node:test";
import assert from "node:assert/strict";
import { CUBE_CORNER, VIEW_NAMES, cubeView, fitDistance, orbitSafeOffset, planeViewBasis, viewBasis, type ViewBasis } from "../src/views.ts";

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

test("bottom: looking up +Z, the front (−Y) at the top of the screen and +X to the right", () => {
  const v = viewBasis("bottom", box);
  // The camera is at z = 10 − 70.362; the bottom face (z = 0) is 60.362 away. Its front
  // edge's middle (20, 0, 0) is 15 towards −Y, which is up: y = 15 / 25.003 = 0.5999.
  const [x, y] = ndc(v, [20, 0, 0]);
  assert.ok(Math.abs(x) < 1e-12 && Math.abs(y - 0.5999) < 1e-3, `${x} ${y}`);
  // right = forward × up = (0, 0, 1) × (0, −1, 0) = (1, 0, 0): (40, 15, 0) at x = 20 / 25.003 = 0.7999.
  const [rx, ry] = ndc(v, [40, 15, 0]);
  assert.ok(Math.abs(rx - 0.7999) < 1e-3 && Math.abs(ry) < 1e-12);
});

test("back and left: from +Y, −X is to the right; from −X, −Y is to the right", () => {
  // Back: the y = 30 face is 70.362 − 15 = 55.362 away; (0, 30, 10) is 20 towards −X:
  // x = 20 / (55.362 × tan 22.5°) = 0.8722.
  const [bx, by] = ndc(viewBasis("back", box), [0, 30, 10]);
  assert.ok(Math.abs(bx - 0.8722) < 1e-3 && Math.abs(by) < 1e-12, `back ${bx}`);
  // Left: the x = 0 face is 70.362 − 20 = 50.362 away; (0, 0, 10) is 15 towards −Y:
  // x = 15 / (50.362 × tan 22.5°) = 0.7191.
  const [lx, ly] = ndc(viewBasis("left", box), [0, 0, 10]);
  assert.ok(Math.abs(lx - 0.7191) < 1e-3 && Math.abs(ly) < 1e-12, `left ${lx}`);
});

test("a corner view looks from that corner along the cube's diagonal, Z up", () => {
  const v = viewBasis("top-front-right", box);
  // From (1, −1, 1): the centre + (10, −10, 10) is on the line of sight.
  const [cx, cy] = ndc(v, [30, 5, 20]);
  assert.ok(Math.abs(cx) < 1e-12 && Math.abs(cy) < 1e-12);
  // right = forward × Z = (−1, 1, −1)/√3 × (0, 0, 1) = (1, 1, 0)/√3: along (1, 1, 0) from the
  // centre is level with it and to the right; straight up is above.
  const [hx, hy] = ndc(v, [25, 20, 10]);
  assert.ok(hx > 0 && Math.abs(hy) < 1e-12);
  assert.ok(ndc(v, [20, 15, 20])[1] > 0);
  // The opposite corner looks the other way.
  const w = viewBasis("bottom-back-left", box);
  assert.deepEqual(w.position.map((p, i) => Math.round(p - w.target[i] + (v.position[i] - v.target[i]))), [0, 0, 0]);
});

test("fitDistance: the sphere fits the narrower of the two fields of view", () => {
  // fov 90°: the vertical half-angle is 45°, so on a square or wide canvas
  // the distance is r / sin 45° = √2 r, whatever the width.
  assert.ok(Math.abs(fitDistance(1, 90, 1) - Math.SQRT2) < 1e-12);
  assert.ok(Math.abs(fitDistance(1, 90, 2) - Math.SQRT2) < 1e-12);
  // Twice as tall as wide: tan(horizontal half-angle) = tan 45° × 0.5 = 0.5,
  // so sin = 0.5 / √(1 + 0.25) = 1/√5 and the distance is √5 r = 2.2361 r.
  assert.ok(Math.abs(fitDistance(1, 90, 0.5) - Math.sqrt(5)) < 1e-12);
  // The default box on the 375 × 407 phone canvas, fov 45°: tan h = 0.414214 × 375/407
  // = 0.381647, sin h = 0.381647 / √(1 + 0.145655) = 0.356563, r / sin h = 26.9258 / 0.356563 = 75.5148.
  assert.ok(Math.abs(fitDistance(Math.sqrt(2900) / 2, 45, 375 / 407) - 75.5148) < 1e-3);
});

test("viewBasis on a tall canvas: the sphere's sides touch the left and right edges", () => {
  // Aspect 0.5, fov 45°. The sphere's silhouette is tangent to the frustum's
  // side planes: the angle from the view axis to a tangent is asin(r / d),
  // which must equal the horizontal half-angle atan(tan 22.5° × 0.5) = 11.7°.
  const v = viewBasis("front", box, 45, 0.5);
  const d = Math.hypot(...v.position.map((p, i) => p - v.target[i]));
  assert.ok(Math.abs(Math.asin(box.radius / d) - Math.atan(Math.tan(Math.PI / 8) * 0.5)) < 1e-12);
  // Framed to the vertical fov only (the old way) the sphere would spill sideways.
  assert.ok(Math.asin(box.radius / dist) > Math.atan(Math.tan(Math.PI / 8) * 0.5));
});

test("15 views: home, six faces, eight corners", () => {
  assert.equal(VIEW_NAMES.length, 15);
  assert.equal(new Set(VIEW_NAMES).size, 15);
});

test("orbitSafeOffset: straight down or up, the camera leans so Z points along the view's up on screen", () => {
  // Top: offset (0, 0, 70), up +Y: the camera steps 70 × 1e-6 = 7e-5 against up, to −Y.
  assert.deepEqual(orbitSafeOffset([0, 0, 70], [0, 1, 0]), [0, -7e-5, 70]);
  // Bottom: offset (0, 0, −70), up −Y: the camera steps 7e-5 along up, also to −Y.
  assert.deepEqual(orbitSafeOffset([0, 0, -70], [0, -1, 0]), [0, -7e-5, -70]);
  // Seen from there, Z's part across the line of sight, Z − (Z·f) f with f = −offset/|offset|,
  // is what the orbit shows as up: it must point along the view's up in both cases.
  for (const [offset, up] of [[[0, 0, 70], [0, 1, 0]], [[0, 0, -70], [0, -1, 0]]] as [Vec3, Vec3][]) {
    const o = orbitSafeOffset(offset, up);
    const f = unit(o.map((x) => -x) as Vec3);
    const screenUp = [0, 0, 1].map((z, i) => z - f[2] * f[i]) as Vec3;
    assert.ok(dot(screenUp, up) > 0, `up ${up}`);
  }
  // Any other direction is left alone.
  assert.deepEqual(orbitSafeOffset([0, -70, 0], [0, 0, 1]), [0, -70, 0]);
});

test("cubeView: a hit on a face gives that face, near a corner on two axes gives the corner", () => {
  // Face centres (the cube spans −1…1): +Z is top, −Y front, +X right, and so on.
  assert.equal(cubeView([0, 0, 1]), "top");
  assert.equal(cubeView([0.1, -0.2, -1]), "bottom");
  assert.equal(cubeView([0.3, -1, 0.2]), "front");
  assert.equal(cubeView([0, 1, 0]), "back");
  assert.equal(cubeView([-1, 0.5, -0.5]), "left");
  assert.equal(cubeView([1, 0, 0]), "right");
  // (0.7, −0.8, 1): on the top face, x and y both past 0.6 towards +X and −Y.
  assert.equal(cubeView([0.7, -0.8, 1]), "top-front-right");
  // The same corner from its other two faces.
  assert.equal(cubeView([1, -0.9, 0.65]), "top-front-right");
  assert.equal(cubeView([0.95, -1, 0.7]), "top-front-right");
  assert.equal(cubeView([-1, 0.7, -0.7]), "bottom-back-left");
  // Near an edge but not a corner (only one other axis out far): still the face.
  assert.equal(cubeView([0.9, 0.1, 1]), "top");
});

test("cubeView corner boundary: 0.9 × CUBE_CORNER is the face, 1.1 × is the corner", () => {
  const inner = 0.9 * CUBE_CORNER; // 0.54
  const outer = 1.1 * CUBE_CORNER; // 0.66
  assert.equal(cubeView([inner, -inner, 1]), "top");
  assert.equal(cubeView([outer, -outer, 1]), "top-front-right");
  assert.equal(cubeView([outer, -inner, 1]), "top"); // one axis out is not enough
});

test("cubeView: points not on the cube's surface give null", () => {
  assert.equal(cubeView([0, 0, 0.5]), null); // inside
  assert.equal(cubeView([0, 0, 1.5]), null); // outside
  assert.equal(cubeView([NaN, 0, 1]), null);
  assert.equal(cubeView([0, 1]), null);
});

test("hand-worked: Look At on the ground plane, a body above it", () => {
  // fov 60: half-angle 30°, sin 0.5, so a sphere of radius 10 fits from 20 away. Its centre (10, 20, 5) is 5
  // above the plane: the camera looks at (10, 20, 0), the centre moved down onto the plane, from 20 + 5 = 25 up,
  // so it is exactly 20 from the sphere's centre. Up on screen is the plane's y axis, Z × X = Y.
  const b = planeViewBasis({ origin: [0, 0, 0], xAxis: [1, 0, 0], normal: [0, 0, 1] }, { centre: [10, 20, 5], radius: 10 }, 60, 1);
  const near = (a: number[], e: number[], what: string) => assert.ok(a.every((v, i) => Math.abs(v - e[i]) < 1e-12), `${what}: ${a} not ${e}`); // sin 30° is a hair off 0.5 in doubles
  near(b.position, [10, 20, 25], "position");
  near(b.target, [10, 20, 0], "target");
  near(b.up, [0, 1, 0], "up");
});

test("hand-worked: Look At on the front plane, a body behind it", () => {
  // XZ, normal −Y, x along X: up is (−Y) × X = Z. The centre (3, 4, 5) is 4 behind the plane (n·c = −4), so it is
  // not added: the camera looks at (3, 0, 5) from 20 out along −Y, (3, −20, 5), 24 from the centre (fits with room).
  const b = planeViewBasis({ origin: [0, 0, 0], xAxis: [1, 0, 0], normal: [0, -1, 0] }, { centre: [3, 4, 5], radius: 10 }, 60, 1);
  const near = (a: number[], e: number[], what: string) => assert.ok(a.every((v, i) => Math.abs(v - e[i]) < 1e-12), `${what}: ${a} not ${e}`);
  near(b.position, [3, -20, 5], "position");
  near(b.target, [3, 0, 5], "target");
  near(b.up, [0, 0, 1], "up");
});

test("Look At on an origin plane is that plane's standard view when the framed centre is on the plane", () => {
  // Two code paths agreeing (a self-consistency check): the ground plane is the top view, the front plane the front view.
  const framing = { centre: [2, 0, 0] as [number, number, number], radius: 7 };
  const near = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]) < 1e-12);
  const top = viewBasis("top", framing, 45, 1.5);
  const xy = planeViewBasis({ origin: [0, 0, 0], xAxis: [1, 0, 0], normal: [0, 0, 1] }, framing, 45, 1.5);
  assert.ok(near(xy.position, top.position) && near(xy.target, top.target) && near(xy.up, top.up));
  const front = viewBasis("front", framing, 45, 1.5);
  const xz = planeViewBasis({ origin: [0, 0, 0], xAxis: [1, 0, 0], normal: [0, -1, 0] }, framing, 45, 1.5);
  assert.ok(near(xz.position, front.position) && near(xz.target, front.target) && near(xz.up, front.up));
});

test("seeded: Look At on 500 slanted planes looks straight at the plane, its x axis to the right, and fits the sphere", () => {
  let a = 99;
  const rand = () => ((a = (Math.imul(a, 1103515245) + 12345) >>> 0) / 4294967296);
  for (let i = 0; i < 500; i++) {
    const normal = unit([rand() - 0.5, rand() - 0.5, rand() - 0.5]);
    const xAxis = unit(cross(normal, unit([rand() - 0.5, rand() - 0.5, rand() - 0.5])));
    const origin: Vec3 = [rand() * 100, rand() * 100, rand() * 100];
    const framing = { centre: [rand() * 200 - 100, rand() * 200 - 100, rand() * 200 - 100] as Vec3, radius: 1 + rand() * 50 };
    const b = planeViewBasis({ origin, xAxis, normal }, framing, 45, 1);
    const look = unit(b.target.map((t, k) => t - b.position[k]) as Vec3);
    assert.ok(Math.abs(dot(look, normal) + 1) < 1e-9, `plane ${i}: not looking straight at it`);
    assert.ok(Math.abs(dot(b.target.map((t, k) => t - origin[k]) as Vec3, normal)) < 1e-9, `plane ${i}: target off the plane`);
    // Screen right is look × up; it must be the plane's x axis.
    const right = cross(look, b.up);
    assert.ok(right.every((v, k) => Math.abs(v - xAxis[k]) < 1e-9), `plane ${i}: x axis not to the right`);
    const centreDistance = Math.sqrt(b.position.reduce((s, p, k) => s + (p - framing.centre[k]) ** 2, 0));
    assert.ok(centreDistance >= fitDistance(framing.radius, 45, 1) * (1 - 1e-12), `plane ${i}: the sphere doesn't fit`);
  }
});

test("hand-worked (26d): Look At on a box's bottom face, side −1, looks up from below", () => {
  // The bottom face of the box (0..40, 0..30, 0..20) gets the ground plane's frame (normal +Z, into the box) with
  // side −1. Toward the camera is −Z. fov 60, radius 10: fits from 20. The centre (20, 15, 10) is 10 above the plane,
  // so on the far side from the camera (d = −10, not added): the camera looks at (20, 15, 0) from 20 below,
  // (20, 15, −20), outside the box. Up is still the frame's y, Z × X = Y, so X runs to the left on screen.
  const b = planeViewBasis({ origin: [0, 0, 0], xAxis: [1, 0, 0], normal: [0, 0, 1] }, { centre: [20, 15, 10], radius: 10 }, 60, 1, -1);
  const near = (a: number[], e: number[], what: string) => assert.ok(a.every((v, i) => Math.abs(v - e[i]) < 1e-12), `${what}: ${a} not ${e}`);
  near(b.position, [20, 15, -20], "position");
  near(b.target, [20, 15, 0], "target");
  near(b.up, [0, 1, 0], "up");
});

test("hand-worked (26d): Look At on a box's back face, side −1, looks from behind", () => {
  // The back face y = 30 gets the front plane's frame (normal −Y, into the box) at origin (0, 30, 0), side −1, so
  // toward the camera is +Y. The centre (20, 15, 10) is 15 in front of the face (d = (15 − 30)·1 = −15, not
  // added): the camera looks at (20, 30, 10) from 20 along +Y, (20, 50, 10). Up is (−Y) × X = Z.
  const b = planeViewBasis({ origin: [0, 30, 0], xAxis: [1, 0, 0], normal: [0, -1, 0] }, { centre: [20, 15, 10], radius: 10 }, 60, 1, -1);
  const near = (a: number[], e: number[], what: string) => assert.ok(a.every((v, i) => Math.abs(v - e[i]) < 1e-12), `${what}: ${a} not ${e}`);
  near(b.position, [20, 50, 10], "position");
  near(b.target, [20, 30, 10], "target");
  near(b.up, [0, 0, 1], "up");
});

test("Look At from side −1 on a plane is side +1 on the plane with its normal and x turned round (same up)", () => {
  // Two code paths agreeing: flipping both the normal and x keeps y = n × x, and the camera goes to −n.
  const framing = { centre: [3, -2, 7] as [number, number, number], radius: 6 };
  const p = { origin: [1, 2, 3] as [number, number, number], xAxis: [0.6, 0.8, 0] as [number, number, number], normal: [0.8, -0.6, 0] as [number, number, number] };
  const a = planeViewBasis(p, framing, 45, 1.3, -1);
  const b = planeViewBasis({ origin: p.origin, xAxis: [-0.6, -0.8, 0], normal: [-0.8, 0.6, 0] }, framing, 45, 1.3, 1);
  const near = (u: number[], v: number[]) => u.every((x, i) => Math.abs(x - v[i]) < 1e-12);
  assert.ok(near(a.position, b.position) && near(a.target, b.target) && near(a.up, b.up), JSON.stringify({ a, b }));
});
