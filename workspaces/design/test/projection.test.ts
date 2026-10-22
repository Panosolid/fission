// Step 27d: edges projected into a sketch (projection.ts), the parts the
// kernel isn't needed for: what an edge is seen as from a sketch, finding
// it again by name, which projected curves join the outline, projecting
// and removing (sketch.ts), what a click takes (`projectPick`), the
// rebuild's followed places taken into the sketch, the warning's words and
// the data's checks when a file is opened (document.ts). On the real
// kernel: packages/testing/journeys/projection.journey.ts, and against the
// naming model (rule 12): packages/testing/journeys/naming.journey.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyProject, projectFromJson, projectToJson, type BodyView, type Plane, type SketchXY } from "@fission/core";
import { partDocument, readDesignDocument, type DesignDocument, type Sketch } from "../src/document.ts";
import { addFaceSketch, addSketch, deleteCurve, drawLine, drawRectangle, movePoint, pinNewPoints, PROJECTED_POINT, projectEdges, sketchCurves, unproject, type EdgeToProject } from "../src/sketch.ts";
import { cornerOrder, edgeNamed, edgeShape, MIN_LENGTH, placesOf, profileCurves, PROJECTED_OPEN, projectedOpen, PROJECT_HELD, PROJECT_NOTHING, PROJECT_UNNAMED, projectAfter, projectionWords, projectPick, REFUSED, type EdgeShape } from "../src/projection.ts";
import { drawnFrame, facePlane } from "../src/face-sketch.ts";
import { followedSketch } from "../src/rebuild.ts";
import { nameBody, type BodyNames } from "../src/naming.ts";
import { SAME_PLACE } from "../src/snap.ts";
import { boxView, cylinderView, onlyBody } from "./views.ts";

const DESIGN = [{ id: "design" as const, readData: readDesignDocument }];
const plane = (origin: number[], xAxis: number[], normal: number[]): Plane => ({ origin: origin as Plane["origin"], xAxis: xAxis as Plane["xAxis"], normal: normal as Plane["normal"] });
const XY = plane([0, 0, 0], [1, 0, 0], [0, 0, 1]);
/** The XZ plane's frame (sketch.ts PLANES): x along X, normal −Y, so y = normal × x = Z. */
const XZ = plane([0, 0, 0], [1, 0, 0], [0, -1, 0]);
const near = (a: number, b: number, eps = 1e-12) => Math.abs(a - b) <= eps;
/** Each coordinate of a shape's points, to 1e-12 (−0 and 0 alike). */
function same(got: EdgeShape | { refused: string }, want: EdgeShape, eps = 1e-12): void {
  assert.ok(!("refused" in got), `refused: ${JSON.stringify(got)}`);
  assert.equal(got.kind, want.kind);
  const flat = (s: EdgeShape) => (s.kind === "point" ? [...s.at] : s.kind === "line" ? [...s.a, ...s.b] : s.kind === "circle" ? [...s.centre, s.radius] : [...s.start, ...s.end, ...s.centre]);
  const [g, w] = [flat(got), flat(want)];
  assert.ok(g.every((x, k) => near(x, w[k], eps)), `${JSON.stringify(got)} is not ${JSON.stringify(want)}`);
}
const box = (w = 40, d = 30, h = 20) => {
  const view = boxView(w, d, h);
  return { view, names: nameBody("feature-1", view, () => null) };
};
/** A cylinder of radius r and height h with its caps' normals and its faces' centroids (cylinderView has its points only). */
const cylinder = (r = 5, h = 10): BodyView => ({ ...cylinderView(r, h), face_normals: [[0, 0, -1], [0, 0, 1], null], face_centroids: [[0, 0, 0], [0, 0, h], [0, 0, h / 2]] }) as unknown as BodyView;
/** One straight edge from `a` to `b`, the only edge of a made-up view. */
const oneLine = (a: number[], b: number[]): BodyView => ({ edge_types: ["line"], edge_vertices: [[0, 1]], vertex_points: [a, b], edge_middles: [a.map((x, k) => (x + b[k]) / 2)], edge_centres: [null], edge_faces: [[0, 1]] }) as unknown as BodyView;
/** One round edge round `centre` from `start` through `middle` to `end` (one vertex for a whole circle) on a flat face of normal `axis`. */
const oneRound = (centre: number[], start: number[], middle: number[], end: number[] | null, axis: number[]): BodyView =>
  ({
    edge_types: ["circle"],
    edge_vertices: [end === null ? [0, 0] : [0, 1]],
    vertex_points: end === null ? [start] : [start, end],
    edge_middles: [middle],
    edge_centres: [centre],
    edge_faces: [[0, 1]],
    face_normals: [axis, null],
    face_centroids: [centre, centre],
  }) as unknown as BodyView;
/** A plane through the origin with x along X, its normal turned from +Z towards −Y so that its cosine with Z is `c`. */
const tilted = (c: number) => plane([0, 0, 0], [1, 0, 0], [0, -Math.sqrt(1 - c * c), c]);

