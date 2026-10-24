// Projected edges (step 27d, the Project tool; the naming model's rules 12
// and 13, Fusion's projected geometry as the harness reads it): an edge of
// a body built before a sketch, seen straight along the sketch's normal,
// taken into the sketch as a curve of its own that stays linked to the
// edge. On every rebuild each projection goes where its edge is now (so
// what is built from the sketch follows the body); one whose edge is gone,
// or whose name is now two edges', stays where it was and the sketch warns
// "projection lost" naming it, never moved onto a guess (the owner's rule
// for 25a). Projecting an edge the sketch already holds adds nothing.
//
// What an edge becomes, seen along the normal n of the sketch (`edgeShape`):
// - a straight edge, the segment between its two ends seen from the sketch,
//   or a single point when those are one place (within LINEAR, the kernel's
//   10 nm: an upright edge seen end on). A segment shorter than the
//   kernel's smallest line (MIN_LENGTH, 1 µm) and longer than LINEAR is
//   neither, and is refused in words.
// - a round edge (a circle or an arc, radius r, round the axis m) in a
//   plane parallel to the sketch's, a circle or an arc of the same radius;
//   one in a plane square to the sketch's (seen edge on), the segment it
//   covers, at most 2r long. Seen along n, a circle of radius r whose axis
//   makes the angle θ with n is an ellipse with half axes r and r·|cos θ|:
//   it is the circle to within LINEAR when r(1 − |cos θ|) ≤ LINEAR, and the
//   segment when r·|cos θ| ≤ LINEAR. Anything between is an ellipse, which
//   sketches don't have yet: refused in words (a tracked compromise, to go
//   when sketches get ellipses). 1 − |cos θ| is worked out as
//   |m × n|² / (1 + |m · n|), which loses nothing to cancellation near 1.
//
// A projection's curve (or its point, for an edge seen end on) is a sketch
// curve like any other: drawn (in a colour of its own), snapped to, and
// part of the outline when it joins the sketch's own curves end to end
// (`profileCurves`): a closed loop of projected lines extrudes, and a
// projected edge used only to snap to never breaks the sketch's outline.
// It is never dragged (sketch.ts `movePoint` refuses its points) and is
// deleted only whole (`unproject`; deleting its curve does the same).
// Each projection has points of its own, never shared with another's, so
// one held while the next follows can't pull it.
//
// An edge is named as a vertex's name names it (face-edges.ts `partName`):
// an edge between two sides by which end of each side's curve meets there
// (27b), any other by its two faces without their order ("end+side:line-6"),
// which a flipped extrude turns over without the edge being any other.

import type { BodyView, Plane, SketchXY, StableId } from "@fission/core";
import type { DesignDocument, Sketch, SketchCurve, SketchPoint } from "./document.ts";
import { inSketch, partName, unordered, vertexNames } from "./face-edges.ts";
import { faceReference, isFacePlane } from "./face-sketch.ts";
import type { BodyNames } from "./naming.ts";
import { sharedBy } from "./references.ts";
import { findInScene, sceneHit, type Scene } from "./scene.ts";
import type { EdgeToProject } from "./sketch.ts";
import { SAME_PLACE } from "./snap.ts";

/**
 * An edge of a body projected into a sketch (kept in the sketch's content,
 * document.ts `Sketch.projected`): its id ("projection-9", from the
 * counter), the feature whose body the edge is on, the edge's name there
 * (the part after "edge:<feature>/"), and what it made in the sketch: a
 * curve's id (a line, a circle or an arc), or a point's for an edge seen
 * end on.
 */
export interface SketchProjection {
  id: string;
  feature: string;
  edge: string;
  made: string;
}

/** The shortest line the kernel takes in a sketch (kernel/src/tolerance.rs MIN_FEATURE, 1 µm). */
export const MIN_LENGTH = 1e-3;

