// Tests written to kill the mutants StrykerJS found surviving in the file
// reader's checks of face sketches, pins (26f, 27c) and projections (27d)
// (packages/testing/stryker/run.sh design, 2026-10-22). Each test names the
// change to the code it catches. Mutants no caller can tell apart are in
// packages/testing/stryker/explained.json with the reason.
import { test } from "node:test";
import assert from "node:assert/strict";
import { partDocument, readDesignDocument, type DesignDocument } from "../src/document.ts";
import { drawnFrame, facePlane } from "../src/face-sketch.ts";
import { addFaceSketch, addSketch, drawCircle, drawLine, projectEdges } from "../src/sketch.ts";
import { extrudeSketch } from "../src/extrude.ts";

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
/** Refused with exactly this message (not a TypeError from reading into a value of the wrong kind). */
const refused = (data: unknown, message: string) =>
  assert.throws(() => readDesignDocument(data), (e: Error) => e.constructor === Error && e.message === message, message);
/** Opens, and reads back as it was. */
const opens = (data: DesignDocument) => assert.deepEqual(readDesignDocument(clone(data)), data);

/** A circle of radius 5 round (40, 30) in a sketch on the box's top (sketch-2), its centre point-3. */
function onTop() {
  const doc = partDocument("box", 40, 30, 20);
  const made = addFaceSketch(doc, { plane: facePlane("feature-1", "top"), feature: "feature-1" }, drawnFrame([0, 0, 1], [20, 15, 20]));
  return { doc: drawCircle(made.doc, made.id, [40, 30], 5).doc, id: made.id };
}
const withSketch = (doc: DesignDocument, id: string, change: (s: Record<string, unknown>) => Record<string, unknown>) => ({ ...doc, sketches: doc.sketches.map((s) => (s.id === id ? (change(clone(s)) as never) : s)) });
const centre = (doc: DesignDocument, id: string) => (doc.sketches.find((s) => s.id === id)!.curves[0] as { centre: string }).centre;

test("a face sketch drawn facing against its frame (side −1) opens; one with side 0 is refused (catches `face.side !== -1` made always true, and −1 made +1)", () => {
  const { doc, id } = onTop();
  const back = withSketch(doc, id, (s) => ({ ...s, face: { ...(s.face as object), side: -1 } }));
  opens(back);
  refused(withSketch(doc, id, (s) => ({ ...s, face: { ...(s.face as object), side: 0 } })), `Design sketch ${id}'s side must be 1 or -1, not 0`);
});

test("a kept shape placed with side 1 opens, and with side −1, but not 0 (catches `p.side !== 1` made always true)", () => {
  // An XZ sketch's rectangle, extruded, its sketch deleted: the extrude keeps its shape and where it lay (26c).
  const xz = addSketch(partDocument("box", 40, 30, 20), "XZ");
  const drawn = drawLine(drawLine(drawLine(drawLine(xz.doc, xz.id, [0, 0], [10, 0]).doc, xz.id, "point-4", [10, 10]).doc, xz.id, "point-6", [0, 10]).doc, xz.id, "point-8", "point-3").doc;
  const up = extrudeSketch(drawn, xz.id, 5);
  const s = up.doc.sketches.find((x) => x.id === xz.id)!;
  const plane = { origin: [0, 0, 0], xAxis: [1, 0, 0], normal: [0, -1, 0] };
  const kept = (side: number) => ({ ...up.doc, kept: { [up.id]: { points: s.points, curves: s.curves, placement: { plane, side } } } }) as unknown as DesignDocument;
  opens(kept(1));
  opens(kept(-1));
  refused(kept(0), `Design feature ${up.id}'s kept shape's placement's side must be 1 or -1, not 0`);
});

test("pins: a null pin, a name that is a number, refused in words; a centre's pin and a middle's pin open (catches the record and string checks dropped, \"centre\" and \"&\" emptied)", () => {
  const { doc, id } = onTop();
  const point = centre(doc, id);
  const pinned = (pins: unknown) => withSketch(doc, id, (s) => ({ ...s, pins }));
  refused(pinned([null]), `Design sketch ${id}'s pin 1 is not on one of the sketch's points`);
  refused(pinned([{ point, kind: "endpoint", name: 5 }]), `Design sketch ${id}'s pin on ${point} has no vertex name`);
  refused(pinned([{ point, kind: "midpoint", name: 5 }]), `Design sketch ${id}'s pin on ${point} has no edge name`);
  // A round edge's centre, and an edge's middle: names without "&", which open.
  opens(pinned([{ point, kind: "centre", name: "side+top" }]) as DesignDocument);
  opens(pinned([{ point, kind: "midpoint", name: "right+top" }]) as DesignDocument);
  // A middle's name holding "&" (a vertex's) is refused.
  refused(pinned([{ point, kind: "midpoint", name: "a&b" }]), `Design sketch ${id}'s pin on ${point} has no edge name`);
});

/** A box, a sketch on XY after it (sketch-2), the box's top front edge projected as projection-3. */
function projected() {
  const made = addSketch(partDocument("box", 40, 30, 20));
  const p = projectEdges(made.doc, made.id, [{ feature: "feature-1", edge: "front+top", shape: { kind: "line", a: [0, 0], b: [40, 0] } }]);
  return { doc: p.doc, id: made.id, projection: p.ids[0] };
}

test("projections: each refusal names the sketch and the projection; a feature or an edge that is a number is refused in words (catches the messages emptied and the string checks dropped)", () => {
  const { doc, id, projection } = projected();
  const one = doc.sketches.find((s) => s.id === id)!.projected![0];
  const list = (projections: unknown) => withSketch(doc, id, (s) => ({ ...s, projected: projections }));
  refused(list([]), `Design sketch ${id}'s projections must be a list of at least one, or left out`);
  refused(list([{ ...one, feature: 7 }]), `Design sketch ${id}'s projection ${projection} names no feature`);
  refused(list([{ ...one, edge: 5 }]), `Design sketch ${id}'s projection ${projection} has no edge name`);
  refused(list([{ ...one, made: 4 }]), `Design sketch ${id}'s projection ${projection} made nothing`);
});

test("a sketch listed twice is checked by its first entry, so a broken second one is refused for its repeated ids, not its pins (catches `!sketchIds.has(s.id)` made always true: the last entry checked)", () => {
  const made = addSketch(partDocument("box", 40, 30, 20));
  const doc = drawCircle(made.doc, made.id, [1, 1], 1).doc;
  const s = doc.sketches[0];
  const centrePoint = (s.curves[0] as { centre: string }).centre;
  refused({ ...doc, sketches: [s, { ...s, pins: [] }] }, `Design id ${centrePoint} is used twice`);
});
