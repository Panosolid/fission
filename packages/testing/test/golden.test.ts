// The golden models' runner without the kernel (step 28a, src/golden.ts):
// the arithmetic expectations are written in, hand-worked and against a
// tree evaluated directly for seeded random sums; the reader's refusals;
// which models wait for a later step; the gap measured on a view; and the
// comparer at 0.9× and 1.1× of each of its tolerances. The models
// themselves run on the real kernel in journeys/golden.journey.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { compare, evaluate, LINEAR, NORMAL_ABS, plan, planeGap, POINT_ABS, readExpect, REL, type GoldenExpect, type Measured, type MeasuredBody } from "../src/golden.ts";
import { seeded } from "../src/index.ts";

test("hand-worked arithmetic: precedence, powers right to left, a leading minus, pi and the functions", () => {
  // 2 + 3 · 4 = 14, not 20; (2 + 3) · 4 = 20.
  assert.equal(evaluate("2 + 3*4"), 14);
  assert.equal(evaluate("(2 + 3)*4"), 20);
  // 2^3^2 = 2^9 = 512 (right to left), not 8² = 64; −2² = −4 (the power first), (−2)² = 4.
  assert.equal(evaluate("2^3^2"), 512);
  assert.equal(evaluate("-2^2"), -4);
  assert.equal(evaluate("(-2)^2"), 4);
  // 10 − 4 − 3 = 3 (left to right), 24 / 4 / 3 = 2.
  assert.equal(evaluate("10 - 4 - 3"), 3);
  assert.equal(evaluate("24/4/3"), 2);
  // 2 · 3^2 = 18; 2^-1 = 0.5.
  assert.equal(evaluate("2*3^2"), 18);
  assert.equal(evaluate("2^-1"), 0.5);
  // The plate's volume: 6 · (80 · 40 − 2π · 6²) = 19200 − 432π.
  assert.equal(evaluate("6*(80*40 - 2*pi*6^2)"), 19200 - 432 * Math.PI);
  // sqrt(9) + sin(pi/2) + cos(0) + tan(0) + atan(1) · 4 = 3 + 1 + 1 + 0 + π.
  assert.ok(Math.abs(evaluate("sqrt(9) + sin(pi/2) + cos(0) + tan(0) + atan(1)*4") - (5 + Math.PI)) < 1e-15);
  // Numbers as JSON writes them: 1e-5, 2.5e+3, .5, 7.: 2500 + 0.5 + 7 = 2507.5.
  assert.equal(evaluate("1e-5"), 1e-5);
  assert.equal(evaluate("2.5e+3 + .5 + 7."), 2507.5);
  assert.equal(evaluate(24000), 24000);
});

test("arithmetic it can't read is refused, naming where", () => {
  assert.throws(() => evaluate("2 +"), /"2 \+": expected a number, pi, a function or \( at character 4/);
  assert.throws(() => evaluate("(2 + 3"), /expected \)/);
  assert.throws(() => evaluate("2 3"), /unexpected text at character 3/);
  assert.throws(() => evaluate("e"), /unknown name e/);
  assert.throws(() => evaluate("sqrt 4"), /expected \( after sqrt/);
  assert.throws(() => evaluate("1/0"), /"1\/0" is Infinity, not a finite number/);
  assert.throws(() => evaluate("sqrt(-1)"), /NaN/);
  assert.throws(() => evaluate("2 × 3"), /unexpected text/, "the working's × is words, not arithmetic");
  assert.throws(() => evaluate(Infinity), /not a finite number/);
  assert.throws(() => evaluate(null as never), /neither a number nor arithmetic/);
});

type Tree = number | { op: "+" | "-" | "*" | "/" | "^"; a: Tree; b: Tree } | { neg: Tree } | { pi: true };

test("200 seeded random sums × 5 seeds read as a tree built of them is evaluated directly", () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const r = seeded(BigInt(seed));
    const pick = <T>(xs: readonly T[]) => xs[Math.floor(r.next() * xs.length)];
    const grow = (depth: number): Tree => {
      const k = r.next();
      if (depth === 0 || k < 0.3) return pick([1, 2, 3, 0.5, 10, 1e-3, 7.25]);
      if (k < 0.37) return { pi: true };
      if (k < 0.45) return { neg: grow(depth - 1) };
      return { op: pick(["+", "-", "*", "/", "^"] as const), a: grow(depth - 1), b: grow(depth - 1) };
    };
    // Every operation bracketed, so the printing doesn't depend on precedence; the precedence cases are hand-worked above.
    const print = (t: Tree): string => (typeof t === "number" ? String(t) : "pi" in t ? "pi" : "neg" in t ? `(-${print(t.neg)})` : `(${print(t.a)} ${t.op} ${print(t.b)})`);
    const direct = (t: Tree): number => {
      if (typeof t === "number") return t;
      if ("pi" in t) return Math.PI;
      if ("neg" in t) return -direct(t.neg);
      const [a, b] = [direct(t.a), direct(t.b)];
      return t.op === "+" ? a + b : t.op === "-" ? a - b : t.op === "*" ? a * b : t.op === "/" ? a / b : a ** b;
    };
    let finite = 0;
    for (let i = 0; i < 200; i++) {
      const t = grow(4);
      const want = direct(t);
      if (Number.isFinite(want)) {
        finite++;
        assert.equal(evaluate(print(t)), want, `seed ${seed}: ${print(t)}`);
      } else assert.throws(() => evaluate(print(t)), /not a finite number/, `seed ${seed}: ${print(t)}`);
    }
    assert.ok(finite > 150, `seed ${seed}: ${finite} finite`);
  }
});

