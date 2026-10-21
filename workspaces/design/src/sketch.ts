// Sketch edits on the Design document (step 21b, docs/document-model.md
// section 3): each is a pure function from one document to the next, so
// the workspace records each as one undo step with its label (SKETCH_STEPS)
// and the history needs no inverse for any of them. New ids come from the
// document's counter and are never reused, even after a delete.
//
// The geometry a sketch makes is never stored: its one closed outline is
// found by the kernel (sketch_outline, step 21a; circles from 22b, arcs
// from 23a) from the curves rebuilt from point ids, every time it is asked
// for.

import type { Feature, KernelCalls, Outline, Plane, SketchArc, SketchCircle, SketchLine } from "@fission/core";
import { XY_PLANE } from "@fission/core";
import { faceFeature, isFacePlane, squared, type SketchFace, type SketchPlacement } from "./face-sketch.ts";
import { curvePoints, insertAt, insertItem, isSketchItem, profileLabel, shown, type DesignDocument, type ReadyProfile, type Sketch, type SketchLineCurve, type SketchPlane } from "./document.ts";
import { readProfileReference } from "./references.ts";

/** The undo step each sketch edit is recorded as. */
export const SKETCH_STEPS = { create: "Create sketch", draw: "Draw line", rectangle: "Draw rectangle", circle: "Draw circle", arc: "Draw arc", centre: "Draw centre arc", tangent: "Draw tangent arc", delete: "Delete line", move: "Move point" } as const;

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

/** Where a sketch plane reference is; a face id joins these at step 24. */
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

/**
 * What an outline reference names in `doc` (25c1): a ready-made profile,
 * or a sketch with at least one curve (an empty one has nothing to hand
 * over); null for anything else.
 */
export function outlineSourceOf(ref: { kind: string; id: string }, doc: DesignDocument): { kind: "profile"; profile: ReadyProfile; label: string } | { kind: "sketch"; sketch: Sketch; label: string } | null {
  const id = readProfileReference(ref);
  if (id === null) return null;
  const profile = doc.profiles.find((p) => p.id === id);
  if (profile) return { kind: "profile", profile, label: profileLabel(profile) };
  const sketch = doc.sketches.find((s) => s.id === id);
  if (!sketch || sketch.curves.length === 0) return null;
  return { kind: "sketch", sketch, label: sketchItem(doc, sketch.id).provenance.self.label };
}

/** The sketch's timeline item. */
export function sketchItem(doc: DesignDocument, id: string): Feature {
  const f = doc.timeline.features.find((x) => x.id === id && isSketchItem(x));
  if (!f) throw new Error(`there is no sketch ${id} in the timeline`);
  return f;
}

/**
 * A new empty sketch on a plane, put in the timeline at the marker (insertItem). Its name is
 * "Sketch n", n one more than the sketches there are, skipping a name in
 * use; the name is part of its summary and stays when others are added.
 */
export function addSketch(doc: DesignDocument, plane: SketchPlane = "XY"): { doc: DesignDocument; id: string } {
  if (!PLANES[plane]) throw new Error(`${shown(plane)} is not a plane a sketch can be on (XY, XZ or YZ)`);
  return newSketch(doc, (n) => `Sketch ${n} on the ${plane} plane`, { plane }, []);
}

/**
 * A new empty sketch on a flat face of the body `face.feature` built (step
 * 26c), put in at the marker like `addSketch`: its plane the face's name
 * (`face.plane`, as a reference names it, face-sketch.ts `facePlane`),
 * its content keeping the frame and side it is drawn with (`drawnFrame` on
 * the face as built now), depending on that feature so it can't be dragged
 * before it.
 */
export function addFaceSketch(doc: DesignDocument, face: { plane: string; feature: string }, drawn: SketchPlacement): { doc: DesignDocument; id: string } {
  if (!isFacePlane(face.plane) || faceFeature(face.plane) !== face.feature) throw new Error(`${shown(face.plane)} is not a face of ${shown(face.feature)}`);
  const on = doc.timeline.features.find((f) => f.id === face.feature);
  if (!on || isSketchItem(on)) throw new Error(`there is no solid item ${shown(face.feature)} to sketch on`);
  if (doc.timeline.features.indexOf(on) >= insertAt(doc)) throw new Error(`${on.provenance.self.label} comes after the rollback marker, so a sketch put in at the marker can't be on it`);
  const frame = squared(drawn.plane);
  if (frame === null || (drawn.side !== 1 && drawn.side !== -1)) throw new Error("a sketch on a face needs a frame and a side of 1 or -1");
  const label = on.provenance.self.label;
  return newSketch(doc, (n) => `Sketch ${n} on a face of ${label}`, { plane: face.plane }, [face.feature], [{ workspace: "design", id: face.feature, label }], { frame, side: drawn.side });
}

