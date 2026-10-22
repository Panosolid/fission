// Step 27b on the real kernel: the two corners of an outline of only two
// curves (a half disc, a crescent) each get a name of their own, so each
// can be snapped to and pinned, and the name stays with its corner through
// every edit that keeps the curves: the radius changed, the extrude
// flipped, the curves' bulges swapped. A corner is named by which end of
// each curve meets there ("side:line-5@end+side:arc-7@start"), never by the
// way round the outline goes, which a flip or a swap turns over (checked
// here: the kernel's own order of the two sides turns over with them).
// Run with `npm run journeys` after the app build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  addFaceSketch,
  addSketch,
  BodyCache,
  drawArc,
  drawCircle,
  drawLine,
  drawnFrame,
  extrudeSketch,
  faceEdgeTargets,
  facePlane,
  inSketch,
  joinBodies,
  movePoint,
  partDocument,
  pinNewPoints,
  pinNow,
  readDesignDocument,
  rebuildTimeline,
  setExtrudeFlip,
  shownBodies,
  twiceArea,
  vertexNames,
  type DesignDocument,
} from "@fission/design";
import { emptyProject, projectFromJson, projectToJson } from "@fission/core";
import { kernel } from "./design-app.ts";
import { seeded } from "../src/index.ts";

/** The last body of `doc` as the app names it, and the rebuild. */
async function built(doc: DesignDocument) {
  const cache = new BodyCache(kernel);
  try {
    const build = await rebuildTimeline(doc, cache, kernel);
    return { body: joinBodies(await shownBodies(doc, build, cache)).bodies.at(-1)!, build };
  } finally {
    await cache.clear();
  }
}
/** The vertex at world point `p` (to 1e-9), by kernel index. */
function vertexAt(view: { vertex_points: readonly (readonly number[])[] }, p: number[]): number {
  const v = view.vertex_points.findIndex((q) => q.every((c, k) => Math.abs(c - p[k]) < 1e-9));
  assert.ok(v >= 0, `a vertex at ${p}`);
  return v;
}

/** The half disc of radius 5: line P (−5, 0) → Q (5, 0), the arc from Q counter-clockwise round (0, 0) back to P; extruded 10 (flipped with `flip`). */
function halfDisc(flip = false) {
  const made = addSketch(partDocument("box", 40, 30, 20));
  let doc = drawLine(made.doc, made.id, [-5, 0], [5, 0]).doc;
  const [p, q] = doc.sketches.at(-1)!.points;
  doc = drawArc(doc, made.id, q.id, p.id, [0, 0]).doc;
  const extrude = extrudeSketch(doc, made.id, 10, flip);
  return { doc: extrude.doc, sketch: made.id, extrude: extrude.id, p: p.id, q: q.id };
}

