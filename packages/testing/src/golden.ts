// Golden models (step 28a): project files as the app saves them
// (`tests/golden/<name>.panosolid.json`) and their answers worked out by
// hand (`<name>.expect.json`), rebuilt through Design's own rebuild on the
// real kernel by `journeys/golden.journey.ts`. This file is the part that
// needs neither: the expectation format and its reader, the arithmetic the
// hand-worked numbers are written in, the gap measured on a body's view,
// which models wait for a later step, and the comparer.
//
// An expectation holds, for each body Design shows: its volume, area,
// face, edge and vertex counts, box and the largest tolerance any of its
// vertices and edges may carry; for each sketch on a face, the face's name
// and plane; for each pinned point, its pin and where it lands. Every
// number is written as arithmetic ("5 * (60*40 - 2*pi*6^2)") with the
// working beside it (`why`), so a reader can check it without running
// anything.
//
// A model that needs a later step (`from`) is written before that step
// exists (28a2), so it also carries its `recipe`: the steps a user takes,
// in words and numbers, each naming the timeline item it makes, so the
// step's thread makes exactly that project file. A body may have voids
// (`shells`), and an item may be expected to fail with words (`refused`),
// as the boolean rules in docs/progress/booleans.md say.

import { LANDED } from "./landed.ts";
import type { BodyView } from "@fission/core";

/** A number worked out by hand: arithmetic (`evaluate`) or a plain number, and the working. */
export interface Worked {
  is: string | number;
  why: string;
}

export type Expr = string | number;
type Triple = [Expr, Expr, Expr];
export type Vec3 = [number, number, number];

export interface BodyExpect {
  /** The browser's row, "Body 1", and the timeline item that builds it. */
  body: string;
  item: string;
  volume: Worked;
  area: Worked;
  /** `shells`: the outer shell and one per void (B0 decision 3); left out, 1. */
  topology: { faces: number; edges: number; vertices: number; shells?: number; why: string };
  /** The smallest axis-aligned box round the body, [low, high] corners. */
  box: { is: [Triple, Triple]; why: string };
  /** The largest tolerance any vertex or edge of the body may carry (LINEAR, 1e-5 mm, for every model we make ourselves). */
  tolerance: Worked;
}

/** A sketch on a face: the face's name as Design gives it (the sketch item's plane) and the face's plane, by its outward normal and a point on it. */
export interface SketchExpect {
  sketch: string;
  face: string;
  plane: { normal: Triple; point: Triple; why: string };
}

/** A sketch point pinned to an edge (26f, 27c): the pin as Design writes it, and where the point lands in the world. */
export interface PinExpect {
  sketch: string;
  point: string;
  kind: string;
  name: string;
  /** The feature whose body the edge is on, when not the sketch's own face's. */
  feature?: string;
  at: { is: Triple; why: string };
}

/** One step of a recipe: what the user does, in words and numbers, and the timeline item it makes, by the id Design gives it. */
export interface RecipeStep {
  do: string;
  makes?: string;
}

/** A timeline item that must fail, and words its message must hold (each, ignoring case), with the reason it must. */
export interface RefusedExpect {
  item: string;
  says: string[];
  why: string;
}

export interface GoldenExpect {
  model: string;
  what: string;
  /** The step this model needs, when it is later than today's (it runs from the day that step lands, `LANDED`). */
  from?: string;
  /**
   * How a user makes the model, for a model written before its step
   * exists (required with `from`). Item ids follow Design's one counter
   * (each sketch, sketch point, line, circle and feature takes the next
   * number; a deleted item's number isn't reused), and every item an
   * expectation names is made by some step.
   */
  recipe?: RecipeStep[];
  bodies: BodyExpect[];
  sketches: SketchExpect[];
  pins: PinExpect[];
  /** Items that must fail with words, as a cut leaving a face thinner than 1 µm must; every other item builds cleanly. */
  refused?: RefusedExpect[];
}

/**
 * The steps after 27 that have landed, so their models run (landed.ts, the
 * one list the session bots' waiting moves read too). A step's thread adds
 * its number there the day it lands, and must then add the project file of
 * every model waiting for it (`plan` fails until it does).
 */
export { LANDED };

/**
 * Exact answers agree to a billionth of their size (the kernel's volumes
 * and areas are exact up to rounding: journeys/old-files.journey.ts).
 */