// ---------------------------------------------------------------- what an edge is seen as

test("hand-worked: a box's top front edge seen from XY is the line (0, 0) to (40, 0), and its front right upright, seen end on, the point (40, 0)", () => {
  const { view } = box();
  // Edge 4 joins corners 4 (0, 0, 20) and 5 (40, 0, 20) (views.ts): along the normal both drop 20 onto z = 0.
  same(edgeShape(view, 4, XY), { kind: "line", a: [0, 0], b: [40, 0] });
  // Edge 8 joins corners 1 (40, 0, 0) and 5 (40, 0, 20): both ends land on (40, 0), one place, so a point; the end nearer
  // the plane (corner 1, on it) is the one taken, as a pin there would take it.
  same(edgeShape(view, 8, XY), { kind: "point", at: [40, 0] });
  // From the front (XZ: x = X, y = Z) the same upright is the line (40, 0) to (40, 20), and the top front edge the line at height 20.
  same(edgeShape(view, 8, XZ), { kind: "line", a: [40, 0], b: [40, 20] });
  same(edgeShape(view, 4, XZ), { kind: "line", a: [0, 20], b: [40, 20] });
});

test("hand-worked (27e): a straight edge's line runs from the corner whose name comes first, whichever way the kernel runs the edge", () => {
  // One edge from (40, 0, 20) to (0, 0, 20), its corners named "b" and "a": seen from XY it runs from "a" at (0, 0) to "b"
  // at (40, 0), against the kernel's order; given the other way round, the same line.
  const back = oneLine([40, 0, 20], [0, 0, 20]);
  const ahead = oneLine([0, 0, 20], [40, 0, 20]);
  same(edgeShape(back, 0, XY, ["b", "a"]), { kind: "line", a: [0, 0], b: [40, 0] });
  same(edgeShape(ahead, 0, XY, ["a", "b"]), { kind: "line", a: [0, 0], b: [40, 0] });
  assert.deepEqual(cornerOrder(back, 0, ["b", "a"]), [1, 0]);
  // No names, one unknown, or both one name: the kernel's order (null), as before 27e.
  for (const corners of [undefined, [null, "a"], ["a", null], ["a", "a"]]) assert.equal(cornerOrder(back, 0, corners), null, JSON.stringify(corners));
  same(edgeShape(back, 0, XY), { kind: "line", a: [40, 0], b: [0, 0] });
  // A round edge has no corners to order by.
  assert.equal(cornerOrder(oneRound([0, 0, 0], [5, 0, 0], [0, 5, 0], [-5, 0, 0], [0, 0, 1]), 0, ["a", "b"]), null);
});

test("hand-worked (27e): a followed line's ends go by its corners' names when it has them, else each to the place that moves the line's points less", () => {
  const { doc, id, front } = onGround();
  const s = sketchOf(projectEdges(doc, id, [front]).doc, id);
  const q = s.projected![0];
  const [start, end] = [s.points[0].id, s.points[1].id];
  // The line is (0, 0) to (40, 0). Seen now from (0, 0) to (−60, 0) (its far end moved past its near one), by names: as given.
  const named = placesOf(s, q, { kind: "line", a: [0, 0], b: [-60, 0] }, true);
  assert.deepEqual(named.points, [{ point: start, at: [0, 0] }, { point: end, at: [-60, 0] }]);
  // With no names, the moves: as given, 0² + (40 + 60)² = 10000; swapped, (0 + 60)² + (40 − 0)² = 3600 + 1600 = 5200. Swapped.
  const free = placesOf(s, q, { kind: "line", a: [0, 0], b: [-60, 0] });
  assert.deepEqual(free.points, [{ point: start, at: [-60, 0] }, { point: end, at: [0, 0] }]);
  // Slid 100 along itself, given end first: as given 100² + 100² = 20000, swapped 140² + 60² = 23200. Each end slides.
  assert.deepEqual(placesOf(s, q, { kind: "line", a: [140, 0], b: [100, 0] }).points, [{ point: start, at: [100, 0] }, { point: end, at: [140, 0] }]);
  // Turned half a turn about its middle: 40² + 40² both ways, a tie: the shape's order.
  assert.deepEqual(placesOf(s, q, { kind: "line", a: [20, 20], b: [20, -20] }).points, [{ point: start, at: [20, 20] }, { point: end, at: [20, -20] }]);
});

test("hand-worked: a 20 mm upright seen from a plane tilted to cos 0.8 is 12 mm long (a 3-4-5 triangle)", () => {
  // Normal n = (0, −0.6, 0.8), x = X, so y = n × x = (0, 0.8, 0.6). The upright (0, 0, 0) to (0, 0, 20) (box edge 9) reads
  // x = 0 at both ends and y = 0 and 20 · 0.6 = 12: seen along n, 20 · sin θ with cos θ = 0.8, sin θ = 0.6, so 12.
  const { view } = box();
  same(edgeShape(view, 9, tilted(0.8)), { kind: "line", a: [0, 0], b: [0, 12] }, 1e-12);
});

