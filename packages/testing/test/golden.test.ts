// The golden models' runner without the kernel (step 28a, src/golden.ts):
// the arithmetic expectations are written in, hand-worked and against a
// tree evaluated directly for seeded random sums; the reader's refusals;
// which models wait for a later step; the gap measured on a view; and the
// comparer at 0.9× and 1.1× of each of its tolerances. From 28a2: the
// elliptic integrals the pipe tee's answers are written in, hand-worked
// and against quadrature; the tee's answers against its integrals worked
// numerically from their definitions; recipes, shells and refusals; and a
// look over every expectation for answers no solid could have. The models
// themselves run on the real kernel in journeys/golden.journey.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { compare, elliptic, evaluate, LINEAR, NORMAL_ABS, plan, planeGap, POINT_ABS, readExpect, REL, shellCount, type GoldenExpect, type Measured, type MeasuredBody } from "../src/golden.ts";
import { seeded } from "../src/index.ts";

const GOLDEN = new URL("../../../tests/golden/", import.meta.url);
const allExpects = () =>
  readdirSync(GOLDEN)
    .filter((f) => f.endsWith(".expect.json"))
    .sort()
    .map((f) => readExpect(readFileSync(new URL(f, GOLDEN), "utf8"), f));

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
  bodies: [{ body: "Body 1", item: "feature-1", volume: 24000, area: 5200, faces: 6, edges: 12, vertices: 8, shells: 1, box: [[0, 0, 0], [40, 30, 20]], tolerance: LINEAR, gap: 0, errors: [] }],
  sketches: [{ sketch: "sketch-2", face: "face:feature-1/top", found: 1, normal: [0, 0, 1], centroid: [20, 15, 20], placed: { normal: [0, 0, 1], origin: [0, 0, 20] } }],
  pins: [{ sketch: "sketch-2", point: "point-3", kind: "endpoint", name: "back+right&back+top&right+top", at: [40, 30, 20] }],
  trouble: [],
  failed: [],
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
  assert.deepEqual(compare(want, { ...exact(), trouble: ["feature-5 is off"] }), ["feature-5 is off"]);
  assert.deepEqual(compare(want, { ...exact(), failed: [{ item: "feature-5", message: "no outline" }] }), ["feature-5 failed: no outline"]);
});

test("the comparer, from 28a2: volumes and areas to REL of their own size however small, shells, and items refused with words", () => {
  // Regression (found writing 28a2's 1 µm cube): the check was REL · max(1, |answer|), so a volume of 1e-9 mm³ passed at 2e-9.
  const micron = (volume: number): Measured => withBody({ volume });
  const cube = { ...expectation(), bodies: [{ ...expectation().bodies[0], volume: { is: "0.001^3", why: "a 1 µm cube" } }] };
  assert.match(compare(cube, micron(2e-9)).join(), /^Body 1 \(feature-1\): volume 2e-9, not 1e-9/);
  // At 0.9× and 1.1× of REL of 1e-9: 1e-9 · (1 + 0.9e-9) in, 1e-9 · (1 − 1.1e-9) out.
  assert.deepEqual(compare(cube, micron(1e-9 * (1 + 0.9 * REL))), []);
  assert.match(compare(cube, micron(1e-9 * (1 - 1.1 * REL))).join(), /volume/);
  // Shells: left out means 1; a body with a void says 2.
  assert.match(compare(expectation(), withBody({ shells: 2 })).join(), /^Body 1 \(feature-1\): 2 shells, not 1$/);
  const hollow = structuredClone(expectation());
  hollow.bodies[0].topology.shells = 2;
  assert.match(compare(hollow, exact()).join(), /1 shells, not 2/);
  assert.deepEqual(compare(hollow, withBody({ shells: 2 })), []);
  // Refused: the item fails and its message holds every word, ignoring case; or it fails with other words; or it builds.
  const refusing: GoldenExpect = { ...expectation(), refused: [{ item: "feature-9", says: ["1 µm", "thin"], why: "a sliver" }] };
  const failing = (message: string): Measured => ({ ...exact(), failed: [{ item: "feature-9", message }] });
  assert.deepEqual(compare(refusing, failing("A face would be THIN: move them at least 1 µm apart")), []);
  assert.deepEqual(compare(refusing, failing("too thin")), ['feature-9 failed, but its message "too thin" doesn\'t say "1 µm"']);
  assert.deepEqual(compare(refusing, exact()), ["feature-9 built, but must be refused: a sliver"]);
  // Another item failing is still a difference, refusal or not.
  assert.deepEqual(compare(refusing, { ...failing("thin, 1 µm"), failed: [{ item: "feature-9", message: "thin, 1 µm" }, { item: "feature-4", message: "no outline" }] }), ["feature-4 failed: no outline"]);
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
  // A model waiting for a later step may have no bodies yet, and must say how a user makes it.
  const recipe = [{ do: "Start from the ready-made box", makes: "feature-1" }, { do: "Create Sketch on its top", makes: "sketch-2" }];
  assert.equal(readExpect(text((e) => ((e.bodies = []), (e.from = "35"), (e.recipe = recipe))), "f").from, "35");
  assert.throws(() => readExpect(text((e) => (e.from = "35")), "f"), /recipe must say how a user makes the model, which waits for step 35/);
});

