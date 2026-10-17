import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_STEP, POLE_EPS, ZOOM_PER_PIXEL, clampZoom, cubeDragAngles, orbitBy, dragAction, dragZoomFactor, focusPixel, focusPoint, panBy, wheelFactor, zoomAt, type CameraPose, type Lens, type Vec3 } from "../src/navigation.ts";

const near = (a: readonly number[], b: readonly number[], eps = 1e-9, what = "") =>
  a.forEach((x, i) => assert.ok(Math.abs(x - b[i]) <= eps, `${what} [${a}] vs [${b}]`));

/**
 * The simple model the seeded tests check against, written apart from the
 * module: a point's screen pixel for a camera, from the pinhole picture.
 * forward = unit(target − position), right = unit(forward × up), screen up
 * = right × forward; a point v ahead lands at ndc (v·right / (v·forward ·
 * t · aspect), v·up / (v·forward · t)) with t = tan(fov/2), and ndc runs
 * −1…1 over a W × H canvas, +y up, while pixels run down.
 */
function pixelOf(pose: CameraPose, lens: Lens, heightPx: number, p: Vec3): [number, number] {
  const f = pose.target.map((x, i) => x - pose.position[i]);
  const fl = Math.sqrt(f[0] ** 2 + f[1] ** 2 + f[2] ** 2);
  const fw = f.map((x) => x / fl);
  const r0 = [fw[1] * pose.up[2] - fw[2] * pose.up[1], fw[2] * pose.up[0] - fw[0] * pose.up[2], fw[0] * pose.up[1] - fw[1] * pose.up[0]];
  const rl = Math.sqrt(r0[0] ** 2 + r0[1] ** 2 + r0[2] ** 2);
  const r = r0.map((x) => x / rl);
  const u = [r[1] * fw[2] - r[2] * fw[1], r[2] * fw[0] - r[0] * fw[2], r[0] * fw[1] - r[1] * fw[0]];
  const v = p.map((x, i) => x - pose.position[i]);
  const d = (a: number[]) => a[0] * v[0] + a[1] * v[1] + a[2] * v[2];
  const t = Math.tan((lens.fov * Math.PI) / 360);
  const nx = d(r) / (d(fw) * t * lens.aspect);
  const ny = d(u) / (d(fw) * t);
  const w = heightPx * lens.aspect;
  return [((nx + 1) / 2) * w, ((1 - ny) / 2) * heightPx];
}

// Hand-worked camera: at (0, 0, 10) looking down at the origin, y up on
// screen, a 90° fov (tan 45° = 1) on a 2:1 canvas 200 px tall.
const down: CameraPose = { position: [0, 0, 10], target: [0, 0, 0], up: [0, 1, 0] };
const wide: Lens = { fov: 90, aspect: 2 };

test("hand-worked: the focus point under a cursor half way to the right edge and a quarter of the way down", () => {
  // forward = (0, 0, −1); right = forward × up = (0,0,−1) × (0,1,0) = (1, 0, 0);
  // screen up = right × forward = (0, 1, 0). The ray for ndc (0.5, −0.25) is
  // forward + 0.5·1·2·right − 0.25·1·up = (1, −0.25, −1); 10 of those from
  // (0, 0, 10) is (10, −2.5, 0). Check by size: the canvas's half width at
  // 10 mm away spans 10·tan 45°·2 = 20 mm, so ndc 0.5 is 10 mm right.
  near(focusPoint(down, [0.5, -0.25], wide), [10, -2.5, 0]);
});

test("hand-worked: zooming in by half toward that point", () => {
  // P = (10, −2.5, 0). New camera = P + ½((0, 0, 10) − P) = (10, −2.5, 0) +
  // ½(−10, 2.5, 10) = (5, −1.25, 5); new target = P + ½((0,0,0) − P) = (5, −1.25, 0).
  // The camera still looks straight down, 5 mm from its target.
  const z = zoomAt(down, [0.5, -0.25], wide, 0.5);
  near(z.position, [5, -1.25, 5]);
  near(z.target, [5, -1.25, 0]);
  // And P is still at ndc (0.5, −0.25): (P − camera) = (5, −1.25, −5), so
  // x = 5 / (5 · 1 · 2) = 0.5 and y = −1.25 / 5 = −0.25.
  near(pixelOf(z, wide, 200, [10, -2.5, 0]), pixelOf(down, wide, 200, [10, -2.5, 0]));
});