test("an edge seen end on is a point within SAME_PLACE (0.9 ×), refused as too short past it (1.1 ×), and a line from MIN_LENGTH on", () => {
  // An edge 10 mm tall leaning `d` along x is seen from XY as d long.
  const seen = (d: number) => edgeShape(oneLine([0, 0, 0], [d, 0, 10]), 0, XY);
  assert.equal((seen(0.9 * SAME_PLACE) as EdgeShape).kind, "point");
  assert.deepEqual(seen(1.1 * SAME_PLACE), { refused: "short", message: REFUSED.short });
  assert.deepEqual(seen(0.9 * MIN_LENGTH), { refused: "short", message: REFUSED.short });
  same(seen(1.1 * MIN_LENGTH), { kind: "line", a: [0, 0], b: [1.1 * MIN_LENGTH, 0] });
  // The point is the end nearer the plane, wherever it was drawn from: the top end first, the bottom one still taken.
  same(edgeShape(oneLine([0.5 * SAME_PLACE, 0, 10], [0, 0, 0]), 0, XY), { kind: "point", at: [0, 0] });
});

test("hand-worked: a cylinder's top circle seen from a parallel plane is the same circle, and from the side a line 2r long at its height", () => {
  const view = cylinder(5, 10);
  // From 30 above the ground, parallel: centre (0, 0), radius 5, whatever the height.
  same(edgeShape(view, 1, plane([0, 0, 30], [1, 0, 0], [0, 0, 1])), { kind: "circle", centre: [0, 0], radius: 5 });
  // From XZ (y = Z) the top rim, axis Z square to the normal −Y, is seen edge on: from x = −5 to 5 at height 10.
  same(edgeShape(view, 1, XZ), { kind: "line", a: [-5, 10], b: [5, 10] });
  // The bottom rim from below (the XY frame faces up; seen from below it is the same circle).
  same(edgeShape(view, 0, plane([0, 0, -7], [0, 1, 0], [0, 0, -1])), { kind: "circle", centre: [0, 0], radius: 5 });
});

test("a round edge is a circle while r(1 − cos θ) ≤ SAME_PLACE (0.9 ×) and slanted past it (1.1 ×); edge on while r·cos θ ≤ SAME_PLACE (0.9 ×), slanted past it (1.1 ×)", () => {
  // Seen along n at the angle θ to its axis, a circle of radius r is an ellipse with half axes r and r cos θ: it is short of
  // the circle by r(1 − cos θ), and as wide as a line by r cos θ. Radius 5 on the plane tilted to cos θ = c.
  const r = 5;
  const view = cylinder(r, 10);
  const kind = (c: number) => {
    const s = edgeShape(view, 1, tilted(c));
    return "refused" in s ? s.refused : s.kind;
  };
  assert.equal(kind(1 - (0.9 * SAME_PLACE) / r), "circle");
  assert.equal(kind(1 - (1.1 * SAME_PLACE) / r), "slanted");
  assert.equal(kind((0.9 * SAME_PLACE) / r), "line");
  assert.equal(kind((1.1 * SAME_PLACE) / r), "slanted");
  assert.deepEqual(edgeShape(view, 1, tilted(0.8)), { refused: "slanted", message: REFUSED.slanted });
});

test("hand-worked: an arc parallel to the sketch runs counter-clockwise in it, whichever way the body runs it", () => {
  // The half circle from (5, 0) through (0, 5) to (−5, 0): counter-clockwise already, so as it is.
  same(edgeShape(oneRound([0, 0, 0], [5, 0, 0], [0, 5, 0], [-5, 0, 0], [0, 0, 1]), 0, XY), { kind: "arc", start: [5, 0], end: [-5, 0], centre: [0, 0] });
  // The other half, (5, 0) through (0, −5) to (−5, 0), runs clockwise: turned round, from (−5, 0) through (0, −5) to (5, 0).
  same(edgeShape(oneRound([0, 0, 0], [5, 0, 0], [0, -5, 0], [-5, 0, 0], [0, 0, 1]), 0, XY), { kind: "arc", start: [-5, 0], end: [5, 0], centre: [0, 0] });
  // Seen from below (normal −Z, x along Y, so y = −Z × Y = X) the first half runs clockwise: (5, 0, 0) reads (0, 5), (0, 5, 0)
  // reads (5, 0) and (−5, 0, 0) reads (0, −5), so it is turned round, from (0, −5) through (5, 0) to (0, 5).
  same(edgeShape(oneRound([0, 0, 0], [5, 0, 0], [0, 5, 0], [-5, 0, 0], [0, 0, 1]), 0, plane([0, 0, 0], [0, 1, 0], [0, 0, -1])), { kind: "arc", start: [0, -5], end: [0, 5], centre: [0, 0] });
});