export const REL = 1e-9;
/**
 * A box corner or a point is within a nanometre (LINEAR / 10) of where it
 * was worked out to be. Rounding is far below that even at the kernel's
 * 100 km limit (a double there resolves 15 nm per unit in the last place,
 * 1.5e-8 mm), so a nanometre off is already wrong geometry, not rounding,
 * while LINEAR itself would let a creeping corner pass.
 */
export const POINT_ABS = 1e-6;
/** A unit normal's components agree to the kernel's angular tolerance (ANGULAR, 1e-9 rad). */
export const NORMAL_ABS = 1e-9;
/** The kernel's linear tolerance (kernel/src/tolerance.rs LINEAR): the default every vertex and edge carries until an intersection grows its own (step 31a gave each one a field; growth starts at 32a). */
export const LINEAR = 1e-5;

/**
 * The complete elliptic integrals of the first and second kind,
 * K(k) = ∫₀^{π/2} dθ / √(1 − k² sin²θ) and E(k) = ∫₀^{π/2} √(1 − k² sin²θ) dθ,
 * of the modulus k (not the parameter m = k²), by the arithmetic-geometric
 * mean: a₀ = 1, b₀ = √(1 − k²), c₀ = k; aₙ₊₁ = (aₙ + bₙ)/2, bₙ₊₁ = √(aₙbₙ),
 * cₙ₊₁ = (aₙ − bₙ)/2; then K = π / (2a∞) and E = K (1 − Σ 2ⁿ⁻¹ cₙ²)
 * (Abramowitz and Stegun 17.6). The mean converges quadratically, so 32
 * rounds is far past the last digit (six reach it for k = 0.99). A pipe
 * tee's crossing (two cylinders of radii a < R at right angles) has its
 * volumes and areas in these, with k = a / R. Outside 0 ≤ k ≤ 1 both are
 * NaN, and K(1) is infinite, so `evaluate` refuses them.
 */
export function elliptic(k: number): { K: number; E: number } {
  if (!(k >= 0 && k <= 1)) return { K: NaN, E: NaN };
  if (k === 1) return { K: Infinity, E: 1 };
  let [a, b, c] = [1, Math.sqrt(1 - k * k), k];
  let weight = 0.5;
  let sum = weight * c * c;
  for (let n = 0; n < 32; n++) {
    [a, b, c] = [(a + b) / 2, Math.sqrt(a * b), (a - b) / 2];
    weight *= 2;
    sum += weight * c * c;
  }
  const K = Math.PI / (2 * a);
  return { K, E: K * (1 - sum) };
}

const FUNCTIONS: Record<string, (x: number) => number> = {
  sqrt: Math.sqrt,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  atan: Math.atan,
  ellipk: (k) => elliptic(k).K,
  ellipe: (k) => elliptic(k).E,
};

/**
 * The value of hand-worked arithmetic: numbers (1e-5 too), + − * /, ^
 * (right to left, binding tighter than a leading minus: -2^2 is −4), pi,
 * sqrt, sin, cos, tan, atan, ellipk and ellipe (`elliptic`) of a bracketed
 * argument, brackets. Anything
 * else throws, naming where it stopped; so does a result that isn't a
 * finite number. A plain number is itself.
 */
export function evaluate(e: Expr): number {
  if (typeof e === "number") {
    if (!Number.isFinite(e)) throw new Error(`${e} is not a finite number`);
    return e;
  }
  if (typeof e !== "string") throw new Error(`${JSON.stringify(e)} is neither a number nor arithmetic`);
  let at = 0;
  const space = () => {
    while (at < e.length && e[at] === " ") at++;
  };
  const fail = (what: string): never => {
    throw new Error(`"${e}": ${what} at character ${at + 1}`);
  };
  const take = (c: string) => {
    space();
    if (e[at] === c) {
      at++;
      return true;
    }
    return false;
  };
  const atom = (): number => {
    space();
    if (take("(")) {
      const v = sum();
      if (!take(")")) fail("expected )");
      return v;
    }
    const num = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/.exec(e.slice(at));
    if (num) {
      at += num[0].length;
      return Number(num[0]);
    }
    const word = /^[a-z]+/.exec(e.slice(at));
    if (!word) return fail("expected a number, pi, a function or (");
    at += word[0].length;
    if (word[0] === "pi") return Math.PI;
    const f = FUNCTIONS[word[0]];
    if (!f) return fail(`unknown name ${word[0]}`);
    if (!take("(")) fail(`expected ( after ${word[0]}`);
    const v = sum();
    if (!take(")")) fail("expected )");
    return f(v);
  };
  const power = (): number => {
    const base = atom();
    return take("^") ? base ** unary() : base;
  };
  const unary = (): number => (take("-") ? -unary() : power());
  const product = (): number => {
    let v = unary();
    for (;;) {
      if (take("*")) v *= unary();
      else if (take("/")) v /= unary();
      else return v;
    }
  };
  const sum = (): number => {
    let v = product();
    for (;;) {
      if (take("+")) v += product();
      else if (take("-")) v -= product();
      else return v;
    }
  };
  const v = sum();
  space();
  if (at !== e.length) fail("unexpected text");
  if (!Number.isFinite(v)) throw new Error(`"${e}" is ${v}, not a finite number`);
  return v;
}

