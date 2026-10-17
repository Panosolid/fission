// The sketch tools (line, step 21c; rectangle, step 22a; circle, step 22c;
// 3-point arc, step 23b; tangent arc, step 23c): what a click on
// the sketch plane does to the document, as pure functions the workspace
// calls with a point the kernel has already rounded (where you clicked to
// within half a pixel, or onto the grid with grid snap on) and snap.ts
// has snapped to nearby points. Lines drawn click after click form a chain, each line
// starting at the point the last one ended on, so the chain's corners are
// shared point ids in the data. A rectangle is two clicks at opposite
// corners and is four such lines. A circle is two clicks, the centre and a
// point on the circle: the radius is the distance between them, and only
// the centre becomes a point. A 3-point arc is three clicks: its two ends,
// then a point it passes through (`arcThrough`). A tangent arc is two: the
// free end of a line or arc, then its own end (`tangentArc`); it leaves
// along the curve it starts from, and chains like the line tool.
//
// Two clicks are at the same point only when their snapped coordinates are
// equal: snap.ts puts a click near a point exactly on it, and the kernel
// gives bit-identical nodes for the same node, so a click back on the
// chain's first point closes it. Keeping points together after that comes
// with the sketch constraints (29).

import type { Plane, SketchArc, SketchDrawing, SketchXY, OriginPlane, ViewName } from "@fission/core";
import type { DesignDocument, Sketch, SketchArcCurve, SketchLineCurve, SketchPlane } from "./document.ts";
import { drawArc, drawCircle, drawLine, drawRectangle, planeOf, pointAt, SKETCH_STEPS, sketchCurves, type LineEnd } from "./sketch.ts";

export { pointAt };

/** The line tool on one sketch: where the next line starts (a point id, or a first click not yet a point), or null between chains. */
export interface LineTool {
  kind: "line";
  sketch: string;
  from: LineEnd | null;
}

/** The rectangle tool on one sketch: the first corner clicked, or null before it. */
export interface RectangleTool {
  kind: "rectangle";
  sketch: string;
  corner: SketchXY | null;
}

/** The circle tool on one sketch: the centre clicked, or null before it. */
export interface CircleTool {
  kind: "circle";
  sketch: string;
  centre: SketchXY | null;
}

/** The 3-point arc tool on one sketch: the start clicked, then the end, or null before each. */
export interface ArcTool {
  kind: "arc";
  sketch: string;
  start: SketchXY | null;
  end: SketchXY | null;
}

/** The tangent arc tool on one sketch: the free end it starts from (a point id ending one line or arc), or null before it. */
export interface TangentTool {
  kind: "tangent";
  sketch: string;
  from: string | null;
}

export type SketchTool = LineTool | RectangleTool | CircleTool | ArcTool | TangentTool;
export type ToolKind = SketchTool["kind"];

/** The tools the sketch panel offers, in its order, with their keys (the letters people already know for them). */
export const SKETCH_TOOLS: readonly { kind: ToolKind; label: string; key: string }[] = [
  { kind: "line", label: "Line", key: "L" },
  { kind: "rectangle", label: "Rectangle", key: "R" },
  { kind: "circle", label: "Circle", key: "C" },
  { kind: "arc", label: "Arc", key: "A" },
  { kind: "tangent", label: "Tangent arc", key: "T" },
];

/** A tool of this kind on a sketch, nothing clicked yet. */
export function startTool(kind: ToolKind, sketch: string): SketchTool {
  if (kind === "line" || kind === "tangent") return { kind, sketch, from: null };
  if (kind === "arc") return { kind, sketch, start: null, end: null };
  return kind === "rectangle" ? { kind, sketch, corner: null } : { kind, sketch, centre: null };
}

/** Whether the tool is part way through (a chain going, a first corner down, an arc's ends): what Escape ends. */
export const toolBusy = (tool: SketchTool): boolean => (tool.kind === "line" || tool.kind === "tangent" ? tool.from !== null : pendingClicks(tool).length > 0);