test("hand-worked: an arc seen edge on covers its ends' extent, and ±r where it passes them", () => {
  // From XZ, an arc in the ground plane is seen along X (y = 0). The arc from (3, 4) through (−5, 0) to (3, −4) has its ends at
  // x = 3 and passes x = −5 (its leftmost point): seen from x = −5 to 3, never reaching x = 5.
  same(edgeShape(oneRound([0, 0, 0], [3, 4, 0], [-5, 0, 0], [3, -4, 0], [0, 0, 1]), 0, XZ), { kind: "line", a: [-5, 0], b: [3, 0] });
  // The short arc between the same ends, through (5, 0): from 3 to 5.
  same(edgeShape(oneRound([0, 0, 0], [3, 4, 0], [5, 0, 0], [3, -4, 0], [0, 0, 1]), 0, XZ), { kind: "line", a: [3, 0], b: [5, 0] });
  // The quarter from (0, 5) to (−5, 0), through (−3.5355…, 3.5355…): from −5 to 0, its ends' own extent.
  const h = 5 / Math.SQRT2;
  same(edgeShape(oneRound([0, 0, 0], [0, 5, 0], [-h, h, 0], [-5, 0, 0], [0, 0, 1]), 0, XZ), { kind: "line", a: [-5, 0], b: [0, 0] });
  // A full circle's rim seen edge on: −5 to 5 (the cylinder above), and a body's curve of another kind is refused.
  assert.deepEqual(edgeShape({ ...oneLine([0, 0, 0], [1, 0, 0]), edge_types: ["bspline"] } as unknown as BodyView, 0, XY), { refused: "unknown", message: REFUSED.unknown });
});

// ---------------------------------------------------------------- found again by name

test("an edge is found by its name, lost when no edge has it, and ambiguous when two would, never one of them", () => {
  const { view, names } = box();
  assert.deepEqual(edgeNamed(names, view.edge_faces.length, "front+top"), { edge: 4 });
  assert.deepEqual(edgeNamed(names, view.edge_faces.length, "back+top"), { edge: 6 });
  assert.deepEqual(edgeNamed(names, view.edge_faces.length, "side:line-4+top"), { cause: "projection-lost" });
  // Two edges named alike (a body naming them so), or a name the naming dropped as two edges' (kept in `shared`).
  const twice: BodyNames = { ...names, edges: names.edges.map((e, k) => (k === 6 ? "front+top" : e)) };
  assert.deepEqual(edgeNamed(twice, view.edge_faces.length, "front+top"), { cause: "projection-ambiguous" });
  const dropped: BodyNames = { ...names, edges: names.edges.map((e, k) => (k === 4 ? null : e)), shared: { ...names.shared, edges: new Map([["front>top", 2]]) } };
  assert.deepEqual(edgeNamed(dropped, view.edge_faces.length, "front+top"), { cause: "projection-ambiguous" });
});

// ---------------------------------------------------------------- projecting into a sketch

/** A box, then a sketch on XY after it, and the box's top front and back edges and its front right upright to project. */
function onGround() {
  const made = addSketch(partDocument("box", 40, 30, 20));
  const { view } = box();
  const edge = (e: number, name: string): EdgeToProject => ({ feature: "feature-1", edge: name, shape: edgeShape(view, e, XY) as EdgeShape });
  return { doc: made.doc, id: made.id, front: edge(4, "front+top"), back: edge(6, "back+top"), upright: edge(8, "front+right") };
}
const sketchOf = (doc: DesignDocument, id: string) => doc.sketches.find((s) => s.id === id)!;
const itemOf = (doc: DesignDocument, id: string) => doc.timeline.features.find((f) => f.id === id)!;

test("projecting takes ids projection, points, curve in turn; a point for an upright; the box becomes a dependency; again adds nothing", () => {
  const { doc, id, front, upright } = onGround();
  const n = doc.nextId;
  const made = projectEdges(doc, id, [front, upright]);
  const sketch = sketchOf(made.doc, id);
  // The line: projection-n, point-(n+1), point-(n+2), line-(n+3); the upright: projection-(n+4), point-(n+5).
  assert.deepEqual(made.ids, [`projection-${n}`, `projection-${n + 4}`]);
  assert.deepEqual(sketch.projected, [
    { id: `projection-${n}`, feature: "feature-1", edge: "front+top", made: `line-${n + 3}` },
    { id: `projection-${n + 4}`, feature: "feature-1", edge: "front+right", made: `point-${n + 5}` },
  ]);
  assert.deepEqual(sketch.points.map((p) => [p.id, p.x, p.y]), [[`point-${n + 1}`, 0, 0], [`point-${n + 2}`, 40, 0], [`point-${n + 5}`, 40, 0]]);
  assert.deepEqual(sketch.curves, [{ id: `line-${n + 3}`, kind: "line", start: `point-${n + 1}`, end: `point-${n + 2}` }]);
  assert.equal(made.doc.nextId, n + 6);
  assert.deepEqual(itemOf(made.doc, id).dependsOn, ["feature-1"]);
  // The same edges again (and a different shape for one: the name decides): nothing added, the same document.
  const again = projectEdges(made.doc, id, [front, { ...upright, shape: { kind: "point", at: [1, 1] } }]);
  assert.deepEqual(again.ids, []);
  assert.equal(again.doc, made.doc);
  // Only a solid item before the sketch: the sketch itself, one after it, or one not there, refused in words.
  for (const feature of [id, "feature-99"]) assert.throws(() => projectEdges(doc, id, [{ ...front, feature }]), /is not a solid item before Sketch 1 in the timeline/);
});