function newSketch(doc: DesignDocument, summary: (n: number) => string, parameters: Feature["intent"]["parameters"], dependsOn: string[], from: Feature["provenance"]["from"] = [], face?: SketchFace): { doc: DesignDocument; id: string } {
  const [id, next] = take(doc, "sketch");
  const names = new Set(doc.timeline.features.filter(isSketchItem).map((f) => f.intent.summary.split(" on ")[0]));
  let n = doc.sketches.length + 1;
  while (names.has(`Sketch ${n}`)) n++;
  const item: Feature = {
    id,
    intent: { type: "sketch", parameters, summary: summary(n) },
    provenance: { self: { workspace: "design", id, label: `Sketch ${n}` }, from },
    dependsOn,
    suppressed: false,
  };
  return {
    id,
    doc: { ...next, sketches: [...doc.sketches, face ? { id, points: [], curves: [], constraints: [], face } : { id, points: [], curves: [], constraints: [] }], timeline: insertItem(doc, item) },
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
  if (typeof from === "string" && from === to) throw new Error(`a line can't start and end at the same point ${from}`);
  const [start, first] = pointFor({ doc, sketch: sketchIn(doc, sketchId) }, from);
  const [stop, drawn] = pointFor(first, to);
  const [id, after] = take(withSketch(drawn.doc, drawn.sketch), "line");
  const sketch: Sketch = { ...drawn.sketch, curves: [...drawn.sketch.curves, { id, kind: "line", start, end: stop }] };
  return { id, doc: withSketch(after, sketch) };
}

/**
 * The point id for a line end or a circle's centre: an existing point of
 * the sketch, checked, or a new point at x, y taking the next id.
 */
function pointFor(drawn: { doc: DesignDocument; sketch: Sketch }, at: LineEnd): [string, { doc: DesignDocument; sketch: Sketch }] {
  const { doc, sketch } = drawn;
  if (typeof at === "string") {
    if (!sketch.points.some((p) => p.id === at)) throw new Error(`sketch ${sketch.id} has no point ${at}`);
    return [at, drawn];
  }
  const [x, y] = at;
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`a sketch point needs x and y in mm, not ${x}, ${y}`);
  const [id, next] = take(withSketch(doc, sketch), "point");
  return [id, { doc: next, sketch: { ...sketch, points: [...sketch.points, { id, x, y }] } }];
}

/**
 * A circle round `centre` with radius `radius` in mm (step 22b). A centre
 * given as a point id is shared (a circle round a line's corner); one given
 * as coordinates is a new point, taking its id before the circle's. A
 * radius that is not a number above 0 is refused here; the kernel holds
 * the size limits when it looks for the outline, as it does for lines.
 */
export function drawCircle(doc: DesignDocument, sketchId: string, centre: LineEnd, radius: number): { doc: DesignDocument; id: string } {
  const start = { doc, sketch: sketchIn(doc, sketchId) };
  if (!Number.isFinite(radius) || radius <= 0) throw new Error(`a circle needs a radius in mm above 0, not ${radius}`);
  const [at, drawn] = pointFor(start, centre);
  const [id, after] = take(withSketch(drawn.doc, drawn.sketch), "circle");
  const sketch: Sketch = { ...drawn.sketch, curves: [...drawn.sketch.curves, { id, kind: "circle", centre: at, radius }] };
  return { id, doc: withSketch(after, sketch) };
}

/**
 * An arc from `start` to `end`, counter-clockwise round `centre` (step
 * 23a; the tools are 23b and 23c). Each point given as an id is shared (an
 * arc continuing a line shares its end); one given as coordinates is a new
 * point, taking ids in the order start, end, centre, before the arc's. The
 * same point for both ends, or for an end and the centre, is refused here;
 * the kernel holds the rest (the centre midway between the ends, the
 * sizes) when it looks for the outline.
 */
export function drawArc(doc: DesignDocument, sketchId: string, start: LineEnd, end: LineEnd, centre: LineEnd): { doc: DesignDocument; id: string } {
  if (typeof start === "string" && start === end) throw new Error(`an arc can't start and end at the same point ${start}`);
  if (typeof centre === "string" && (centre === start || centre === end)) throw new Error(`an arc can't be round its own end ${centre}`);
  let drawn = { doc, sketch: sketchIn(doc, sketchId) };
  const ids: string[] = [];
  for (const p of [start, end, centre]) {
    const [id, next] = pointFor(drawn, p);
    ids.push(id);
    drawn = next;
  }
  const [id, after] = take(withSketch(drawn.doc, drawn.sketch), "arc");
  const sketch: Sketch = { ...drawn.sketch, curves: [...drawn.sketch.curves, { id, kind: "arc", start: ids[0], end: ids[1], centre: ids[2] }] };
  return { id, doc: withSketch(after, sketch) };
}

/** The sketch's point exactly at `at`, by id, or null. */
export function pointAt(sketch: Sketch, at: readonly [number, number]): string | null {
  return sketch.points.find((p) => p.x === at[0] && p.y === at[1])?.id ?? null;
}