/** What an edge is seen as from a sketch, in the sketch's (x, y): a point, a line from `a` to `b`, a circle, or an arc counter-clockwise from `start` to `end`. */
export type EdgeShape =
  | { kind: "point"; at: SketchXY }
  | { kind: "line"; a: SketchXY; b: SketchXY }
  | { kind: "circle"; centre: SketchXY; radius: number }
  | { kind: "arc"; start: SketchXY; end: SketchXY; centre: SketchXY };

/** Why an edge can't be projected: too short a line seen from the sketch, a round edge slanted to it (an ellipse), or a curve this SpindleLabs doesn't know. */
export type EdgeRefusal = { refused: "short" | "slanted" | "unknown"; message: string };

/** The words for each refusal. */
export const REFUSED = {
  short: "Seen from the sketch this edge is shorter than 0.001 mm, the shortest line a sketch holds, and longer than a point: it can't be projected.",
  slanted: "This round edge is slanted to the sketch: seen from it, it is an ellipse, which sketches can't hold yet. Project it into a sketch on a plane parallel to it, or square to it.",
  unknown: "This edge is a kind of curve that can't be projected yet.",
} as const;

type Vec3 = readonly [number, number, number];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = (a: Vec3) => Math.sqrt(dot(a, a));
const unit = (a: Vec3): Vec3 | null => {
  const l = length(a);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : null;
};
const between = (a: SketchXY, b: SketchXY) => Math.sqrt((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2);

/** How far point `p` is from the sketch's plane, along its normal. */
const off = (p: Vec3, plane: Plane) => Math.abs(dot(sub(p, plane.origin), plane.normal));

/**
 * The segment from `a` to `b` in the sketch: a point when they are one
 * place (`at`, the point the caller chose for it), refused when shorter
 * than MIN_LENGTH, else a line.
 */
function segment(a: SketchXY, b: SketchXY, at: SketchXY): EdgeShape | EdgeRefusal {
  const l = between(a, b);
  if (l <= SAME_PLACE) return { kind: "point", at };
  if (l < MIN_LENGTH) return { refused: "short", message: REFUSED.short };
  return { kind: "line", a, b };
}

/**
 * A round edge's axis, a unit vector (its sign doesn't matter): a flat
 * face it lies on (the face's plane holds the edge, so its normal is the
 * axis: an extrude's cap); else, for an arc, its two radii to its start
 * and its middle crossed; else the direction from its centre to the
 * centroid of a face it bounds (every face round a circle's axis has its
 * centroid on the axis: a sphere's halves); null when none tells.
 */
function roundAxis(view: BodyView, e: number, centre: Vec3, closed: boolean): Vec3 | null {
  const faces = view.edge_faces[e] ?? [];
  for (const f of faces) {
    const n = view.face_normals[f];
    if (n) return unit(n);
  }
  if (!closed) {
    const n = unit(cross(sub(view.vertex_points[view.edge_vertices[e][0]], centre), sub(view.edge_middles[e], centre)));
    if (n) return n;
  }
  for (const f of faces) {
    const d = sub(view.face_centroids[f], centre);
    if (length(d) > SAME_PLACE) return unit(d);
  }
  return null;
}

/** The angle a turn needs to go counter-clockwise from `from` to `to`, in (0, 2π]. */
function turn(from: number, to: number): number {
  let t = to - from;
  while (t <= 0) t += 2 * Math.PI;
  while (t > 2 * Math.PI) t -= 2 * Math.PI;
  return t;
}

/**
 * Straight edge `e`'s two vertices in the order of their names (`corners`,
 * face-edges.ts `vertexNames`: a corner's name, as a pin names it), the
 * first name first; null when it is not straight, a name is unknown or
 * both are one. The kernel runs an edge whichever way its face's loop
 * goes, which a flipped extrude turns over, so its own order would swap a
 * projected line's ends, and a line drawn from one end would jump to the
 * other (found by 27e); the names don't change with it.
 */
export function cornerOrder(view: BodyView, e: number, corners: readonly (string | null)[] | undefined): readonly [number, number] | null {
  const [v0, v1] = view.edge_vertices[e];
  const [n0, n1] = [corners?.[v0], corners?.[v1]];
  if (view.edge_types[e] !== "line" || !n0 || !n1 || n0 === n1) return null;
  return n0 < n1 ? [v0, v1] : [v1, v0];
}

/**
 * Edge `e` of a body (its kernel view) seen straight along the normal of a
 * sketch through `plane`, in the sketch's (x, y), or why it can't be
 * projected (the module comment's rules). Ends, middles and centres come
 * from the kernel's exact vertex_points, edge_middles and edge_centres,
 * placed through the frame by `inSketch`, as a pin's are, so a projected
 * corner is exactly where a snap onto that corner lands. A straight edge's
 * line runs from the end whose corner's name (`corners`) comes first
 * (`cornerOrder`), the kernel's order when those aren't known.
 */
export function edgeShape(view: BodyView, e: number, plane: Plane, corners?: readonly (string | null)[]): EdgeShape | EdgeRefusal {
  const [v0, v1] = cornerOrder(view, e, corners) ?? view.edge_vertices[e];
  const s3 = view.vertex_points[v0];
  const e3 = view.vertex_points[v1];
  const type = view.edge_types[e];
  if (type === "line") {
    // Seen end on: the end nearer the sketch's plane (the one a pin there would take first, face-edges.ts).
    const [a, b] = [inSketch(s3, plane), inSketch(e3, plane)];
    return segment(a, b, off(s3, plane) <= off(e3, plane) ? a : b);
  }
  const c3 = view.edge_centres[e];
  if (type !== "circle" || !c3) return { refused: "unknown", message: REFUSED.unknown };
  const closed = v0 === v1;
  const r = closed ? length(sub(s3, c3)) : (length(sub(s3, c3)) + length(sub(e3, c3))) / 2;
  const axis = roundAxis(view, e, c3, closed);
  const n = unit(plane.normal);
  if (axis === null || n === null) return { refused: "unknown", message: REFUSED.unknown };
  const cos = Math.abs(dot(axis, n));
  const sin2 = dot(cross(axis, n), cross(axis, n));
  const centre = inSketch(c3, plane);
  if ((r * sin2) / (1 + cos) <= SAME_PLACE) {
    // Parallel: the same circle, or the same arc turned to run counter-clockwise in the sketch.
    if (closed) return { kind: "circle", centre, radius: r };
    const [s, m, t] = [inSketch(s3, plane), inSketch(view.edge_middles[e], plane), inSketch(e3, plane)];
    const angle = (p: SketchXY) => Math.atan2(p[1] - centre[1], p[0] - centre[0]);
    const ccw = turn(angle(s), angle(m)) < turn(angle(s), angle(t));
    return ccw ? { kind: "arc", start: s, end: t, centre } : { kind: "arc", start: t, end: s, centre };
  }
  if (r * cos > SAME_PLACE) return { refused: "slanted", message: REFUSED.slanted };
  // Seen edge on: along d = axis × n, which lies in the edge's plane and the sketch's. A point p of the edge is seen at
  // (p − centre) · d along it; a whole circle covers −r to r, an arc its ends' and, where it passes them, ±r.
  const d = unit(cross(axis, n))!;
  const along = (p: Vec3) => dot(sub(p, c3), d);
  let lo = -r;
  let hi = r;
  if (!closed) {
    const w = cross(axis, d);
    const angle = (p: Vec3) => Math.atan2(dot(sub(p, c3), w), along(p));
    const [as, am, ae] = [angle(s3), angle(view.edge_middles[e]), angle(e3)];
    // The arc counter-clockwise (about the axis) from `first` through `sweep`.
    const [first, sweep] = turn(as, am) < turn(as, ae) ? [as, turn(as, ae)] : [ae, turn(ae, as)];
    // `a` on the arc: within the sweep from its first end (a turn of 2π back to that end itself is no turn).
    const passes = (a: number) => turn(first, a) <= sweep || turn(first, a) === 2 * Math.PI;
    lo = Math.min(along(s3), along(e3));
    hi = Math.max(along(s3), along(e3));
    if (passes(0)) hi = r;
    if (passes(Math.PI)) lo = -r;
  }
  const d2: SketchXY = [dot(d, plane.xAxis), dot(d, cross(plane.normal, plane.xAxis))];
  const at = (k: number): SketchXY => [centre[0] + k * d2[0] + 0, centre[1] + k * d2[1] + 0];
  return segment(at(lo), at(hi), at((lo + hi) / 2));
}

/** Edge `e`'s name for a projection (face-edges.ts `partName`): by the ends of its sides' curves when known (27b), else its two faces with no order; null when it has none. */
export const edgeName = (names: BodyNames, e: number): string | null => partName(names, e);

/** The edge named `name` on a body now, or why there is none: no edge has it, or two or more would. */
export function edgeNamed(names: BodyNames, count: number, name: string): { edge: number } | { cause: "projection-lost" | "projection-ambiguous" } {
  const found: number[] = [];
  for (let e = 0; e < count; e++) if (edgeName(names, e) === name) found.push(e);
  if (found.length === 1) return { edge: found[0] };
  // Two or more edges have it, or would have (names.ts drops a name two edges share, ordered or not).
  const shared = found.length > 1 || sharedBy({ kind: "edge", id: `edge:${names.feature}/${name}` as StableId }, names) > 1 || [...names.shared.edges].some(([k, n]) => n > 1 && unordered(k) === name);
  return { cause: shared ? "projection-ambiguous" : "projection-lost" };
}

/** What a projection made, as a shape's kind: "point" for a point, else its curve's kind; null when it names neither (a broken file is refused before this). */
export function madeKind(sketch: Pick<Sketch, "points" | "curves">, p: SketchProjection): EdgeShape["kind"] | null {
  const curve = sketch.curves.find((c) => c.id === p.made);
  if (curve) return curve.kind;
  return sketch.points.some((q) => q.id === p.made) ? "point" : null;
}

/** The points a projection made: its point, or its curve's points (a line's ends, a circle's centre, an arc's ends and centre). */
export function madePoints(sketch: Pick<Sketch, "curves">, p: SketchProjection): string[] {
  const c = sketch.curves.find((x) => x.id === p.made);
  if (!c) return [p.made];
  return c.kind === "line" ? [c.start, c.end] : c.kind === "circle" ? [c.centre] : [c.start, c.end, c.centre];
}

/**
 * Where a projection's points go for `shape`, by id, and a circle's
 * radius: in the order its curve names them. A line's ends go in the
 * shape's order when it is by its corners' names (`named`, `cornerOrder`);
 * else (a round edge seen edge on, whose ends are no corners, or corners
 * with no names) each end goes to whichever of the two places moves the
 * line's points less, the sum of their squared moves (a line slid along
 * itself keeps its order, since (t + L)² + (t − L)² > 2t²; the shape's
 * order on a tie), so a line drawn from one end is never swung onto the
 * other because the kernel runs the edge the other way now.
 */
export function placesOf(sketch: Pick<Sketch, "points" | "curves">, p: SketchProjection, shape: EdgeShape, named = false): { points: { point: string; at: SketchXY }[]; radius?: number } {
  const c = sketch.curves.find((x) => x.id === p.made);
  if (shape.kind === "point" || !c) return { points: shape.kind === "point" ? [{ point: p.made, at: shape.at }] : [] };
  if (shape.kind === "line" && c.kind === "line") {
    const [s, t] = [c.start, c.end].map((id) => sketch.points.find((q) => q.id === id));
    const moved = (a: SketchXY, b: SketchXY) => (s && t ? (s.x - a[0]) ** 2 + (s.y - a[1]) ** 2 + (t.x - b[0]) ** 2 + (t.y - b[1]) ** 2 : 0);
    const [a, b] = named || moved(shape.a, shape.b) <= moved(shape.b, shape.a) ? [shape.a, shape.b] : [shape.b, shape.a];
    return { points: [{ point: c.start, at: a }, { point: c.end, at: b }] };
  }
  if (shape.kind === "circle" && c.kind === "circle") return { points: [{ point: c.centre, at: shape.centre }], radius: shape.radius };
  if (shape.kind === "arc" && c.kind === "arc") return { points: [{ point: c.start, at: shape.start }, { point: c.end, at: shape.end }, { point: c.centre, at: shape.centre }] };
  return { points: [] };
}

/**
 * The curves a sketch's outline is made of (what the kernel's
 * sketch_outline is asked about): its own curves, with every projected
 * curve joined to them end to end (through ends within SAME_PLACE, the
 * kernel's LINEAR, as the kernel joins ends); a sketch with no curves of
 * its own, its projected ones. Then, again and again, a projected line or
 * arc with an end that meets no other curve's end is left out: a
 * projected edge used to snap to, or one of a face's edges a drawn line
 * doesn't close, never breaks the outline. Before all that, a projected
 * curve lying on one kept already (`onCurve`; the sketch's own first) is
 * left out (27e). A projected circle joins only a
 * sketch with no curves of its own (it has no ends to join by). In the
 * sketch's order. The sketch's own curves when it has no projections.
 */
export function profileCurves(sketch: { points: readonly SketchPoint[]; curves: readonly SketchCurve[]; projected?: readonly SketchProjection[] }): SketchCurve[] {
  if (!sketch.projected || sketch.projected.length === 0) return [...sketch.curves];
  const projected = new Set(sketch.projected.map((p) => p.made));
  const where = new Map(sketch.points.map((p) => [p.id, [p.x, p.y] as const]));
  // A projected curve on one already kept (the sketch's own first, then the projected in order) adds nothing (27e).
  const kept: SketchCurve[] = sketch.curves.filter((c) => !projected.has(c.id));
  for (const c of sketch.curves) if (projected.has(c.id) && !kept.some((k) => onCurve(c, k, where))) kept.push(c);
  const curves = sketch.curves.filter((c) => kept.includes(c));
  // Each line's and arc's two ends (end 2k, 2k + 1 of curve k), joined where they are within SAME_PLACE.
  const ends: { curve: number; at: readonly [number, number] }[] = [];
  curves.forEach((c, k) => {
    if (c.kind !== "circle") for (const p of [c.start, c.end]) ends.push({ curve: k, at: where.get(p)! });
  });
  const order = ends.map((_, i) => i).sort((i, j) => ends[i].at[0] - ends[j].at[0]);
  const meets: number[][] = ends.map(() => []);
  for (let a = 0; a < order.length; a++) {
    const p = ends[order[a]];
    for (let b = a + 1; b < order.length; b++) {
      const q = ends[order[b]];
      if (q.at[0] - p.at[0] > SAME_PLACE) break;
      if (Math.sqrt((q.at[0] - p.at[0]) ** 2 + (q.at[1] - p.at[1]) ** 2) <= SAME_PLACE) {
        meets[order[a]].push(order[b]);
        meets[order[b]].push(order[a]);
      }
    }
  }
  // Which curves are joined to the sketch's own (or all of them, with none of its own).
  const own = curves.some((c) => !projected.has(c.id));
  const joined = new Set<number>();
  const queue: number[] = [];
  curves.forEach((c, k) => {
    if (!own || !projected.has(c.id)) (joined.add(k), queue.push(k));
  });
  const endsOf = new Map<number, number[]>();
  ends.forEach((x, i) => endsOf.set(x.curve, [...(endsOf.get(x.curve) ?? []), i]));
  while (queue.length > 0) {
    const k = queue.pop()!;
    for (const i of endsOf.get(k) ?? [])
      for (const j of meets[i])
        if (!joined.has(ends[j].curve)) (joined.add(ends[j].curve), queue.push(ends[j].curve));
  }
  // Projected lines and arcs with a free end, left out until none is left.
  const free = (k: number) => (endsOf.get(k) ?? []).some((i) => !meets[i].some((j) => joined.has(ends[j].curve) && ends[j].curve !== k));
  let changed = true;
  while (changed) {
    changed = false;
    for (const k of joined)
      if (projected.has(curves[k].id) && curves[k].kind !== "circle" && free(k)) {
        joined.delete(k);
        changed = true;
      }
  }
  return curves.filter((_, k) => joined.has(k));
}

/**
 * Whether curve `c` lies on curve `k` (27e): the same kind, and each of its
 * points within SAME_PLACE of the matching one of `k` (a line's ends
 * either way round; an arc's start, end and centre, since one with its
 * ends the other way round is the rest of the circle; a circle's centre,
 * and its radius within SAME_PLACE). The kernel joins ends within LINEAR,
 * so two such curves would be one edge drawn twice: a sketch's own line
 * traced over a projected one, a face projected with the one under it, or
 * a face seen edge on (its top and bottom edges one line), which made
 * every corner of the outline four ends and the kernel refuse it.
 */
function onCurve(c: SketchCurve, k: SketchCurve, where: ReadonlyMap<string, readonly [number, number]>): boolean {
  const at = (p: string) => where.get(p)!;
  const same = (p: string, q: string) => Math.hypot(at(p)[0] - at(q)[0], at(p)[1] - at(q)[1]) <= SAME_PLACE;
  if (c.kind === "line" && k.kind === "line") return (same(c.start, k.start) && same(c.end, k.end)) || (same(c.start, k.end) && same(c.end, k.start));
  if (c.kind === "arc" && k.kind === "arc") return same(c.start, k.start) && same(c.end, k.end) && same(c.centre, k.centre);
  if (c.kind === "circle" && k.kind === "circle") return same(c.centre, k.centre) && Math.abs(c.radius - k.radius) <= SAME_PLACE;
  return false;
}

/** Why a sketch of only projected curves has no outline (27e: the kernel, asked about no curves at all, said the sketch had none yet). */
export const PROJECTED_OPEN = "its projected edges don't close an outline (a projected line or arc counts only where both its ends meet another curve), and it has no curves of its own";

/** The words for a sketch whose curves are all projected and none joins the outline (`profileCurves` empty), else null: the kernel judges. */
export function projectedOpen(sketch: { points: readonly SketchPoint[]; curves: readonly SketchCurve[]; projected?: readonly SketchProjection[] }): string | null {
  return sketch.curves.length > 0 && profileCurves(sketch).length === 0 ? PROJECTED_OPEN : null;
}

/** Why a projection is held where it was: its edge is gone, now seen as something else (or slanted), or its name is now two edges'. */
export type HeldCause = "projection-lost" | "projection-changed" | "projection-ambiguous";

/** Why a sketch's projections are held (rule 12): "projection-lost" when any lost or changed its edge, else "projection-ambiguous"; which, by id in the sketch's order; and the words. */
export interface ProjectionWarning {
  cause: "projection-lost" | "projection-ambiguous";
  projections: string[];
  message: string;
}

/** The warning for a sketch whose projections `held` are held, in words for each cause, named by what they made ("line-12"). */
export function projectionWords(held: readonly { id: string; cause: HeldCause }[], sketch: Pick<Sketch, "projected">, sketchLabel: string): ProjectionWarning {
  const order = new Map((sketch.projected ?? []).map((p, k) => [p.id, k]));
  const ids = held.map((h) => h.id).sort((a, b) => order.get(a)! - order.get(b)!);
  const why: Record<HeldCause, [string, string]> = {
    "projection-lost": ["has lost its edge", "have lost their edges"],
    "projection-changed": ["is on an edge the sketch now sees as another kind of curve", "are on edges the sketch now sees as other kinds of curve"],
    "projection-ambiguous": ["is on an edge that is now more than one edge", "are on edges that are now more than one edge"],
  };
  const words = (["projection-lost", "projection-changed", "projection-ambiguous"] as const).flatMap((c) => {
    const n = held.filter((h) => h.cause === c).length;
    if (n === 0) return [];
    const one = n === 1;
    return [`${one ? "a projected edge" : `${n} projected edges`} ${why[c][one ? 0 : 1]}, so ${one ? "it stays where it was" : "they stay where they were"}${c === "projection-ambiguous" ? " rather than guess" : ""}`];
  });
  const lost = held.some((h) => h.cause !== "projection-ambiguous");
  return { cause: lost ? "projection-lost" : "projection-ambiguous", projections: ids, message: `${sketchLabel}: ${words.join(", and ")}` };
}

/** What a click with the Project tool over nothing says. */
export const PROJECT_NOTHING = "Click an edge or a face of a body to project it into the sketch.";
/** What it says in a sketch whose face is lost (held: it follows nothing, so it can't follow an edge either). */
export const PROJECT_HELD = "This sketch's face is lost, so nothing can be projected into it until its face is found again.";
/** What it says on an edge or face whose name another shares (a projection could not follow it). */
export const PROJECT_UNNAMED = "This edge has no name of its own (another edge shares it), so a projection of it could not follow it.";
/** What it says when everything picked is in the sketch already (rule 12: projecting again adds nothing). */
export const PROJECT_AGAIN = "That is projected into this sketch already: projecting it again adds nothing.";

/** What a body after the sketch says: only what is before a sketch can be projected (rule 13). */
export const projectAfter = (label: string, sketchLabel: string) => `${label} comes after ${sketchLabel} in the timeline: only bodies before a sketch can be projected into it.`;

/**
 * What a click with the Project tool on sketch `sketchId` takes (rules 12
 * and 13), from what the viewport says is under the pointer on the bodies
 * shown (`scene`; joined indices): the edge there, else every edge of the
 * face there, each with its name and what it is seen as through `plane`
 * (the frame the last rebuild placed the sketch in), on the body of a
 * feature before the sketch. `note` says why nothing (or not everything)
 * was taken: nothing under the pointer, a body after the sketch, a sketch
 * whose face is lost, an edge with no name of its own, or what
 * `edgeShape` refuses (on a face, its edges that can be are taken and the
 * note says how many were left out and why).
 */
export function projectPick(doc: DesignDocument, sketchId: string, scene: Scene | null, plane: Plane | undefined, under: { edge?: number | null; face?: number | null }): { edges: EdgeToProject[]; note: string | null } {
  const features = doc.timeline.features;
  const at = features.findIndex((f) => f.id === sketchId);
  const item = features[at];
  if (scene === null || plane === undefined || item === undefined) return { edges: [], note: PROJECT_NOTHING };
  const facePlane = item.intent.parameters.plane;
  if (isFacePlane(facePlane) && findInScene(faceReference(facePlane), scene).status !== "found") return { edges: [], note: PROJECT_HELD };
  const kind = under.edge != null ? "edge" : under.face != null ? "face" : null;
  const hit = kind === null ? null : sceneHit(scene, kind, (kind === "edge" ? under.edge : under.face)!);
  if (hit === null) return { edges: [], note: PROJECT_NOTHING };
  const body = scene.bodies[hit.body];
  const on = features.findIndex((f) => f.id === body.feature);
  if (on < 0 || on > at) return { edges: [], note: projectAfter(features[on]?.provenance.self.label ?? body.feature, item.provenance.self.label) };
  const picked = kind === "edge" ? [hit.index] : body.view.edge_faces.flatMap((pair, e) => (pair !== null && (pair[0] === hit.index || pair[1] === hit.index) ? [e] : []));
  const edges: EdgeToProject[] = [];
  const refused: string[] = [];
  const corners = vertexNames(body.view, body.names).vertices;
  for (const e of picked) {
    const name = edgeName(body.names, e);
    const shape = edgeShape(body.view, e, plane, corners);
    if (name === null) refused.push(PROJECT_UNNAMED);
    else if ("refused" in shape) refused.push(shape.message);
    else edges.push({ feature: body.feature, edge: name, shape });
  }
  if (refused.length === 0) return { edges, note: null };
  if (kind === "edge") return { edges, note: refused[0] };
  const n = refused.length;
  const reasons = [...new Set(refused)].join(" ");
  return { edges, note: n === picked.length ? `None of this face's edges could be projected: ${reasons}` : `${n} of this face's ${picked.length} edges ${n === 1 ? "was" : "were"} left out: ${reasons}` };
}