test("a projected point can't be moved by hand or pinned; a projected curve is deleted whole, its feature no longer depended on", () => {
  const { doc, id, front, back } = onGround();
  const made = projectEdges(doc, id, [front, back]).doc;
  const [p] = sketchOf(made, id).points;
  assert.throws(() => movePoint(made, id, p.id, 1, 1), new RegExp(PROJECTED_POINT.replace(/[.:]/g, "\\$&")));
  // A line drawn from the projected corner shares it; drawn exactly onto a target there, it is still not pinned.
  const drawn = drawLine(made, id, p.id, [0, 30]).doc;
  const target = [{ at: [0, 0] as SketchXY, kind: "endpoint" as const, name: "front+left&front+top&left+top", feature: "feature-1" }];
  assert.equal(pinNewPoints(made, drawn, id, target), drawn);
  // Deleting the front's line removes its projection; the shared corner stays, an ordinary point now; the back's stays.
  const [frontLine, backLine] = sketchOf(drawn, id).curves.filter((c) => sketchOf(drawn, id).projected!.some((q) => q.made === c.id));
  const gone = deleteCurve(drawn, id, frontLine.id);
  assert.deepEqual(sketchOf(gone, id).projected!.map((q) => q.edge), ["back+top"]);
  assert.ok(sketchOf(gone, id).points.some((q) => q.id === p.id), "the shared corner stays");
  assert.doesNotThrow(() => movePoint(gone, id, p.id, 1, 1));
  assert.deepEqual(itemOf(gone, id).dependsOn, ["feature-1"]);
  // The back's removed too: no projections left, so the list goes, and nothing makes the sketch depend on the box.
  const none = unproject(gone, id, sketchOf(gone, id).projected![0].id);
  assert.ok(!Object.hasOwn(sketchOf(none, id), "projected"));
  assert.deepEqual(itemOf(none, id).dependsOn, []);
  assert.ok(!sketchOf(none, id).curves.some((c) => c.id === backLine.id));
  assert.throws(() => unproject(none, id, "projection-1"), /holds no projection projection-1/);
});

// ---------------------------------------------------------------- the outline

/** The ids of the outline's lines (sketch.ts `sketchCurves`), by the curves they came from. */
const outlineLines = (s: Sketch) => sketchCurves(s).lines.length;
/** Edges `list` of `view` as seen from XY. */
const edgeShapes = (view: BodyView, list: number[]) => list.map((e) => edgeShape(view, e, XY) as EdgeShape);

test("hand-worked: projected lines join the outline only where they close it with the sketch's own; a face's four alone close by themselves", () => {
  const { doc, id, front, back } = onGround();
  // The box's top, all four edges, from XY: a closed loop with no curves of the sketch's own, so all four are the outline.
  const { view } = box();
  const four = [4, 5, 6, 7].map((e, k): EdgeToProject => ({ feature: "feature-1", edge: ["front+top", "right+top", "back+top", "left+top"][k], shape: edgeShape(view, e, XY) as EdgeShape }));
  assert.equal(outlineLines(sketchOf(projectEdges(doc, id, four).doc, id)), 4);
  // The front edge alone, and a rectangle drawn elsewhere: the projected line has two free ends, so it is left out.
  const apart = drawRectangle(projectEdges(doc, id, [front]).doc, id, [50, 50], [60, 60]).doc;
  assert.equal(outlineLines(sketchOf(apart, id)), 4);
  // The front and back edges, closed by two lines of the sketch's own from (0, 0) to (0, 30) and (40, 0) to (40, 30): six ends
  // meet in pairs, so the four make the outline.
  const both = projectEdges(doc, id, [front, back]).doc;
  const corner = (x: number, y: number) => sketchOf(both, id).points.find((p) => p.x === x && p.y === y)!.id;
  const closed = drawLine(drawLine(both, id, corner(0, 0), corner(0, 30)).doc, id, corner(40, 0), corner(40, 30)).doc;
  assert.equal(outlineLines(sketchOf(closed, id)), 4);
  // One of the two own lines only: the back's line has a free end, then the front's (its end now free too) goes after it.
  const open = drawLine(both, id, corner(0, 0), corner(0, 30)).doc;
  assert.equal(outlineLines(sketchOf(open, id)), 1);
  // No projections: the sketch's own curves, as before 27d.
  assert.equal(outlineLines(sketchOf(drawRectangle(doc, id, [0, 0], [1, 1]).doc, id)), 4);
});