/** The tool's clicks while they are not yet points of the sketch's own (a chain's first click, a first corner, a centre, an arc's ends). */
function pendingClicks(tool: SketchTool): SketchXY[] {
  if (tool.kind === "line") return tool.from !== null && typeof tool.from !== "string" ? [tool.from] : [];
  if (tool.kind === "arc") return [tool.start, tool.end].filter((p) => p !== null);
  if (tool.kind === "tangent") return [];
  const at = tool.kind === "rectangle" ? tool.corner : tool.centre;
  return at ? [at] : [];
}

/** The grid a new sketch starts with (mm), as Design's grid in the viewport. */
export const DEFAULT_GRID = 10;
/** Whether points snap to the grid until you tick it (sketch feel SF1): off, so points go where you click, as in other CAD sketchers. */
export const DEFAULT_GRID_SNAP = false;

/** The origin planes the Create sketch prompt draws; only the ground plane until step 26 brings the other two and flat faces. */
export const ORIGIN_PLANES: readonly { id: SketchPlane; offered: boolean; label: string }[] = [
  { id: "XY", offered: true, label: "Ground plane (XY)" },
  { id: "XZ", offered: false, label: "Front plane (XZ)" },
  { id: "YZ", offered: false, label: "Side plane (YZ)" },
];

/** The origin planes as the viewport draws them for picking. */
export function originPlanes(): OriginPlane[] {
  return ORIGIN_PLANES.map((p) => ({ id: p.id, plane: planeOf(p.id), offered: p.offered }));
}

/** The standard view that looks straight down on a plane: the camera on the side its normal points to. */
export const PLANE_VIEWS: Record<SketchPlane, ViewName> = { XY: "top", XZ: "front", YZ: "right" };

function sketchOf(doc: DesignDocument, id: string): Sketch {
  const s = doc.sketches.find((x) => x.id === id);
  if (!s) throw new Error(`there is no sketch ${id} in the design`);
  return s;
}

/** Where an end of a line is, in the sketch's frame. */
function whereIs(sketch: Sketch, end: LineEnd): SketchXY {
  if (typeof end !== "string") return end;
  const p = sketch.points.find((x) => x.id === end);
  if (!p) throw new Error(`sketch ${sketch.id} has no point ${end}`);
  return [p.x, p.y];
}

/**
 * A click at `at` (snapped). Between chains it only marks where the next
 * line starts (an existing point there is shared). Otherwise it draws a
 * line from the chain's last point to `at`, one undo step: `drew` is true.
 * Ending on a point the sketch already had (closing the shape, or meeting
 * another line's end) ends the chain; ending anywhere else carries on from
 * the new point. A click on the chain's last point draws nothing.
 */
export function clickAt<T extends SketchTool>(doc: DesignDocument, tool: T, at: SketchXY): { doc: DesignDocument; tool: T; drew: boolean; note?: string } {
  if (tool.kind === "rectangle") return rectangleClick(doc, tool, at) as { doc: DesignDocument; tool: T; drew: boolean; note?: string };
  if (tool.kind === "circle") return circleClick(doc, tool, at) as { doc: DesignDocument; tool: T; drew: boolean; note?: string };
  if (tool.kind === "arc") return arcClick(doc, tool, at) as { doc: DesignDocument; tool: T; drew: boolean; note?: string };
  if (tool.kind === "tangent") return tangentClick(doc, tool, at) as { doc: DesignDocument; tool: T; drew: boolean; note?: string };
  return lineClick(doc, tool as LineTool, at) as { doc: DesignDocument; tool: T; drew: boolean };
}