/**
 * A rectangle with opposite corners `a` and `c`, its sides along the
 * sketch's x and y: four lines a → (c.x, a.y) → c → (a.x, c.y) → a, drawn
 * as the line tool would draw them click by click, so each corner is one
 * shared point. A corner landing exactly on a point the sketch already has
 * shares that point (the line tool's rule). Corners on one row or column
 * have no width or no height and are refused.
 */
export function drawRectangle(doc: DesignDocument, sketchId: string, a: readonly [number, number], c: readonly [number, number]): { doc: DesignDocument; ids: string[] } {
  const sketch = sketchIn(doc, sketchId);
  for (const [x, y] of [a, c]) if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`a sketch point needs x and y in mm, not ${x}, ${y}`);
  if (a[0] === c[0] || a[1] === c[1]) throw new Error(`a rectangle needs a width and a height: its corners (${a[0]}, ${a[1]}) and (${c[0]}, ${c[1]}) are on one ${a[0] === c[0] ? "column" : "row"}`);
  const corners: LineEnd[] = ([a, [c[0], a[1]], c, [a[0], c[1]]] as const).map((p) => pointAt(sketch, p) ?? p);
  const ids: string[] = [];
  let next = doc;
  for (let i = 0; i < 4; i++) {
    const drawn = drawLine(next, sketchId, corners[i], corners[(i + 1) % 4]);
    next = drawn.doc;
    ids.push(drawn.id);
    const line = sketchIn(next, sketchId).curves.find((x) => x.id === drawn.id) as SketchLineCurve;
    corners[i] = line.start;
    corners[(i + 1) % 4] = line.end;
  }
  return { doc: next, ids };
}

/** The sketch without this curve, and without the points only it used. The counter stays where it is. */
export function deleteCurve(doc: DesignDocument, sketchId: string, curveId: string): DesignDocument {
  const sketch = sketchIn(doc, sketchId);
  if (!sketch.curves.some((c) => c.id === curveId)) throw new Error(`sketch ${sketchId} has no curve ${curveId}`);
  const curves = sketch.curves.filter((c) => c.id !== curveId);
  const used = new Set(curves.flatMap(curvePoints));
  return withSketch(doc, { ...sketch, curves, points: sketch.points.filter((p) => used.has(p.id)) });
}

/**
 * The sketch with one point moved; every line ending there and circle or
 * arc using it follows, since curves name points. Until constraints (29)
 * nothing else moves with it, so moving one end of an arc leaves its
 * centre off the midway line and the kernel then says so.
 */
export function movePoint(doc: DesignDocument, sketchId: string, pointId: string, x: number, y: number): DesignDocument {
  const sketch = sketchIn(doc, sketchId);
  if (!sketch.points.some((p) => p.id === pointId)) throw new Error(`sketch ${sketchId} has no point ${pointId}`);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`a sketch point needs x and y in mm, not ${x}, ${y}`);
  return withSketch(doc, { ...sketch, points: sketch.points.map((p) => (p.id === pointId ? { ...p, x, y } : p)) });
}

/** The sketch's lines as the kernel takes them, rebuilt from point ids (its circles and arcs are in `sketchCurves`). */
export function sketchLines(sketch: Sketch): SketchLine[] {
  return sketchCurves(sketch).lines;
}

/** The sketch's lines, circles and arcs as the kernel's sketch_outline takes them, rebuilt from point ids, each in the sketch's order. */
export function sketchCurves(sketch: Sketch): { lines: SketchLine[]; circles: SketchCircle[]; arcs: SketchArc[] } {
  const at = new Map(sketch.points.map((p) => [p.id, [p.x, p.y] as [number, number]]));
  const lines: SketchLine[] = [];
  const circles: SketchCircle[] = [];
  const arcs: SketchArc[] = [];
  for (const c of sketch.curves) {
    if (c.kind === "line") lines.push({ a: at.get(c.start)!, b: at.get(c.end)! });
    else if (c.kind === "circle") circles.push({ centre: at.get(c.centre)!, radius: c.radius });
    else arcs.push({ start: at.get(c.start)!, end: at.get(c.end)!, centre: at.get(c.centre)! });
  }
  return { lines, circles, arcs };
}

/** Asks the kernel what the sketch's lines, circles and arcs make. */
export function askOutline(kernel: KernelCalls, curves: ReturnType<typeof sketchCurves>) {
  return kernel.call("sketch_outline", curves.lines, curves.circles, curves.arcs);
}

/** The sketch's one closed outline, from the kernel; a sketch that makes none is refused with the kernel's reason. */
export async function sketchOutline(kernel: KernelCalls, doc: DesignDocument, sketchId: string): Promise<Outline> {
  const sketch = sketchIn(doc, sketchId);
  const result = await askOutline(kernel, sketchCurves(sketch));
  if ("open" in result) throw new Error(`${sketchItem(doc, sketchId).provenance.self.label} has no closed outline: ${result.open}`);
  return result.closed;
}