test("hand-worked (27e): a projected curve lying exactly on one the outline has already is left out of it: traced over, projected twice, seen edge on", () => {
  const { doc, id } = onGround();
  const { view } = box();
  // The box's top edges (4 to 7) and its bottom edges (0 to 3), seen from XY: both the rectangle (0, 0) to (40, 30).
  const edges = (list: number[], tag: string) => list.map((e): EdgeToProject => ({ feature: "feature-1", edge: `${tag}-${e}`, shape: edgeShape(view, e, XY) as EdgeShape }));
  const top = projectEdges(doc, id, edges([4, 5, 6, 7], "top")).doc;
  // A rectangle drawn over the projected one, its corners on the projected corners: the outline is the four drawn lines
  // only (before 27e it was eight, four ends meeting at each corner, and the kernel refused it).
  const traced = drawRectangle(top, id, [0, 0], [40, 30]).doc;
  const own = new Set(sketchOf(traced, id).curves.filter((c) => !sketchOf(traced, id).projected!.some((p) => p.made === c.id)).map((c) => c.id));
  assert.equal(own.size, 4);
  assert.deepEqual(profileCurves(sketchOf(traced, id)).map((c) => c.id).sort(), [...own].sort());
  // The top and the bottom both projected, nothing drawn: the first four (the top's), not eight.
  const twice = projectEdges(top, id, edges([0, 1, 2, 3], "bottom")).doc;
  assert.deepEqual(profileCurves(sketchOf(twice, id)).map((c) => c.id), profileCurves(sketchOf(top, id)).map((c) => c.id));
  // The front face seen edge on from XY: its top and bottom edges (4 and 3) are both (0, 0) to (40, 0), so one is left out, and
  // the other then has two free ends: no outline at all, rather than a loop of two lines with no area.
  const edgeOn = sketchOf(projectEdges(doc, id, edges([4, 3], "front")).doc, id);
  assert.deepEqual(profileCurves(edgeOn), []);
  // That sketch says so in its own words (the kernel, asked about no curves, said it had none yet); one with curves of its
  // own, or none at all, is the kernel's to judge.
  assert.equal(projectedOpen(edgeOn), PROJECTED_OPEN);
  assert.equal(projectedOpen(sketchOf(traced, id)), null);
  assert.equal(projectedOpen(sketchOf(doc, id)), null);
  // A circle projected twice (a cylinder's two rims from XY): one.
  const rim = (k: number): EdgeToProject => ({ feature: "feature-1", edge: `rim-${k}`, shape: { kind: "circle", centre: [60, 15], radius: 5 } });
  assert.equal(profileCurves(sketchOf(projectEdges(doc, id, [rim(0), rim(1)]).doc, id)).length, 1);
  // Arcs: a half disc's arc (5, 0) round to (−5, 0) twice, with its line: the arc and the line, not three curves meeting at
  // each end; the same ends and centre the other way round is the rest of the circle, so the two halves both stay.
  const arc = (k: number, start: SketchXY, end: SketchXY): EdgeToProject => ({ feature: "feature-1", edge: `arc-${k}`, shape: { kind: "arc", start, end, centre: [0, 0] } });
  const chord: EdgeToProject = { feature: "feature-1", edge: "chord", shape: { kind: "line", a: [-5, 0], b: [5, 0] } };
  assert.deepEqual(profileCurves(sketchOf(projectEdges(doc, id, [arc(0, [5, 0], [-5, 0]), arc(1, [5, 0], [-5, 0]), chord]).doc, id)).map((c) => c.kind), ["arc", "line"]);
  assert.equal(profileCurves(sketchOf(projectEdges(doc, id, [arc(0, [5, 0], [-5, 0]), arc(1, [-5, 0], [5, 0])]).doc, id)).length, 2);
});

test("a projected curve is on another when every point it has is within SAME_PLACE of that one's (0.9 ×), not past it (1.1 ×)", () => {
  const { doc, id } = onGround();
  const { view } = box();
  const square = edgeShapes(view, [4, 5, 6, 7]);
  const shifted = (k: number) =>
    square.map((sh, j): EdgeToProject => {
      const move = (p: SketchXY): SketchXY => [p[0] + k * SAME_PLACE, p[1]];
      return { feature: "feature-1", edge: `moved-${j}`, shape: sh.kind === "line" ? { kind: "line", a: move(sh.a), b: move(sh.b) } : sh };
    });
  const first = square.map((shape, j): EdgeToProject => ({ feature: "feature-1", edge: `square-${j}`, shape }));
  // 0.9 × SAME_PLACE along x: every end within SAME_PLACE of the first square's, so the second is the first again.
  assert.equal(profileCurves(sketchOf(projectEdges(doc, id, [...first, ...shifted(0.9)]).doc, id)).length, 4);
  // 1.1 ×: a square of its own (its ends meet each other, not the first's), so both stay and the kernel judges them.
  assert.equal(profileCurves(sketchOf(projectEdges(doc, id, [...first, ...shifted(1.1)]).doc, id)).length, 8);
});