test("the reader, from 28a2: recipes name every item the expectation does, once; shells and refusals are readable", () => {
  const text = (change: (e: Record<string, unknown>) => void) => {
    const e = structuredClone(expectation()) as unknown as Record<string, unknown>;
    e.from = "35";
    e.recipe = [{ do: "Start from the ready-made box", makes: "feature-1" }, { do: "Create Sketch on its top", makes: "sketch-2" }, { do: "Click (40, 30) on the corner" }];
    change(e);
    return JSON.stringify(e);
  };
  type Step = { do?: unknown; makes?: unknown };
  const steps = (e: Record<string, unknown>) => e.recipe as Step[];
  assert.equal(readExpect(text(() => {}), "f").recipe?.length, 3);
  assert.throws(() => readExpect(text((e) => (e.recipe = [])), "f"), /recipe must list its steps/);
  assert.throws(() => readExpect(text((e) => (steps(e)[2].do = " ")), "f"), /recipe\[2\] must say what the user does in do/);
  assert.throws(() => readExpect(text((e) => (steps(e)[1].makes = "feature-1")), "f"), /recipe\[1\]\.makes feature-1 is made by an earlier step too/);
  assert.throws(() => readExpect(text((e) => (steps(e)[0].makes = "feature-7")), "f"), /bodies\[0\]\.item feature-1 is made by no step of the recipe/);
  assert.throws(() => readExpect(text((e) => (steps(e)[1].makes = "sketch-9")), "f"), /sketches\[0\]\.sketch sketch-2 is made by no step/);
  assert.throws(() => readExpect(text((e) => ((e.sketches = []), (steps(e)[1].makes = "sketch-9"))), "f"), /pins\[0\]\.sketch sketch-2 is made by no step/);
  const body = (e: Record<string, unknown>) => (e.bodies as { topology: Record<string, unknown> }[])[0];
  assert.equal(readExpect(text((e) => (body(e).topology.shells = 2)), "f").bodies[0].topology.shells, 2);
  assert.throws(() => readExpect(text((e) => (body(e).topology.shells = 0)), "f"), /topology\.shells must be a count of at least 1/);
  const refused = (r: unknown) => text((e) => (e.refused = [r]));
  assert.equal(readExpect(refused({ item: "feature-1", says: ["1 µm"], why: "a sliver" }), "f").refused?.[0].says[0], "1 µm");
  assert.throws(() => readExpect(refused({ item: "feature-5", says: ["1 µm"], why: "a sliver" }), "f"), /refused\[0\]\.item feature-5 is made by no step/);
  assert.throws(() => readExpect(refused({ item: "feature-1", says: [], why: "a sliver" }), "f"), /refused\[0\]\.says must list the words/);
  assert.throws(() => readExpect(refused({ item: "feature-1", says: [""], why: "a sliver" }), "f"), /refused\[0\]\.says\[0\] must be a name/);
  assert.throws(() => readExpect(refused({ item: "feature-1", says: ["1 µm"] }), "f"), /refused\[0\] needs its working in why/);
});

