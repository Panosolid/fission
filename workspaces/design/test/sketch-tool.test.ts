// Step 21c: the line tool's clicks as document edits (sketch-tool.ts):
// chains share their corners, a click on an existing point ends the chain,
// and the drawing the viewport is given. A seeded random session is checked
// against a simple model that knows only coordinates.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SketchXY } from "@fission/core";
import { partDocument, readDesignDocument, type DesignDocument } from "../src/document.ts";
import { addSketch, drawArc, drawCircle, drawRectangle, SKETCH_STEPS, sketchCurves, sketchLines } from "../src/sketch.ts";
import { arcSegments, CIRCLE_SEGMENTS, circleSegments, clickAt, curveCount, DEFAULT_GRID, drawStep, ORIGIN_PLANES, originPlanes, PLANE_VIEWS, previewLine, previewSegments, SAME_LINE, SKETCH_TOOLS, sketchDrawings, startTool, toolBusy, type CircleTool, type LineTool, type RectangleTool, type SketchTool } from "../src/sketch-tool.ts";
import { DESIGN_SHORTCUTS, sketchToolKey } from "../src/shortcuts.ts";

function fresh() {
  const s = addSketch(partDocument("box", 40, 30, 20));
  return { doc: s.doc, tool: { kind: "line", sketch: s.id, from: null } as LineTool };
}

function clicks<T extends SketchTool>(doc: DesignDocument, tool: T, at: SketchXY[]) {
  let drew = 0;
  for (const p of at) {
    const r = clickAt(doc, tool, p);
    doc = r.doc;
    tool = r.tool;
    if (r.drew) drew++;
  }
  return { doc, tool, drew };
}

test("hand-worked: five clicks draw a closed 40 × 30 rectangle whose corners are shared", () => {
  // The part holds feature-1 and the sketch took 2. Click 1 at (0, 0) only
  // marks the start. Click 2 at (40, 0): both ends are new, point-3 and
  // point-4, then line-5. Click 3 at (40, 30): point-6, line-7 from point-4.
  // Click 4 at (0, 30): point-8, line-9. Click 5 at (0, 0) lands on point-3,
  // so line-10 runs point-8 → point-3 and the chain ends. 4 points, 4 lines,
  // the counter at 11.
  const f = fresh();
  const { doc, tool, drew } = clicks(f.doc, f.tool, [[0, 0], [40, 0], [40, 30], [0, 30], [0, 0]]);
  assert.equal(drew, 4);
  assert.equal(tool.from, null, "closing the shape ends the chain");
  assert.equal(doc.nextId, 11);
  const sketch = doc.sketches[0];
  assert.deepEqual(sketch.points.map((p) => [p.id, p.x, p.y]), [["point-3", 0, 0], ["point-4", 40, 0], ["point-6", 40, 30], ["point-8", 0, 30]]);
  assert.deepEqual(sketch.curves.map((c) => [c.id, c.start, c.end]), [["line-5", "point-3", "point-4"], ["line-7", "point-4", "point-6"], ["line-9", "point-6", "point-8"], ["line-10", "point-8", "point-3"]]);
  // It saves and opens as it is: every sketch rule holds.
  assert.deepEqual(readDesignDocument(JSON.parse(JSON.stringify(doc))), doc);
});

test("a click on the chain's last point draws nothing; a chain started on a point shares it", () => {
  const f = fresh();
  let r = clicks(f.doc, f.tool, [[0, 0], [10, 0]]);
  const same = clickAt(r.doc, r.tool, [10, 0]);
  assert.equal(same.drew, false);
  assert.equal(same.doc, r.doc, "the document is untouched");
  // A first click that is not yet a point, clicked again: still nothing.
  const twice = clicks(f.doc, f.tool, [[5, 5], [5, 5]]);
  assert.equal(twice.drew, 0);
  assert.deepEqual(twice.doc.sketches[0].points, []);
  // Escape (the workspace sets from to null), then a new chain from (10, 0): point-4 is shared.
  r = clicks(r.doc, { ...r.tool, from: null }, [[10, 0], [10, 20]]);
  const curves = r.doc.sketches[0].curves;
  assert.equal(curves.at(-1)!.start, "point-4");
  assert.equal(r.doc.sketches[0].points.length, 3, "one new point only");
  // A chain ending on another line's end stops there, as closing does.
  assert.equal(clickAt(r.doc, r.tool, [0, 0]).tool.from, null);
});

