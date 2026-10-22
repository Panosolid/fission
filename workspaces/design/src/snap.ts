// Sketch snapping: where a click on the sketch plane lands, before the
// sketch constraints (29) exist. The kernel first rounds the pointer
// (`rounding`): placed freely where you click by default (place_freely,
// within half a pixel), or to the grid with grid snap on (snap_to_grid).
// This then lets nearby sketch geometry win over that point, as pure
// functions every tool shares (the "grid" snap below is that rounded
// point, free or on the grid):
//
// 1. A point: within SNAP_PIXELS on screen of a sketch point (a line's or
//    arc's end, a circle's or arc's centre) or a line's midpoint, the
//    nearest one is taken, its coordinates exactly, so a click there
//    shares the point (pointAt compares coordinates exactly).
// 2. Lining up: otherwise, within SNAP_PIXELS of a point's column (same x)
//    or row (same y), that coordinate is the point's exactly and the other
//    stays the rounded one. Lining up with the tool's own clicks is how a
//    line snaps horizontal or vertical.
// 3. Otherwise the rounded point.
//
// From step 26f a sketch on a face snaps in the same way (1 only) to the
// ends, middles and centres of that face's edges (face-edges.ts), which are
// not drawn into the sketch; a point that lands on one is pinned to it
// (sketch.ts `pinNewPoints`) and follows it. From step 27c a sketch on any
// plane or face snaps to every edge of every body before it, seen along its
// normal, so several points can land on one place (a box's top corner, the
// bottom corner under it, the upright's middle between): of the points
// within SAME_PLACE of the nearest, the first listed is taken (the sketch's
// own, then the one on the sketch's plane: face-edges.ts orders them), so
// which one a click pins never turns on the last bit of rounding.
//
// Snapping is only where the click lands: nothing is remembered as a rule
// (a line drawn horizontal is not kept horizontal); that is what the
// constraints of step 29 add. The reach is in screen pixels, turned into mm
// by the size of a pixel on the plane at the pointer (SketchPointer.pixel),
// so it feels the same at any zoom. It is a pick radius, not a geometric
// tolerance: nothing is judged equal by it (SAME_PLACE is what is).

import type { SketchDrawing, SketchXY } from "@fission/core";
import type { DesignDocument, Sketch } from "./document.ts";
import type { EdgeTarget } from "./face-edges.ts";
import type { SketchTool } from "./sketch-tool.ts";

/** How near on screen (px) the pointer must come to a point, or to a point's column or row, to snap to it. */
export const SNAP_PIXELS = 10;

/**
 * Points this close (mm) are one place for snapping (step 27c): the
 * kernel's linear tolerance (kernel/src/tolerance.rs LINEAR, 10 nm), the
 * distance below which it takes two points to be one. A body's points
 * seen along a sketch's normal that differ by less are one point rounded
 * two ways (an upright edge seen end on from a slanted face).
 */
export const SAME_PLACE = 1e-5;

/** What a snapped-to point is: an end of a line or arc, a line's midpoint, or the centre of a circle or arc (and no line's or arc's end). */
export type PointKind = "endpoint" | "midpoint" | "centre";

export interface SnapTarget {
  at: SketchXY;
  kind: PointKind;
  /** On a body's edges, not the sketch's own (26f; any body before the sketch from 27c): a point landing here is pinned to it (`pin`). */
  pin?: EdgeTarget;
}

/** What the pointer may snap to on one sketch for one tool. */
export interface SnapTargets {
  points: SnapTarget[];
  /** Points whose column (x) the pointer may line up with: a vertical guide from them. */
  columns: SketchXY[];
  /** Points whose row (y) the pointer may line up with: a horizontal guide from them. */
  rows: SketchXY[];
  /** The tool's own clicks so far, never landed on by lining up (a click there draws nothing). */
  own: SketchXY[];
}

/** Where the pointer landed and why: on the grid, on a point, or lined up with a point's column, row or both. */
export type Snap =
  | { kind: "grid"; at: SketchXY }
  /** `edge`: a point of the face's edges (26f), not of the sketch. */
  | { kind: PointKind; at: SketchXY; edge?: true }
  | { kind: "aligned"; at: SketchXY; column: SketchXY | null; row: SketchXY | null };

