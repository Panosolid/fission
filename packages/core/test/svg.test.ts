import { test } from "node:test";
import assert from "node:assert/strict";
import { outlineToSvg, svgNumber } from "../src/model/svg.ts";
import type { Loop, Outline } from "../src/kernel/kernel-types.ts";

const path = (corners: number[], bulges: number[] = []): Loop => ({ path: { corners, bulges } });
const circle = (cx: number, cy: number, radius: number): Loop => ({ circle: { center: [cx, cy], radius } });
const attr = (svg: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(svg)?.[1];

test("hand-worked: a 60 × 40 rectangle", () => {
  // Corners (0,0) (60,0) (60,40) (0,40); y flipped gives (0,0) (60,−40)
  // (0,−40) after the start, and the last straight piece back to the start is
  // the Z. The box is x 0..60, y 0..40, so the viewBox starts at
  // (min x, −max y) = (0, −40) and is 60 × 40, the same as width and height in mm.
  const svg = outlineToSvg({ outer: path([0, 0, 60, 0, 60, 40, 0, 40]), holes: [] });
  assert.equal(
    svg.text,
    '<svg xmlns="http://www.w3.org/2000/svg" width="60mm" height="40mm" viewBox="0 -40 60 40">\n' +
      '<path d="M0 0L60 0L60 -40L0 -40Z" fill="none" fill-rule="evenodd" stroke="#000" stroke-width="1" vector-effect="non-scaling-stroke"/>\n' +
      "</svg>\n",
  );
  assert.equal(svg.width, 60);
  assert.equal(svg.height, 40);
});

test("hand-worked: the slot, straight sides and half-circle ends", () => {
  // Design's slot at 60 × 20: corners (10,0) (50,0) (50,20) (10,20), bulges
  // 0, 1, 0, 1. Bulge 1 is a half turn (4·atan 1 = π), radius
  // c(1 + 1)/(4·1) = 20·2/4 = 10, so each end is written as two quarter
  // turns. Sweep flag 0, since b > 0 is counter-clockwise in the model and,
  // with y flipped, that is SVG's negative-angle way. The right end goes from
  // (50,0) through (60,10) to (50,20): in SVG (50,0) → (60,−10) → (50,−20);
  // the left end from (10,20) through (0,10) to (10,0). The ends reach
  // x = 0 and x = 60, so the box is 0..60 × 0..20.
  const svg = outlineToSvg({ outer: path([10, 0, 50, 0, 50, 20, 10, 20], [0, 1, 0, 1]), holes: [] }, "Slot profile");
  assert.equal(attr(svg.text, "d"), "M10 0L50 0A10 10 0 0 0 60 -10A10 10 0 0 0 50 -20L10 -20A10 10 0 0 0 0 -10A10 10 0 0 0 10 0Z");
  assert.equal(attr(svg.text, "viewBox"), "0 -20 60 20");
  assert.equal(attr(svg.text, "width"), "60mm");
  assert.equal(attr(svg.text, "height"), "20mm");
  assert.match(svg.text, /<title>Slot profile<\/title>/);
});

test("hand-worked: a quarter-circle bulge widens the box past its corners", () => {
  // The kernel's own hand-worked arc (ops/profile.rs): chord (0,0) → (2,0),
  // bulge tan(π/8), a quarter turn counter-clockwise; r = 2/√2 = √2 ≈
  // 1.414214, centre (1, 1). It runs from 225° to 315° round the centre,
  // passing 270°, the point (1, 1 − √2) ≈ (1, −0.414214): the lowest point,
  // below both corners. The path is closed by (2,0) → (1,2) → (0,0).
  const svg = outlineToSvg({ outer: path([0, 0, 2, 0, 1, 2], [Math.tan(Math.PI / 8), 0, 0]), holes: [] });
  assert.equal(attr(svg.text, "d"), "M0 0A1.414214 1.414214 0 0 0 2 0L1 -2Z");
  // Box: x 0..2, y −0.414214..2 → viewBox (0, −2), 2 × 2.414214.
  assert.equal(attr(svg.text, "viewBox"), "0 -2 2 2.414214");
  // The same arc the other way round (bulge −tan(π/8)) bulges up to y = −1 + √2 ≈ 0.414214, inside the triangle's box: sweep flag 1.
  const mirrored = outlineToSvg({ outer: path([0, 0, 2, 0, 1, 2], [-Math.tan(Math.PI / 8), 0, 0]), holes: [] });
  assert.equal(attr(mirrored.text, "d"), "M0 0A1.414214 1.414214 0 0 1 2 0L1 -2Z");
  assert.equal(attr(mirrored.text, "viewBox"), "0 -2 2 2");
});

test("hand-worked: a three-quarter arc is written as three quarter turns", () => {
  // Bulge tan(3π/8) ≈ 2.414: the arc turns 4·3π/8 = 3π/2. On the chord
  // (0,0) → (2,0) of length 2 the radius is c/(2 sin(θ/2)) = 2/(2 sin 135°) =
  // √2 again, and the centre is now 1 to the right of the midpoint: (1, −1).
  // It runs counter-clockwise from 135° (the corner (0,0)) through 180°,
  // 270° and 360° to 45°, so the box gains x = 1 − √2, y = −1 − √2 and
  // x = 1 + √2: −0.414214..2.414214 × −2.414214..0 (plus the corner (1, 0.5)).
  // Split at every quarter turn from 135°: at 225°, (1 − 1, −1 − 1) = (0, −2),
  // and at 315°, (2, −2); in SVG (0, 2) and (2, 2).
  const svg = outlineToSvg({ outer: path([0, 0, 2, 0, 1, 0.5], [Math.tan((3 * Math.PI) / 8), 0, 0]), holes: [] });
  assert.equal(attr(svg.text, "d"), "M0 0A1.414214 1.414214 0 0 0 0 2A1.414214 1.414214 0 0 0 2 2A1.414214 1.414214 0 0 0 2 0L1 -0.5Z");
  assert.equal(attr(svg.text, "viewBox"), "-0.414214 -0.5 2.828427 2.914214");
});

test("hand-worked: the plate, a rectangle with two round holes in one path", () => {
  // Design's plate at 80 × 40: holes at (20,20) and (60,20), radius
  // 0.15 × 40 = 6. A circle is four quarter turns, counter-clockwise (sweep
  // 0) from its east point (cx + r, cy) through north, west and south. With
  // y flipped, (26,20) (20,26) (14,20) (20,14) are (26,−20) (20,−26)
  // (14,−20) (20,−14).
  const plate: Outline = { outer: path([0, 0, 80, 0, 80, 40, 0, 40]), holes: [circle(20, 20, 6), circle(60, 20, 6)] };
  const svg = outlineToSvg(plate);
  assert.equal(
    attr(svg.text, "d"),
    "M0 0L80 0L80 -40L0 -40Z" + "M26 -20A6 6 0 0 0 20 -26A6 6 0 0 0 14 -20A6 6 0 0 0 20 -14A6 6 0 0 0 26 -20Z" +
      "M66 -20A6 6 0 0 0 60 -26A6 6 0 0 0 54 -20A6 6 0 0 0 60 -14A6 6 0 0 0 66 -20Z",
  );
  assert.equal(attr(svg.text, "viewBox"), "0 -40 80 40");
  assert.equal(attr(svg.text, "fill-rule"), "evenodd");
  // A lone circle sets the box itself: centre (−5, 3), r 2 → x −7..−3, y 1..5.
  assert.equal(attr(outlineToSvg({ outer: circle(-5, 3, 2), holes: [] }).text, "viewBox"), "-7 -5 4 4");
});

test("numbers: rounded to 1e-6 mm, no trailing zeros, no -0, no exponent", () => {
  assert.equal(svgNumber(0), "0");
  assert.equal(svgNumber(-0), "0");
  assert.equal(svgNumber(-1e-9), "0"); // rounds to −0.000000, written 0
  assert.equal(svgNumber(12.5), "12.5");
  assert.equal(svgNumber(-3), "-3");
  assert.equal(svgNumber(1 / 3), "0.333333");
  assert.equal(svgNumber(2 / 3), "0.666667");
  assert.equal(svgNumber(1e8), "100000000"); // MAX_COORD, no "1e+8"
  assert.equal(svgNumber(1e-3), "0.001"); // MIN_FEATURE, no "1e-3"
  // The rounding step is 1e-6, so the boundary is half a step, 5e-7:
  // 0.9× of it rounds to 0, 1.1× of it up to one step.
  assert.equal(svgNumber(0.9 * 5e-7), "0");
  assert.equal(svgNumber(1.1 * 5e-7), "0.000001");
});

test("arcs split at quarter turns, at their boundaries; the sweep flag follows the bulge's sign", () => {
  // The first piece's A commands: (large-arc, sweep) for each.
  const arcs = (b: number) => [...attr(outlineToSvg({ outer: path([0, 0, 10, 0, 5, 20], [b, 0, 0]), holes: [] }).text, "d")!.matchAll(/A\S+ \S+ 0 (\d) (\d) /g)].map((m) => `${m[1]}${m[2]}`);
  // A quarter turn is bulge tan(π/8): 0.9 of that turn is one A, 1.1 of it two.
  assert.deepEqual(arcs(Math.tan((0.9 * Math.PI) / 8)), ["00"]);
  assert.deepEqual(arcs(Math.tan(Math.PI / 8)), ["00"]);
  assert.deepEqual(arcs(Math.tan((1.1 * Math.PI) / 8)), ["00", "00"]);
  // A half turn is bulge 1: 0.9 and 1.1 of that turn give two and three parts.
  assert.deepEqual(arcs(Math.tan((0.9 * Math.PI) / 4)), ["00", "00"]);
  assert.deepEqual(arcs(1), ["00", "00"]);
  assert.deepEqual(arcs(Math.tan((1.1 * Math.PI) / 4)), ["00", "00", "00"]);
  // Three quarters, then up to a whole turn: four parts at most.
  assert.deepEqual(arcs(Math.tan((1.1 * 3 * Math.PI) / 8)).length, 4);
  assert.deepEqual(arcs(1e6).length, 4);
  // Clockwise (b < 0) is SVG's positive-angle way: sweep 1. Never a large arc.
  assert.deepEqual(arcs(-0.3), ["01"]);
  assert.deepEqual(arcs(-1), ["01", "01"]);
});

test("a 1 m half circle keeps its middle where it belongs despite rounding", () => {
  // Chord 1000 mm with bulge 1: radius 500, middle 500 below the chord's
  // midpoint, (500, −500). Written as one A, rounding the radius by up to
  // 5e-7 could move SVG's centre by √(2·500·5e-7) ≈ 0.022 mm; as two
  // quarter turns the middle is a written corner: exactly (500, −500), "500 500" in SVG.
  const d = attr(outlineToSvg({ outer: path([0, 0, 1000, 0], [1, 1]), holes: [] }).text, "d")!;
  assert.equal(d, "M0 0A500 500 0 0 0 500 500A500 500 0 0 0 1000 0A500 500 0 0 0 500 -500A500 500 0 0 0 0 0Z");
});

test("special characters in the title are escaped", () => {
  const svg = outlineToSvg({ outer: circle(0, 0, 1), holes: [] }, "A & B <part>");
  assert.match(svg.text, /<title>A &amp; B &lt;part&gt;<\/title>/);
});

test("malformed outlines are refused with what is wrong, each check on its own", () => {
  const refuse = (outline: Outline, message: string) => assert.throws(() => outlineToSvg(outline), { message });
  const ok = path([0, 0, 1, 0, 0, 1]);
  refuse({ outer: path([0, 0, 1, 0, 0]), holes: [] }, "the outline can't be written as SVG: it has 5 corner numbers, not whole x, y pairs");
  refuse({ outer: path([0, 0], [1]), holes: [] }, "the outline can't be written as SVG: it has 1 corner, and a closed path needs at least 2");
  refuse({ outer: path([0, 0, 1, 0, 0, 1], [1, 0]), holes: [] }, "the outline can't be written as SVG: it has 3 corners but 2 bulges (one per corner, or none)");
  refuse({ outer: path([0, 0, 1, 0]), holes: [] }, "the outline can't be written as SVG: 2 corners joined by straight pieces enclose nothing");
  refuse({ outer: path([0, 0, 1, NaN, 0, 1]), holes: [] }, "the outline can't be written as SVG: it has a number that is not finite");
  refuse({ outer: path([0, 0, 1, 0, 0, 1], [0, Infinity, 0]), holes: [] }, "the outline can't be written as SVG: it has a number that is not finite");
  refuse({ outer: ok, holes: [ok, circle(0, 0, 0)] }, "the hole 2 can't be written as SVG: its circle's radius is 0, not above 0");
  refuse({ outer: circle(0, 0, -1), holes: [] }, "the outline can't be written as SVG: its circle's radius is -1, not above 0");
  refuse({ outer: circle(NaN, 0, 1), holes: [] }, "the outline can't be written as SVG: its circle has a number that is not finite");
  // Two corners joined by arcs do enclose something (a lens): allowed.
  assert.doesNotThrow(() => outlineToSvg({ outer: path([0, 0, 1, 0], [0.5, 0.5]), holes: [] }));
});

// ---- Seeded random outlines against an independent model ----
//
// The model knows nothing of SVG flags or centres: an arc with bulge b on
// the chord a → b passes, at its middle, the point the sagitta (c/2)·|b|
// puts beside the chord, to the right of a → b for b > 0 (the kernel's
// Seg::from_bulge: counter-clockwise from a, as in its "bulges below the
// chord" hand-worked test). The SVG side is read back with the SVG spec's
// own endpoint-to-centre conversion (SVG 1.1 implementation notes, F.6.5),
// and its middle point must be the model's. The viewBox must be the box of
// thousands of points along each piece, sampled on the circle through the
// arc's ends and middle.

/** SplitMix64 (core can't import packages/testing). */
function rng(seed: bigint) {
  let s = seed;
  const M = (1n << 64n) - 1n;
  return () => {
    s = (s + 0x9e3779b97f4a7c15n) & M;
    let z = s;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & M;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & M;
    return Number((z ^ (z >> 31n)) >> 11n) / 2 ** 53;
  };
}

type Pt = [number, number];

/** The SVG path read back: one list of pieces per loop, in the model's y (flipped back). */
function readPath(d: string): { start: Pt; pieces: ({ line: true; to: Pt } | { line: false; to: Pt; r: number; large: number; sweep: number })[] }[] {
  const loops: ReturnType<typeof readPath> = [];
  const tokens = d.match(/[MLAZ]|-?\d+(?:\.\d+)?/g)!;
  let i = 0;
  const num = () => Number(tokens[i++]);
  const pt = (): Pt => {
    const x = num();
    return [x, -num()];
  };
  while (i < tokens.length) {
    const cmd = tokens[i++];
    if (cmd === "M") loops.push({ start: pt(), pieces: [] });
    else if (cmd === "L") loops.at(-1)!.pieces.push({ line: true, to: pt() });
    else if (cmd === "A") {
      const r = num();
      assert.equal(num(), r, "rx = ry");
      assert.equal(num(), 0, "no rotation");
      const large = num();
      const sweep = num();
      loops.at(-1)!.pieces.push({ line: false, to: pt(), r, large, sweep });
    } else if (cmd === "Z") {
      // Z draws the straight piece back to the start, unless the last piece already ended there (an arc).
      const loop = loops.at(-1)!;
      const end = loop.pieces.at(-1)?.to;
      if (!end || end[0] !== loop.start[0] || end[1] !== loop.start[1]) loop.pieces.push({ line: true, to: loop.start });
    } else throw new Error(`unexpected ${cmd}`);
  }
  return loops;
}

/** SVG F.6.5 in SVG coordinates: the arc's centre and its start angle and turn. */
function svgArc(from: Pt, to: Pt, r: number, large: number, sweep: number) {
  const [x1, y1] = [from[0], -from[1]];
  const [x2, y2] = [to[0], -to[1]];
  const [dx, dy] = [(x1 - x2) / 2, (y1 - y2) / 2];
  // Radius correction (F.6.6): too small a radius is scaled up.
  const lambda = (dx * dx + dy * dy) / (r * r);
  if (lambda > 1) r *= Math.sqrt(lambda);
  const sq = Math.max(0, (r * r * r * r - r * r * (dx * dx + dy * dy)) / (r * r * (dx * dx + dy * dy)));
  const coef = (large !== sweep ? 1 : -1) * Math.sqrt(sq);
  const [cxp, cyp] = [coef * dy, -coef * dx];
  const [cx, cy] = [cxp + (x1 + x2) / 2, cyp + (y1 + y2) / 2];
  const angle = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const theta = angle(1, 0, (dx - cxp) / r, (dy - cyp) / r);
  let delta = angle((dx - cxp) / r, (dy - cyp) / r, (-dx - cxp) / r, (-dy - cyp) / r);
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  if (sweep && delta < 0) delta += 2 * Math.PI;
  return { cx, cy, r, theta, delta };
}

/** The model's middle point of the piece a → b with bulge β. */
function modelMiddle(a: Pt, b: Pt, beta: number): Pt {
  const [ex, ey] = [b[0] - a[0], b[1] - a[1]];
  const c = Math.hypot(ex, ey);
  const s = (c / 2) * beta; // signed sagitta, to the right for β > 0
  return [(a[0] + b[0]) / 2 + (ey / c) * s, (a[1] + b[1]) / 2 - (ex / c) * s];
}

/** The circle through three points: centre and radius (worked relative to `a`, so far-out points keep their digits). */
function circleThrough(a: Pt, m: Pt, b: Pt): [number, number, number] {
  const [bx, by, cx, cy] = [m[0] - a[0], m[1] - a[1], b[0] - a[0], b[1] - a[1]];
  const d = 2 * (bx * cy - by * cx);
  const ux = (cy * (bx * bx + by * by) - by * (cx * cx + cy * cy)) / d;
  const uy = (bx * (cx * cx + cy * cy) - cx * (bx * bx + by * by)) / d;
  return [a[0] + ux, a[1] + uy, Math.hypot(ux, uy)];
}

/** Points along the circle through a, m, b, from a through m to b (the model's arc, sampled). */
function sampleArc(a: Pt, m: Pt, b: Pt, n: number): Pt[] {
  const [ux, uy, r] = circleThrough(a, m, b);
  const t = (p: Pt) => Math.atan2(p[1] - uy, p[0] - ux);
  const [t0, tm, t1] = [t(a), t(m), t(b)];
  // Go the way that passes m.
  const ccw = (x: number) => (((x - t0) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const turn = ccw(tm) < ccw(t1) ? ccw(t1) : ccw(t1) - 2 * Math.PI;
  return Array.from({ length: n + 1 }, (_, k) => [ux + r * Math.cos(t0 + (turn * k) / n), uy + r * Math.sin(t0 + (turn * k) / n)] as Pt);
}

test("seeded random outlines: every piece and the viewBox agree with an independent model", () => {
  let arcs = 0;
  for (const seed of [0x5eedn, 1n, 2n, 3n, 0xdeadbeefn]) {
    const next = rng(seed);
    for (let n = 0; n < 400; n++) {
      // Sizes from 1 µm to 1 km, offsets up to 100 km out: the modelling range.
      const scale = 10 ** (-3 + 9 * next());
      const offset = next() < 0.2 ? (next() - 0.5) * 2e8 : 0;
      const coord = () => offset + (next() - 0.5) * scale;
      const bulge = () => {
        const u = next();
        if (u < 0.3) return 0;
        if (u < 0.4) return next() < 0.5 ? 1 : -1; // exactly half circles
        if (u < 0.45) return (next() < 0.5 ? 1 : -1) * 1e-4; // nearly flat
        return (next() - 0.5) * 6;
      };
      const loop = (): Loop => {
        if (next() < 0.2) return circle(coord(), coord(), scale * (0.01 + next()));
        const k = 2 + Math.floor(next() * 7);
        const corners = Array.from({ length: 2 * k }, coord);
        const bulges = Array.from({ length: k }, bulge);
        if (k === 2) bulges[0] = bulges[0] || 0.5; // two corners need an arc
        return path(corners, next() < 0.1 && k > 2 ? [] : bulges);
      };
      const outline: Outline = { outer: loop(), holes: Array.from({ length: Math.floor(next() * 3) }, loop) };
      const svg = outlineToSvg(outline);
      const [vx, vy, vw, vh] = attr(svg.text, "viewBox")!.split(" ").map(Number);
      assert.equal(attr(svg.text, "width"), `${svgNumber(svg.width)}mm`);
      // Numbers are rounded to 1e-6; far out (1e8) a double holds ~1.5e-8;
      // a sampled arc misses its extreme by at most r(1 − cos(π/4000)) ≈ 3e-7 r.
      const tol = 2e-6 + 1e-12 * Math.abs(offset);
      const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
      const add = ([x, y]: Pt) => {
        box.minX = Math.min(box.minX, x);
        box.minY = Math.min(box.minY, y);
        box.maxX = Math.max(box.maxX, x);
        box.maxY = Math.max(box.maxY, y);
      };
      const read = readPath(attr(svg.text, "d")!);
      const loops = [outline.outer, ...outline.holes];
      assert.equal(read.length, loops.length, `seed ${seed} case ${n}: one subpath per loop`);
      for (const [li, l] of loops.entries()) {
        const got = read[li];
        /**
         * Checks the SVG arcs from `from` that must make up one model arc
         * round (cx, cy) of radius r turning `turn` (counter-clockwise > 0):
         * as many as the turn has started quarter turns, each at most a
         * quarter turn, on the model's circle, turning the model's way, adding
         * up to the model's turn. Returns how many it used.
         */
        const checkArcs = (first: number, from: Pt, cx: number, cy: number, r: number, turn: number, what: string) => {
          const parts = Math.ceil(Math.abs(turn) / (Math.PI / 2));
          // Rounding the ends by 5e-7 turns each part by up to ~tol / r more or less.
          const angleTol = 1e-9 + (4 * tol) / r;
          let total = 0;
          let at = from;
          let used = 0;
          while (used < parts) {
            const p = got.pieces[first + used];
            assert.ok(p && !p.line, `${what}: arc part ${used} missing (turned ${total} of ${turn})`);
            if (p.line) break;
            assert.equal(p.large, 0, `${what}: never a large arc`);
            const arc = svgArc(at, p.to, p.r, p.large, p.sweep);
            // SVG's delta is in y-down terms: the model turns −delta.
            const step = -arc.delta;
            assert.ok(Math.abs(step) <= Math.PI / 2 + angleTol, `${what}: part ${used} turns ${step}, more than a quarter`);
            assert.ok(Math.sign(step) === Math.sign(turn), `${what}: part ${used} turns the wrong way`);
            const mid = arc.theta + arc.delta / 2;
            const m: Pt = [arc.cx + arc.r * Math.cos(mid), -(arc.cy + arc.r * Math.sin(mid))];
            // Quarter turns keep SVG's centre within ~√2 × the rounding of the model's.
            const off = Math.abs(Math.hypot(m[0] - cx, m[1] - cy) - r);
            assert.ok(off <= 4 * tol + 1e-9 * r, `${what}: part ${used}'s middle is ${off} off the model's circle`);
            total += step;
            at = p.to;
            used++;
          }
          assert.ok(Math.abs(total - turn) <= parts * angleTol, `${what}: the parts turn ${total}, the model ${turn}`);
          return used;
        };
        if ("circle" in l) {
          const { center: [cx, cy], radius: r } = l.circle;
          for (let k = 0; k <= 4000; k++) add([cx + r * Math.cos((k / 4000) * 2 * Math.PI), cy + r * Math.sin((k / 4000) * 2 * Math.PI)]);
          assert.ok(Math.hypot(got.start[0] - (cx + r), got.start[1] - cy) <= tol, `seed ${seed} case ${n}: circle starts east`);
          assert.equal(checkArcs(0, got.start, cx, cy, r, 2 * Math.PI, `seed ${seed} case ${n}: circle`), 4);
          assert.equal(got.pieces.length, 4, `seed ${seed} case ${n}: circle is four arcs`);
          continue;
        }
        const { corners, bulges } = l.path;
        const k = corners.length / 2;
        const at = (i: number): Pt => [corners[2 * (i % k)], corners[2 * (i % k) + 1]];
        assert.ok(Math.hypot(got.start[0] - at(0)[0], got.start[1] - at(0)[1]) <= tol);
        let next = 0;
        for (let i = 0; i < k; i++) {
          const [a, b] = [at(i), at(i + 1)];
          const beta = bulges[i] ?? 0;
          const what = `seed ${seed} case ${n}: piece ${i} (bulge ${beta})`;
          add(a);
          if (beta === 0) {
            assert.ok(got.pieces[next]?.line, `${what} is straight`);
          } else {
            arcs++;
            // The model's circle: through a, b and the sagitta's middle point.
            const m = modelMiddle(a, b, beta);
            const samples = sampleArc(a, m, b, 4000);
            for (const q of samples) add(q);
            const [ux, uy, r] = circleThrough(a, m, b);
            const from = next === 0 ? got.start : got.pieces[next - 1].to;
            next += checkArcs(next, from, ux, uy, r, 4 * Math.atan(beta), what) - 1;
          }
          const to = got.pieces[next].to;
          assert.ok(Math.hypot(to[0] - b[0], to[1] - b[1]) <= tol, `${what} ends at its corner`);
          next++;
        }
        assert.equal(got.pieces.length, next, `seed ${seed} case ${n}: no pieces beyond the loop's`);
      }
      // The viewBox is the box of the samples, y flipped: exact to the tolerance on every side.
      const sideTol = tol + 3e-7 * Math.max(box.maxX - box.minX, box.maxY - box.minY);
      assert.ok(Math.abs(vx - box.minX) <= sideTol, `seed ${seed} case ${n}: left ${vx} vs ${box.minX}`);
      assert.ok(Math.abs(vx + vw - box.maxX) <= sideTol, `seed ${seed} case ${n}: right ${vx + vw} vs ${box.maxX}`);
      assert.ok(Math.abs(-vy - box.maxY) <= sideTol, `seed ${seed} case ${n}: top ${-vy} vs ${box.maxY}`);
      assert.ok(Math.abs(-(vy + vh) - box.minY) <= sideTol, `seed ${seed} case ${n}: bottom ${-(vy + vh)} vs ${box.minY}`);
    }
  }
  assert.ok(arcs > 2000, `enough arcs were tried (${arcs})`);
});

test("too few corners: the error counts them in good English, 0 corners and 1 corner", () => {
  // Kills `n === 1 ? "" : "s"` => true and "s" => "": 0 needs the plural, 1 must not have it.
  assert.throws(() => outlineToSvg({ outer: path([]), holes: [] }), { message: "the outline can't be written as SVG: it has 0 corners, and a closed path needs at least 2" });
  assert.throws(() => outlineToSvg({ outer: path([1, 2]), holes: [] }), { message: "the outline can't be written as SVG: it has 1 corner, and a closed path needs at least 2" });
});

test("hand-worked: a bulge on a piece of zero length draws a straight step, not an arc of radius 0", () => {
  // Kills `c === 0` => false. Corners (0,0) (0,0) (10,0) (0,10), bulges 0.5 then 0: the first
  // piece goes nowhere (c = 0), so its bulge can't make a circle (r = c(1 + b²)/(4|b|) = 0) and
  // it is written L0 0; then L10 0 and the closing Z after (0,10), flipped to (0,-10). The box
  // is 0..10 both ways.
  const svg = outlineToSvg({ outer: path([0, 0, 0, 0, 10, 0, 0, 10], [0.5, 0, 0, 0]), holes: [] });
  assert.equal(attr(svg.text, "d"), "M0 0L0 0L10 0L0 -10Z");
  assert.equal(attr(svg.text, "viewBox"), "0 -10 10 10");
});