test("a line on top of one already there draws nothing and says why; the chain stays where it was (25a5, the report list's \"3 ends meet\")", () => {
  // The closed 40 × 30 rectangle of the first test: point-3 (0, 0), point-4 (40, 0), point-6 (40, 30), point-8 (0, 30), counter 11.
  const f = fresh();
  const closed = clicks(f.doc, f.tool, [[0, 0], [40, 0], [40, 30], [0, 30], [0, 0]]);
  // A chain started on (0, 0) then a click on (40, 0): line-5 already joins point-3 and point-4. A second line there would make three
  // line ends meet at both corners and break the outline, so nothing is drawn, the counter stays at 11 and the chain stays at point-3.
  const start = clickAt(closed.doc, closed.tool, [0, 0]);
  const again = clickAt(start.doc, start.tool, [40, 0]);
  assert.equal(again.drew, false);
  assert.equal(again.doc, start.doc, "the document is unchanged");
  assert.equal(again.note, SAME_LINE);
  assert.equal((again.tool as LineTool).from, "point-3");
  // The other way round (point-8 → point-3 is line-10, clicked from (0, 0) to (0, 30)) is the same line: refused too.
  const back = clickAt(again.doc, again.tool, [0, 30]);
  assert.equal(back.drew, false);
  assert.equal(back.note, SAME_LINE);
  // A diagonal to (40, 30) joins two points no line joins: drawn, line-11, and the chain ends there (an existing point).
  const diagonal = clickAt(back.doc, back.tool, [40, 30]);
  assert.equal(diagonal.drew, true);
  assert.equal(diagonal.note, undefined);
  assert.deepEqual(diagonal.doc.sketches[0].curves.at(-1), { id: "line-11", kind: "line", start: "point-3", end: "point-6" });
});

test("the preview runs from the chain's last point to the pointer, and only while a chain is going", () => {
  const f = fresh();
  assert.equal(previewLine(f.doc, f.tool, [1, 2]), null, "no chain yet");
  const started = clicks(f.doc, f.tool, [[0, 0]]);
  assert.deepEqual(previewLine(started.doc, started.tool, [10, 0]), [[0, 0], [10, 0]], "from the first click, not yet a point");
  const going = clicks(started.doc, started.tool, [[10, 0]]);
  assert.deepEqual(previewLine(going.doc, going.tool, [10, 10]), [[10, 0], [10, 10]]);
  assert.equal(previewLine(going.doc, going.tool, null), null, "pointer off the plane");
  assert.equal(previewLine(going.doc, null, [1, 1]), null, "not editing");
});

test("the drawings: the edited sketch with its grid, points and preview; the others lines only", () => {
  const f = fresh();
  const drawn = clicks(f.doc, f.tool, [[0, 0], [10, 0], [10, 10]]);
  const other = addSketch(drawn.doc);
  const doc = clicks(other.doc, { kind: "line", sketch: other.id, from: null }, [[0, 0], [0, 5]]).doc;
  const [first, second] = sketchDrawings(doc, { tool: drawn.tool, grid: 5, pointer: [20, 10] });
  assert.deepEqual(first.lines, [[[0, 0], [10, 0]], [[10, 0], [10, 10]]]);
  assert.deepEqual(first.editing, { grid: 5, gridSnap: false, points: [[0, 0], [10, 0], [10, 10]], preview: [[[10, 10], [20, 10]]] });
  // Grid snap on reaches the viewport, which then draws the snap grid's multiples (SF2).
  assert.equal(sketchDrawings(doc, { tool: drawn.tool, grid: 5, pointer: null, gridSnap: true })[0].editing!.gridSnap, true);
  assert.deepEqual(first.plane.normal, [0, 0, 1]);
  assert.deepEqual(second, { plane: first.plane, lines: [[[0, 0], [0, 5]]] });
  // The pending first click is drawn as a point before it is one.
  const pending = sketchDrawings(other.doc, { tool: { kind: "line", sketch: other.id, from: [3, 4] }, grid: DEFAULT_GRID, pointer: null });
  assert.deepEqual(pending[1].editing!.points, [[3, 4]]);
  assert.deepEqual(sketchDrawings(doc, null).map((d) => d.editing), [undefined, undefined], "nothing edited");
});

test("the plane prompt offers only the ground plane until step 26, and each plane is looked at straight down", () => {
  assert.deepEqual(ORIGIN_PLANES.filter((p) => p.offered).map((p) => p.id), ["XY"]);
  assert.deepEqual(originPlanes().map((p) => [p.id, p.offered]), [["XY", true], ["XZ", false], ["YZ", false]]);
  // Straight down means the camera on the normal's side: XY's normal +Z is the top
  // view, XZ's −Y the front (the front camera sits at −Y), YZ's +X the right.
  assert.deepEqual(PLANE_VIEWS, { XY: "top", XZ: "front", YZ: "right" });
});

