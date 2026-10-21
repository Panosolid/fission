// Step 26f: a face's edges in a sketch drawn on it (face-edges.ts), the
// parts the kernel isn't needed for: the points a sketch can snap to and
// their names, where a pin is now, the snap onto them (snap.ts), pinning
// a new point (sketch.ts pinNewPoints), dropping a pin, and the data's
// checks when a file is opened (document.ts). On the real kernel, against
// the naming model: packages/testing/journeys/naming.journey.ts; the app:
// packages/testing/journeys/face-edges.journey.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyProject, projectFromJson, projectToJson, type BodyView, type Plane } from "@fission/core";
import { partDocument, readDesignDocument, type DesignDocument } from "../src/document.ts";
import { faceEdgeTargets, inSketch, pinNow, pointWords, vertexNames, type EdgeTarget, type SketchPin } from "../src/face-edges.ts";
import { drawnFrame, facePlane } from "../src/face-sketch.ts";
import { nameBody } from "../src/naming.ts";
import { addFaceSketch, deleteCurve, drawCircle, drawLine, drawRectangle, movePoint, pinNewPoints } from "../src/sketch.ts";
import { SNAP_PIXELS, snapLabel, snapPointer, snapTargets } from "../src/snap.ts";
import { startTool } from "../src/sketch-tool.ts";
import { followedDoc, type TimelineBuild } from "../src/rebuild.ts";
import { boxView, cylinderView } from "./views.ts";

const DESIGN = [{ id: "design" as const, readData: readDesignDocument }];
const plane = (origin: number[], xAxis: number[], normal: number[]): Plane => ({ origin: origin as Plane["origin"], xAxis: xAxis as Plane["xAxis"], normal: normal as Plane["normal"] });
const TOP = plane([0, 0, 20], [1, 0, 0], [0, 0, 1]);
const box = (w = 40, d = 30, h = 20) => {
  const view = boxView(w, d, h);
  return { view, names: nameBody("feature-1", view, () => null) };
};
const at = (ts: EdgeTarget[]) => ts.map((t) => `${t.kind} ${t.at} ${t.name}`);

test("hand-worked: a point in the sketch is its offset from the frame's origin along x and along normal × x", () => {
  // Frame at (1, 2, 3), x (0.6, 0.8, 0), normal z: y = z × x = (−0.8, 0.6, 0).
  // The world point origin + 5x + 2y = (1 + 3 − 1.6, 2 + 4 + 1.2, 3) = (2.4, 7.2, 3) reads (5, 2).
  const p = inSketch([2.4, 7.2, 3], plane([1, 2, 3], [0.6, 0.8, 0], [0, 0, 1]));
  assert.ok(Math.abs(p[0] - 5) <= 1e-12 && Math.abs(p[1] - 2) <= 1e-12, `${p}`);
  // The top of a 40 × 30 × 20 box: (40, 30, 20) is (40, 30), exactly; −0 never comes out.
  assert.deepEqual(inSketch([40, 30, 20], TOP), [40, 30]);
  assert.ok(Object.is(inSketch([0, 0, 20], TOP)[0], 0));
});

test("hand-worked: a box's corners are named by the three edges meeting there", () => {
  const { view, names } = box();
  const { vertices, shared } = vertexNames(view, names);
  // Corner 4, (0, 0, 20): edges 4 (front+top), 7 (left+top) and 9 (front+left), sorted and joined.
  assert.equal(vertices[4], "front+left&front+top&left+top");
  // Corner 7, (40, 30, 20): edges 5 (right+top), 6 (back+top) and 11 (back+right).
  assert.equal(vertices[7], "back+right&back+top&right+top");
  assert.equal(new Set(vertices).size, 8);
  assert.equal(shared.size, 0);
});