function lineClick(doc: DesignDocument, tool: LineTool, at: SketchXY): { doc: DesignDocument; tool: LineTool; drew: boolean } {
  const sketch = sketchOf(doc, tool.sketch);
  const there = pointAt(sketch, at);
  const end: LineEnd = there ?? [at[0], at[1]];
  if (tool.from === null) return { doc, tool: { ...tool, from: end }, drew: false };
  const [fx, fy] = whereIs(sketch, tool.from);
  if (fx === at[0] && fy === at[1]) return { doc, tool, drew: false };
  const drawn = drawLine(doc, tool.sketch, tool.from, end);
  const line = sketchOf(drawn.doc, tool.sketch).curves.find((c) => c.id === drawn.id) as SketchLineCurve;
  return { doc: drawn.doc, tool: { ...tool, from: there ? null : line.end }, drew: true };
}

/** A rectangle's two clicks, the second at the opposite corner, sharing points; `note` says why a second click on the first corner's row or column draws nothing. */
const SAME_ROW = "A rectangle needs a width and a height: click the opposite corner off the first corner's row and column.";

function rectangleClick(doc: DesignDocument, tool: RectangleTool, at: SketchXY): { doc: DesignDocument; tool: RectangleTool; drew: boolean; note?: string } {
  sketchOf(doc, tool.sketch);
  if (tool.corner === null) return { doc, tool: { ...tool, corner: [at[0], at[1]] }, drew: false };
  if (tool.corner[0] === at[0] || tool.corner[1] === at[1]) return { doc, tool, drew: false, note: SAME_ROW };
  return { doc: drawRectangle(doc, tool.sketch, tool.corner, at).doc, tool: { ...tool, corner: null }, drew: true };
}

/**
 * The distance between two clicks, √(dx² + dy²). Not Math.hypot: V8's is
 * off by a unit in the last place for (10, 30), giving 31.622776601683796
 * for √1000 = 31.62277660168379332…; snapped clicks have dx² + dy² exact,
 * so Math.sqrt's correctly rounded root is the nearest double to the true
 * radius. Clicks lie within the kernel's MAX_COORD, so the squares never
 * overflow.
 */