const expectation = (): GoldenExpect => ({
  model: "box",
  what: "a 40 × 30 × 20 box",
  bodies: [
    {
      body: "Body 1",
      item: "feature-1",
      volume: { is: "40*30*20", why: "40 × 30 × 20" },
      area: { is: "2*(40*30 + 40*20 + 30*20)", why: "three pairs of faces" },
      topology: { faces: 6, edges: 12, vertices: 8, why: "a box" },
      box: { is: [[0, 0, 0], [40, 30, 20]], why: "from the origin" },
      tolerance: { is: "1e-5", why: "LINEAR" },
    },
  ],
  sketches: [{ sketch: "sketch-2", face: "face:feature-1/top", plane: { normal: [0, 0, 1], point: [0, 0, 20], why: "the top at z = 20" } }],
  pins: [{ sketch: "sketch-2", point: "point-3", kind: "endpoint", name: "back+right&back+top&right+top", at: { is: [40, 30, 20], why: "the back right top corner" } }],
});

/** What a rebuild matching `expectation` measures. */
const exact = (): Measured => ({
  bodies: [{ body: "Body 1", item: "feature-1", volume: 24000, area: 5200, faces: 6, edges: 12, vertices: 8, box: [[0, 0, 0], [40, 30, 20]], tolerance: LINEAR, gap: 0, errors: [] }],
  sketches: [{ sketch: "sketch-2", face: "face:feature-1/top", found: 1, normal: [0, 0, 1], centroid: [20, 15, 20], placed: { normal: [0, 0, 1], origin: [0, 0, 20] } }],
  pins: [{ sketch: "sketch-2", point: "point-3", kind: "endpoint", name: "back+right&back+top&right+top", at: [40, 30, 20] }],
  trouble: [],
});

const withBody = (change: Partial<MeasuredBody>): Measured => ({ ...exact(), bodies: [{ ...exact().bodies[0], ...change }] });

