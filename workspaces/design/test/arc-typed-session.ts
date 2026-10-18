// Seeded sessions for typed sizes on the arc tools: random 3-point,
// centre and tangent arcs, each point clicked or typed (some of length,
// angle, radius or arc angle locked), run through the real tools the way
// the workspace runs them (a hover moves the tool, a click goes to
// `withLocks` at `aimOf`'s point), and checked against a plain model that
// knows only polar coordinates and the circumcentre formula: it shares no
// code with typed-entry.ts, sketch-tool.ts or centre-arc.ts, and never
// unwraps an angle (it adds up the turns it made the pointer take).
// `runArcSession` takes the typed-entry module, so a copy with a bug
// planted in it can be run (arc-typed-planted.test.ts).

import type { SketchXY } from "@fission/core";
import { partDocument, type DesignDocument } from "../src/document.ts";
import { addSketch, drawLine, sketchCurves } from "../src/sketch.ts";
import { clickAt, hoverTool, startTool, type SketchTool } from "../src/sketch-tool.ts";
import { hintOf } from "../src/pointer-hint.ts";
import type * as TypedEntry from "../src/typed-entry.ts";

export type Entry = Pick<typeof TypedEntry, "aimOf" | "withLocks" | "typedFields" | "liveValues" | "anchorOf">;
type Locks = TypedEntry.Locks;

/** One click: the pointer there (after hovers through `hovers`), with these sizes typed. */
interface Place {
  hovers: SketchXY[];
  pointer: SketchXY;
  locks: Locks;
}

/** One arc: which tool, the first click (for the tangent arc, the line it leaves), then the places. */
export type Episode =
  | { kind: "arc"; start: SketchXY; end: Place; through: SketchXY; model: { end: SketchXY; centre: SketchXY; ccwFromEnd: boolean } }
  | { kind: "centre"; centre: SketchXY; start: Place; end: Place; model: { start: SketchXY; end: SketchXY; way: 1 | -1; sweep: number; live: number | null } }
  | { kind: "tangent"; line: [SketchXY, SketchXY]; end: Place; model: { end: SketchXY } };

export function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const polar = (o: SketchXY, r: number, a: number): SketchXY => [o[0] + r * Math.cos(a), o[1] + r * Math.sin(a)];
const bearing = (o: SketchXY, p: SketchXY) => Math.atan2(p[1] - o[1], p[0] - o[0]);
const far = (a: SketchXY, b: SketchXY) => Math.hypot(b[0] - a[0], b[1] - a[1]);
const TURN = 2 * Math.PI;
/** An angle in [0, 2π), the model's only reduction (a remainder, never an unwrap). */
const rem = (a: number) => ((a % TURN) + TURN) % TURN;

