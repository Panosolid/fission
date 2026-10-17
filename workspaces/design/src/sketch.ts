// Sketch edits on the Design document (step 21b, docs/document-model.md
// section 3): each is a pure function from one document to the next, so
// the workspace records each as one undo step with its label (SKETCH_STEPS)
// and the history needs no inverse for any of them. New ids come from the
// document's counter and are never reused, even after a delete.
//
// The geometry a sketch makes is never stored: its one closed outline is
// found by the kernel (sketch_outline, step 21a) from the lines rebuilt
// from point ids, every time it is asked for.

import type { Feature, KernelCalls, Outline, Plane, SketchLine } from "@fission/core";
import { XY_PLANE } from "@fission/core";
import { isSketchItem, shown, type DesignDocument, type Sketch, type SketchPlane } from "./document.ts";

/** The undo step each sketch edit is recorded as. */
export const SKETCH_STEPS = { create: "Create sketch", draw: "Draw line", delete: "Delete line", move: "Move point" } as const;

/**
 * Each origin plane's frame: the sketch's x along `xAxis`, its y along
 * normal × xAxis (right-handed). XY: x = X, y = Y, normal Z. XZ: x = X,
 * y = Z, so normal = X × Z = −Y. YZ: x = Y, y = Z, so normal = Y × Z = X.
 */
const PLANES: Record<SketchPlane, Plane> = {
  XY: XY_PLANE,
  XZ: { origin: [0, 0, 0], xAxis: [1, 0, 0], normal: [0, -1, 0] },
  YZ: { origin: [0, 0, 0], xAxis: [0, 1, 0], normal: [1, 0, 0] },
};

/** Where a sketch plane reference is; a face id joins these at step 32. */
export const planeOf = (ref: SketchPlane): Plane => PLANES[ref];

/** The document with the next id taken: "line-4" and the counter moved on. */
function take(doc: DesignDocument, prefix: string): [string, DesignDocument] {
  return [`${prefix}-${doc.nextId}`, { ...doc, nextId: doc.nextId + 1 }];
}

function sketchIn(doc: DesignDocument, id: string): Sketch {
  const s = doc.sketches.find((x) => x.id === id);
  if (!s) throw new Error(`there is no sketch ${id} in the design`);
  return s;
}

const withSketch = (doc: DesignDocument, sketch: Sketch): DesignDocument => ({ ...doc, sketches: doc.sketches.map((s) => (s.id === sketch.id ? sketch : s)) });

/** The sketch's timeline item. */
export function sketchItem(doc: DesignDocument, id: string): Feature {
  const f = doc.timeline.features.find((x) => x.id === id && isSketchItem(x));
  if (!f) throw new Error(`there is no sketch ${id} in the timeline`);
  return f;
}

/**
 * A new empty sketch on a plane, appended to the timeline. Its name is
 * "Sketch n", n one more than the sketches there are, skipping a name in
 * use; the name is part of its summary and stays when others are added.
 */
export function addSketch(doc: DesignDocument, plane: SketchPlane = "XY"): { doc: DesignDocument; id: string } {
  if (!PLANES[plane]) throw new Error(`${shown(plane)} is not a plane a sketch can be on (XY, XZ or YZ)`);
  const [id, next] = take(doc, "sketch");
  const names = new Set(doc.timeline.features.filter(isSketchItem).map((f) => f.intent.summary.split(" on ")[0]));
  let n = doc.sketches.length + 1;
  while (names.has(`Sketch ${n}`)) n++;
  const item: Feature = {
    id,
    intent: { type: "sketch", parameters: { plane }, summary: `Sketch ${n} on the ${plane} plane` },
    provenance: { self: { workspace: "design", id, label: `Sketch ${n}` }, from: [] },
    dependsOn: [],
    suppressed: false,
  };
  return {
    id,
    doc: { ...next, sketches: [...doc.sketches, { id, points: [], curves: [], constraints: [] }], timeline: { ...doc.timeline, features: [...doc.timeline.features, item] } },
  };
}

/** A line's end: an existing point of the sketch, by id (a chain shares it), or a new point at x, y in mm. */
export type LineEnd = string | readonly [number, number];

/**
 * A line from one end to the other. An end given as a point id is shared
 * with the lines already there (so "coincident" is true in the data);
 * one given as coordinates is a new point. The kernel judges the lines
 * when it looks for the outline; a line from a point to itself is refused
 * here, since it has no direction at all.
 */
export function drawLine(doc: DesignDocument, sketchId: string, from: LineEnd, to: LineEnd): { doc: DesignDocument; id: string } {
  let sketch = sketchIn(doc, sketchId);
  let next = doc;
  const end = (e: LineEnd): string => {
    if (typeof e === "string") {
      if (!sketch.points.some((p) => p.id === e)) throw new Error(`sketch ${sketchId} has no point ${e}`);
      return e;
    }
    const [x, y] = e;
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`a sketch point needs x and y in mm, not ${x}, ${y}`);
    const [id, after] = take(withSketch(next, sketch), "point");
    next = after;
    sketch = { ...sketch, points: [...sketch.points, { id, x, y }] };
    return id;
  };
  if (typeof from === "string" && from === to) throw new Error(`a line can't start and end at the same point ${from}`);
  const start = end(from);
  const stop = end(to);
  const [id, after] = take(withSketch(next, sketch), "line");
  sketch = { ...sketch, curves: [...sketch.curves, { id, kind: "line", start, end: stop }] };
  return { id, doc: withSketch(after, sketch) };
}

/** The sketch without this curve, and without the points only it used. The counter stays where it is. */
export function deleteCurve(doc: DesignDocument, sketchId: string, curveId: string): DesignDocument {
  const sketch = sketchIn(doc, sketchId);
  if (!sketch.curves.some((c) => c.id === curveId)) throw new Error(`sketch ${sketchId} has no curve ${curveId}`);
  const curves = sketch.curves.filter((c) => c.id !== curveId);
  const used = new Set(curves.flatMap((c) => [c.start, c.end]));
  return withSketch(doc, { ...sketch, curves, points: sketch.points.filter((p) => used.has(p.id)) });
}

/** The sketch with one point moved; every line ending there follows it, since lines name points. */
export function movePoint(doc: DesignDocument, sketchId: string, pointId: string, x: number, y: number): DesignDocument {
  const sketch = sketchIn(doc, sketchId);
  if (!sketch.points.some((p) => p.id === pointId)) throw new Error(`sketch ${sketchId} has no point ${pointId}`);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`a sketch point needs x and y in mm, not ${x}, ${y}`);
  return withSketch(doc, { ...sketch, points: sketch.points.map((p) => (p.id === pointId ? { ...p, x, y } : p)) });
}

/** The sketch's lines as the kernel takes them, rebuilt from point ids. */
export function sketchLines(sketch: Sketch): SketchLine[] {
  const at = new Map(sketch.points.map((p) => [p.id, [p.x, p.y] as [number, number]]));
  return sketch.curves.map((c) => ({ a: at.get(c.start)!, b: at.get(c.end)! }));
}

/** The sketch's one closed outline, from the kernel; a sketch that makes none is refused with the kernel's reason. */
export async function sketchOutline(kernel: KernelCalls, doc: DesignDocument, sketchId: string): Promise<Outline> {
  const sketch = sketchIn(doc, sketchId);
  const result = await kernel.call("sketch_outline", sketchLines(sketch));
  if ("open" in result) throw new Error(`${sketchItem(doc, sketchId).provenance.self.label} has no closed outline: ${result.open}`);
  return result.closed;
}