const same = (a: SketchXY, b: SketchXY) => a[0] === b[0] && a[1] === b[1];

/** The tool's own clicks so far (a chain's last point, a first corner, a centre, an arc's start and end, a centre arc's centre and start, a tangent arc's start); none before them. A kind it does not know has none. */
function ownClicks(sketch: Sketch, tool: SketchTool): SketchXY[] {
  if (tool.kind === "line") {
    if (tool.from === null) return [];
    if (typeof tool.from !== "string") return [tool.from];
    const p = sketch.points.find((x) => x.id === tool.from);
    return p ? [[p.x, p.y]] : [];
  }
  if (tool.kind === "arc") return [tool.start, tool.end].filter((p) => p !== null);
  if (tool.kind === "centre") return [tool.centre, tool.start].filter((p) => p !== null);
  if (tool.kind === "tangent") {
    const p = sketch.points.find((x) => x.id === tool.from);
    return p ? [[p.x, p.y]] : [];
  }
  const at = tool.kind === "rectangle" ? tool.corner : tool.kind === "circle" ? tool.centre : null;
  return at ? [at] : [];
}

/**
 * What the pointer may snap to on `sketch` while `tool` is used. Points:
 * every sketch point, then every line's midpoint ((a + b) / 2), then
 * (26f) `edges`, the ends, middles and centres of the edges of the face
 * the sketch is on (face-edges.ts; never a column or row), leaving
 * out the tool's own clicks: a click there draws nothing (an arc's end on
 * its start, its third point on an end). Columns and rows: every sketch
 * point and the tool's own clicks (lining up with one is horizontal or
 * vertical), except for the rectangle, where a
 * second corner on the first corner's column or row draws nothing, so
 * neither the first corner nor any point on its column (or row) is
 * offered as a column (or row).
 */
export function snapTargets(sketch: Sketch, tool: SketchTool, edges: readonly EdgeTarget[] = []): SnapTargets {
  const own = ownClicks(sketch, tool);
  const isEnd = new Set(sketch.curves.flatMap((c) => (c.kind === "circle" ? [] : [c.start, c.end])));
  const at = new Map(sketch.points.map((p) => [p.id, [p.x, p.y] as SketchXY]));
  const points: SnapTarget[] = sketch.points.map((p) => ({ at: [p.x, p.y], kind: isEnd.has(p.id) ? "endpoint" : "centre" }));
  for (const c of sketch.curves) {
    if (c.kind !== "line") continue;
    const a = at.get(c.start)!;
    const b = at.get(c.end)!;
    points.push({ at: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], kind: "midpoint" });
  }
  // The face's edges (26f) after the sketch's own points, so where both are at one spot the click shares the sketch's point.
  for (const e of edges) points.push({ at: e.at, kind: e.kind, pin: e });
  const refs: SketchXY[] = sketch.points.map((p) => [p.x, p.y]);
  for (const o of own) if (!refs.some((r) => same(r, o))) refs.push(o);
  const corner = tool.kind === "rectangle" ? (own[0] ?? null) : null;
  return {
    points: points.filter((t) => !own.some((o) => same(t.at, o))),
    columns: corner ? refs.filter((r) => r[0] !== corner[0]) : refs,
    rows: corner ? refs.filter((r) => r[1] !== corner[1]) : refs,
    own,
  };
}

/** The one of `refs` nearest the pointer by `off`, if it is within `reach`; the first listed on a tie. */
function nearest(refs: readonly SketchXY[], off: (r: SketchXY) => number, reach: number): SketchXY | null {
  let best: SketchXY | null = null;
  let bestOff = Infinity;
  for (const r of refs) {
    const d = off(r);
    if (d <= reach && d < bestOff) [best, bestOff] = [r, d];
  }
  return best;
}