// Step 22a: the rectangle tool.

function freshRectangle() {
  const s = addSketch(partDocument("box", 40, 30, 20));
  return { doc: s.doc, tool: startTool("rectangle", s.id) as RectangleTool };
}

test("hand-worked: two rectangle clicks make exactly what five line clicks make", () => {
  // Corners (0, 0) and (40, 30): the sides run (0, 0) → (40, 0) → (40, 30) →
  // (0, 30) → (0, 0), drawn as the line tool draws them. The counter is at 3
  // after feature-1 and sketch-2: point-3, point-4, line-5; point-6, line-7;
  // point-8, line-9; line-10 back to point-3. Counter at 11, the same
  // document as the hand-worked five-click chain above.
  const f = freshRectangle();
  const first = clickAt(f.doc, f.tool, [0, 0]);
  assert.equal(first.drew, false);
  assert.equal(first.doc, f.doc, "the first corner changes nothing in the document");
  assert.deepEqual(first.tool.corner, [0, 0]);
  const second = clickAt(first.doc, first.tool, [40, 30]);
  assert.equal(second.drew, true);
  assert.equal(second.tool.corner, null, "ready for the next rectangle");
  const byLines = clicks(fresh().doc, fresh().tool, [[0, 0], [40, 0], [40, 30], [0, 30], [0, 0]]).doc;
  assert.deepEqual(second.doc, byLines);
  assert.equal(second.doc.nextId, 11);
  assert.equal(drawStep(second.tool), "Draw rectangle", "one undo step, named for the tool");
  assert.equal(drawStep(fresh().tool), SKETCH_STEPS.draw);
});

test("hand-worked: a second rectangle beside the first shares the two corners it lands on", () => {
  // After the first (counter 11), corners (40, 0) and (70, 30): (40, 0) is
  // point-4 and (40, 30) is point-6, both shared. Sides: point-4 → (70, 0)
  // new point-11, line-12; → (70, 30) new point-13, line-14; → point-6
  // line-15; point-6 → point-4 line-16. Six points, eight lines, counter 17.
  // The shared side is drawn a second time (line-16 lies on line-7), as the
  // line tool would; the kernel then reports more than two ends at a corner.
  const f = freshRectangle();
  let r = clicks(f.doc, f.tool, [[0, 0], [40, 30], [40, 0], [70, 30]]);
  const sketch = r.doc.sketches[0];
  assert.equal(r.drew, 2);
  assert.equal(r.doc.nextId, 17);
  assert.deepEqual(sketch.points.map((p) => [p.id, p.x, p.y]).slice(4), [["point-11", 70, 0], ["point-13", 70, 30]]);
  assert.deepEqual(sketch.curves.slice(4).map((c) => [c.id, c.start, c.end]), [["line-12", "point-4", "point-11"], ["line-14", "point-11", "point-13"], ["line-15", "point-13", "point-6"], ["line-16", "point-6", "point-4"]]);
  // Clicked the other way (from the top right corner), the sides still run along x first.
  r = clicks(f.doc, f.tool, [[40, 30], [0, 0]]);
  assert.deepEqual(sketchLines(r.doc.sketches[0]).map((l) => [l.a, l.b]), [[[40, 30], [0, 30]], [[0, 30], [0, 0]], [[0, 0], [40, 0]], [[40, 0], [40, 30]]]);
  assert.deepEqual(readDesignDocument(JSON.parse(JSON.stringify(r.doc))), r.doc, "it saves and opens as it is");
});

test("a second corner on the first one's row or column draws nothing and says why; the first corner stays", () => {
  const f = freshRectangle();
  const down = clickAt(f.doc, f.tool, [10, 10]);
  for (const at of [[10, 10], [30, 10], [10, -20]] as SketchXY[]) {
    const r = clickAt(down.doc, down.tool, at);
    assert.equal(r.drew, false, `${at}`);
    assert.equal(r.doc, down.doc, `${at}: the document is untouched`);
    assert.deepEqual(r.tool.corner, [10, 10], `${at}: still waiting for the opposite corner`);
    assert.match(r.note ?? "", /^A rectangle needs a width and a height/);
  }
  assert.equal(clickAt(down.doc, down.tool, [11, 9]).note, undefined, "one step off both: drawn, no note");
  // drawRectangle itself refuses, naming which way the corners line up, and coordinates that are not numbers.
  const id = f.tool.sketch;
  assert.throws(() => drawRectangle(f.doc, id, [5, 0], [5, 9]), /^Error: a rectangle needs a width and a height: its corners \(5, 0\) and \(5, 9\) are on one column$/);
  assert.throws(() => drawRectangle(f.doc, id, [0, 7], [3, 7]), /are on one row$/);
  assert.throws(() => drawRectangle(f.doc, id, [0, 0], [NaN, 1]), /needs x and y in mm, not NaN, 1/);
  assert.throws(() => drawRectangle(f.doc, id, [Infinity, 0], [1, 1]), /not Infinity, 0/);
  assert.throws(() => drawRectangle(f.doc, "sketch-99", [0, 0], [1, 1]), /there is no sketch sketch-99/);
});