/** A random episode: sizes from 0.01 mm to 1 m, about a place up to 1 m from the origin; quarter turns and whole numbers often. */
export function randomEpisode(r: () => number): Episode | null {
  const size = () => 10 ** (r() * 5 - 2);
  const where = (): SketchXY => [(r() - 0.5) * 10 ** (r() * 3), (r() - 0.5) * 10 ** (r() * 3)];
  const degrees = () => (r() < 0.25 ? 90 * Math.floor(r() * 4) : Number((r() * 360).toFixed(r() < 0.5 ? 0 : 3)));
  const kind = r();
  if (kind < 0.4) {
    // 3-point arc: the start, the end by a typed length and/or angle or a click, then a point well off the chord.
    const start = where();
    const L = Number(size().toFixed(3)) || 0.01;
    const th = degrees();
    const a = r() * TURN;
    const pointer = polar(start, size(), a);
    const pick = Math.floor(r() * 4);
    const locks: Locks = pick === 0 ? {} : pick === 1 ? { length: L } : pick === 2 ? { angle: th } : { length: L, angle: th };
    const t = (th * Math.PI) / 180;
    const along = far(start, pointer) * Math.cos(a - t);
    if (pick === 2 && along <= 1e-6 * far(start, pointer)) return null; // behind the typed angle: no end (checked by hand elsewhere)
    const end: SketchXY = pick === 0 ? pointer : pick === 1 ? polar(start, L, a) : pick === 2 ? polar(start, along, t) : polar(start, L, t);
    const chord = far(start, end);
    if (chord < 1e-6 * Math.max(1, Math.abs(start[0]), Math.abs(start[1]))) return null;
    // Through: off the chord's midpoint by 0.1 to 3 chords to the side, and up to half a chord along it.
    const mid: SketchXY = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
    const ux = (end[0] - start[0]) / chord, uy = (end[1] - start[1]) / chord;
    const side = (r() < 0.5 ? -1 : 1) * chord * (0.1 + r() * 2.9);
    const slide = (r() - 0.5) * chord;
    const through: SketchXY = [mid[0] + ux * slide - uy * side, mid[1] + uy * slide + ux * side];
    // The circumcentre, by the textbook determinant formula.
    const [ax, ay] = start, [bx, by] = end, [cx, cy] = through;
    const D = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    const n = (x: number, y: number) => x * x + y * y;
    const centre: SketchXY = [(n(ax, ay) * (by - cy) + n(bx, by) * (cy - ay) + n(cx, cy) * (ay - by)) / D, (n(ax, ay) * (cx - bx) + n(bx, by) * (ax - cx) + n(cx, cy) * (bx - ax)) / D];
    // Through on the left of start → end: the arc through it runs counter-clockwise from the end round to the start.
    return { kind: "arc", start, end: { hovers: [pointer], pointer, locks }, through, model: { end, centre, ccwFromEnd: side > 0 } };
  }
  if (kind < 0.8) {
    // Centre arc: the centre, the start by a typed radius and/or angle or a click, then the end swept round to.
    const centre = where();
    const R = Number(size().toFixed(3)) || 0.01;
    const th = degrees();
    const a = r() * TURN;
    const p2 = polar(centre, size(), a);
    const pick = Math.floor(r() * 4);
    const locks: Locks = pick === 0 ? {} : pick === 1 ? { radius: R } : pick === 2 ? { angle: th } : { radius: R, angle: th };
    const t = (th * Math.PI) / 180;
    const along = far(centre, p2) * Math.cos(a - t);
    if (pick === 2 && along <= 1e-6 * far(centre, p2)) return null;
    const start: SketchXY = pick === 0 ? p2 : pick === 1 ? polar(centre, R, a) : pick === 2 ? polar(centre, along, t) : polar(centre, R, t);
    const radius = far(centre, start);
    if (radius < 1e-6 * Math.max(1, Math.abs(centre[0]), Math.abs(centre[1]))) return null;
    const a0 = bearing(centre, start);
    // The pointer's way round: no hovers (a tap, the shorter way to it), or hovers each under 0.9 of a half turn, added up.
    const tap = r() < 0.2;
    const steps = tap ? 1 : 1 + Math.floor(r() * 5);
    const turns: number[] = [];
    for (let i = 0; i < steps; i++) turns.push((r() * 2 - 1) * Math.PI * (tap ? 0.95 : 0.9));
    const total = turns.reduce((x, y) => x + y, 0);
    if (Math.abs(total) < 1e-3 || Math.abs(rem(total)) < 1e-3 || TURN - rem(total) < 1e-3) return null;
    let so = 0;
    const hovers = turns.map((d) => polar(centre, size(), a0 + (so += d)));
    const pointer = hovers.at(-1)!;
    const way = total > 0 ? 1 : -1;
    const clicked = way > 0 ? rem(total) : rem(-total);
    const typed = r() < 0.7;
    const sigma = typed ? (r() < 0.3 ? 90 * (1 + Math.floor(r() * 3)) : Number((0.5 + r() * 359).toFixed(3))) : 0;
    const sweep = typed ? (sigma * Math.PI) / 180 : clicked;
    const end = polar(centre, radius, a0 + way * sweep);
    return { kind: "centre", centre, start: { hovers: [p2], pointer: p2, locks }, end: { hovers: tap ? [] : hovers, pointer, locks: typed ? { sweep: sigma } : {} }, model: { start, end, way, sweep, live: (clicked * 180) / Math.PI } };
  }
  // Tangent arc: from the end of a line, its own end by a typed length and/or angle or a click, well off the line's way.
  const l0 = where();
  const l1 = polar(l0, size(), r() * TURN);
  if (far(l0, l1) < 1e-6 * Math.max(1, Math.abs(l0[0]), Math.abs(l0[1]))) return null;
  const out = bearing(l0, l1);
  const turn = (r() < 0.5 ? -1 : 1) * (0.2 + r() * 2.6); // 0.2 to 2.8 rad off the way out
  const L = Number(size().toFixed(3)) || 0.01;
  const pointer = polar(l1, size(), out + turn);
  const pick = Math.floor(r() * 3);
  const th = Number(((((out + turn) * 180) / Math.PI + 360) % 360).toFixed(3));
  const locks: Locks = pick === 0 ? {} : pick === 1 ? { length: L } : { length: L, angle: th };
  const end = pick === 0 ? pointer : pick === 1 ? polar(l1, L, out + turn) : polar(l1, L, (th * Math.PI) / 180);
  return { kind: "tangent", line: [l0, l1], end: { hovers: [pointer], pointer, locks }, model: { end } };
}