/**
 * Where a pointer at `raw` (on the plane, unsnapped) lands, given the
 * kernel's grid point for it and the size of a screen pixel on the plane
 * there (mm). The reach is SNAP_PIXELS pixels: a point at most that far
 * (√(dx² + dy²) ≤ reach) is taken, the nearest first; else a column and a
 * row each at most that far (|dx| ≤ reach, |dy| ≤ reach), the nearest of
 * each; else the grid point. A pixel size that is not a positive number
 * (unknown) snaps to the grid only. Lining up with one point's column and
 * row both lands on that point, and is called that point; lining up onto
 * one of the tool's own clicks (not a target) gives the grid point instead.
 * Of the points within SAME_PLACE of the nearest, the first listed is the
 * one taken (27c).
 */
export function snapPointer(raw: SketchXY, grid: SketchXY, targets: SnapTargets, pixel: number | undefined): Snap {
  if (pixel === undefined || !(pixel > 0) || !Number.isFinite(pixel)) return { kind: "grid", at: grid };
  const reach = SNAP_PIXELS * pixel;
  let point: SnapTarget | null = null;
  let best = Infinity;
  for (const t of targets.points) {
    const d = Math.sqrt((t.at[0] - raw[0]) ** 2 + (t.at[1] - raw[1]) ** 2);
    if (d <= reach && d < best) [point, best] = [t, d];
  }
  const found = (t: SnapTarget): Snap => (t.pin ? { kind: t.kind, at: t.at, edge: true } : { kind: t.kind, at: t.at });
  // Of the points at one place as the nearest, the first listed (27c): the sketch's own, then the one on its plane.
  if (point) {
    const near = point.at;
    return found(targets.points.find((t) => Math.sqrt((t.at[0] - near[0]) ** 2 + (t.at[1] - near[1]) ** 2) <= SAME_PLACE)!);
  }
  const column = nearest(targets.columns, (r) => Math.abs(r[0] - raw[0]), reach);
  const row = nearest(targets.rows, (r) => Math.abs(r[1] - raw[1]), reach);
  if (!column && !row) return { kind: "grid", at: grid };
  const at: SketchXY = [column ? column[0] : grid[0], row ? row[1] : grid[1]];
  // Lined up onto one of the tool's own clicks is being on it, not lined up with anything.
  if (targets.own.some((o) => same(at, o))) return { kind: "grid", at: grid };
  const on = targets.points.find((t) => same(t.at, at));
  return on ? found(on) : { kind: "aligned", at, column, row };
}

/** The snap for a pointer on the sketch a tool is drawing on (snapTargets, then snapPointer). */
export function snapOnSketch(doc: DesignDocument, tool: SketchTool, raw: SketchXY, grid: SketchXY, pixel: number | undefined, edges: readonly EdgeTarget[] = []): Snap {
  const sketch = doc.sketches.find((s) => s.id === tool.sketch);
  if (!sketch) throw new Error(`there is no sketch ${tool.sketch} in the design`);
  return snapPointer(raw, grid, snapTargets(sketch, tool, edges), pixel);
}

const xy = (p: SketchXY) => `${p[0]},${p[1]}`;

/** The snap in words, for the viewport's data (read by the e2e test): "endpoint 10,0", "edge endpoint 40,30" (26f), "vertical from 0,0 and horizontal from 10,20", "" on the grid. */
export function snapLabel(snap: Snap): string {
  if (snap.kind === "grid") return "";
  if (snap.kind !== "aligned") return `${snap.edge ? "edge " : ""}${snap.kind} ${xy(snap.at)}`;
  const words = [snap.column && `vertical from ${xy(snap.column)}`, snap.row && `horizontal from ${xy(snap.row)}`];
  return words.filter(Boolean).join(" and ");
}

type Segment = readonly [SketchXY, SketchXY];

/** Sizes of the marks on screen (px): a mark's half width, a guide's dashes and gaps, and how far a guide runs on past the pointer. */
export const MARK_PIXELS = 7;
const DASH_PIXELS = 6;
const GAP_PIXELS = 4;
const PAST_PIXELS = 30;
/** At most this many dashes in a guide; a longer one gets longer dashes. */
const MAX_DASHES = 400;