test("hand-worked: zooming at the centre of the screen moves straight in, the target stays", () => {
  // ndc (0, 0) is the target itself: P = (0, 0, 0), so the target stays and the camera halves its height.
  const z = zoomAt(down, [0, 0], wide, 0.5);
  near(z.position, [0, 0, 5]);
  near(z.target, [0, 0, 0]);
});

test("hand-worked: a pan moves the camera opposite to the pointer, a tenth of a millimetre a pixel", () => {
  // The canvas's 200 px height spans 2 · 10 · tan 45° = 20 mm at the target: 0.1 mm a pixel.
  near([focusPixel(10, 90, 200)], [0.1], 1e-15);
  // Pointer 50 px right and 20 px up (dy = −20): the scene follows it, so the
  // camera goes 5 mm left (−x) and 2 mm down (−y): (−5, −2, 10) and (−5, −2, 0).
  const p = panBy(down, 50, -20, wide, 200);
  near(p.position, [-5, -2, 10]);
  near(p.target, [-5, -2, 0]);
  // The origin, grabbed at the centre (200, 100), is now at (250, 80).
  near(pixelOf(p, wide, 200, [0, 0, 0]), [250, 80]);
});

test("hand-worked: the wheel's factors", () => {
  // One 100 px notch away from you: e^(−100 · 0.002) = e^−0.2 = 0.8187 (in).
  near([wheelFactor(-100, 0, false)], [Math.exp(-0.2)]);
  // Toward you, a line-mode notch of 3 lines = 48 px: e^0.096 = 1.1008 (out).
  near([wheelFactor(3, 1, false)], [Math.exp(0.096)]);
  // A pinch of 10 counts five times: e^(10 · 0.002 · 5) = e^0.1.
  near([wheelFactor(10, 0, true)], [Math.exp(0.1)]);
  // Half a page: 400 px, e^0.8 = 2.2255. A whole page would be e^1.6 = 4.95, capped at 4.
  near([wheelFactor(0.5, 2, false)], [Math.exp(0.8)]);
  assert.equal(wheelFactor(1, 2, false), MAX_STEP);
  // Dragging up 50 px in Zoom mode zooms in like a 50 px scroll away.
  near([dragZoomFactor(-50)], [Math.exp(-0.1)]);
  assert.equal(wheelFactor(0, 0, false), 1);
  assert.equal(wheelFactor(NaN, 0, false), 1);
  assert.equal(wheelFactor(Infinity, 0, false), 1);
});

test("boundary: one event zooms at most ×4 either way; 0.9× of the scroll that reaches it is kept, 1.1× is capped", () => {
  const edge = Math.log(MAX_STEP) / ZOOM_PER_PIXEL; // 693.1 px
  near([wheelFactor(edge * 0.9, 0, false)], [Math.exp(edge * 0.9 * ZOOM_PER_PIXEL)]);
  assert.ok(wheelFactor(edge * 0.9, 0, false) < MAX_STEP);
  assert.equal(wheelFactor(edge * 1.1, 0, false), MAX_STEP);
  assert.ok(wheelFactor(-edge * 0.9, 0, false) > 1 / MAX_STEP);
  assert.equal(wheelFactor(-edge * 1.1, 0, false), 1 / MAX_STEP);
});

test("boundary: zooms stop at the view's nearest and farthest distances", () => {
  // From 100 mm with limits 10…1000: ×0.09 would be 9 mm (stops at 10, ×0.1); ×0.11 is 11 mm, kept.
  assert.equal(clampZoom(100, 0.1 * 0.9, 10, 1000), 0.1);
  assert.equal(clampZoom(100, 0.1 * 1.1, 10, 1000), 0.1 * 1.1);
  // ×11 would be 1100 mm (stops at ×10); ×9 is kept.
  assert.equal(clampZoom(100, 10 * 1.1, 10, 1000), 10);
  assert.equal(clampZoom(100, 10 * 0.9, 10, 1000), 10 * 0.9);
  // No limits (the 3D view): anything goes.
  assert.equal(clampZoom(100, 1e-6, 0, Infinity), 1e-6);
});