const triple = (t: Triple): Vec3 => [evaluate(t[0]), evaluate(t[1]), evaluate(t[2])];

/**
 * Reads an expect.json's text: refused (thrown, naming where) unless every
 * field is there, every `why` says something, and every number evaluates;
 * a model with `from` needs its recipe, and every item it names (a body's,
 * a sketch's, a pin's sketch, a refused item) must be one a step makes.
 */
export function readExpect(text: string, file: string): GoldenExpect {
  const data = JSON.parse(text) as GoldenExpect;
  const bad = (where: string, what: string): never => {
    throw new Error(`${file}: ${where} ${what}`);
  };
  const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
  const why = (x: unknown, where: string) => {
    if (!isObject(x) || typeof x.why !== "string" || x.why.trim().length < 3) bad(where, "needs its working in why");
  };
  const num = (x: unknown, where: string) => {
    why(x, where);
    try {
      evaluate((x as Worked).is);
    } catch (e) {
      bad(where, (e as Error).message);
    }
  };
  const three = (x: unknown, where: string) => {
    if (!Array.isArray(x) || x.length !== 3) bad(where, "must be three numbers");
    for (const [k, c] of (x as unknown[]).entries())
      try {
        evaluate(c as Expr);
      } catch (e) {
        bad(`${where}[${k}]`, (e as Error).message);
      }
  };
  const word = (x: unknown, where: string) => {
    if (typeof x !== "string" || x === "") bad(where, "must be a name");
  };
  if (!isObject(data)) bad("the file", "must be an object");
  word(data.model, "model");
  word(data.what, "what");
  if (data.from !== undefined) word(data.from, "from");
  for (const key of ["bodies", "sketches", "pins"] as const) if (!Array.isArray(data[key])) bad(key, "must be a list");
  if (data.from !== undefined && data.recipe === undefined) bad("recipe", `must say how a user makes the model, which waits for step ${data.from}`);
  const made = new Set<string>();
  if (data.recipe !== undefined) {
    if (!Array.isArray(data.recipe) || data.recipe.length === 0) bad("recipe", "must list its steps");
    data.recipe.forEach((r, i) => {
      if (!isObject(r) || typeof r.do !== "string" || r.do.trim().length < 3) bad(`recipe[${i}]`, "must say what the user does in do");
      if (r.makes === undefined) return;
      word(r.makes, `recipe[${i}].makes`);
      if (made.has(r.makes)) bad(`recipe[${i}].makes`, `${r.makes} is made by an earlier step too`);
      made.add(r.makes);
    });
  }
  // With a recipe, every item named is one its steps make.
  const madeBy = (id: string, where: string) => {
    if (data.recipe !== undefined && !made.has(id)) bad(where, `${id} is made by no step of the recipe`);
  };
  if (data.bodies.length === 0 && data.from === undefined) bad("bodies", "must list at least one body");
  data.bodies.forEach((b, i) => {
    const at = `bodies[${i}]`;
    if (!isObject(b)) bad(at, "must be an object");
    word(b.body, `${at}.body`);
    word(b.item, `${at}.item`);
    num(b.volume, `${at}.volume`);
    num(b.area, `${at}.area`);
    num(b.tolerance, `${at}.tolerance`);
    why(b.topology, `${at}.topology`);
    for (const k of ["faces", "edges", "vertices"] as const) if (!Number.isInteger(b.topology[k]) || b.topology[k] < 0) bad(`${at}.topology.${k}`, "must be a count");
    if (b.topology.shells !== undefined && (!Number.isInteger(b.topology.shells) || b.topology.shells < 1)) bad(`${at}.topology.shells`, "must be a count of at least 1");
    madeBy(b.item, `${at}.item`);
    why(b.box, `${at}.box`);
    if (!Array.isArray(b.box.is) || b.box.is.length !== 2) bad(`${at}.box`, "must be two corners");
    three(b.box.is[0], `${at}.box.is[0]`);
    three(b.box.is[1], `${at}.box.is[1]`);
  });
  data.sketches.forEach((s, i) => {
    const at = `sketches[${i}]`;
    word(s.sketch, `${at}.sketch`);
    word(s.face, `${at}.face`);
    madeBy(s.sketch, `${at}.sketch`);
    why(s.plane, `${at}.plane`);
    three(s.plane.normal, `${at}.plane.normal`);
    three(s.plane.point, `${at}.plane.point`);
  });
  data.pins.forEach((p, i) => {
    const at = `pins[${i}]`;
    for (const k of ["sketch", "point", "kind", "name"] as const) word(p[k], `${at}.${k}`);
    if (p.feature !== undefined) word(p.feature, `${at}.feature`);
    madeBy(p.sketch, `${at}.sketch`);
    why(p.at, `${at}.at`);
    three(p.at.is, `${at}.at.is`);
  });
  if (data.refused !== undefined) {
    if (!Array.isArray(data.refused)) bad("refused", "must be a list");
    data.refused.forEach((r, i) => {
      const at = `refused[${i}]`;
      if (!isObject(r)) bad(at, "must be an object");
      word(r.item, `${at}.item`);
      madeBy(r.item, `${at}.item`);
      if (!Array.isArray(r.says) || r.says.length === 0) bad(`${at}.says`, "must list the words its message holds");
      r.says.forEach((w, j) => word(w, `${at}.says[${j}]`));
      why(r, at);
    });
  }
  return data;
}