test("27b regression, hand-worked: a half disc's two top corners have two names, both offered and both pinned, and both pins follow the radius", async () => {
  // The end cap is z = 10; its corners Q (5, 0, 10) and P (−5, 0, 10). Each has three edges: the cap's edge along the line, the
  // cap's edge along the arc, and the upright between the two sides. The first two are the same pair at both corners, so only the
  // upright tells them apart: at Q the line ends and the arc starts, at P the arc ends and the line starts.
  const h = halfDisc();
  const { body } = await built(h.doc);
  const { vertices, shared } = vertexNames(body.view, body.names);
  const [atQ, atP] = [vertices[vertexAt(body.view, [5, 0, 10])], vertices[vertexAt(body.view, [-5, 0, 10])]];
  assert.ok(atQ !== null && atP !== null, `both named: ${atQ} | ${atP}`);
  assert.notEqual(atQ, atP);
  assert.equal(shared.size, 0, "no name two vertices would share");
  // Hand-worked: the line is "line-N", drawn first, the arc after it; the names are the edges' names sorted and joined by "&".
  const [line, arc] = body.names.faces.filter((f): f is string => f !== null && f.startsWith("side:")).sort((a, b) => (a.includes("line") ? -1 : b.includes("line") ? 1 : 0));
  assert.equal(atQ, [`${arc}@start+${line}@end`, `end+${arc}`, `end+${line}`].sort().join("&"));
  assert.equal(atP, [`${arc}@end+${line}@start`, `end+${arc}`, `end+${line}`].sort().join("&"));

  // A sketch on the end cap (XY's frame: sketch (x, y) is the world's), offered both corners as endpoints.
  const end = body.view.face_roles.findIndex((r) => r?.role === "end");
  const face = addFaceSketch(h.doc, { plane: facePlane(h.extrude, "end"), feature: h.extrude }, drawnFrame([0, 0, 1], [0, 2, 10]));
  const targets = faceEdgeTargets(body.view, body.names, end, { origin: [0, 0, 10], xAxis: [1, 0, 0], normal: [0, 0, 1] });
  const corners = targets.filter((t) => t.kind === "endpoint");
  assert.deepEqual(corners.map((t) => `${t.at}`).sort(), ["-5,0", "5,0"], "both corners offered");
  // Circles of radius 1 round each corner, each centre pinned there.
  const one = drawCircle(face.doc, face.id, [5, 0], 1).doc;
  const two = drawCircle(one, face.id, [-5, 0], 1).doc;
  const pinned = pinNewPoints(face.doc, two, face.id, targets);
  assert.equal(pinned.sketches.find((s) => s.id === face.id)!.pins!.length, 2, "both centres pinned");

  // The radius made 8: P to (−8, 0), Q to (8, 0), the centre where it was. Each pin goes with its own corner: Q's to (8, 0).
  const wider = movePoint(movePoint(pinned, h.sketch, h.p, -8, 0), h.sketch, h.q, 8, 0);
  const r = (await built(wider)).build.results[face.id] as { pinned?: { point: string; at: number[] }[]; points?: unknown };
  assert.equal(r.points, undefined, "no pin held");
  const centres = pinned.sketches.find((s) => s.id === face.id)!.points;
  const at = new Map(r.pinned!.map((p) => [p.point, `${p.at}`]));
  assert.deepEqual([at.get(centres[0].id), at.get(centres[1].id)], ["8,0", "-8,0"]);
});

/** The vertex named `name` on `body`, by kernel index (−1 for none). */
const named = (body: { view: Parameters<typeof vertexNames>[0]; names: Parameters<typeof vertexNames>[1] }, name: string) => vertexNames(body.view, body.names).vertices.indexOf(name);
/** The name of the edge whose middle is at `p`, by naming.ts ("A>B" between two sides). */
const edgeAt = (body: { view: { edge_middles: readonly (readonly number[])[] }; names: { edges: (string | null)[] } }, p: number[]) =>
  body.names.edges[body.view.edge_middles.findIndex((m) => m.every((c, k) => Math.abs(c - p[k]) < 1e-9))];
const XY = { origin: [0, 0, 0] as [number, number, number], xAxis: [1, 0, 0] as [number, number, number], normal: [0, 0, 1] as [number, number, number] };

test("27b, hand-worked: flipping the half disc's extrude keeps each corner's name on its own corner, though the kernel's order of its sides turns over", async () => {
  // Unflipped, the end cap is z = 10; flipped, the body goes down and the end cap is z = −10, the same outline under it. Q (5, 0)
  // is where the line ends and the arc starts either way, so Q's end-cap corner keeps its name, now at (5, 0, −10).
  const up = halfDisc();
  const down = halfDisc(true);
  const [a, b] = [await built(up.doc), await built(down.doc)];
  const atQ = vertexNames(a.body.view, a.body.names).vertices[vertexAt(a.body.view, [5, 0, 10])]!;
  assert.match(atQ, /@end\+.*@start|@start\+.*@end/);
  assert.equal(named(b.body, atQ), vertexAt(b.body.view, [5, 0, -10]), "flipped: the same name on Q's corner");
  // A pin on Q, seen from above (XY's frame), is found at (5, 0) on both bodies.
  const pin = { point: "q", kind: "endpoint" as const, name: atQ };
  assert.deepEqual([pinNow(pin, a.body.view, a.body.names, XY), pinNow(pin, b.body.view, b.body.names, XY)], [{ at: [5, 0] }, { at: [5, 0] }]);
  // Why the order can't name a corner: the upright at Q is "line>arc" unflipped, and "line>arc" is at P once flipped (the kernel
  // builds from the outline mirrored, which turns it round), so a name keeping that order would send Q's pin to P.
  const ordered = edgeAt(a.body, [5, 0, 5])!;
  assert.equal(edgeAt(b.body, [-5, 0, -5]), ordered);
  // The upright's middle, as a sketch on the flat side pins it, is named by the ends too, and stays at Q: (5, 0, ±5).
  const upright = a.body.view.edge_middles.findIndex((m) => m.every((c, k) => Math.abs(c - [5, 0, 5][k]) < 1e-9));
  const middle = { point: "m", kind: "midpoint" as const, name: a.body.names.ends![upright]! };
  assert.deepEqual(pinNow(middle, b.body.view, b.body.names, XY), { at: [5, 0] });
});