const distance = (a: SketchXY, b: SketchXY): number => Math.sqrt((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2);

const NO_RADIUS = "A circle needs a radius: click a point on the circle away from its centre.";

/**
 * A circle's two clicks: the centre (an existing point there is shared),
 * then a point on the circle. The radius is the distance between the two
 * snapped clicks (`distance`); the second click is not kept as a point.
 * A second click on the centre draws nothing and says why.
 */
function circleClick(doc: DesignDocument, tool: CircleTool, at: SketchXY): { doc: DesignDocument; tool: CircleTool; drew: boolean; note?: string } {
  const sketch = sketchOf(doc, tool.sketch);
  if (tool.centre === null) return { doc, tool: { ...tool, centre: [at[0], at[1]] }, drew: false };
  const radius = distance(tool.centre, at);
  if (radius === 0) return { doc, tool, drew: false, note: NO_RADIUS };
  const centre: LineEnd = pointAt(sketch, tool.centre) ?? tool.centre;
  return { doc: drawCircle(doc, tool.sketch, centre, radius).doc, tool: { ...tool, centre: null }, drew: true };
}

/**
 * The arc through three snapped clicks (step 23b): from `a` to `b` through
 * `p`, as the start, end and centre of a counter-clockwise arc, or null
 * when the three can't be told from points on one line.
 *
 * The centre is put ON the line midway between the ends, never found as a
 * general circumcentre, so it is the same distance from both ends to
 * within rounding and the kernel's check_arcs accepts it. With d = b − a,
 * m = (a + b) / 2 and d⊥ = (−dy, dx) (d turned a quarter left), the
 * centre is m + d⊥·k, and it is as far from p as from a when
 *   k = (|p − m|² − |d|²/4) / (2·(d × (p − a))),
 * where d × v = dx·vy − dy·vx. (In a frame with m at the origin and d
 * along x, the ends are (±h, 0) with h = |d|/2, the centre is (0, t) with
 * t = |d|·k, and p is (px, py) with py = (d × (p − a))/|d|; h² + t² =
 * px² + (py − t)² gives t = (px² + py² − h²)/(2·py).) No square root is
 * taken. An arc runs counter-clockwise round its centre, so when p is on
 * the left of a → b (the cross product above 0) the arc that passes
 * through p is the one from b to a, and the ends swap.
 *
 * "Can't be told from one line": the cross product is compared with how
 * far rounding can move it, not with a tolerance. Each click is a double
 * within ½ulp of the node meant (a decimal grid's 0.3 is not 3/10), so a
 * click is off by at most εM/2 (ε = Number.EPSILON, M the largest
 * coordinate's size) and each difference, after its own rounding, by at
 * most η = 2εM. The cross product of differences (x, y) and (u, w) is then
 * off by at most η(|x| + |y| + |u| + |w|) + 2η² from the inputs, plus
 * ε(|x·w| + |y·u|) from its two products and subtraction. A cross
 * product within that bound might be rounding alone, as it is for three
 * nodes of a 0.1 mm grid on one line, so it is refused; two grid nodes
 * off a line make a cross product of at least the grid squared, far
 * above it.
 */
export function arcThrough(a: SketchXY, b: SketchXY, p: SketchXY): SketchArc | null {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const cross = bend([dx, dy], [p[0] - a[0], p[1] - a[1]], [a, b, p]);
  if (cross === null) return null;
  const m: SketchXY = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const k = ((p[0] - m[0]) ** 2 + (p[1] - m[1]) ** 2 - (dx * dx + dy * dy) / 4) / (2 * cross);
  const centre: [number, number] = [m[0] - dy * k, m[1] + dx * k];
  const [start, end] = cross < 0 ? [a, b] : [b, a];
  return { start: [start[0], start[1]], end: [end[0], end[1]], centre };
}

/**
 * The cross product u × v = ux·vy − uy·vx of two differences of the
 * points `from`, or null when it is within the rounding bound described
 * at `arcThrough` (η = 2εM, M the largest coordinate of `from`), so it
 * might be rounding alone: the two don't make a bend that can be told
 * from a straight line. Shared by the 3-point arc and the tangent arc.
 */
function bend(u: SketchXY, v: SketchXY, from: readonly SketchXY[]): number | null {
  const [ux, uy] = u;
  const [vx, vy] = v;
  const cross = ux * vy - uy * vx;
  const big = Math.max(...from.flatMap((q) => [Math.abs(q[0]), Math.abs(q[1])]));
  const eta = 2 * Number.EPSILON * big;
  const bound = eta * (Math.abs(ux) + Math.abs(uy) + Math.abs(vx) + Math.abs(vy)) + 2 * eta * eta + Number.EPSILON * (Math.abs(ux * vy) + Math.abs(uy * vx));
  return Math.abs(cross) > bound ? cross : null;
}

const SAME_ENDS = "An arc needs two ends: click its end away from its start.";
const ONE_LINE = "An arc needs to bend: click a point it passes through off the line through its ends.";

/**
 * A 3-point arc's clicks: the start, the end, then a point on the arc
 * (`arcThrough`), one undo step. Ends landing on existing points share
 * them (an arc closing a chain of lines); the centre shares a point only
 * if one is exactly there, else it is a new one (usually off the grid);
 * the third click is not kept. An end on the start, or a third click that
 * makes no bend (on an end, or in line with both), draws nothing and says
 * why.
 */
function arcClick(doc: DesignDocument, tool: ArcTool, at: SketchXY): { doc: DesignDocument; tool: ArcTool; drew: boolean; note?: string } {
  const sketch = sketchOf(doc, tool.sketch);
  if (tool.start === null) return { doc, tool: { ...tool, start: [at[0], at[1]] }, drew: false };
  if (tool.end === null) {
    if (tool.start[0] === at[0] && tool.start[1] === at[1]) return { doc, tool, drew: false, note: SAME_ENDS };
    return { doc, tool: { ...tool, end: [at[0], at[1]] }, drew: false };
  }
  const arc = arcThrough(tool.start, tool.end, at);
  if (!arc) return { doc, tool, drew: false, note: ONE_LINE };
  const share = (p: SketchXY): LineEnd => pointAt(sketch, p) ?? p;
  const drawn = drawArc(doc, tool.sketch, share(arc.start), share(arc.end), share(arc.centre));
  return { doc: drawn.doc, tool: { ...tool, start: null, end: null }, drew: true };
}

/**
 * The direction a curve leaves its sketch point `id` along, carried on
 * past its end: for a line a → b, b − a at b and a − b at a; for an arc
 * (counter-clockwise round c), the radius r = end − c turned a quarter
 * left, (−ry, rx), at its end, and r = start − c turned a quarter right,
 * (ry, −rx), at its start. Not made a unit: only its direction is used.
 * Null unless exactly one line or arc ends at the point (a point no line
 * or arc ends at, a centre say, has no direction; one where two meet, a
 * corner, has two).
 */
export function leaving(sketch: Sketch, id: string): SketchXY | null {
  const ends = sketch.curves.filter((c) => c.kind !== "circle" && (c.start === id || c.end === id));
  if (ends.length !== 1) return null;
  const c = ends[0] as SketchLineCurve | SketchArcCurve;
  const at = (q: string) => whereIs(sketch, q);
  const [sx, sy] = at(c.start);
  const [ex, ey] = at(c.end);
  if (c.kind === "line") return c.end === id ? [ex - sx, ey - sy] : [sx - ex, sy - ey];
  const [cx, cy] = at(c.centre);
  return c.end === id ? [-(ey - cy), ex - cx] : [sy - cy, -(sx - cx)];
}

/**
 * The arc from `s` leaving along `t` (`leaving`) to `e`, as the start,
 * end and centre of a counter-clockwise arc, or null when `e` is on the
 * line through `s` along `t` (ahead or behind) to within rounding, where
 * no arc both leaves along `t` and reaches `e`. `along` are the points
 * `t` was taken from, for the rounding bound (`bend`).
 *
 * The centre is on the normal to `t` at `s` (so the arc leaves along `t`)
 * and as far from `e` as from `s`. With n = t⊥ = (−ty, tx) (t turned a
 * quarter left) and w = e − s, the centre is s + n·k, and
 * |n·k|² = |n·k − w|² gives 0 = |w|² − 2k(n·w), so
 *   k = |w|² / (2·(n·w)) = |w|² / (2·(t × w)),
 * since n·w = −ty·wx + tx·wy = t × w. No square root is taken. When e is
 * on the left of the way out (t × w above 0) the arc turns left, so it
 * runs counter-clockwise from s to e; on the right it turns clockwise,
 * which is counter-clockwise from e to s, and the ends swap.
 *
 * The centre is s + n·k exactly, rounded once per coordinate, so it is
 * on the normal at s, and on the line midway between the ends that the
 * kernel's check_arcs asks for, to within rounding of the coordinates.
 */
export function tangentArc(s: SketchXY, t: SketchXY, e: SketchXY, along: readonly SketchXY[]): SketchArc | null {
  const w: SketchXY = [e[0] - s[0], e[1] - s[1]];
  const cross = bend(t, w, [...along, s, e]);
  if (cross === null) return null;
  const k = (w[0] * w[0] + w[1] * w[1]) / (2 * cross);
  const centre: [number, number] = [s[0] - t[1] * k, s[1] + t[0] * k];
  const [start, end] = cross > 0 ? [s, e] : [e, s];
  return { start: [start[0], start[1]], end: [end[0], end[1]], centre };
}

/** The points the direction `leaving(sketch, id)` was worked out from: the curve's ends, or an arc's end and centre. */
function leavingFrom(sketch: Sketch, id: string): SketchXY[] {
  const c = sketch.curves.find((x) => x.kind !== "circle" && (x.start === id || x.end === id)) as SketchLineCurve | SketchArcCurve;
  return (c.kind === "line" ? [c.start, c.end] : [id, c.centre]).map((q) => whereIs(sketch, q));
}

/** Where the tangent tool's start is and the way it leaves, or null when its start is gone or no longer one curve's free end (after an undo, say). */
function tangentStart(sketch: Sketch, tool: TangentTool): { s: SketchXY; t: SketchXY; along: SketchXY[] } | null {
  if (tool.from === null || !sketch.points.some((p) => p.id === tool.from)) return null;
  const t = leaving(sketch, tool.from);
  return t ? { s: whereIs(sketch, tool.from), t, along: leavingFrom(sketch, tool.from) } : null;
}

const NO_FREE_END = "A tangent arc starts at the end of a line or arc: click a free end (where only one line or arc ends).";
const SAME_START = "A tangent arc needs an end: click away from its start.";
const NO_TURN = "A tangent arc needs to turn: click off the line it leaves along (the line tool draws straight on).";

/**
 * A tangent arc's clicks: the free end of a line or arc to start from
 * (`leaving`; snapping lands on it), then the arc's end (`tangentArc`),
 * one undo step. The end shares a point already there, and so does the
 * centre if one is exactly there, else each is a new point. The arc
 * chains: ending on a new point the tool carries on from it, leaving
 * along the arc just drawn; ending on a point the sketch already had
 * ends the chain. A first click that is not a free end, an end on the
 * start, or one straight ahead or behind draws nothing and says why.
 */
function tangentClick(doc: DesignDocument, tool: TangentTool, at: SketchXY): { doc: DesignDocument; tool: TangentTool; drew: boolean; note?: string } {
  const sketch = sketchOf(doc, tool.sketch);
  const start = tangentStart(sketch, tool);
  if (!start) {
    const there = pointAt(sketch, at);
    if (there === null || !leaving(sketch, there)) return { doc, tool: { ...tool, from: null }, drew: false, note: NO_FREE_END };
    return { doc, tool: { ...tool, from: there }, drew: false };
  }
  if (start.s[0] === at[0] && start.s[1] === at[1]) return { doc, tool, drew: false, note: SAME_START };
  const arc = tangentArc(start.s, start.t, at, start.along);
  if (!arc) return { doc, tool, drew: false, note: NO_TURN };
  const there = pointAt(sketch, at);
  const end: LineEnd = there ?? [at[0], at[1]];
  const centre: LineEnd = pointAt(sketch, arc.centre) ?? arc.centre;
  const left = arc.start[0] === start.s[0] && arc.start[1] === start.s[1];
  const drawn = left ? drawArc(doc, tool.sketch, tool.from!, end, centre) : drawArc(doc, tool.sketch, end, tool.from!, centre);
  const made = sketchOf(drawn.doc, tool.sketch).curves.find((c) => c.id === drawn.id) as SketchArcCurve;
  const next = there ? null : left ? made.end : made.start;
  return { doc: drawn.doc, tool: { ...tool, from: next }, drew: true };
}

/**
 * The tool a sketch switches to (the panel's buttons, or the keys): a
 * new one, nothing clicked, except between the line and the tangent arc,
 * which carry on from the chain's last point, so a slot is lines and
 * arcs drawn without clicking a corner twice. The line tool takes the
 * tangent arc's start as where its next line starts; the tangent arc
 * takes the line chain's last point if it is a free end (`leaving`).
 */
export function switchTool(doc: DesignDocument, tool: SketchTool, kind: ToolKind): SketchTool {
  const fresh = startTool(kind, tool.sketch);
  if (tool.kind === "tangent" && kind === "line" && tool.from !== null) return { ...fresh, from: tool.from } as LineTool;
  if (tool.kind === "line" && kind === "tangent" && typeof tool.from === "string" && leaving(sketchOf(doc, tool.sketch), tool.from)) return { ...fresh, from: tool.from } as TangentTool;
  return fresh;
}

/** The undo step a tool's drawing click is recorded as. */
export const drawStep = (tool: SketchTool): string => SKETCH_STEPS[tool.kind === "line" ? "draw" : tool.kind];

/**
 * How many straight segments the viewport draws a circle with. Drawing
 * only: the sketch keeps the exact circle (centre and radius) and the
 * kernel extrudes that. 64 sides stray from the circle by at most
 * r·(1 − cos(π/64)) ≈ 0.0012·r, under a pixel at any zoom that frames it.
 */
export const CIRCLE_SEGMENTS = 64;

/**
 * A circle as the viewport draws it: CIRCLE_SEGMENTS segments between
 * points on it at angles 2πk/n, counter-clockwise from its east point
 * (centre + (r, 0)); the last segment ends on the first point exactly.
 */
export function circleSegments(centre: SketchXY, radius: number): (readonly [SketchXY, SketchXY])[] {
  const n = CIRCLE_SEGMENTS;
  const at: SketchXY[] = [];
  for (let k = 0; k < n; k++) {
    const t = (2 * Math.PI * k) / n;
    at.push([centre[0] + radius * Math.cos(t), centre[1] + radius * Math.sin(t)]);
  }
  return at.map((p, k) => [p, at[(k + 1) % n]] as const);
}

/**
 * An arc as the viewport draws it (step 23a): from its start to its end
 * counter-clockwise round its centre, at the mean of the ends' distances
 * from it, in ⌈CIRCLE_SEGMENTS × turn / 2π⌉ equal steps (at least one), so
 * a half circle gets 32 segments, as half a drawn circle has. The first
 * segment starts on the start and the last ends on the end exactly, so
 * lines sharing those points meet the drawing. Ends at the same angle are
 * drawn as a whole turn.
 */
export function arcSegments(arc: SketchArc): (readonly [SketchXY, SketchXY])[] {
  const { start, end, centre } = arc;
  const radius = (distance(centre, start) + distance(centre, end)) / 2;
  const from = Math.atan2(start[1] - centre[1], start[0] - centre[0]);
  let turn = Math.atan2(end[1] - centre[1], end[0] - centre[0]) - from;
  while (turn <= 0) turn += 2 * Math.PI;
  const n = Math.max(1, Math.ceil((CIRCLE_SEGMENTS * turn) / (2 * Math.PI)));
  const at: SketchXY[] = [start];
  for (let k = 1; k < n; k++) {
    const t = from + (turn * k) / n;
    at.push([centre[0] + radius * Math.cos(t), centre[1] + radius * Math.sin(t)]);
  }
  at.push(end);
  return at.slice(1).map((p, k) => [at[k], p] as const);
}

/** The rubber-band line from the chain's last point to the pointer, or null between chains or off the plane. */
export function previewLine(doc: DesignDocument, tool: LineTool | null, pointer: SketchXY | null): readonly [SketchXY, SketchXY] | null {
  if (!tool || tool.from === null || !pointer) return null;
  return [whereIs(sketchOf(doc, tool.sketch), tool.from), pointer];
}

/**
 * What the tool would draw if clicked at the pointer: the line tool's
 * rubber band, the rectangle's four sides from the first corner (none
 * while the pointer is on its row or column, where a click draws nothing),
 * the circle round the centre through the pointer (none on the centre), or
 * the arc: a line from its start to the pointer until the end is down, then
 * the arc through the pointer (the line between the ends while the pointer
 * makes no bend), or the tangent arc from its start to the pointer (the
 * line to the pointer while it is straight ahead or behind, where a click
 * draws nothing).
 */
export function previewSegments(doc: DesignDocument, tool: SketchTool | null, pointer: SketchXY | null): (readonly [SketchXY, SketchXY])[] {
  if (!tool || !pointer) return [];
  if (tool.kind === "line") {
    const line = previewLine(doc, tool, pointer);
    return line ? [line] : [];
  }
  if (tool.kind === "arc") {
    if (!tool.start) return [];
    if (!tool.end) return tool.start[0] === pointer[0] && tool.start[1] === pointer[1] ? [] : [[tool.start, pointer]];
    const arc = arcThrough(tool.start, tool.end, pointer);
    return arc ? arcSegments(arc) : [[tool.start, tool.end]];
  }
  if (tool.kind === "tangent") {
    const start = tangentStart(sketchOf(doc, tool.sketch), tool);
    if (!start || (start.s[0] === pointer[0] && start.s[1] === pointer[1])) return [];
    const arc = tangentArc(start.s, start.t, pointer, start.along);
    return arc ? arcSegments(arc) : [[start.s, pointer]];
  }
  if (tool.kind === "circle") {
    const c = tool.centre;
    const radius = c ? distance(c, pointer) : 0;
    return c && radius > 0 ? circleSegments(c, radius) : [];
  }
  const a = tool.corner;
  if (!a || a[0] === pointer[0] || a[1] === pointer[1]) return [];
  const c: SketchXY[] = [a, [pointer[0], a[1]], pointer, [a[0], pointer[1]]];
  return c.map((p, i) => [p, c[(i + 1) % 4]] as const);
}

/**
 * Every sketch as the viewport draws it, lines, then circles (each as
 * `circleSegments`), then arcs (`arcSegments`): the one being edited (if
 * any) with its grid, its points (and a first click not yet a point) and
 * the preview.
 */
export function sketchDrawings(doc: DesignDocument, editing: { tool: SketchTool; grid: number; pointer: SketchXY | null; gridSnap?: boolean } | null): SketchDrawing[] {
  return doc.sketches.map((s) => {
    const plane: Plane = planeOf(sketchPlaneOf(doc, s.id));
    const curves = sketchCurves(s);
    const lines = [...curves.lines.map((l) => [l.a, l.b] as const), ...curves.circles.flatMap((c) => circleSegments(c.centre, c.radius)), ...curves.arcs.flatMap(arcSegments)];
    if (editing?.tool.sketch !== s.id) return { plane, lines };
    const points: SketchXY[] = s.points.map((p) => [p.x, p.y]);
    const tool = editing.tool;
    for (const at of pendingClicks(tool)) if (!s.points.some((p) => p.x === at[0] && p.y === at[1])) points.push([at[0], at[1]]);
    return { plane, lines, editing: { grid: editing.grid, gridSnap: editing.gridSnap ?? false, points, preview: previewSegments(doc, tool, editing.pointer) } };
  });
}

/** The plane a sketch is on, from its timeline item. */
export function sketchPlaneOf(doc: DesignDocument, id: string): SketchPlane {
  const item = doc.timeline.features.find((f) => f.id === id);
  return (item?.intent.parameters.plane as SketchPlane | undefined) ?? "XY";
}

/** What the sketch holds, in words for its status: "3 lines", "1 circle", "4 lines and 2 circles", "2 lines, 1 arc and 1 circle", or "Nothing drawn yet" when empty. */
export function curveCount(sketch: Sketch): string {
  const count = (kind: string, word: string) => {
    const n = sketch.curves.filter((c) => c.kind === kind).length;
    return n ? `${n} ${word}${n === 1 ? "" : "s"}` : "";
  };
  const words = [count("line", "line"), count("arc", "arc"), count("circle", "circle")].filter(Boolean);
  return words.length ? [words.slice(0, -1).join(", "), words.at(-1)].filter(Boolean).join(" and ") : "Nothing drawn yet";
}