/** What one model does today: rebuilt and checked, or waiting for its step (no project file yet). */
export type Plan = { model: string; run: "build" } | { model: string; run: "waits"; from: string };

/**
 * Which models run, from the expectations and the project files there: a
 * model whose step hasn't landed waits and must have no file yet (none
 * could be saved by today's app); every other model needs its file; a file
 * with no expectation is refused. Throws naming each problem.
 */
export function plan(expects: readonly GoldenExpect[], files: readonly string[], landed: ReadonlySet<string> = LANDED): Plan[] {
  const problems: string[] = [];
  const names = new Set(expects.map((e) => e.model));
  if (names.size !== expects.length) problems.push("two expectations name the same model");
  for (const f of files) if (!names.has(f)) problems.push(`${f}.panosolid.json has no ${f}.expect.json`);
  const out: Plan[] = expects.map((e) => {
    const waits = e.from !== undefined && !landed.has(e.from);
    if (waits && files.includes(e.model)) problems.push(`${e.model} waits for step ${e.from}, which hasn't landed, yet has a project file`);
    if (!waits && !files.includes(e.model)) problems.push(e.from === undefined ? `${e.model} has no project file` : `step ${e.from} has landed: make ${e.model}.panosolid.json with it`);
    return waits ? { model: e.model, run: "waits", from: e.from! } : { model: e.model, run: "build" };
  });
  if (problems.length > 0) throw new Error(problems.join("; "));
  return out;
}

const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const minus = (a: readonly number[], b: readonly number[]): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

/**
 * The largest distance of any vertex, or any edge's middle, from the plane
 * of a flat face it bounds (the plane through the face's centroid along
 * its normal): how far the body's corners have crept off its faces, which
 * no volume shows. Curved faces aren't measured here (the view doesn't
 * carry their surfaces); validation holds each edge to its own tolerance.
 */
export function planeGap(view: Pick<BodyView, "face_normals" | "face_centroids" | "edge_faces" | "edge_vertices" | "edge_middles" | "vertex_points">): number {
  let gap = 0;
  view.edge_faces.forEach((pair, e) => {
    for (const f of pair ?? []) {
      // A curved face has no normal: null, or left out as the kernel's WASM build hands an empty option over.
      const n = view.face_normals[f];
      if (n === null || n === undefined) continue;
      const c = view.face_centroids[f];
      for (const p of [view.vertex_points[view.edge_vertices[e][0]], view.vertex_points[view.edge_vertices[e][1]], view.edge_middles[e]]) gap = Math.max(gap, Math.abs(dot(n, minus(p, c))));
    }
  });
  return gap;
}

