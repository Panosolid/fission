// The sketch tools (line, step 21c; rectangle, step 22a; circle, step 22c): what a click on
// the sketch plane does to the document, as pure functions the workspace
// calls with a point the kernel has already snapped to the grid
// (snap_to_grid). Lines drawn click after click form a chain, each line
// starting at the point the last one ended on, so the chain's corners are
// shared point ids in the data. A rectangle is two clicks at opposite
// corners and is four such lines. A circle is two clicks, the centre and a
// point on the circle: the radius is the distance between them, and only
// the centre becomes a point.
//
// Two clicks are at the same point only when their snapped coordinates are
// equal: the kernel gives bit-identical grid nodes for the same node, so a
// click back on the chain's first point closes it. Snapping to points off
// the grid comes with the sketch constraints (27).

import type { Plane, SketchArc, SketchDrawing, SketchXY, OriginPlane, ViewName } from "@fission/core";
import type { DesignDocument, Sketch, SketchLineCurve, SketchPlane } from "./document.ts";
import { drawCircle, drawLine, drawRectangle, planeOf, pointAt, SKETCH_STEPS, sketchCurves, type LineEnd } from "./sketch.ts";

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

export type SketchTool = LineTool | RectangleTool | CircleTool;
export type ToolKind = SketchTool["kind"];

/** The tools the sketch panel offers, in its order, with their keys (the letters people already know for them). */
export const SKETCH_TOOLS: readonly { kind: ToolKind; label: string; key: string }[] = [
  { kind: "line", label: "Line", key: "L" },
  { kind: "rectangle", label: "Rectangle", key: "R" },
  { kind: "circle", label: "Circle", key: "C" },
];

/** A tool of this kind on a sketch, nothing clicked yet. */
export function startTool(kind: ToolKind, sketch: string): SketchTool {
  if (kind === "line") return { kind, sketch, from: null };
  return kind === "rectangle" ? { kind, sketch, corner: null } : { kind, sketch, centre: null };
}

/** Whether the tool is part way through (a chain going, a first corner down): what Escape ends. */
export const toolBusy = (tool: SketchTool): boolean => (tool.kind === "line" ? tool.from !== null : pendingClick(tool) !== null);

/** The tool's first click while it is not yet a point of the sketch's own (a chain's first click, a first corner, a centre), or null. */
function pendingClick(tool: SketchTool): SketchXY | null {
  if (tool.kind === "line") return tool.from !== null && typeof tool.from !== "string" ? tool.from : null;
  return tool.kind === "rectangle" ? tool.corner : tool.centre;
}

/** The grid a new sketch starts with (mm), as Design's grid in the viewport. */
export const DEFAULT_GRID = 10;

/** The origin planes the Create sketch prompt draws; only the ground plane until step 24 brings the other two and flat faces. */
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
 * or the circle round the centre through the pointer (none on the centre).
 */
export function previewSegments(doc: DesignDocument, tool: SketchTool | null, pointer: SketchXY | null): (readonly [SketchXY, SketchXY])[] {
  if (!tool || !pointer) return [];
  if (tool.kind === "line") {
    const line = previewLine(doc, tool, pointer);
    return line ? [line] : [];
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
export function sketchDrawings(doc: DesignDocument, editing: { tool: SketchTool; grid: number; pointer: SketchXY | null } | null): SketchDrawing[] {
  return doc.sketches.map((s) => {
    const plane: Plane = planeOf(sketchPlaneOf(doc, s.id));
    const curves = sketchCurves(s);
    const lines = [...curves.lines.map((l) => [l.a, l.b] as const), ...curves.circles.flatMap((c) => circleSegments(c.centre, c.radius)), ...curves.arcs.flatMap(arcSegments)];
    if (editing?.tool.sketch !== s.id) return { plane, lines };
    const points: SketchXY[] = s.points.map((p) => [p.x, p.y]);
    const tool = editing.tool;
    const pending = pendingClick(tool);
    if (pending && !s.points.some((p) => p.x === pending[0] && p.y === pending[1])) points.push([pending[0], pending[1]]);
    return { plane, lines, editing: { grid: editing.grid, points, preview: previewSegments(doc, tool, editing.pointer) } };
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