test("the comparer: each tolerance at 0.9× passes and at 1.1× fails, each difference named", () => {
  const want = expectation();
  assert.deepEqual(compare(want, exact()), []);
  // Volume 24000 and area 5200 to REL of their size: 24000 · (1 ± 0.9e-9) in, 1.1e-9 out.
  assert.deepEqual(compare(want, withBody({ volume: 24000 * (1 + 0.9 * REL) })), []);
  assert.deepEqual(compare(want, withBody({ volume: 24000 * (1 - 1.1 * REL) })), [`Body 1 (feature-1): volume ${24000 * (1 - 1.1 * REL)}, not 24000 (40*30*20)`]);
  assert.deepEqual(compare(want, withBody({ area: 5200 * (1 - 0.9 * REL) })), []);
  assert.match(compare(want, withBody({ area: 5200 * (1 + 1.1 * REL) })).join(), /area/);
  // A box corner to POINT_ABS (a nanometre), a zero coordinate included.
  assert.deepEqual(compare(want, withBody({ box: [[0.9 * POINT_ABS, 0, 0], [40, 30, 20 - 0.9 * POINT_ABS]] })), []);
  assert.match(compare(want, withBody({ box: [[0, 0, 0], [40, 30 + 1.1 * POINT_ABS, 20]] })).join(), /box \(0, 0, 0\) to \(40, 30\.0000011, 20\), not \(0, 0, 0\) to \(40, 30, 20\)/);
  assert.match(compare(want, withBody({ box: [[-1.1 * POINT_ABS, 0, 0], [40, 30, 20]] })).join(), /box/);
  // The gap to a flat face, against the body's tolerance 1e-5: 0.9e-5 in, 1.1e-5 out.
  assert.deepEqual(compare(want, withBody({ gap: 0.9 * LINEAR })), []);
  assert.match(compare(want, withBody({ gap: 1.1 * LINEAR })).join(), /lies 0\.000011\d* mm off a flat face it bounds, more than the 0\.00001 it may/);
  // The tolerance carried: LINEAR in, 1.1 LINEAR out (a body's own tolerance, step 31 on).
  assert.deepEqual(compare(want, withBody({ tolerance: 0.9 * LINEAR })), []);
  assert.match(compare(want, withBody({ tolerance: 1.1 * LINEAR })).join(), /carries a tolerance of 0\.000011\d* mm/);
  // Counts exactly; validation errors; another body list.
  assert.match(compare(want, withBody({ edges: 13 })).join(), /faces, edges, vertices 6, 13, 8, not 6, 12, 8/);
  assert.match(compare(want, withBody({ errors: ["vertex 7 off edge 3"] })).join(), /fails validation: vertex 7 off edge 3/);
  assert.match(compare(want, withBody({ body: "Body 2" })).join(), /^bodies Body 2 \(feature-1\), not Body 1 \(feature-1\)$/);
  assert.match(compare(want, { ...exact(), bodies: [] }).join(), /^bodies none, not Body 1/);
  // Anything that didn't build cleanly is a difference of its own.
  assert.deepEqual(compare(want, { ...exact(), trouble: ["feature-5 failed: no outline"] }), ["feature-5 failed: no outline"]);
});