/**
 * How many shells the body has: its faces fall into groups joined by the
 * edges between them (each edge joins the two faces it bounds), and each
 * group is one closed shell, the outer one or a void (B0 decision 3). An
 * edge not used once each way (null, only in a body that failed
 * validation) joins nothing.
 */
export function shellCount(view: Pick<BodyView, "faces" | "edge_faces">): number {
  const up = Array.from({ length: view.faces }, (_, f) => f);
  const root = (f: number): number => {
    while (up[f] !== f) f = up[f] = up[up[f]];
    return f;
  };
  let shells = view.faces;
  for (const pair of view.edge_faces) {
    if (!pair) continue;
    const [a, b] = [root(pair[0]), root(pair[1])];
    if (a !== b) {
      up[a] = b;
      shells--;
    }
  }
  return shells;
}

/**
 * The largest tolerance the body's vertices and edges carry, as the
 * kernel's view says (`tolerance`, step 31a; kernel/CLAUDE.md, B0 decision
 * 5): validation holds each vertex and edge to its own. A body that failed
 * validation carries none it can be held to. `journeys/golden.journey.ts`
 * fails when the view gains a tolerance field this doesn't read.
 */
export function bodyTolerance(view: Pick<BodyView, "errors" | "tolerance">): number {
  return view.errors.length === 0 ? view.tolerance : Infinity;
}

export interface MeasuredBody {
  body: string;
  item: string;
  volume: number;
  area: number;
  faces: number;
  edges: number;
  vertices: number;
  shells: number;
  box: [Vec3, Vec3];
  tolerance: number;
  gap: number;
  errors: string[];
}

export interface MeasuredSketch {
  sketch: string;
  face: string;
  /** How many shown faces carry that name: 1 found, 0 gone, more shared. */
  found: number;
  /** The named face's outward normal and centroid, when found. */
  normal: Vec3 | null;
  centroid: Vec3 | null;
  /** Where the rebuild placed the sketch: its outward normal (the frame's normal times its side) and origin. */
  placed: { normal: Vec3; origin: Vec3 } | null;
}

export interface MeasuredPin {
  sketch: string;
  point: string;
  kind: string;
  name: string;
  feature?: string;
  /** Where the point is after the rebuild, in the world; null when the rebuild didn't find its edge. */
  at: Vec3 | null;
}

export interface Measured {
  bodies: MeasuredBody[];
  sketches: MeasuredSketch[];
  pins: MeasuredPin[];
  /** Every item that built but not cleanly: off, or built with a warning (a golden model has none). */
  trouble: string[];
  /** Every item that failed, with its message. */
  failed: { item: string; message: string }[];
}

// Relative to the answer's own size, however small: a 1 µm cube's volume is 1e-9 mm³ (28a2 found the old floor of 1 let it be 2e-9).
const near = (got: number, want: number, rel = REL) => Math.abs(got - want) <= rel * Math.abs(want);
const within = (got: readonly number[], want: readonly number[], abs: number) => got.every((g, k) => Math.abs(g - want[k]) <= abs);
const show = (v: readonly number[]) => `(${v.join(", ")})`;