test("hand-worked: the top of a 40 × 30 × 20 box offers its four corners and four middles, edge by edge, in the sketch's (x, y)", () => {
  const { view, names } = box();
  // Top is face 1; its edges 4 (corners 4, 5), 5 (5, 7), 6 (6, 7), 7 (4, 6), each corner once.
  assert.deepEqual(at(faceEdgeTargets(view, names, 1, TOP)), [
    "endpoint 0,0 front+left&front+top&left+top",
    "endpoint 40,0 front+right&front+top&right+top",
    "midpoint 20,0 front+top",
    "endpoint 40,30 back+right&back+top&right+top",
    "midpoint 40,15 right+top",
    "endpoint 0,30 back+left&back+top&left+top",
    "midpoint 20,30 back+top",
    "midpoint 0,15 left+top",
  ]);
  // The front (face 2) on the XZ frame (x = X, y = −Y × X = Z): corners (0, 0), (40, 0), (0, 20), (40, 20).
  const front = faceEdgeTargets(view, names, 2, plane([0, 0, 0], [1, 0, 0], [0, -1, 0]));
  assert.deepEqual(
    front.map((t) => `${t.kind} ${t.at}`),
    ["endpoint 0,0", "endpoint 40,0", "midpoint 20,0", "endpoint 0,20", "endpoint 40,20", "midpoint 20,20", "midpoint 40,10", "midpoint 0,10"],
  );
  // The bottom seen from below (26c: its frame faces +Z, side −1, so (x, y) is the world's).
  const bottom = faceEdgeTargets(view, names, 0, plane([0, 0, 0], [1, 0, 0], [0, 0, 1]));
  assert.deepEqual(bottom.filter((t) => t.kind === "endpoint").map((t) => `${t.at}`).sort(), ["0,0", "0,30", "40,0", "40,30"]);
});

test("hand-worked: a cylinder's top offers only its rim's centre: a whole circle has no ends and no middle", () => {
  const view = cylinderView(5, 10);
  const names = nameBody("feature-1", view, () => null);
  assert.deepEqual(at(faceEdgeTargets(view, names, 1, plane([0, 0, 10], [1, 0, 0], [0, 0, 1]))), ["centre 0,0 side+top"]);
  assert.deepEqual(pinNow({ point: "p", kind: "midpoint", name: "side+top" }, view, names, TOP), { cause: "point-lost" });
});

test("hand-worked: a pin is found by name where its corner is now, and is lost or ambiguous, never moved to another", () => {
  const corner: SketchPin = { point: "point-3", kind: "endpoint", name: "back+right&back+top&right+top" };
  const before = box();
  assert.deepEqual(pinNow(corner, before.view, before.names, TOP), { at: [40, 30] });
  // The box made 60 wide: the back right corner is at (60, 30); the right edge's middle at (60, 15).
  const wider = box(60);
  assert.deepEqual(pinNow(corner, wider.view, wider.names, TOP), { at: [60, 30] });
  assert.deepEqual(pinNow({ point: "p", kind: "midpoint", name: "right+top" }, wider.view, wider.names, TOP), { at: [60, 15] });
  // A name the body hasn't got: lost; a line's edge asked for its centre: lost.
  assert.deepEqual(pinNow({ ...corner, name: "back+left&back+top&right+top" }, wider.view, wider.names, TOP), { cause: "point-lost" });
  assert.deepEqual(pinNow({ point: "p", kind: "centre", name: "right+top" }, wider.view, wider.names, TOP), { cause: "point-lost" });
  // Two vertices with one name (two curves meeting at both ends, a half disc): ambiguous, so never one of them.
  const lens = {
    vertex_points: [[10, 0, 5], [-10, 0, 5]],
    edge_vertices: [[0, 1], [1, 0], [0, 0], [1, 1]],
    edge_faces: [[1, 2], [1, 3], [2, 3], [3, 2]],
    edge_middles: [[0, 0, 5], [0, 10, 5], [10, 0, 2.5], [-10, 0, 2.5]],
    edge_centres: [null, [0, 0, 5], null, null],
  } as unknown as BodyView;
  // Hand-named: the end cap's edges along the line and the arc, and the two uprights between the sides, one each way.
  const lensNames = { feature: "feature-2", faces: [], edges: ["end+side:line-1", "end+side:arc-2", "side:line-1>side:arc-2", "side:arc-2>side:line-1"], shared: { faces: new Map(), edges: new Map() } };
  const v = vertexNames(lens, lensNames);
  assert.deepEqual(v.vertices, [null, null]);
  assert.deepEqual([...v.shared], [["end+side:arc-2&end+side:line-1&side:arc-2+side:line-1", 2]]);
  assert.deepEqual(pinNow({ point: "p", kind: "endpoint", name: "end+side:arc-2&end+side:line-1&side:arc-2+side:line-1" }, lens, lensNames, TOP), { cause: "point-ambiguous" });
  // An arc's middle and centre are offered; its ends are not, the corners being unnamed.
  assert.deepEqual(at(faceEdgeTargets(lens, lensNames, 1, plane([0, 0, 5], [1, 0, 0], [0, 0, 1]))), ["midpoint 0,0 end+side:line-1", "midpoint 0,10 end+side:arc-2", "centre 0,0 end+side:arc-2"]);
});