test("the rectangle's preview: four sides from the first corner to the pointer, none on its row or column", () => {
  const f = freshRectangle();
  assert.deepEqual(previewSegments(f.doc, f.tool, [5, 5]), [], "no corner yet");
  const down = clickAt(f.doc, f.tool, [0, 0]);
  assert.deepEqual(previewSegments(down.doc, down.tool, [20, -10]), [[[0, 0], [20, 0]], [[20, 0], [20, -10]], [[20, -10], [0, -10]], [[0, -10], [0, 0]]]);
  assert.deepEqual(previewSegments(down.doc, down.tool, [20, 0]), [], "on the row: a click there draws nothing, so nothing is previewed");
  assert.deepEqual(previewSegments(down.doc, down.tool, null), [], "pointer off the plane");
  // The drawing: the first corner shown as a point before anything is drawn.
  const [d] = sketchDrawings(down.doc, { tool: down.tool, grid: 10, pointer: [20, 10] });
  assert.deepEqual(d.editing!.points, [[0, 0]]);
  assert.equal(d.editing!.preview.length, 4);
  // A first corner on a point already there is not drawn twice.
  const drawn = clicks(f.doc, f.tool, [[0, 0], [40, 30], [40, 30]]);
  assert.deepEqual(sketchDrawings(drawn.doc, { tool: drawn.tool, grid: 10, pointer: null })[0].editing!.points.length, 4);
});

function freshCircle() {
  const s = addSketch(partDocument("box", 40, 30, 20));
  return { doc: s.doc, tool: { kind: "circle", sketch: s.id, centre: null } as CircleTool };
}

test("hand-worked: a centre at (0, 0) and a click at (30, 40) draw a circle of radius 50 round a new point", () => {
  // The radius is the distance between the clicks: √(30² + 40²) = √(900 +
  // 1600) = √2500 = 50 (a 3-4-5 triangle scaled by 10). The counter is at 3
  // after feature-1 and sketch-2: the centre becomes point-3, the circle
  // circle-4, counter 5. The click on the circle is not kept as a point.
  const f = freshCircle();
  const first = clickAt(f.doc, f.tool, [0, 0]);
  assert.equal(first.drew, false);
  assert.equal(first.doc, f.doc, "the centre changes nothing in the document");
  assert.deepEqual(first.tool.centre, [0, 0]);
  const second = clickAt(first.doc, first.tool, [30, 40]);
  assert.equal(second.drew, true);
  assert.equal(second.note, undefined);
  assert.equal(second.tool.centre, null, "ready for the next circle");
  const sketch = second.doc.sketches[0];
  assert.deepEqual(sketch.points, [{ id: "point-3", x: 0, y: 0 }]);
  assert.deepEqual(sketch.curves, [{ id: "circle-4", kind: "circle", centre: "point-3", radius: 50 }]);
  assert.equal(second.doc.nextId, 5);
  assert.deepEqual(second.doc, drawCircle(f.doc, f.tool.sketch, [0, 0], 50).doc, "the same document drawCircle makes");
  assert.equal(drawStep(second.tool), "Draw circle", "one undo step, named for the tool");
  assert.equal(drawStep(second.tool), SKETCH_STEPS.circle);
  assert.deepEqual(readDesignDocument(JSON.parse(JSON.stringify(second.doc))), second.doc, "it saves and opens as it is");
  // A diagonal radius that is not a whole number: (0, 0) to (10, 10) is √200 = 10√2 ≈ 14.142135623730951.
  const diagonal = clickAt(first.doc, first.tool, [10, 10]).doc.sketches[0].curves[0] as { radius: number };
  assert.ok(Math.abs(diagonal.radius - 10 * Math.SQRT2) < 1e-12, `${diagonal.radius}`);
  // (0, 0) to (10, 30): √1000 = 31.62277660168379332…, whose nearest double
  // is 31.622776601683793 exactly (Math.hypot gives 31.622776601683796, one
  // unit in the last place off, so the tool must not use it).
  const root = clickAt(first.doc, first.tool, [10, 30]).doc.sketches[0].curves[0] as { radius: number };
  assert.equal(root.radius, 31.622776601683793);
});