test("27b, hand-worked: a crescent whose arcs swap which bulges further keeps its corners' names", async () => {
  // Arc 1 from (5, 0) counter-clockwise round (0, 0) to (−5, 0): the upper half circle, radius 5, top at y = 5. Arc 2 from the
  // same (5, 0) to the same (−5, 0) round (0, −3): radius √34 ≈ 5.83, top at −3 + 5.83 = 2.83, inside arc 1: a crescent. Both
  // arcs start at (5, 0), so its corners are "arc 1's start with arc 2's start" and "both ends" at (−5, 0).
  const made = addSketch(partDocument("box", 40, 30, 20));
  let doc = drawArc(made.doc, made.id, [5, 0], [-5, 0], [0, 0]).doc;
  const [q, p] = doc.sketches.at(-1)!.points;
  const second = drawArc(doc, made.id, q.id, p.id, [0, -3]);
  doc = second.doc;
  const centre2 = doc.sketches.at(-1)!.points.at(-1)!.id;
  const [arc1, arc2] = doc.sketches.at(-1)!.curves.map((c) => `side:${c.id}`);
  doc = extrudeSketch(doc, made.id, 10).doc;
  const Q = [`end+${arc1}`, `end+${arc2}`, [`${arc1}@start`, `${arc2}@start`].sort().join("+")].sort().join("&");
  const P = [`end+${arc1}`, `end+${arc2}`, [`${arc1}@end`, `${arc2}@end`].sort().join("+")].sort().join("&");
  const before = (await built(doc)).body;
  assert.equal(named(before, Q), vertexAt(before.view, [5, 0, 10]));
  assert.equal(named(before, P), vertexAt(before.view, [-5, 0, 10]));
  // Arc 2's centre to (0, 3): radius √34 still, top at 3 + 5.83 = 8.83, now outside arc 1. The outline runs the other arc
  // backwards, so the kernel's order at each corner turns over; the names stay where they were.
  const after = (await built(movePoint(doc, made.id, centre2, 0, 3))).body;
  assert.equal(edgeAt(after, [5, 0, 5]), edgeAt(before, [-5, 0, 5]), "the order at Q is the order P had");
  assert.equal(named(after, Q), vertexAt(after.view, [5, 0, 10]));
  assert.equal(named(after, P), vertexAt(after.view, [-5, 0, 10]));
});

/** A triangle A (0, 0), B (20, 0), C (10, 10) on XY, lines AB, BC, CA drawn in that order, extruded 10. */
function triangleDoc() {
  const made = addSketch(partDocument("box", 40, 30, 20));
  let doc = drawLine(made.doc, made.id, [0, 0], [20, 0]).doc;
  let pts = doc.sketches.at(-1)!.points;
  doc = drawLine(doc, made.id, pts[1].id, [10, 10]).doc;
  pts = doc.sketches.at(-1)!.points;
  doc = drawLine(doc, made.id, pts[2].id, pts[0].id).doc;
  const [ab, bc] = doc.sketches.at(-1)!.curves.map((c) => `side:${c.id}`);
  const e = extrudeSketch(doc, made.id, 10);
  return { doc: e.doc, sketch: made.id, extrude: e.id, c: pts[2].id, ab, bc };
}