test("the comparer on sketches and pins: the face's name, its plane at 0.9× and 1.1× of NORMAL_ABS and POINT_ABS, the pin and where it lands", () => {
  const want = expectation();
  const sketch = (change: Partial<Measured["sketches"][0]>): Measured => ({ ...exact(), sketches: [{ ...exact().sketches[0], ...change }] });
  assert.match(compare(want, sketch({ face: "face:feature-1/bottom" })).join(), /^sketch-2: on the face named face:feature-1\/bottom, not face:feature-1\/top$/);
  assert.match(compare(want, sketch({ found: 0, normal: null, centroid: null })).join(), /no face named face:feature-1\/top/);
  assert.match(compare(want, sketch({ found: 2, normal: null, centroid: null })).join(), /2 faces named/);
  // A normal off by 0.9 ANGULAR passes, 1.1 fails; the face's centroid off its plane by 0.9 and 1.1 nm.
  assert.deepEqual(compare(want, sketch({ normal: [0.9 * NORMAL_ABS, 0, 1] })), []);
  assert.match(compare(want, sketch({ normal: [1.1 * NORMAL_ABS, 0, 1] })).join(), /face:feature-1\/top faces/);
  assert.deepEqual(compare(want, sketch({ centroid: [20, 15, 20 + 0.9 * POINT_ABS] })), []);
  assert.match(compare(want, sketch({ centroid: [20, 15, 20 - 1.1 * POINT_ABS] })).join(), /off its plane/);
  // Where the rebuild placed the sketch: anywhere on the plane (an origin of (5, 5, 20) is fine), facing out.
  assert.deepEqual(compare(want, sketch({ placed: { normal: [0, 0, 1], origin: [5, 5, 20] } })), []);
  assert.match(compare(want, sketch({ placed: { normal: [0, 0, -1], origin: [0, 0, 20] } })).join(), /placed facing \(0, 0, -1\)/);
  assert.match(compare(want, sketch({ placed: { normal: [0, 0, 1], origin: [0, 0, 20 + 1.1 * POINT_ABS] } })).join(), /placed .* off its face's plane/);
  assert.match(compare(want, sketch({ placed: null })).join(), /not placed/);
  assert.match(compare(want, { ...exact(), sketches: [] }).join(), /sketches on faces none, not sketch-2/);
  // Pins.
  const pin = (change: Partial<Measured["pins"][0]>): Measured => ({ ...exact(), pins: [{ ...exact().pins[0], ...change }] });
  assert.match(compare(want, pin({ name: "back+left&back+top&left+top" })).join(), /pinned to endpoint back\+left/);
  assert.match(compare(want, pin({ feature: "feature-7" })).join(), /of feature-7, not endpoint/);
  assert.deepEqual(compare(want, pin({ at: [40 + 0.9 * POINT_ABS, 30, 20] })), []);
  assert.match(compare(want, pin({ at: [40, 30, 20 + 1.1 * POINT_ABS] })).join(), /sketch-2\/point-3: at/);
  assert.match(compare(want, pin({ at: null })).join(), /its edge wasn't found/);
  assert.match(compare(want, { ...exact(), pins: [] }).join(), /pinned points none, not sketch-2\/point-3/);
});

test("the reader refuses an expectation missing a field, its working or a readable number", () => {
  const text = (change: (e: Record<string, unknown>) => void) => {
    const e = structuredClone(expectation()) as unknown as Record<string, unknown>;
    change(e);
    return JSON.stringify(e);
  };
  assert.deepEqual(readExpect(text(() => {}), "box.expect.json"), expectation());
  const bodies = (e: Record<string, unknown>) => e.bodies as Record<string, Record<string, unknown>>[];
  assert.throws(() => readExpect(text((e) => (bodies(e)[0].volume.why = "")), "box.expect.json"), /box\.expect\.json: bodies\[0\]\.volume needs its working in why/);
  assert.throws(() => readExpect(text((e) => (bodies(e)[0].area.is = "2*(40*30")), "f"), /bodies\[0\]\.area "2\*\(40\*30": expected \)/);
  assert.throws(() => readExpect(text((e) => ((bodies(e)[0].topology as Record<string, unknown>).edges = 12.5)), "f"), /topology\.edges must be a count/);
  assert.throws(() => readExpect(text((e) => ((bodies(e)[0].box as Record<string, unknown>).is = [[0, 0, 0]])), "f"), /box must be two corners/);
  assert.throws(() => readExpect(text((e) => ((bodies(e)[0].box as { is: unknown[][] }).is[1] = [40, 30])), "f"), /box\.is\[1\] must be three numbers/);
  assert.throws(() => readExpect(text((e) => delete bodies(e)[0].tolerance), "f"), /tolerance needs its working/);
  assert.throws(() => readExpect(text((e) => (e.bodies = [])), "f"), /bodies must list at least one body/);
  assert.throws(() => readExpect(text((e) => delete e.pins), "f"), /pins must be a list/);
  assert.throws(() => readExpect(text((e) => (((e.sketches as Record<string, Record<string, unknown>>[])[0].plane.normal as unknown[])[2] = "up")), "f"), /plane\.normal\[2\] "up": unknown name up/);
  assert.throws(() => readExpect(text((e) => (((e.pins as Record<string, unknown>[])[0].name = ""))), "f"), /pins\[0\]\.name must be a name/);
  // A model waiting for a later step may have no bodies yet (28a2 writes them).
  assert.equal(readExpect(text((e) => ((e.bodies = []), (e.from = "34"))), "f").from, "34");
});

test("which models run: one waiting for a step that hasn't landed has no file; once it lands it needs one; every file has an expectation", () => {
  const e = (model: string, from?: string): GoldenExpect => ({ ...expectation(), model, ...(from ? { from } : {}) });
  assert.deepEqual(plan([e("box"), e("cut", "34")], ["box"], new Set()), [{ model: "box", run: "build" }, { model: "cut", run: "waits", from: "34" }]);
  assert.deepEqual(plan([e("box"), e("cut", "34")], ["box", "cut"], new Set(["34"])), [{ model: "box", run: "build" }, { model: "cut", run: "build" }]);
  assert.throws(() => plan([e("box"), e("cut", "34")], ["box"], new Set(["34"])), /step 34 has landed: make cut\.panosolid\.json with it/);
  assert.throws(() => plan([e("cut", "34")], ["cut"], new Set()), /cut waits for step 34, which hasn't landed, yet has a project file/);
  assert.throws(() => plan([e("box")], []), /box has no project file/);
  assert.throws(() => plan([e("box")], ["box", "stray"]), /stray\.panosolid\.json has no stray\.expect\.json/);
  assert.throws(() => plan([e("box"), e("box")], ["box"]), /two expectations name the same model/);
});

/** A unit cube's view as the kernel gives it (faces −Z, +Z, −Y, +Y, −X, +X; corners k = 4z + 2y + x). */
function cube() {
  const corner = (k: number): [number, number, number] => [k & 1, (k >> 1) & 1, (k >> 2) & 1];
  const faces: { n: [number, number, number]; c: [number, number, number]; on: (p: number[]) => boolean }[] = [
    { n: [0, 0, -1], c: [0.5, 0.5, 0], on: (p) => p[2] === 0 },
    { n: [0, 0, 1], c: [0.5, 0.5, 1], on: (p) => p[2] === 1 },
    { n: [0, -1, 0], c: [0.5, 0, 0.5], on: (p) => p[1] === 0 },
    { n: [0, 1, 0], c: [0.5, 1, 0.5], on: (p) => p[1] === 1 },
    { n: [-1, 0, 0], c: [0, 0.5, 0.5], on: (p) => p[0] === 0 },
    { n: [1, 0, 0], c: [1, 0.5, 0.5], on: (p) => p[0] === 1 },
  ];
  const edges: [number, number][] = [];
  for (let a = 0; a < 8; a++) for (const bit of [1, 2, 4]) if (!(a & bit)) edges.push([a, a | bit]);
  const points = Array.from({ length: 8 }, (_, k) => corner(k));
  return {
    face_normals: faces.map((f) => f.n) as ([number, number, number] | null)[],
    face_centroids: faces.map((f) => f.c),
    vertex_points: points,
    edge_vertices: edges,
    edge_middles: edges.map(([a, b]) => [0, 1, 2].map((k) => (points[a][k] + points[b][k]) / 2) as [number, number, number]),
    edge_faces: edges.map(([a, b]) => faces.map((_, f) => f).filter((f) => faces[f].on(points[a]) && faces[f].on(points[b])) as [number, number]),
  };
}

test("the gap: none on a true cube; a corner lifted d sits d off the top it bounds (hand-worked), and seeded lifts against that", () => {
  assert.equal(planeGap(cube()), 0);
  // Corner 7 (1, 1, 1) lifted 2e-5 in z: 2e-5 off the top's plane z = 1, while the sides x = 1 and y = 1 it also bounds are still
  // through it; the middles of its three edges move half as far.
  const lifted = cube();
  lifted.vertex_points[7] = [1, 1, 1 + 2e-5];
  // (1 + 2e-5 is rounded to a double, so the lift read back is within an ulp of 1, 2.2e-16, of 2e-5.)
  const ULP = 2 ** -52;
  assert.ok(Math.abs(planeGap(lifted) - 2e-5) <= ULP, String(planeGap(lifted)));
  // A curved face (no normal) isn't measured: corner 7 lifted, the top made curved, the sides it bounds are still true.
  assert.equal(planeGap({ ...lifted, face_normals: lifted.face_normals.map((n, f) => (f === 1 ? null : n)) }), 0);
  // Seeded: a random corner moved a random amount along a random axis is off by that amount (each axis is some face's normal).
  for (const seed of [11, 12, 13]) {
    const r = seeded(BigInt(seed));
    for (let i = 0; i < 50; i++) {
      const v = cube();
      const k = Math.floor(r.next() * 8);
      const axis = Math.floor(r.next() * 3);
      const d = (r.next() - 0.5) * 1e-4;
      v.vertex_points[k] = v.vertex_points[k].map((c, n) => (n === axis ? c + d : c)) as [number, number, number];
      assert.ok(Math.abs(planeGap(v) - Math.abs(d)) <= ULP, `seed ${seed}, corner ${k}, axis ${axis}, ${d}: ${planeGap(v)}`);
    }
  }
});