test("hand-worked: a circle centred on a rectangle's corner shares that point; a centre off every point is a new one", () => {
  // The rectangle (0, 0)–(40, 30) takes 4 points and 4 lines from 3, leaving
  // the counter at 11, with (40, 30) as point-6. A centre there is shared:
  // through (40, 40) the radius is 10 and the circle takes 11. A circle
  // round (100, 0) through (100, 5): new point-12, circle-13, radius 5.
  const f = freshCircle();
  const rect = clicks(f.doc, { kind: "rectangle", sketch: f.tool.sketch, corner: null } as RectangleTool, [[0, 0], [40, 30]]).doc;
  assert.equal(rect.nextId, 11);
  const r = clicks(rect, f.tool, [[40, 30], [40, 40], [100, 0], [100, 5]]);
  const sketch = r.doc.sketches[0];
  assert.equal(r.drew, 2);
  assert.deepEqual(sketch.curves.slice(4), [
    { id: "circle-11", kind: "circle", centre: "point-6", radius: 10 },
    { id: "circle-13", kind: "circle", centre: "point-12", radius: 5 },
  ]);
  assert.equal(sketch.points.length, 5, "the four corners and one new centre");
  assert.deepEqual(sketch.points.at(-1), { id: "point-12", x: 100, y: 0 });
  // A second circle round the first one's centre shares it too.
  const again = clicks(r.doc, f.tool, [[100, 0], [100, 20]]);
  assert.equal(again.doc.sketches[0].points.length, 5);
  assert.deepEqual(again.doc.sketches[0].curves.at(-1), { id: "circle-14", kind: "circle", centre: "point-12", radius: 20 });
});

test("a second click on the centre draws nothing and says why; the centre stays", () => {
  const f = freshCircle();
  const down = clickAt(f.doc, f.tool, [10, -10]);
  const r = clickAt(down.doc, down.tool, [10, -10]);
  assert.equal(r.drew, false);
  assert.equal(r.doc, down.doc, "the document is untouched");
  assert.deepEqual(r.tool.centre, [10, -10], "still waiting for a point on the circle");
  assert.match(r.note ?? "", /^A circle needs a radius/);
  // Off the centre by one grid step on either axis: drawn, no note.
  for (const at of [[20, -10], [10, 0], [0, -20]] as SketchXY[]) {
    const ok = clickAt(down.doc, down.tool, at);
    assert.equal(ok.drew, true, `${at}`);
    assert.equal(ok.note, undefined, `${at}`);
  }
});

test("hand-worked: a circle drawn as 64 segments round (10, 20), radius 5", () => {
  // Point k is at angle 2πk/64 from the east point: k = 0 is (10 + 5, 20) =
  // (15, 20); k = 16 (a quarter turn) is (10, 25); k = 32 (half) is (5, 20);
  // k = 48 is (10, 15). Every point is 5 from the centre, and segment k runs
  // from point k to point k + 1, the last one back to point 0 exactly.
  const segs = circleSegments([10, 20], 5);
  assert.equal(CIRCLE_SEGMENTS, 64);
  assert.equal(segs.length, 64);
  assert.deepEqual(segs[0][0], [15, 20]);
  const near = (p: SketchXY, q: SketchXY, what: string) => assert.ok(Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-12, `${what}: ${p} is not ${q}`);
  near(segs[16][0], [10, 25], "a quarter turn");
  near(segs[32][0], [5, 20], "a half turn");
  near(segs[48][0], [10, 15], "three quarters");
  assert.equal(segs[63][1], segs[0][0], "closed: the last segment ends on the first point");
  for (let k = 0; k < 64; k++) {
    assert.equal(segs[k][1], segs[(k + 1) % 64][0], `segment ${k} meets the next`);
    assert.ok(Math.abs(Math.hypot(segs[k][0][0] - 10, segs[k][0][1] - 20) - 5) < 1e-12, `point ${k} on the circle`);
    // Each side is the chord 2r·sin(π/64) = 10·sin(π/64) ≈ 0.49067674.
    assert.ok(Math.abs(Math.hypot(segs[k][1][0] - segs[k][0][0], segs[k][1][1] - segs[k][0][1]) - 10 * Math.sin(Math.PI / 64)) < 1e-12, `side ${k}`);
  }
  // Counter-clockwise: point 1 is above the east point.
  assert.ok(segs[1][0][1] > 20);
});

