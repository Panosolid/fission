// The line tool (step 21c): what a click on the sketch plane does to the
// document, as pure functions the workspace calls with a point the kernel
// has already snapped to the grid (snap_to_grid). Lines drawn click after
// click form a chain, each line starting at the point the last one ended
// on, so the chain's corners are shared point ids in the data.
//
// Two clicks are at the same point only when their snapped coordinates are
// equal: the kernel gives bit-identical grid nodes for the same node, so a
// click back on the chain's first point closes it. Snapping to points off
// the grid comes with the sketch constraints (27).

import type { Plane, SketchDrawing, SketchXY, OriginPlane, ViewName } from "@fission/core";
import type { DesignDocument, Sketch, SketchPlane } from "./document.ts";
import { drawLine, planeOf, sketchLines, type LineEnd } from "./sketch.ts";

/** The line tool on one sketch: where the next line starts (a point id, or a first click not yet a point), or null between chains. */
export interface LineTool {
  sketch: string;
  from: LineEnd | null;
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

/** The sketch's point exactly at `at`, by id, or null. */
export function pointAt(sketch: Sketch, at: SketchXY): string | null {
  return sketch.points.find((p) => p.x === at[0] && p.y === at[1])?.id ?? null;
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
export function clickAt(doc: DesignDocument, tool: LineTool, at: SketchXY): { doc: DesignDocument; tool: LineTool; drew: boolean } {
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

/** The rubber-band line from the chain's last point to the pointer, or null between chains or off the plane. */
export function previewLine(doc: DesignDocument, tool: LineTool | null, pointer: SketchXY | null): readonly [SketchXY, SketchXY] | null {
  if (!tool || tool.from === null || !pointer) return null;
  return [whereIs(sketchOf(doc, tool.sketch), tool.from), pointer];
}

/**
 * Every sketch as the viewport draws it: the one being edited (if any)
 * with its grid, its points (and the chain's first click, not yet a point)
 * and the preview line.
 */
export function sketchDrawings(doc: DesignDocument, editing: { tool: LineTool; grid: number; pointer: SketchXY | null } | null): SketchDrawing[] {
  return doc.sketches.map((s) => {
    const plane: Plane = planeOf(sketchPlaneOf(doc, s.id));
    const lines = sketchLines(s).map((l) => [l.a, l.b] as const);
    if (editing?.tool.sketch !== s.id) return { plane, lines };
    const points: SketchXY[] = s.points.map((p) => [p.x, p.y]);
    const from = editing.tool.from;
    if (from !== null && typeof from !== "string") points.push(from);
    return { plane, lines, editing: { grid: editing.grid, points, preview: previewLine(doc, editing.tool, editing.pointer) } };
  });
}

/** The plane a sketch is on, from its timeline item. */
export function sketchPlaneOf(doc: DesignDocument, id: string): SketchPlane {
  const item = doc.timeline.features.find((f) => f.id === id);
  return (item?.intent.parameters.plane as SketchPlane | undefined) ?? "XY";
}