test("27b, hand-worked: a triangle turned over keeps its corners' names, with no second try", async () => {
  // B (20, 0) is where AB ends and BC starts. C dragged to (10, −10), across AB: the outline now runs every line backwards (the
  // kernel's order at every corner turns over), and B is still where AB ends and BC starts.
  const t = triangleDoc();
  const B = [`end+${t.ab}`, `end+${t.bc}`, `${t.ab}@end+${t.bc}@start`].sort().join("&");
  const before = (await built(t.doc)).body;
  assert.equal(named(before, B), vertexAt(before.view, [20, 0, 10]));
  const after = (await built(movePoint(t.doc, t.sketch, t.c, 10, -10))).body;
  assert.equal(edgeAt(after, [20, 0, 5]), `${t.bc}>${t.ab}`, "the order turned over");
  assert.equal(named(after, B), vertexAt(after.view, [20, 0, 10]));
});

test("27b, hand-worked: a file from 0.26, whose corner names leave the sides' order out, opens with its pins found; a half disc's old name stays ambiguous", async () => {
  // A sketch on the triangle's end cap (z = 10, XY's frame) with a circle round B (20, 0), pinned with 26f's name for B: the
  // upright between AB and BC written "AB+BC", sorted. Saved and opened, then the triangle made bigger: B to (30, 0).
  const t = triangleDoc();
  const face = addFaceSketch(t.doc, { plane: facePlane(t.extrude, "end"), feature: t.extrude }, drawnFrame([0, 0, 1], [10, 3, 10]));
  const old = [`end+${t.ab}`, `end+${t.bc}`, [t.ab, t.bc].sort().join("+")].sort().join("&");
  const circle = drawCircle(face.doc, face.id, [20, 0], 2).doc;
  const pinned = pinNewPoints(face.doc, circle, face.id, [{ at: [20, 0], kind: "endpoint", name: old }]);
  const save = (d: DesignDocument) => projectToJson({ ...emptyProject("0.26"), workspaces: { design: d } });
  const opened = projectFromJson(save(pinned), [{ id: "design", readData: readDesignDocument }]).workspaces.design as DesignDocument;
  assert.equal(opened.sketches.find((s) => s.id === face.id)!.pins![0].name, old, "the old name is kept as saved");
  const b = opened.sketches.find((s) => s.id === t.sketch)!.points[1].id;
  const r = (await built(movePoint(opened, t.sketch, b, 30, 0))).build.results[face.id] as { pinned?: { at: number[] }[]; points?: unknown };
  assert.equal(r.points, undefined);
  assert.deepEqual(r.pinned!.map((p) => p.at), [[30, 0]], "found at B, now (30, 0)");

  // 26f's name for a half disc's corner is both corners' (it was never offered, but a file could hold it): held, ambiguous.
  const h = halfDisc();
  const body = (await built(h.doc)).body;
  const sides = body.names.faces.filter((f): f is string => f !== null && f.startsWith("side:")).sort();
  const both = [`end+${sides[0]}`, `end+${sides[1]}`, `${sides[0]}+${sides[1]}`].sort().join("&");
  assert.deepEqual(pinNow({ point: "p", kind: "endpoint", name: both }, body.view, body.names, XY), { cause: "point-ambiguous" });
});

// ---------------------------------------------------------------- seeded

/** A sketch outline drawn curve by curve: each piece a line or an arc (counter-clockwise from `from` round `centre` to `to`), ends by corner number. */
interface Piece {
  kind: "line" | "arc";
  from: number;
  to: number;
  centre?: [number, number];
}
interface Shape {
  what: string;
  corners: [number, number][];
  pieces: Piece[];
}
/** Where a case is drawn: XY, or a face of the 40 × 30 × 20 box (`role`, its outward normal, a point on it). */
const FACES = [
  { role: "top", n: [0, 0, 1], p: [20, 15, 20] },
  { role: "bottom", n: [0, 0, -1], p: [20, 15, 0] },
  { role: "front", n: [0, -1, 0], p: [20, 0, 10] },
  { role: "right", n: [1, 0, 0], p: [40, 15, 10] },
] as const;