test("the circle's preview runs through the pointer, none before a centre or on it; drawings show circles as segments", () => {
  const f = freshCircle();
  assert.deepEqual(previewSegments(f.doc, f.tool, [5, 5]), [], "no centre yet");
  const down = clickAt(f.doc, f.tool, [0, 0]);
  // Pointer at (0, 30): radius 30, the same segments circleSegments gives.
  assert.deepEqual(previewSegments(down.doc, down.tool, [0, 30]), circleSegments([0, 0], 30));
  assert.deepEqual(previewSegments(down.doc, down.tool, [0, 0]), [], "on the centre: a click there draws nothing");
  assert.deepEqual(previewSegments(down.doc, down.tool, null), [], "pointer off the plane");
  // The pending centre is drawn as a point before it is one, and the preview is the circle.
  const [pending] = sketchDrawings(down.doc, { tool: down.tool, grid: 10, pointer: [30, 40] });
  assert.deepEqual(pending.editing!.points, [[0, 0]]);
  assert.equal(pending.editing!.preview.length, CIRCLE_SEGMENTS);
  // Drawn: a line then a circle; the viewport gets the line, then the circle's 64 segments, edited or not.
  const line = clicks(down.doc, { kind: "line", sketch: f.tool.sketch, from: null } as LineTool, [[50, 0], [60, 0]]);
  const drawn = clicks(line.doc, f.tool, [[0, 0], [30, 40]]);
  for (const editing of [{ tool: drawn.tool, grid: 10, pointer: null }, null]) {
    const [d] = sketchDrawings(drawn.doc, editing);
    assert.deepEqual(d.lines, [[[50, 0], [60, 0]], ...circleSegments([0, 0], 50)]);
  }
  // The centre already a point is not drawn twice while a new circle round it is started.
  const again = clickAt(drawn.doc, drawn.tool, [0, 0]);
  assert.deepEqual(sketchDrawings(again.doc, { tool: again.tool, grid: 10, pointer: null })[0].editing!.points, [[50, 0], [60, 0], [0, 0]]);
});

test("hand-worked: the sketch status counts lines and circles apart", () => {
  const f = freshCircle();
  const sketch = (doc: DesignDocument) => doc.sketches[0];
  assert.equal(curveCount(sketch(f.doc)), "Nothing drawn yet");
  const one = clicks(f.doc, f.tool, [[0, 0], [0, 10]]).doc;
  assert.equal(curveCount(sketch(one)), "1 circle");
  const two = clicks(one, f.tool, [[50, 0], [50, 10]]).doc;
  assert.equal(curveCount(sketch(two)), "2 circles");
  const line = { kind: "line", sketch: f.tool.sketch, from: null } as LineTool;
  assert.equal(curveCount(sketch(clicks(f.doc, line, [[0, 0], [10, 0]]).doc)), "1 line");
  assert.equal(curveCount(sketch(clicks(two, line, [[0, 0], [10, 0], [10, 10]]).doc)), "2 lines and 2 circles");
  const rect = clicks(one, { kind: "rectangle", sketch: f.tool.sketch, corner: null } as RectangleTool, [[20, 20], [40, 40]]).doc;
  assert.equal(curveCount(sketch(rect)), "4 lines and 1 circle");
  assert.equal(curveCount(sketch(clicks(f.doc, { kind: "rectangle", sketch: f.tool.sketch, corner: null } as RectangleTool, [[20, 20], [40, 40]]).doc)), "4 lines");
});

test("tools: Escape ends what is part way, switching starts afresh, L, R, C and A choose them", () => {
  const f = freshRectangle();
  assert.equal(toolBusy(f.tool), false);
  assert.equal(toolBusy(clickAt(f.doc, f.tool, [0, 0]).tool), true, "a first corner down");
  assert.equal(toolBusy(fresh().tool), false);
  assert.equal(toolBusy(clickAt(fresh().doc, fresh().tool, [0, 0]).tool), true, "a chain started");
  assert.deepEqual(startTool("line", "sketch-2"), { kind: "line", sketch: "sketch-2", from: null });
  assert.deepEqual(startTool("rectangle", "sketch-2"), { kind: "rectangle", sketch: "sketch-2", corner: null });
  assert.deepEqual(startTool("circle", "sketch-2"), { kind: "circle", sketch: "sketch-2", centre: null });
  assert.equal(toolBusy(freshCircle().tool), false);
  assert.equal(toolBusy(clickAt(freshCircle().doc, freshCircle().tool, [0, 0]).tool), true, "a centre down");
  assert.deepEqual(startTool("arc", "sketch-2"), { kind: "arc", sketch: "sketch-2", start: null, end: null });
  assert.deepEqual(SKETCH_TOOLS.map((t) => [t.kind, t.key]), [["line", "L"], ["rectangle", "R"], ["circle", "C"], ["arc", "A"], ["centre", undefined], ["tangent", "T"]]);
  assert.deepEqual(startTool("tangent", "sketch-2"), { kind: "tangent", sketch: "sketch-2", from: null });
  assert.deepEqual(startTool("centre", "sketch-2"), { kind: "centre", sketch: "sketch-2", centre: null, start: null, swept: 0 });
  // The keys in Design's table are the ones the panel's buttons name, and they choose those tools (the centre arc has none).
  for (const t of SKETCH_TOOLS) {
    if (!t.key) continue;
    const spec = DESIGN_SHORTCUTS.find((s) => s.keys === t.key)!;
    assert.equal(sketchToolKey(spec.id), t.kind);
    assert.equal(spec.inText, undefined, "never while typing a grid size");
  }
  assert.equal(sketchToolKey("clear-selection"), null);
});