test("the warning's words: one point or several, lost or ambiguous", () => {
  assert.equal(pointWords("point-lost", 1, "Sketch 2"), "Sketch 2: a point snapped to an edge of its face has lost that edge, so it stays where it was");
  assert.equal(pointWords("point-lost", 3, "Sketch 2"), "Sketch 2: 3 points snapped to edges of its face have lost their edges, so they stay where they were");
  assert.equal(pointWords("point-ambiguous", 1, "Sketch 2"), "Sketch 2: a point snapped to an edge of its face is on an edge that is now more than one edge, so it stays where it was rather than guess");
});

// ---- The snap ----

const targets: EdgeTarget[] = [
  { at: [40, 30], kind: "endpoint", name: "back+right&back+top&right+top" },
  { at: [40, 15], kind: "midpoint", name: "right+top" },
];

/** A sketch on the box's top with nothing drawn, and its id. */
function onTop(): { doc: DesignDocument; id: string } {
  const doc = partDocument("box", 40, 30, 20);
  return addFaceSketch(doc, { plane: facePlane("feature-1", "top"), feature: "feature-1" }, drawnFrame([0, 0, 1], [20, 15, 20]));
}

test("the pointer snaps onto a face's corner within SNAP_PIXELS: 0.9 × reaches it, 1.1 × doesn't", () => {
  const { doc, id } = onTop();
  const sketch = doc.sketches.find((s) => s.id === id)!;
  const tool = startTool("line", id);
  const t = snapTargets(sketch, tool, targets);
  // A pixel 0.1 mm wide: the reach is SNAP_PIXELS · 0.1 = 1 mm.
  const reach = SNAP_PIXELS * 0.1;
  const near = snapPointer([40 + 0.9 * reach, 30], [40.9, 30], t, 0.1);
  assert.deepEqual(near, { kind: "endpoint", at: [40, 30], edge: true });
  assert.equal(snapLabel(near), "edge endpoint 40,30");
  assert.deepEqual(snapPointer([40 + 1.1 * reach, 30], [41.1, 30], t, 0.1), { kind: "grid", at: [41.1, 30] });
  // Never a column or a row from them: level with the corner, 5 mm off, stays on the grid.
  assert.deepEqual(snapPointer([45, 30.05], [45, 30.05], t, 0.1).kind, "grid");
  // The middle of the right edge, nearer than the corner.
  assert.deepEqual(snapPointer([40.2, 15.3], [40.2, 15.3], t, 0.1), { kind: "midpoint", at: [40, 15], edge: true });
});

