// The sketch tools (line, step 21c; rectangle, step 22a): what a click on
// the sketch plane does to the document, as pure functions the workspace
// calls with a point the kernel has already snapped to the grid
// (snap_to_grid). Lines drawn click after click form a chain, each line
// starting at the point the last one ended on, so the chain's corners are
// shared point ids in the data. A rectangle is two clicks at opposite
// corners and is four such lines.
//
// Two clicks are at the same point only when their snapped coordinates are
// equal: the kernel gives bit-identical grid nodes for the same node, so a
// click back on the chain's first point closes it. Snapping to points off
// the grid comes with the sketch constraints (27).

import type { Plane, SketchDrawing, SketchXY, OriginPlane, ViewName } from "@fission/core";
import type { DesignDocument, Sketch, SketchPlane } from "./document.ts";
import { drawLine, drawRectangle, planeOf, pointAt, SKETCH_STEPS, sketchLines, type LineEnd } from "./sketch.ts";

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

export type SketchTool = LineTool | RectangleTool;
export type ToolKind = SketchTool["kind"];

/** The tools the sketch panel offers, in its order, with their keys (the letters people already know for them). */
export const SKETCH_TOOLS: readonly { kind: ToolKind; label: string; key: string }[] = [
  { kind: "line", label: "Line", key: "L" },
  { kind: "rectangle", label: "Rectangle", key: "R" },
];

/** A tool of this kind on a sketch, nothing clicked yet. */
export function startTool(kind: ToolKind, sketch: string): SketchTool {
  return kind === "line" ? { kind, sketch, from: null } : { kind, sketch, corner: null };
}

/** Whether the tool is part way through (a chain going, a first corner down): what Escape ends. */
export const toolBusy = (tool: SketchTool): boolean => (tool.kind === "line" ? tool.from !== null : tool.corner !== null);

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
  const line = sketchOf(drawn.doc, tool.sketch).curves.find((c) => c.id === drawn.id)!;
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

/** The undo step a tool's drawing click is recorded as. */
export const drawStep = (tool: SketchTool): string => (tool.kind === "line" ? SKETCH_STEPS.draw : SKETCH_STEPS.rectangle);

/** The rubber-band line from the chain's last point to the pointer, or null between chains or off the plane. */
export function previewLine(doc: DesignDocument, tool: LineTool | null, pointer: SketchXY | null): readonly [SketchXY, SketchXY] | null {
  if (!tool || tool.from === null || !pointer) return null;
  return [whereIs(sketchOf(doc, tool.sketch), tool.from), pointer];
}

/**
 * What the tool would draw if clicked at the pointer: the line tool's
 * rubber band, or the rectangle's four sides from the first corner (none
 * while the pointer is on its row or column, where a click draws nothing).
 */
export function previewSegments(doc: DesignDocument, tool: SketchTool | null, pointer: SketchXY | null): (readonly [SketchXY, SketchXY])[] {
  if (!tool || !pointer) return [];
  if (tool.kind === "line") {
    const line = previewLine(doc, tool, pointer);
    return line ? [line] : [];
  }
  const a = tool.corner;
  if (!a || a[0] === pointer[0] || a[1] === pointer[1]) return [];
  const c: SketchXY[] = [a, [pointer[0], a[1]], pointer, [a[0], pointer[1]]];
  return c.map((p, i) => [p, c[(i + 1) % 4]] as const);
}

/**
 * Every sketch as the viewport draws it: the one being edited (if any)
 * with its grid, its points (and the chain's first click, not yet a point)
 * and the preview line.
 */
export function sketchDrawings(doc: DesignDocument, editing: { tool: SketchTool; grid: number; pointer: SketchXY | null } | null): SketchDrawing[] {
  return doc.sketches.map((s) => {
    const plane: Plane = planeOf(sketchPlaneOf(doc, s.id));
    const lines = sketchLines(s).map((l) => [l.a, l.b] as const);
    if (editing?.tool.sketch !== s.id) return { plane, lines };
    const points: SketchXY[] = s.points.map((p) => [p.x, p.y]);
    const tool = editing.tool;
    const pending = tool.kind === "line" ? (tool.from !== null && typeof tool.from !== "string" ? tool.from : null) : tool.corner;
    if (pending && !s.points.some((p) => p.x === pending[0] && p.y === pending[1])) points.push([pending[0], pending[1]]);
    return { plane, lines, editing: { grid: editing.grid, points, preview: previewSegments(doc, tool, editing.pointer) } };
  });
}

/** The plane a sketch is on, from its timeline item. */
export function sketchPlaneOf(doc: DesignDocument, id: string): SketchPlane {
  const item = doc.timeline.features.find((f) => f.id === id);
  return (item?.intent.parameters.plane as SketchPlane | undefined) ?? "XY";
}