/** What a failed check says; null when every check passed. */
export type Failure = { message: string } | null;

const close = (a: SketchXY, b: SketchXY, scale: number) => Math.abs(a[0] - b[0]) <= 1e-9 * scale && Math.abs(a[1] - b[1]) <= 1e-9 * scale;
const show = (p: SketchXY) => `(${p[0]}, ${p[1]})`;

/** Runs one episode through the real tools with `te`'s typed sizes, as the workspace does; the first check that fails. */
export function runEpisode(te: Entry, e: Episode): Failure {
  const s = addSketch(partDocument("box", 40, 30, 20));
  let doc: DesignDocument = s.doc;
  let tool: SketchTool = startTool(e.kind, s.id);
  const fail = (check: string, detail: string): Failure => ({ message: `${check}: ${detail} (episode ${JSON.stringify(e)})` });
  const expect = (fields: string[], hint: string): Failure => {
    const got = te.typedFields(tool);
    if (got.join() !== fields.join()) return fail("fields", `${tool.kind} shows [${got}], wants [${fields}]`);
    if (hintOf(tool) !== hint) return fail("hint", `"${hintOf(tool)}", wants "${hint}"`);
    return null;
  };
  /** A click at `at` as is, as the workspace's click with nothing typed. */
  const click = (at: SketchXY) => {
    const done = clickAt(doc, tool, at);
    doc = done.doc;
    tool = done.tool;
    return done;
  };
  /** A place: hovers, then the click where the locks put it. */
  const place = (p: Place) => {
    for (const h of p.hovers) tool = hoverTool(tool, h);
    const aim = te.aimOf(doc, tool, p.pointer, p.locks);
    if (!aim) return null;
    const done = clickAt(doc, te.withLocks(tool, p.locks, p.pointer), aim);
    doc = done.doc;
    tool = done.tool;
    return done;
  };
  const arcs = () => sketchCurves(doc.sketches[0]).arcs;

  if (e.kind === "arc") {
    const scale = Math.max(1, ...[e.start, e.model.end, e.through, e.model.centre].flatMap((p) => [Math.abs(p[0]), Math.abs(p[1])]), far(e.model.centre, e.start));
    let f = expect([], "Place start point");
    if (f) return f;
    click(e.start);
    if ((f = expect(["length", "angle"], "Specify next point"))) return f;
    if (!place(e.end)) return fail("end", "no aim");
    if ((f = expect([], "Place point on arc"))) return f;
    if (!tool.kind || tool.kind !== "arc" || !tool.end || !close(tool.end, e.model.end, scale)) return fail("end", `the end is ${tool.kind === "arc" && tool.end ? show(tool.end) : "missing"}, the model's ${show(e.model.end)}`);
    const done = click(e.through);
    if (!done.drew) return fail("drew", `no arc: ${done.note}`);
    const arc = arcs().at(-1)!;
    if (!close(arc.centre, e.model.centre, scale)) return fail("centre", `${show(arc.centre)}, the model's ${show(e.model.centre)}`);
    const [from, to] = e.model.ccwFromEnd ? [e.model.end, e.start] : [e.start, e.model.end];
    if (!close(arc.start, from, scale) || !close(arc.end, to, scale)) return fail("way round", `${show(arc.start)} → ${show(arc.end)}, the model's ${show(from)} → ${show(to)}`);
    return expect([], "Place start point");
  }

  if (e.kind === "centre") {
    const scale = Math.max(1, ...[e.centre, e.model.start, e.model.end].flatMap((p) => [Math.abs(p[0]), Math.abs(p[1])]), far(e.centre, e.model.start));
    let f = expect([], "Place centre point");
    if (f) return f;
    click(e.centre);
    if ((f = expect(["radius", "angle"], "Place start point"))) return f;
    if (!place(e.start)) return fail("start", "no aim");
    if (tool.kind !== "centre" || !tool.start || !close(tool.start, e.model.start, scale)) return fail("start", `the start is ${tool.kind === "centre" && tool.start ? show(tool.start) : "missing"}, the model's ${show(e.model.start)}`);
    if ((f = expect(["sweep"], "Place end point"))) return f;
    // What the Arc angle box shows before anything is typed: how far round a click at the pointer would go.
    if (e.end.hovers.length > 0) {
      let t = tool;
      for (const h of e.end.hovers) t = hoverTool(t, h);
      const live = te.liveValues(e.centre, e.end.pointer, t).sweep;
      const want = e.model.live!;
      if (want > 1e-6 && want < 360 - 1e-6 && (live === undefined || Math.abs(live - want) > 1e-9 * 360)) return fail("live", `the box shows ${live}°, the model's ${want}°`);
    }
    const done = place(e.end);
    if (!done) return fail("end", "no aim");
    if (!done.drew) return fail("drew", `no arc: ${done.note}`);
    const arc = arcs().at(-1)!;
    if (arc.centre[0] !== e.centre[0] || arc.centre[1] !== e.centre[1]) return fail("centre", `${show(arc.centre)}, clicked at ${show(e.centre)}`);
    const [from, to] = e.model.way > 0 ? [e.model.start, e.model.end] : [e.model.end, e.model.start];
    if (!close(arc.start, from, scale) || !close(arc.end, to, scale)) return fail("end", `${show(arc.start)} → ${show(arc.end)}, the model's ${show(from)} → ${show(to)} (way ${e.model.way})`);
    const ccw = rem(bearing(arc.centre, arc.end) - bearing(arc.centre, arc.start));
    const off = Math.abs(ccw - e.model.sweep);
    if (Math.min(off, TURN - off) > 1e-9 * TURN) return fail("sweep", `${(ccw * 180) / Math.PI}° counter-clockwise from start to end, the model's ${(e.model.sweep * 180) / Math.PI}°`);
    return expect([], "Place centre point");
  }

  // Tangent arc: the line, then from its free end.
  const line = drawLine(doc, s.id, e.line[0], e.line[1]);
  doc = line.doc;
  const scale = Math.max(1, ...[...e.line, e.model.end].flatMap((p) => [Math.abs(p[0]), Math.abs(p[1])]));
  let f = expect([], "Click the free end of a line or arc");
  if (f) return f;
  click(e.line[1]);
  if ((f = expect(["length", "angle"], "Specify next point"))) return f;
  const done = place(e.end);
  if (!done) return fail("end", "no aim");
  if (!done.drew) return fail("drew", `no arc: ${done.note}`);
  const arc = arcs().at(-1)!;
  const other = close(arc.start, e.line[1], scale) ? arc.end : arc.start;
  if (!close(other, e.model.end, scale)) return fail("end", `${show(other)}, the model's ${show(e.model.end)}`);
  // Tangent: the radius at the line's end is square to the line.
  const [rx, ry] = [e.line[1][0] - arc.centre[0], e.line[1][1] - arc.centre[1]];
  const [tx, ty] = [e.line[1][0] - e.line[0][0], e.line[1][1] - e.line[0][1]];
  if (Math.abs(rx * tx + ry * ty) > 1e-8 * Math.hypot(rx, ry) * Math.hypot(tx, ty)) return fail("tangent", `the radius ${show([rx, ry])} is not square to the line ${show([tx, ty])}`);
  return null;
}

/** `count` seeded episodes; the first failure, with its seed and number. */
export function runArcSession(te: Entry, seed: number, count: number): Failure {
  const r = rng(seed);
  for (let i = 0; i < count; i++) {
    const e = randomEpisode(r);
    if (!e) continue;
    const f = runEpisode(te, e);
    if (f) return { message: `seed ${seed} episode ${i}: ${f.message}` };
  }
  return null;
}