test("a sketch's own point on a face's corner is snapped to as the sketch's (the click shares it), and a tool's own click is never a target", () => {
  const { doc, id } = onTop();
  const drawn = drawLine(doc, id, [40, 30], [10, 10]).doc;
  const sketch = drawn.sketches.find((s) => s.id === id)!;
  const snap = snapPointer([40.1, 30], [40.1, 30], snapTargets(sketch, startTool("line", id), targets), 0.1);
  assert.deepEqual(snap, { kind: "endpoint", at: [40, 30] });
  // A rectangle's first corner on the face's corner: the second click can't land there.
  const rect = { ...startTool("rectangle", id), corner: [40, 30] } as ReturnType<typeof startTool>;
  assert.ok(!snapTargets(sketch, rect, targets).points.some((p) => p.pin && p.at[0] === 40 && p.at[1] === 30));
});

// ---- Pinning ----

test("hand-worked: a new point exactly on a face's corner or middle is pinned there; one elsewhere, or already there, is not", () => {
  const { doc, id } = onTop();
  const c = drawCircle(doc, id, [40, 30], 5);
  const centre = (c.doc.sketches.find((s) => s.id === id)!.curves[0] as { centre: string }).centre;
  const pinned = pinNewPoints(doc, c.doc, id, targets);
  assert.deepEqual(pinned.sketches.find((s) => s.id === id)!.pins, [{ point: centre, kind: "endpoint", name: "back+right&back+top&right+top" }]);
  // A second circle round the same point shares it: nothing new to pin.
  const again = drawCircle(pinned, id, centre, 2);
  assert.equal(pinNewPoints(pinned, again.doc, id, targets), again.doc);
  // A circle a hair off the corner: not on it, not pinned (exact coordinates only).
  const off = drawCircle(doc, id, [40, 30 + 1e-9], 5);
  assert.equal(pinNewPoints(doc, off.doc, id, targets), off.doc);
  // No targets (an origin plane): the document as it was.
  assert.equal(pinNewPoints(doc, c.doc, id, []), c.doc);
  // A rectangle from corner to corner of the top: (40, 0) and (0, 30) land on corners too, all pinned (the rule is where a point lands).
  const all: EdgeTarget[] = [...targets, { at: [0, 0], kind: "endpoint", name: "a" }, { at: [40, 0], kind: "endpoint", name: "b" }, { at: [0, 30], kind: "endpoint", name: "c" }];
  const r = drawRectangle(doc, id, [0, 0], [40, 30]);
  assert.equal(pinNewPoints(doc, r.doc, id, all).sketches.find((s) => s.id === id)!.pins!.length, 4);
});

test("hand-worked: a rebuild's followed points are taken into the document, and a document whose points are all where they were is the same object", () => {
  // A circle centred on the top's back right corner (40, 30), the box then
  // 60 wide: the rebuild found the corner at (60, 30), so the centre goes
  // there; the circle's radius point (45, 30) is not pinned and stays.
  const { doc, id } = onTop();
  const c = drawCircle(doc, id, [40, 30], 5);
  const pinned = pinNewPoints(doc, c.doc, id, targets);
  const sketch = pinned.sketches.find((s) => s.id === id)!;
  const centre = (sketch.curves[0] as { centre: string }).centre;
  const build = (results: TimelineBuild["results"]) => ({ results }) as TimelineBuild;
  const moved = followedDoc(pinned, build({ [id]: { status: "built", pinned: [{ point: centre, at: [60, 30] }] } }));
  const points = (d: DesignDocument) => d.sketches.find((s) => s.id === id)!.points.map((p) => [p.id, p.x, p.y]);
  assert.deepEqual(points(moved), points(pinned).map(([p, x, y]) => (p === centre ? [p, 60, 30] : [p, x, y])));
  assert.deepEqual(moved.sketches.find((s) => s.id === id)!.pins, sketch.pins, "still pinned");
  // Found where it is: nothing to take in, the same document.
  assert.equal(followedDoc(pinned, build({ [id]: { status: "built", pinned: [{ point: centre, at: [40, 30] }] } })), pinned);
  // Lost (no place found), greyed, or not built: held where it is.
  assert.equal(followedDoc(pinned, build({ [id]: { status: "built", pinned: [] } })), pinned);
  assert.equal(followedDoc(pinned, build({ [id]: { status: "greyed", by: "feature-1" } })), pinned);
  assert.equal(followedDoc(pinned, build({})), pinned);
});