test("which drag a press starts: middle pans, Shift+middle orbits, right does nothing (kept for a menu), left follows the mode", () => {
  for (const mode of ["orbit", "pan", "zoom"] as const) {
    assert.equal(dragAction(1, false, mode), "pan");
    assert.equal(dragAction(1, true, mode), "orbit");
    assert.equal(dragAction(2, false, mode), null);
    assert.equal(dragAction(2, true, mode), null);
    assert.equal(dragAction(0, false, mode), mode);
  }
  assert.equal(dragAction(3, false, "orbit"), null, "the back button does nothing");
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
const SEED = Number(process.env.FISSION_SEED ?? 20261017);

/** A random camera: anywhere within a few metres, looking at a target 1 mm…10 m away, with a random roll. */
function randomCase(rand: () => number) {
  const r = (lo: number, hi: number) => lo + (hi - lo) * rand();
  const target: Vec3 = [r(-500, 500), r(-500, 500), r(-500, 500)];
  // A random direction on the sphere and a distance spread over four powers of ten.
  const z = r(-1, 1), a = r(0, 2 * Math.PI), s = Math.sqrt(1 - z * z);
  const dist = 10 ** r(0, 4);
  const position: Vec3 = [target[0] + dist * s * Math.cos(a), target[1] + dist * s * Math.sin(a), target[2] + dist * z];
  let up: Vec3 = [r(-1, 1), r(-1, 1), r(-1, 1)];
  // An up almost along the view has no screen direction: redraw it square to the view's x axis instead.
  const f = [s * Math.cos(a), s * Math.sin(a), z];
  const along = Math.abs(f[0] * up[0] + f[1] * up[1] + f[2] * up[2]) / Math.sqrt(up[0] ** 2 + up[1] ** 2 + up[2] ** 2);
  if (!(along < 0.99)) up = Math.abs(f[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const lens: Lens = { fov: r(20, 90), aspect: r(0.4, 3) };
  const height = Math.round(r(100, 2000));
  return { pose: { position, target, up }, lens, height, ndc: [r(-1, 1), r(-1, 1)] as [number, number], dist, r };
}

test(`seeded (${SEED}): 2,000 zooms keep the point under the cursor still and scale the distance`, () => {
  const rand = seeded(SEED);
  for (let i = 0; i < 2000; i++) {
    const { pose, lens, height, ndc, dist, r } = randomCase(rand);
    const factor = 10 ** r(-0.6, 0.6);
    const p = focusPoint(pose, ndc, lens);
    // The focus point is under the cursor (by the model) and on the focus plane (as far along the view as the target).
    const w = height * lens.aspect;
    near(pixelOf(pose, lens, height, p), [((ndc[0] + 1) / 2) * w, ((1 - ndc[1]) / 2) * height], 1e-6, `case ${i}: focus point under the cursor`);
    const z = zoomAt(pose, ndc, lens, factor);
    near(pixelOf(z, lens, height, p), pixelOf(pose, lens, height, p), 1e-6, `case ${i}: still under the cursor`);
    const nd = Math.sqrt(z.target.reduce((s, t, k) => s + (t - z.position[k]) ** 2, 0));
    assert.ok(Math.abs(nd / dist - factor) < 1e-9, `case ${i}: distance ×${factor}, got ×${nd / dist}`);
    // The view direction doesn't turn.
    const f0 = pose.target.map((t, k) => (t - pose.position[k]) / dist);
    const f1 = z.target.map((t, k) => (t - z.position[k]) / nd);
    near(f1, f0, 1e-9, `case ${i}: same direction`);
  }
});

test(`seeded (${SEED}): 2,000 pans move the grabbed point exactly with the pointer`, () => {
  const rand = seeded(SEED + 1);
  for (let i = 0; i < 2000; i++) {
    const { pose, lens, height, ndc, r } = randomCase(rand);
    const grabbed = focusPoint(pose, ndc, lens);
    const dx = r(-400, 400), dy = r(-400, 400);
    const before = pixelOf(pose, lens, height, grabbed);
    const after = pixelOf(panBy(pose, dx, dy, lens, height), lens, height, grabbed);
    near(after, [before[0] + dx, before[1] + dy], 1e-6, `case ${i}: moved (${dx}, ${dy})`);
  }
});

test("seeded: a zoom then the opposite zoom at the same cursor gives the camera back", () => {
  const rand = seeded(SEED + 2);
  for (let i = 0; i < 500; i++) {
    const { pose, lens, ndc, r, dist } = randomCase(rand);
    const factor = 10 ** r(-0.6, 0.6);
    const back = zoomAt(zoomAt(pose, ndc, lens, factor), ndc, lens, 1 / factor);
    near(back.position, pose.position, 1e-9 * (dist + 1000), `case ${i}`);
    near(back.target, pose.target, 1e-9 * (dist + 1000), `case ${i}`);
  }
});

test("hand-worked: orbiting a quarter turn round Z and tilting up an eighth", () => {
  // From (10, 0, 0) looking at the origin: θ = 0, φ = 90°. A quarter turn
  // (θ + 90°) puts the camera at (0, 10, 0).
  const side: CameraPose = { position: [10, 0, 0], target: [0, 0, 0], up: [0, 0, 1] };
  near(orbitBy(side, Math.PI / 2, 0).position, [0, 10, 0]);
  // Tilting up 45° (φ 90° → 45°): (10 sin 45°, 0, 10 cos 45°) = (7.0711, 0, 7.0711).
  near(orbitBy(side, 0, -Math.PI / 4).position, [7.0710678118654755, 0, 7.0710678118654755]);
  // About a target that isn't the origin: (1, 2, 3) + the same offsets.
  near(orbitBy({ position: [11, 2, 3], target: [1, 2, 3], up: [0, 0, 1] }, Math.PI / 2, 0).position, [1, 12, 3]);
  // The cube: a 100 px drag right is half a turn the other way round Z: (10, 0, 0) to (−10, 0, 0).
  const { dTheta, dPhi } = cubeDragAngles(100, 0);
  near([dTheta, dPhi], [-Math.PI, -0]);
  near(orbitBy(side, dTheta, dPhi).position, [-10, 0, 0]);
});

test("boundary: an orbit stops just short of straight down; 0.9× of the tilt to the pole is kept, 1.1× stops at it", () => {
  // From φ = 90°, tilting up by 0.9 × 90° leaves φ = 9° (kept); by 1.1 × 90° would pass the pole, so φ stops at POLE_EPS.
  const side: CameraPose = { position: [10, 0, 0], target: [0, 0, 0], up: [0, 0, 1] };
  const phiOf = (p: CameraPose) => Math.acos(p.position[2] / 10);
  near([phiOf(orbitBy(side, 0, -0.9 * Math.PI / 2))], [0.1 * Math.PI / 2], 1e-12);
  near([phiOf(orbitBy(side, 0, -1.1 * Math.PI / 2))], [POLE_EPS], 1e-9);
  near([phiOf(orbitBy(side, 0, 1.1 * Math.PI / 2))], [Math.PI - POLE_EPS], 1e-7);
});

test(`seeded (${SEED}): 2,000 orbits keep the target and distance, and turning back undoes them`, () => {
  const rand = seeded(SEED + 3);
  for (let i = 0; i < 2000; i++) {
    const { pose, dist, r } = randomCase(rand);
    const dTheta = r(-7, 7), dPhi = r(-0.5, 0.5);
    const o = orbitBy(pose, dTheta, dPhi);
    near(o.target, pose.target, 0, `case ${i}: target`);
    const nd = Math.sqrt(o.position.reduce((s, x, k) => s + (x - o.target[k]) ** 2, 0));
    assert.ok(Math.abs(nd / dist - 1) < 1e-12, `case ${i}: distance`);
    // Away from the poles, the opposite orbit comes back.
    const phi = Math.acos((pose.position[2] - pose.target[2]) / dist);
    if (phi + dPhi > 0.01 && phi + dPhi < Math.PI - 0.01) near(orbitBy(o, -dTheta, -dPhi).position, pose.position, 1e-9 * (dist + 1000), `case ${i}: back`);
  }
});