// ---------------------------------------------------------------- what a click takes

test("a click on an edge takes it; on a face, every edge of it; on a body after the sketch, nothing, said in words", () => {
  const { view, names } = box();
  const scene = onlyBody(view, names);
  const { doc, id } = onGround();
  // Edge 4: the top front, seen from XY.
  const one = projectPick(doc, id, scene, XY, { edge: 4 });
  assert.deepEqual(one, { edges: [{ feature: "feature-1", edge: "front+top", shape: { kind: "line", a: [0, 0], b: [40, 0] } }], note: null });
  // The front face (2): its edges 3, 4, 8 and 9 (views.ts), the two uprights seen end on as points.
  const face = projectPick(doc, id, scene, XY, { face: 2 });
  assert.equal(face.note, null);
  assert.deepEqual(face.edges.map((e) => `${e.edge} ${e.shape.kind}`), ["bottom+front line", "front+top line", "front+right point", "front+left point"]);
  // Nothing under the pointer, no scene, or no frame: nothing, said.
  for (const [s, p, under] of [[scene, XY, {}], [null, XY, { edge: 4 }], [scene, undefined, { edge: 4 }]] as const) assert.deepEqual(projectPick(doc, id, s, p, under), { edges: [], note: PROJECT_NOTHING });
  // The sketch moved before the box: the box is after it.
  const first = { ...doc, timeline: { features: [doc.timeline.features[1], doc.timeline.features[0]] } };
  assert.deepEqual(projectPick(first, id, scene, XY, { edge: 4 }), { edges: [], note: projectAfter("Feature 1 (box)", "Sketch 1") });
  // An edge with no name of its own.
  const unnamed = onlyBody(view, { ...names, edges: names.edges.map((e, k) => (k === 4 ? null : e)) });
  assert.deepEqual(projectPick(doc, id, unnamed, XY, { edge: 4 }), { edges: [], note: PROJECT_UNNAMED });
});

test("a face's edges that can't be projected are left out, and the note says how many and why", () => {
  // A cylinder seen from a plane tilted to cos 0.8: its rims are slanted (refused), so its top face's one edge can't be.
  const view = cylinder();
  const names = nameBody("feature-1", view, () => null);
  const scene = onlyBody(view, names);
  const { doc, id } = onGround();
  assert.deepEqual(projectPick(doc, id, scene, tilted(0.8), { face: 1 }), { edges: [], note: `None of this face's edges could be projected: ${REFUSED.slanted}` });
  // Its side (both rims): from XY both are circles; one rim named by no edge of its own leaves 1 of 2 out.
  const half = onlyBody(view, { ...names, edges: [names.edges[0], null] });
  const side = projectPick(doc, id, half, XY, { face: 2 });
  assert.equal(side.edges.length, 1);
  assert.equal(side.note, `1 of this face's 2 edges was left out: ${PROJECT_UNNAMED}`);
  // A face sketch whose face is lost projects nothing until the face is back.
  const { view: bv, names: bn } = box();
  const held = addFaceSketch(partDocument("box", 40, 30, 20), { plane: facePlane("feature-1", "side:line-9"), feature: "feature-1" }, drawnFrame([0, 0, 1], [20, 15, 20]));
  assert.deepEqual(projectPick(held.doc, held.id, onlyBody(bv, bn), XY, { edge: 4 }), { edges: [], note: PROJECT_HELD });
});

// ---------------------------------------------------------------- followed, and held

test("hand-worked: a rebuild's followed projections are taken into the sketch, a circle's radius too; one not found stays", () => {
  const { doc, id, front } = onGround();
  const circle: EdgeToProject = { feature: "feature-1", edge: "side+top", shape: { kind: "circle", centre: [50, 50], radius: 5 } };
  const made = projectEdges(doc, id, [front, circle]);
  const s = sketchOf(made.doc, id);
  const [line, round] = s.projected!;
  const [a, b, c] = s.points.map((p) => p.id);
  // The box 60 wide: the front edge now runs (0, 0) to (60, 0); the circle grew to radius 8 round (52, 50).
  const moved = followedSketch(s, { status: "built", placement: { plane: XY, side: 1 }, projected: [{ id: line.id, points: [{ point: a, at: [0, 0] }, { point: b, at: [60, 0] }] }, { id: round.id, points: [{ point: c, at: [52, 50] }], radius: 8 }] });
  assert.deepEqual(moved.points.map((p) => [p.x, p.y]), [[0, 0], [60, 0], [52, 50]]);
  assert.equal((moved.curves.find((x) => x.id === round.made) as { radius: number }).radius, 8);
  // Found where they are: the same sketch object. Held (not in the list) or not built: as it was.
  assert.equal(followedSketch(s, { status: "built", placement: { plane: XY, side: 1 }, projected: [{ id: line.id, points: [{ point: a, at: [0, 0] }, { point: b, at: [40, 0] }] }] }), s);
  assert.equal(followedSketch(s, { status: "built", placement: { plane: XY, side: 1 }, projected: [] }), s);
  assert.equal(followedSketch(s, { status: "greyed", by: "feature-1" }), s);
});