test("a pinned point moved by hand, or left by every curve, loses its pin; the list goes when it is empty", () => {
  const { doc, id } = onTop();
  const c = drawCircle(doc, id, [40, 30], 5);
  const pinned = pinNewPoints(doc, c.doc, id, targets);
  const sketch = () => pinned.sketches.find((s) => s.id === id)!;
  const centre = sketch().pins![0].point;
  const moved = movePoint(pinned, id, centre, 10, 10).sketches.find((s) => s.id === id)!;
  assert.ok(!Object.hasOwn(moved, "pins"));
  const gone = deleteCurve(pinned, id, sketch().curves[0].id).sketches.find((s) => s.id === id)!;
  assert.ok(!Object.hasOwn(gone, "pins"));
  // Another point moved: the pin stays.
  const line = drawLine(pinned, id, [0, 0], [5, 5]);
  const other = line.doc.sketches.find((s) => s.id === id)!.points.find((p) => p.x === 0)!.id;
  assert.equal(movePoint(line.doc, id, other, 1, 1).sketches.find((s) => s.id === id)!.pins!.length, 1);
});

test("pins survive save and open, and every way a file can break them is refused", () => {
  const { doc, id } = onTop();
  const c = drawCircle(doc, id, [40, 30], 5);
  const pinned = pinNewPoints(doc, c.doc, id, targets);
  const save = (d: unknown) => projectToJson({ ...emptyProject("Pins"), workspaces: { design: d as DesignDocument } });
  const open = (d: unknown) => projectFromJson(save(d), DESIGN).workspaces.design as DesignDocument;
  assert.deepEqual(open(pinned), pinned);
  const centre = pinned.sketches.find((s) => s.id === id)!.pins![0].point;
  const withPins = (pins: unknown) => ({ ...pinned, sketches: pinned.sketches.map((s) => (s.id === id ? { ...s, pins } : s)) });
  const pin = { point: centre, kind: "endpoint", name: "back+right&back+top&right+top" };
  for (const [pins, words] of [
    [[], /pins must be a list of at least one pin/],
    ["x", /pins must be a list/],
    [[{ ...pin, point: "point-99" }], /pin 1 is not on one of the sketch's points/],
    [[pin, pin], /pins point .* twice/],
    [[{ ...pin, kind: "corner" }], /must be an endpoint, a midpoint or a centre/],
    [[{ ...pin, name: "" }], /has no vertex name/],
    [[{ ...pin, name: "a/b" }], /has no vertex name/],
    [[{ ...pin, kind: "midpoint", name: "a&b" }], /has no edge name/],
  ] as const) assert.throws(() => open(withPins(pins)), words, JSON.stringify(pins));
  // A sketch on an origin plane can't pin points to a face's edges.
  const xy = { ...partDocument("box", 40, 30, 20) };
  const flat = drawCircle({ ...xy, nextId: 5, sketches: [{ id: "sketch-4", points: [], curves: [], constraints: [] }], timeline: { features: [...xy.timeline.features, { id: "sketch-4", intent: { type: "sketch", parameters: { plane: "XY" }, summary: "Sketch 1 on the XY plane" }, provenance: { self: { workspace: "design", id: "sketch-4", label: "Sketch 1" }, from: [] }, dependsOn: [], suppressed: false }] } }, "sketch-4", [1, 1], 1);
  const flatPinned = { ...flat.doc, sketches: flat.doc.sketches.map((s) => ({ ...s, pins: [{ point: s.points[0].id, kind: "endpoint", name: "a" }] })) };
  assert.throws(() => open(flatPinned), /XY plane but pins points to a face's edges/);
});