/**
 * A random outline, scaled by `s` and moved by `at`: a simple polygon of 3
 * to 6 corners drawn either way round; a half disc (its line drawn either
 * way, its arc on either side); a lens; a crescent; a slot (two lines and
 * two half circles); or a triangle with one side an arc bulging out or in
 * (the outline then runs the arc backwards).
 */
function randomShape(r: () => number, s: number, at: [number, number]): Shape {
  const P = (x: number, y: number): [number, number] => [at[0] + s * x, at[1] + s * y];
  const pick = Math.floor(r() * 6);
  if (pick === 0) {
    // Corners at increasing angles round (0, 0), radii 5 to 15: a star-shaped, so simple, polygon; drawn backwards half the time.
    const n = 3 + Math.floor(r() * 4);
    const angles = Array.from({ length: n }, (_, k) => ((k + 0.2 + 0.6 * r()) * 2 * Math.PI) / n);
    let corners = angles.map((a) => P(Math.round((5 + 10 * r()) * Math.cos(a)), Math.round((5 + 10 * r()) * Math.sin(a))));
    const cw = r() < 0.5;
    if (cw) corners = corners.reverse();
    return { what: cw ? "polygon drawn clockwise" : "polygon", corners, pieces: corners.map((_, k) => ({ kind: "line", from: k, to: (k + 1) % n })) };
  }
  const w = 4 + Math.round(8 * r());
  const corners = [P(-w, 0), P(w, 0)];
  if (pick === 1) {
    // Line between the two ends, either way; the arc round (0, c) over either side: from end 1 to end 0 bulges up, from 0 to 1 down.
    const c = Math.round(-w / 2 + w * r());
    const up = r() < 0.5;
    const line: Piece = r() < 0.5 ? { kind: "line", from: 0, to: 1 } : { kind: "line", from: 1, to: 0 };
    return { what: `half disc, line ${line.from}→${line.to}, arc ${up ? "up" : "down"}`, corners, pieces: [line, up ? { kind: "arc", from: 1, to: 0, centre: P(0, c) } : { kind: "arc", from: 0, to: 1, centre: P(0, c) }] };
  }
  if (pick === 2) {
    // A lens: one arc from end 0 to end 1 (bulging down), one from 1 to 0 (bulging up), centres off the line on the other side.
    return { what: "lens", corners, pieces: [{ kind: "arc", from: 0, to: 1, centre: P(0, 1 + Math.round(w * r())) }, { kind: "arc", from: 1, to: 0, centre: P(0, -1 - Math.round(w * r())) }] };
  }
  if (pick === 3) {
    // A crescent: both arcs from end 1 to end 0, so both bulge up, the one round the lower centre further; listed in either order.
    const c1 = -Math.round(w * r()) - 1;
    const c2 = c1 + 1 + Math.round(2 * w * r());
    const arcs: Piece[] = [{ kind: "arc", from: 1, to: 0, centre: P(0, c1) }, { kind: "arc", from: 1, to: 0, centre: P(0, c2) }];
    return { what: "crescent", corners, pieces: r() < 0.5 ? arcs : arcs.reverse() };
  }
  if (pick === 4) {
    // A slot: the bottom line 0→1, a half circle up round (w, h) to 2, the top line 2→3, a half circle round (−w, h) back to 0.
    const h = 2 + Math.round(4 * r());
    const slot = [P(-w, 0), P(w, 0), P(w, 2 * h), P(-w, 2 * h)];
    return { what: "slot", corners: slot, pieces: [{ kind: "line", from: 0, to: 1 }, { kind: "arc", from: 1, to: 2, centre: P(w, h) }, { kind: "line", from: 2, to: 3 }, { kind: "arc", from: 3, to: 0, centre: P(-w, h) }] };
  }
  // A triangle (−w, 0), (w, 0), (0, t) whose base is an arc: from 1 to 0 round (0, c > 0) it bulges in (run backwards), from 0 to 1 round (0, c < 0) out.
  const t = 2 * w;
  const tri = [P(-w, 0), P(w, 0), P(0, t)];
  const inward = r() < 0.5;
  const base: Piece = inward ? { kind: "arc", from: 1, to: 0, centre: P(0, -2 * w) } : { kind: "arc", from: 0, to: 1, centre: P(0, 2 * w) };
  // Inward: from (w, 0) counter-clockwise round (0, −2w) to (−w, 0) passes above the base, at y = √5 w − 2w ≈ 0.24 w, under the apex.
  return { what: inward ? "triangle, base arc in" : "triangle, base arc out", corners: tri, pieces: [base, { kind: "line", from: 1, to: 2 }, { kind: "line", from: 2, to: 0 }] };
}