/** A dashed line from a to b, dashes and gaps `dash` and `gap` long (mm), the last dash cut at b. */
function dashes(a: SketchXY, b: SketchXY, dash: number, gap: number): Segment[] {
  const length = Math.sqrt((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2);
  if (!(length > 0)) return [];
  const stretch = Math.max(1, length / ((dash + gap) * MAX_DASHES));
  const [d, g] = [dash * stretch, gap * stretch];
  const along = (t: number): SketchXY => [a[0] + ((b[0] - a[0]) * t) / length, a[1] + ((b[1] - a[1]) * t) / length];
  const out: Segment[] = [];
  for (let t = 0; t < length; t += d + g) out.push([along(t), along(Math.min(t + d, length))]);
  return out;
}

/** A closed outline through these corners as segments. */
const loop = (c: SketchXY[]): Segment[] => c.map((p, i) => [p, c[(i + 1) % c.length]] as const);

/**
 * The snap's marks on the plane, sized in screen pixels (pixel = mm per
 * pixel): a square round an endpoint, a triangle round a midpoint, a
 * circle round a centre (MARK_PIXELS out from the point), and for lining
 * up a dashed guide from each point lined up with, running on PAST_PIXELS
 * past the pointer, and a small cross at the pointer. Nothing on the grid.
 */
export function snapMarks(snap: Snap, pixel: number): Segment[] {
  const m = MARK_PIXELS * pixel;
  const [x, y] = snap.at;
  if (snap.kind === "endpoint") return loop([[x - m, y - m], [x + m, y - m], [x + m, y + m], [x - m, y + m]]);
  if (snap.kind === "midpoint") return loop([[x - m, y - m], [x + m, y - m], [x, y + m]]);
  if (snap.kind === "centre") return loop(Array.from({ length: 16 }, (_, k): SketchXY => [x + m * Math.cos((Math.PI * k) / 8), y + m * Math.sin((Math.PI * k) / 8)]));
  if (snap.kind !== "aligned") return [];
  const out: Segment[] = [[[x - m, y - m], [x + m, y + m]], [[x - m, y + m], [x + m, y - m]]];
  const past = PAST_PIXELS * pixel;
  if (snap.column) out.push(...dashes(snap.column, [x, y + Math.sign(y - snap.column[1]) * past], DASH_PIXELS * pixel, GAP_PIXELS * pixel));
  if (snap.row) out.push(...dashes(snap.row, [x + Math.sign(x - snap.row[0]) * past, y], DASH_PIXELS * pixel, GAP_PIXELS * pixel));
  return out;
}

/** The drawings with the snap shown on the edited sketch (its marks and label); the others as they were. */
export function withSnap(drawings: SketchDrawing[], snap: Snap | null, pixel: number | undefined): SketchDrawing[] {
  if (!snap || snap.kind === "grid" || pixel === undefined || !(pixel > 0)) return drawings;
  return drawings.map((d) => (d.editing ? { ...d, editing: { ...d.editing, snap: { label: snapLabel(snap), marks: snapMarks(snap, pixel) } } } : d));
}

/**
 * The kernel call that rounds a pointer at `at` on the plane before the
 * snaps above (sketch feel SF1). Grid snap on: the nearest node of the
 * grid (snap_to_grid). Off, the default: placed freely (place_freely),
 * where you click, rounded to the largest power of ten no bigger than a
 * pixel there, so it moves by at most half a pixel. A pixel size that is
 * not a positive number (the viewport can't tell) falls back to the
 * grid, as snapPointer does.
 */
export type Rounding = { op: "snap_to_grid"; args: [x: number, y: number, spacing: number] } | { op: "place_freely"; args: [x: number, y: number, pixel: number] };
export function rounding(at: SketchXY, grid: number, gridSnap: boolean, pixel: number | undefined): Rounding {
  if (gridSnap || pixel === undefined || !(pixel > 0) || !Number.isFinite(pixel)) return { op: "snap_to_grid", args: [at[0], at[1], grid] };
  return { op: "place_freely", args: [at[0], at[1], pixel] };
}