/** Mulberry32: a small seeded generator, so a failing session replays from its seed. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("seeded sessions of random clicks, Escapes and tool switches match a model that knows only coordinates", () => {
  let rectangles = 0;
  let circles = 0;
  let refused = 0;
  const next = { line: "rectangle", rectangle: "circle", circle: "line" } as const;
  for (const seed of [1, 2, 3, 4, 5]) {
    const random = rng(seed);
    let { doc } = fresh();
    let tool: SketchTool = fresh().tool;
    let corner: string | null = null;
    let centre: string | null = null;
    // The model: where the chain is, the points there are (as "x,y"), the segments drawn.
    let from: string | null = null;
    const points = new Set<string>();
    const segments: string[] = [];
    const rounds: string[] = [];
    for (let step = 0; step < 400; step++) {
      const roll = random();
      if (roll < 0.1) {
        tool = startTool(tool.kind, tool.sketch); // Escape
        from = corner = centre = null;
        continue;
      }
      if (roll < 0.15) {
        tool = startTool(next[tool.kind], tool.sketch); // the next tool
        from = corner = centre = null;
        continue;
      }
      // A 5 × 5 grid of nodes 10 apart, so clicks often land on points already there.
      const at: SketchXY = [10 * Math.floor(random() * 5), 10 * Math.floor(random() * 5)];
      const key = `${at[0]},${at[1]}`;
      const r = clickAt(doc, tool, at);
      doc = r.doc;
      if (tool.kind === "line") {
        if (from === null) from = key;
        else if (from !== key && (segments.includes(`${from} ${key}`) || segments.includes(`${key} ${from}`))) {
          // A line already joins the two places (a side drawn again): nothing drawn, the chain stays (25a5).
          assert.equal(r.note, SAME_LINE);
          refused++;
        } else if (from !== key) {
          const existed = points.has(key);
          segments.push(`${from} ${key}`);
          points.add(from).add(key);
          from = existed ? null : key;
        }
      } else if (tool.kind === "circle") {
        if (centre === null) centre = key;
        else if (centre !== key) {
          // The model's radius: the distance between the two clicks, worked out from the keys alone.
          const [cx, cy] = centre.split(",").map(Number);
          rounds.push(`${centre} r${Math.sqrt((at[0] - cx) ** 2 + (at[1] - cy) ** 2)}`);
          points.add(centre);
          centre = null;
          circles++;
        }
      } else if (corner === null) corner = key;
      else {
        const [ax, ay] = corner.split(",").map(Number);
        if (ax !== at[0] && ay !== at[1]) {
          const c = [corner, `${at[0]},${ay}`, key, `${ax},${at[1]}`];
          c.forEach((p, i) => segments.push(`${p} ${c[(i + 1) % 4]}`));
          c.forEach((p) => points.add(p));
          corner = null;
          rectangles++;
        }
      }
      tool = r.tool;
      const where = `seed ${seed}, step ${step}`;
      const sketch = doc.sketches[0];
      const curves = sketchCurves(sketch);
      assert.deepEqual(curves.lines.map((l) => `${l.a[0]},${l.a[1]} ${l.b[0]},${l.b[1]}`), segments, `${where}: the lines`);
      assert.deepEqual(curves.circles.map((c) => `${c.centre[0]},${c.centre[1]} r${c.radius}`), rounds, `${where}: the circles`);
      assert.equal(new Set(sketch.points.map((p) => `${p.x},${p.y}`)).size, sketch.points.length, `${where}: no two points in one place`);
      assert.equal(sketch.points.length, points.size, `${where}: one point per place`);
      assert.equal(toolBusy(tool), (tool.kind === "line" ? from : tool.kind === "rectangle" ? corner : centre) !== null, `${where}: part way`);
    }
    assert.deepEqual(readDesignDocument(JSON.parse(JSON.stringify(doc))), doc, `seed ${seed}: the session opens as saved`);
  }
  assert.ok(rectangles >= 100, `the sessions drew ${rectangles} rectangles`);
  assert.ok(circles >= 100, `the sessions drew ${circles} circles`);
  assert.ok(refused >= 20, `the sessions tried ${refused} lines on top of another`);
});

test("hand-worked: arcs drawn as segments, a quarter turn in 16 like a quarter of a drawn circle (23a)", () => {
  const near = (p: SketchXY, q: SketchXY, what: string) => assert.ok(Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-12, `${what}: ${p} is not ${q}`);
  // From the east point (15, 20) of the circle round (10, 20), radius 5, to
  // its north point (10, 25): a quarter turn, ⌈64 × ¼⌉ = 16 segments, each
  // the chord 10·sin(π/64), as on the drawn circle; step 8 is at 45°,
  // (10 + 5/√2, 20 + 5/√2). It starts and ends on the given points exactly.
  const quarter = arcSegments({ start: [15, 20], end: [10, 25], centre: [10, 20] });
  assert.equal(quarter.length, 16);
  assert.equal(quarter[0][0][0], 15);
  assert.deepEqual([quarter[0][0], quarter[15][1]], [[15, 20], [10, 25]]);
  near(quarter[8][0], [10 + 5 / Math.SQRT2, 20 + 5 / Math.SQRT2], "45°");
  for (let k = 0; k < 16; k++) {
    if (k > 0) assert.equal(quarter[k][0], quarter[k - 1][1], `segment ${k} meets the last`);
    assert.ok(Math.abs(Math.hypot(quarter[k][1][0] - quarter[k][0][0], quarter[k][1][1] - quarter[k][0][1]) - 10 * Math.sin(Math.PI / 64)) < 1e-12, `side ${k}`);
  }
  // Counter-clockwise across the angle where atan2 jumps: from north (90°)
  // round through west and south to east (360°), three quarters, 48
  // segments; a quarter of the way along (16) is the west point (5, 20).
  const round = arcSegments({ start: [10, 25], end: [15, 20], centre: [10, 20] });
  assert.equal(round.length, 48);
  near(round[16][0], [5, 20], "west");
  near(round[32][0], [10, 15], "south");
  // A sliver of an arc is one segment, start to end.
  assert.deepEqual(arcSegments({ start: [10, 0], end: [10 * Math.cos(1e-4), 10 * Math.sin(1e-4)], centre: [0, 0] }), [[[10, 0], [10 * Math.cos(1e-4), 10 * Math.sin(1e-4)]]]);
  // A whole turn when the ends are at one angle (refused by the kernel; drawn anyway).
  assert.equal(arcSegments({ start: [5, 0], end: [6, 0], centre: [0, 0] }).length, 64);
});

test("drawings show arcs after lines and circles, and the status counts them (23a)", () => {
  const f = fresh();
  const line = clicks(f.doc, f.tool, [[0, 0], [10, 0]]);
  const ringed = drawCircle(line.doc, f.tool.sketch, [50, 50], 2).doc;
  const arc = drawArc(ringed, f.tool.sketch, "point-4", [0, 10], "point-3").doc;
  for (const editing of [{ tool: f.tool, grid: 10, pointer: null }, null]) {
    const [d] = sketchDrawings(arc, editing);
    assert.deepEqual(d.lines, [[[0, 0], [10, 0]], ...circleSegments([50, 50], 2), ...arcSegments({ start: [10, 0], end: [0, 10], centre: [0, 0] })]);
  }
  const sketch = (doc: DesignDocument) => doc.sketches[0];
  assert.equal(curveCount(sketch(arc)), "1 line, 1 arc and 1 circle");
  const twoArcs = drawArc(arc, f.tool.sketch, [0, 10], [-10, 0], "point-3").doc;
  assert.equal(curveCount(sketch(twoArcs)), "1 line, 2 arcs and 1 circle");
  const fresh2 = fresh();
  const lone = drawArc(fresh2.doc, fresh2.tool.sketch, [5, 0], [-5, 0], [0, 0]).doc;
  assert.equal(curveCount(sketch(lone)), "1 arc");
  const withLines = clicks(lone, fresh2.tool, [[20, 0], [30, 0], [30, 10]]).doc;
  assert.equal(curveCount(sketch(withLines)), "2 lines and 1 arc");
});