/** `shape` drawn on a new sketch of the box document (on XY, or on a face of the box) and extruded `d`, flipped or not; the sketch's id and its curves' ids by piece, with the point ids by corner. */
function drawShape(shape: Shape, on: (typeof FACES)[number] | null, d: number, flip: boolean) {
  const box = partDocument("box", 40, 30, 20);
  const made = on === null ? addSketch(box) : addFaceSketch(box, { plane: facePlane("feature-1", on.role), feature: "feature-1" }, drawnFrame(on.n, on.p));
  let doc = made.doc;
  const ids: (string | undefined)[] = shape.corners.map(() => undefined);
  const end = (k: number) => ids[k] ?? shape.corners[k];
  const curves: string[] = [];
  for (const piece of shape.pieces) {
    const drawn = piece.kind === "line" ? drawLine(doc, made.id, end(piece.from), end(piece.to)) : drawArc(doc, made.id, end(piece.from), end(piece.to), piece.centre!);
    doc = drawn.doc;
    curves.push(drawn.id);
    const c = doc.sketches.find((s) => s.id === made.id)!.curves.find((x) => x.id === drawn.id)!;
    ids[piece.from] = (c as { start: string }).start;
    ids[piece.to] = (c as { end: string }).end;
  }
  const e = extrudeSketch(doc, made.id, d, flip);
  return { doc: e.doc, sketch: made.id, extrude: e.id };
}

/**
 * Checks every vertex of the case's body against where its name says it is,
 * the oracle being the sketch itself: each vertex has a name, no two the
 * same, and the ends its name gives (each "side:<curve>@start|end") are one
 * sketch point, the one the vertex lies over seen along the sketch's normal.
 * Returns whether the kernel turned the outline round to build it (it
 * builds counter-clockwise, from the outline mirrored when flipped), worked
 * out from the outline as built, to show both ways are reached.
 */
async function checkCase(shape: Shape, on: (typeof FACES)[number] | null, d: number, flip: boolean, scale: number) {
  const c = drawShape(shape, on, d, flip);
  const { body, build } = await built(c.doc);
  const plane = (build.results[c.sketch] as { placement: { plane: Parameters<typeof inSketch>[1] } }).placement.plane;
  const sketch = c.doc.sketches.find((s) => s.id === c.sketch)!;
  const point = (id: string) => sketch.points.find((p) => p.id === id)!;
  const { vertices, shared } = vertexNames(body.view, body.names);
  assert.equal(shared.size, 0, "no name two vertices would share");
  assert.equal(body.view.vertex_points.length, 2 * shape.pieces.length, "two vertices a piece");
  vertices.forEach((name, v) => {
    assert.ok(name !== null, `vertex ${v} has a name`);
    const ends = name.split("&").filter((part) => part.includes("@"));
    assert.equal(ends.length, 1, `one upright in ${name}`);
    const at = ends[0].split("+").map((e) => {
      const [face, which] = e.split("@");
      const curve = sketch.curves.find((x) => `side:${encodeURIComponent(x.id)}` === face)!;
      assert.ok(curve && curve.kind !== "circle" && (which === "start" || which === "end"), e);
      return point(which === "start" ? curve.start : curve.end);
    });
    const seen = inSketch(body.view.vertex_points[v], plane);
    const slack = 1e-9 * Math.max(1, ...seen.map(Math.abs)) + 1e-9 * scale;
    for (const p of at) assert.ok(Math.abs(p.x - seen[0]) <= slack && Math.abs(p.y - seen[1]) <= slack, `${name} names (${p.x}, ${p.y}) but the vertex is over (${seen})`);
  });
  const spec = (build.results[c.extrude] as { spec: { extrude: { profile: { outer: { path: Parameters<typeof twiceArea>[0] } } } } }).spec;
  return twiceArea(spec.extrude.profile.outer.path) > 0 === flip;
}