test("which models run: one waiting for a step that hasn't landed has no file; once it lands it needs one; every file has an expectation", () => {
  const e = (model: string, from?: string): GoldenExpect => ({ ...expectation(), model, ...(from ? { from } : {}) });
  assert.deepEqual(plan([e("box"), e("cut", "35")], ["box"], new Set()), [{ model: "box", run: "build" }, { model: "cut", run: "waits", from: "35" }]);
  assert.deepEqual(plan([e("box"), e("cut", "35")], ["box", "cut"], new Set(["35"])), [{ model: "box", run: "build" }, { model: "cut", run: "build" }]);
  assert.throws(() => plan([e("box"), e("cut", "35")], ["box"], new Set(["35"])), /step 35 has landed: make cut\.panosolid\.json with it/);
  assert.throws(() => plan([e("cut", "35")], ["cut"], new Set()), /cut waits for step 35, which hasn't landed, yet has a project file/);
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

test("the elliptic integrals: hand-worked values, the limits refused, and seeded moduli against quadrature and Legendre's relation", () => {
  // k = 0: the integrands are 1, so K = E = π/2. k = 1: E = ∫ cos θ dθ = 1, and K = ∫ sec θ dθ diverges.
  assert.equal(elliptic(0).K, Math.PI / 2);
  assert.equal(elliptic(0).E, Math.PI / 2);
  assert.equal(elliptic(1).E, 1);
  assert.equal(elliptic(1).K, Infinity);
  // The lemniscate case k = 1/√2 (Whittaker and Watson 22.8): K = Γ(1/4)²/(4√π), E = Γ(1/4)²/(8√π) + π^(3/2)/Γ(1/4)², with
  // Γ(1/4) = 3.6256099082219083119 from the tables: K = 1.8540746773013719, E = 1.3506438810476755.
  const g = 3.6256099082219083119;
  const lemniscate = elliptic(Math.SQRT1_2);
  assert.ok(Math.abs(lemniscate.K - (g * g) / (4 * Math.sqrt(Math.PI))) < 1e-15, String(lemniscate.K));
  assert.ok(Math.abs(lemniscate.E - ((g * g) / (8 * Math.sqrt(Math.PI)) + Math.PI ** 1.5 / (g * g))) < 1e-15, String(lemniscate.E));
  // Through the arithmetic: K(1) is infinite and out of range is NaN, so neither reads as a number.
  assert.ok(Math.abs(evaluate("ellipk(0.5) + ellipe(0)") - (elliptic(0.5).K + Math.PI / 2)) === 0);
  assert.throws(() => evaluate("ellipk(1)"), /Infinity, not a finite number/);
  assert.throws(() => evaluate("ellipe(1.5)"), /NaN/);
  assert.throws(() => evaluate("ellipk(-0.1)"), /NaN/);
  // Seeded moduli: Simpson's rule on each definition (2000 panels; the integrands are smooth and periodic, so it is far past 1e-12),
  // and Legendre's relation E·K' + E'·K − K·K' = π/2, with K' and E' of the complementary modulus √(1 − k²).
  const simpson = (f: (t: number) => number, n = 2000) => {
    const h = Math.PI / 2 / n;
    let sum = f(0) + f(Math.PI / 2);
    for (let i = 1; i < n; i++) sum += f(i * h) * (i % 2 ? 4 : 2);
    return (sum * h) / 3;
  };
  for (const seed of [21, 22, 23]) {
    const r = seeded(BigInt(seed));
    for (let i = 0; i < 20; i++) {
      const k = r.next() * 0.95;
      const { K, E } = elliptic(k);
      const K0 = simpson((t) => 1 / Math.sqrt(1 - (k * Math.sin(t)) ** 2));
      const E0 = simpson((t) => Math.sqrt(1 - (k * Math.sin(t)) ** 2));
      assert.ok(Math.abs(K - K0) < 1e-12 && Math.abs(E - E0) < 1e-12, `seed ${seed}, k ${k}: ${K} vs ${K0}, ${E} vs ${E0}`);
      const c = elliptic(Math.sqrt(1 - k * k));
      assert.ok(Math.abs(E * c.K + c.E * K - K * c.K - Math.PI / 2) < 1e-13, `seed ${seed}, k ${k}: Legendre`);
    }
  }
});

test("the pipe tee's hand-worked answers equal its volumes and areas integrated numerically from their definitions, and the Steinmetz limit", () => {
  const tee = allExpects().find((e) => e.model === "pipe-tee")!;
  // Simpson over t in −π/2..π/2 with y = a sin t, which takes the square roots' ends away.
  const simpson = (f: (t: number) => number, lo: number, hi: number, n = 4000) => {
    const h = (hi - lo) / n;
    let sum = f(lo) + f(hi);
    for (let i = 1; i < n; i++) sum += f(lo + i * h) * (i % 2 ? 4 : 2);
    return (sum * h) / 3;
  };
  const half = Math.PI / 2;
  // A branch r a standing on the axis of a main pipe r R. Overlap: the main's height above its axis, √(R² − y²), over the branch's disc.
  const overlap = (R: number, a: number) => simpson((t) => 2 * a * Math.cos(t) * Math.sqrt(R * R - (a * Math.sin(t)) ** 2) * a * Math.cos(t), -half, half);
  // The patch the branch takes out of the main: R dφ dx over the main's surface, y = R sin φ, so dφ = dy / √(R² − y²), x across the disc.
  const patch = (R: number, a: number) => simpson((t) => ((2 * R * a * Math.cos(t)) / Math.sqrt(R * R - (a * Math.sin(t)) ** 2)) * a * Math.cos(t), -half, half);
  // The branch's side inside the main: a dψ round it, up to the main's surface √(R² − a² sin²ψ).
  const inside = (R: number, a: number) => 4 * simpson((s) => a * Math.sqrt(R * R - (a * Math.sin(s)) ** 2), 0, half);
  const volume = Math.PI * 100 * 60 + Math.PI * 36 * 25 - overlap(10, 6) - (Math.PI * 64 * 60 + Math.PI * 16 * 25 - overlap(8, 4));
  const area =
    2 * Math.PI * 10 * 60 - patch(10, 6) + 2 * Math.PI * 6 * 25 - inside(10, 6) + 2 * Math.PI * 8 * 60 - patch(8, 4) + 2 * Math.PI * 4 * 25 - inside(8, 4) + 2 * Math.PI * (100 - 64) + Math.PI * (36 - 16);
  const near = (got: number, want: number) => Math.abs(got - want) <= 1e-12 * want;
  assert.ok(near(evaluate(tee.bodies[0].volume.is), volume), `${evaluate(tee.bodies[0].volume.is)} vs ${volume}`);
  assert.ok(near(evaluate(tee.bodies[0].area.is), area), `${evaluate(tee.bodies[0].area.is)} vs ${area}`);
  // As a → R the overlap's closed form (4R/3)[(R² + a²)E − (R² − a²)K] goes to 8R³/3, half the Steinmetz solid 16R³/3 (the test plan's
  // hand-worked case), the patch 4R²[E − (1 − k²)K] and the side inside 4aR·E both to 4R² (its surface, 16R², from four such halves).
  const R = 10;
  const a = R * (1 - 1e-12);
  const { K, E } = elliptic(a / R);
  assert.ok(Math.abs(((4 * R) / 3) * ((R * R + a * a) * E - (R * R - a * a) * K) - (8 * R ** 3) / 3) < 1e-6);
  assert.ok(Math.abs(4 * R * R * (E - (1 - (a / R) ** 2) * K) - 4 * R * R) < 1e-6);
  assert.ok(Math.abs(4 * a * R * E - 4 * R * R) < 1e-6);
});

test("shells: faces joined by edges, one cube is one, two are two, a void is one more; seeded boxes against their count", () => {
  assert.equal(shellCount({ faces: 6, edge_faces: cube().edge_faces }), 1);
  // Two cubes in one view (the hollow box's outside and void): the second's faces 6..11, its edges joining only those.
  const two = { faces: 12, edge_faces: [...cube().edge_faces, ...cube().edge_faces.map(([a, b]) => [a + 6, b + 6] as [number, number])] };
  assert.equal(shellCount(two), 2);
  // An edge not used once each way joins nothing (a body that failed validation): with every edge null, the cube's six faces are six.
  assert.equal(shellCount({ faces: 6, edge_faces: cube().edge_faces.map(() => null) }), 6);
  // With only the top's four edges left, the top and the four sides are one group and the bottom another: 2.
  const top = cube().edge_faces.map((pair) => (pair.includes(1) ? pair : null));
  assert.equal(shellCount({ faces: 6, edge_faces: top }), 2);
  // Seeded: n boxes with their faces numbered in a shuffled order and their edges listed shuffled are n shells.
  for (const seed of [31, 32, 33]) {
    const r = seeded(BigInt(seed));
    for (let i = 0; i < 30; i++) {
      const n = 1 + Math.floor(r.next() * 5);
      const order = Array.from({ length: 6 * n }, (_, f) => f);
      for (let j = order.length - 1; j > 0; j--) {
        const k = Math.floor(r.next() * (j + 1));
        [order[j], order[k]] = [order[k], order[j]];
      }
      const edges = Array.from({ length: n }, (_, b) => cube().edge_faces.map(([x, y]) => [order[6 * b + x], order[6 * b + y]] as [number, number])).flat();
      for (let j = edges.length - 1; j > 0; j--) {
        const k = Math.floor(r.next() * (j + 1));
        [edges[j], edges[k]] = [edges[k], edges[j]];
      }
      assert.equal(shellCount({ faces: 6 * n, edge_faces: edges }), n, `seed ${seed}, ${n} boxes`);
    }
  }
});

test("every expectation is one some solid could have: inside its box, and no more volume than its area allows", () => {
  const all = allExpects();
  assert.ok(all.length >= 17, "the six models today's app builds and 28a2's eleven");
  for (const e of all)
    for (const b of e.bodies) {
      const at = `${e.model} ${b.body}`;
      const [lo, hi] = [b.box.is[0].map(evaluate), b.box.is[1].map(evaluate)];
      const [V, A] = [evaluate(b.volume.is), evaluate(b.area.is)];
      const size = [0, 1, 2].map((k) => hi[k] - lo[k]);
      assert.ok(size.every((d) => d > 0), `${at}: its box is empty`);
      // Inside its box: V ≤ the box's volume; and the isoperimetric inequality, A³ ≥ 36πV², the sphere's equality.
      assert.ok(V > 0 && V <= size[0] * size[1] * size[2] * (1 + 1e-12), `${at}: volume ${V} doesn't fit its box`);
      assert.ok(A ** 3 >= 36 * Math.PI * V * V, `${at}: area ${A} is too small for volume ${V}`);
    }
});