test("the warning's words: one projection or several, lost, changed or ambiguous, in the sketch's order", () => {
  const sketch = { projected: [{ id: "projection-3", feature: "f", edge: "a", made: "line-6" }, { id: "projection-7", feature: "f", edge: "b", made: "point-8" }] };
  assert.deepEqual(projectionWords([{ id: "projection-3", cause: "projection-lost" }], sketch, "Sketch 2"), { cause: "projection-lost", projections: ["projection-3"], message: "Sketch 2: a projected edge has lost its edge, so it stays where it was" });
  assert.deepEqual(projectionWords([{ id: "projection-7", cause: "projection-ambiguous" }, { id: "projection-3", cause: "projection-ambiguous" }], sketch, "Sketch 2"), {
    cause: "projection-ambiguous",
    projections: ["projection-3", "projection-7"],
    message: "Sketch 2: 2 projected edges are on edges that are now more than one edge, so they stay where they were rather than guess",
  });
  // Any lost or changed makes the cause "lost"; each cause in its own words, joined.
  const both = projectionWords([{ id: "projection-7", cause: "projection-ambiguous" }, { id: "projection-3", cause: "projection-changed" }], sketch, "Sketch 2");
  assert.equal(both.cause, "projection-lost");
  assert.equal(both.message, "Sketch 2: a projected edge is on an edge the sketch now sees as another kind of curve, so it stays where it was, and a projected edge is on an edge that is now more than one edge, so it stays where it was rather than guess");
});

// ---------------------------------------------------------------- files

test("projections survive save and open, and every way a file can break them is refused", () => {
  const { doc, id, front, upright } = onGround();
  const made = projectEdges(doc, id, [front, upright]).doc;
  const save = (d: unknown) => projectToJson({ ...emptyProject("Projections"), workspaces: { design: d as DesignDocument } });
  const open = (d: unknown) => projectFromJson(save(d), DESIGN).workspaces.design as DesignDocument;
  assert.deepEqual(open(made), made);
  const [line, point] = sketchOf(made, id).projected!;
  const lineCurve = sketchOf(made, id).curves[0] as { start: string };
  const withList = (projected: unknown, d: DesignDocument = made) => ({ ...d, sketches: d.sketches.map((s) => (s.id === id ? { ...s, projected } : s)) });
  for (const [list, words] of [
    [[], /projections must be a list of at least one, or left out/],
    ["x", /projections must be a list of at least one, or left out/],
    [[{ ...line, id: 3 }], /projection 1 has no id/],
    [["projection"], /projection 1 has no id/],
    [[{ ...line, feature: "" }], /names no feature/],
    [[{ ...line, feature: id }], /is of sketch-\d+, which is not a solid item before it in the timeline/],
    [[{ ...line, feature: "feature-77" }], /projects an edge of feature-77 but does not depend on it/],
    [[{ ...line, edge: "" }], /has no edge name/],
    [[{ ...line, edge: "a/b" }], /has no edge name/],
    [[line, { ...point, edge: line.edge }], /projects the edge front\+top of feature-1 twice/],
    [[{ ...line, made: 4 }], /made nothing/],
    [[{ ...line, made: "line-99" }], /made line-99, which is not one of the sketch's curves, or a point no curve is drawn from/],
    [[{ ...line, made: lineCurve.start }], /which is not one of the sketch's curves, or a point no curve is drawn from/],
    [[line, { ...point, made: line.made }], /line-\d+ is made by two projections/],
  ] as const) assert.throws(() => open(withList(list)), words, JSON.stringify(list));
  // A deleted feature (still depended on) opens: the projection is held, "projection lost".
  const deleted = { ...withList([{ ...line, feature: "feature-77" }]), timeline: { features: made.timeline.features.map((f) => (f.id === id ? { ...f, dependsOn: ["feature-1", "feature-77"] } : f)) } };
  assert.doesNotThrow(() => open(deleted));
  // A projected point pinned too is refused; and the sketch after the feature it projects from, refused.
  const pinned = { ...made, sketches: made.sketches.map((s) => (s.id === id ? { ...s, pins: [{ point: point.made, kind: "endpoint", name: "a", feature: "feature-1" }] } : s)) };
  assert.throws(() => open(pinned), /is projected, so it can't be pinned too/);
  const after = { ...made, timeline: { features: [made.timeline.features[1], made.timeline.features[0]] } };
  assert.throws(() => open(after), /which is not a solid item before it in the timeline|is built on feature-1, which comes after it/);
  // A projection's id is an id like any other: used twice in the file, or past the counter, refused.
  assert.throws(() => open(withList([{ ...line, id: lineCurve.start }, point])), /twice|used twice/);
  assert.throws(() => open({ ...made, nextId: 2 }), /nextId|counter/);
});