/** Every way a rebuild differs from the hand-worked answers, in words; empty when it matches. */
export function compare(want: GoldenExpect, got: Measured): string[] {
  const out: string[] = [...got.trouble];
  for (const f of got.failed) {
    const w = want.refused?.find((r) => r.item === f.item);
    if (!w) out.push(`${f.item} failed: ${f.message}`);
    else {
      const missing = w.says.filter((word) => !f.message.toLowerCase().includes(word.toLowerCase()));
      if (missing.length > 0) out.push(`${f.item} failed, but its message "${f.message}" doesn't say ${missing.map((m) => `"${m}"`).join(", ")}`);
    }
  }
  for (const w of want.refused ?? []) if (!got.failed.some((f) => f.item === w.item)) out.push(`${w.item} built, but must be refused: ${w.why}`);
  const key = (b: { body: string; item: string }) => `${b.body} (${b.item})`;
  if (JSON.stringify(got.bodies.map(key)) !== JSON.stringify(want.bodies.map(key))) out.push(`bodies ${got.bodies.map(key).join(", ") || "none"}, not ${want.bodies.map(key).join(", ") || "none"}`);
  for (const w of want.bodies) {
    const g = got.bodies.find((b) => key(b) === key(w));
    if (!g) continue;
    const at = key(w);
    const volume = evaluate(w.volume.is);
    const area = evaluate(w.area.is);
    const tolerance = evaluate(w.tolerance.is);
    if (g.errors.length > 0) out.push(`${at}: fails validation: ${g.errors.join("; ")}`);
    if (!near(g.volume, volume)) out.push(`${at}: volume ${g.volume}, not ${volume} (${w.volume.is})`);
    if (!near(g.area, area)) out.push(`${at}: area ${g.area}, not ${area} (${w.area.is})`);
    const counts = [g.faces, g.edges, g.vertices];
    const wanted = [w.topology.faces, w.topology.edges, w.topology.vertices];
    if (counts.some((c, k) => c !== wanted[k])) out.push(`${at}: faces, edges, vertices ${counts.join(", ")}, not ${wanted.join(", ")}`);
    const shells = w.topology.shells ?? 1;
    if (g.shells !== shells) out.push(`${at}: ${g.shells} shells, not ${shells}`);
    const box = [triple(w.box.is[0]), triple(w.box.is[1])];
    if (!within(g.box[0], box[0], POINT_ABS) || !within(g.box[1], box[1], POINT_ABS)) out.push(`${at}: box ${show(g.box[0])} to ${show(g.box[1])}, not ${show(box[0])} to ${show(box[1])}`);
    if (g.tolerance > tolerance) out.push(`${at}: carries a tolerance of ${g.tolerance} mm, more than the ${tolerance} it may`);
    if (g.gap > tolerance) out.push(`${at}: a corner or edge lies ${g.gap} mm off a flat face it bounds, more than the ${tolerance} it may`);
  }
  const sketchIds = (l: readonly { sketch: string }[]) => l.map((s) => s.sketch).sort();
  if (JSON.stringify(sketchIds(got.sketches)) !== JSON.stringify(sketchIds(want.sketches))) out.push(`sketches on faces ${sketchIds(got.sketches).join(", ") || "none"}, not ${sketchIds(want.sketches).join(", ") || "none"}`);
  for (const w of want.sketches) {
    const g = got.sketches.find((s) => s.sketch === w.sketch);
    if (!g) continue;
    const normal = triple(w.plane.normal);
    const point = triple(w.plane.point);
    if (g.face !== w.face) out.push(`${w.sketch}: on the face named ${g.face}, not ${w.face}`);
    else if (g.found !== 1) out.push(`${w.sketch}: ${g.found === 0 ? "no face" : `${g.found} faces`} named ${w.face}`);
    else {
      if (!within(g.normal!, normal, NORMAL_ABS)) out.push(`${w.sketch}: ${w.face} faces ${show(g.normal!)}, not ${show(normal)}`);
      const off = Math.abs(dot(normal, minus(g.centroid!, point)));
      if (off > POINT_ABS) out.push(`${w.sketch}: ${w.face} lies ${off} mm off its plane`);
    }
    if (g.placed === null) out.push(`${w.sketch}: not placed by the rebuild`);
    else {
      if (!within(g.placed.normal, normal, NORMAL_ABS)) out.push(`${w.sketch}: placed facing ${show(g.placed.normal)}, not ${show(normal)}`);
      const off = Math.abs(dot(normal, minus(g.placed.origin, point)));
      if (off > POINT_ABS) out.push(`${w.sketch}: placed ${off} mm off its face's plane`);
    }
  }
  const pinKey = (p: { sketch: string; point: string }) => `${p.sketch}/${p.point}`;
  if (JSON.stringify(got.pins.map(pinKey).sort()) !== JSON.stringify(want.pins.map(pinKey).sort())) out.push(`pinned points ${got.pins.map(pinKey).sort().join(", ") || "none"}, not ${want.pins.map(pinKey).sort().join(", ") || "none"}`);
  for (const w of want.pins) {
    const g = got.pins.find((p) => pinKey(p) === pinKey(w));
    if (!g) continue;
    const at = pinKey(w);
    if (g.kind !== w.kind || g.name !== w.name || g.feature !== w.feature) out.push(`${at}: pinned to ${g.kind} ${g.name}${g.feature ? ` of ${g.feature}` : ""}, not ${w.kind} ${w.name}${w.feature ? ` of ${w.feature}` : ""}`);
    const where = triple(w.at.is);
    if (g.at === null) out.push(`${at}: its edge wasn't found`);
    else if (!within(g.at, where, POINT_ABS)) out.push(`${at}: at ${show(g.at)}, not ${show(where)}`);
  }
  return out;
}