const CASES = Number(process.env.FISSION_SESSIONS ?? 100) * 3;
const SAVED = new URL("../test/regressions/half-disc/", import.meta.url);

/** One seeded case: its shape, where it is drawn, its distance, flip and scale. */
function caseOf(seed: bigint) {
  const random = seeded(seed);
  const r = () => random.next();
  const scale = [1, 1, 1, 0.01, 1000][Math.floor(r() * 5)];
  const far = r() < 0.2 ? [Math.round(400000 * (r() - 0.5)), Math.round(400000 * (r() - 0.5))] : [0, 0];
  const shape = randomShape(r, scale === 1000 ? 10 : scale, far as [number, number]);
  const on = r() < 0.5 ? null : FACES[Math.floor(r() * FACES.length)];
  const d = 1 + Math.round(29 * r());
  const flip = r() < 0.5;
  return { shape, on, d, flip, scale: scale === 1000 ? 10 : scale };
}

test(`seeded: ${CASES} outlines (polygons either way round, half discs, lenses, crescents, slots, arcs bulging in), flipped or not, on XY or a box's face: every corner's name says where it is`, async () => {
  const start = await kernel.call("body_count");
  const reached: Record<string, number> = {};
  const count = (k: string) => (reached[k] = (reached[k] ?? 0) + 1);
  for (let k = 0; k < CASES; k++) {
    const seed = BigInt(27000 + k);
    const c = caseOf(seed);
    try {
      const turned = await checkCase(c.shape, c.on, c.d, c.flip, c.scale);
      count(c.shape.what.split(",")[0].replace(" drawn clockwise", ""));
      if (c.shape.what.includes("clockwise")) count("clockwise");
      if (c.flip) count("flipped");
      if (c.on !== null) count(`face ${c.on.role}`);
      if (c.scale !== 1) count(`scale ${c.scale}`);
      count(turned ? "kernel order turned" : "kernel order as given");
    } catch (e) {
      // Saved for good (the CLAUDE.md rule), except while planted/run.ts plants a bug on purpose (FISSION_PLANTED).
      const words = `seed ${seed} (${c.shape.what}, ${c.on?.role ?? "XY"}, ${c.d}${c.flip ? " flipped" : ""}): ${e instanceof Error ? e.message : e}`;
      if (process.env.FISSION_PLANTED) assert.fail(words);
      mkdirSync(SAVED, { recursive: true });
      const file = new URL(`case-${seed}.json`, SAVED);
      writeFileSync(file, JSON.stringify({ seed: String(seed), ...c }, null, 1) + "\n");
      assert.fail(`${words}\nsaved in ${file.pathname}`);
    }
  }
  assert.equal(await kernel.call("body_count"), start, "every body freed");
  if (CASES >= 300)
    for (const key of ["polygon", "clockwise", "half disc", "lens", "crescent", "slot", "triangle", "flipped", "face top", "face bottom", "face front", "face right", "scale 0.01", "scale 10", "kernel order turned", "kernel order as given"])
      assert.ok((reached[key] ?? 0) >= 5, `${key} reached ${reached[key] ?? 0} times: ${JSON.stringify(reached)}`);
});

test("saved cases replay", { skip: !existsSync(SAVED) && "none saved yet" }, async () => {
  for (const file of readdirSync(SAVED).filter((f) => f.endsWith(".json"))) {
    const c = JSON.parse(readFileSync(new URL(file, SAVED), "utf8"));
    await checkCase(c.shape, c.on, c.d, c.flip, c.scale);
  }
});
