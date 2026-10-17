// Step 21c: the line tool's clicks as document edits (sketch-tool.ts):
// chains share their corners, a click on an existing point ends the chain,
// and the drawing the viewport is given. A seeded random session is checked
// against a simple model that knows only coordinates.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SketchXY } from "@fission/core";
import { partDocument, readDesignDocument, type DesignDocument } from "../src/document.ts";
import { addSketch, drawRectangle, SKETCH_STEPS, sketchLines } from "../src/sketch.ts";
import { clickAt, DEFAULT_GRID, drawStep, ORIGIN_PLANES, originPlanes, PLANE_VIEWS, previewLine, previewSegments, SKETCH_TOOLS, sketchDrawings, startTool, toolBusy, type LineTool, type RectangleTool, type SketchTool } from "../src/sketch-tool.ts";
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
  assert.deepEqual(first.editing, { grid: 5, points: [[0, 0], [10, 0], [10, 10]], preview: [[[10, 10], [20, 10]]] });
  assert.deepEqual(first.plane.normal, [0, 0, 1]);
  assert.deepEqual(second, { plane: first.plane, lines: [[[0, 0], [0, 5]]] });
  // The pending first click is drawn as a point before it is one.
  const pending = sketchDrawings(other.doc, { tool: { kind: "line", sketch: other.id, from: [3, 4] }, grid: DEFAULT_GRID, pointer: null });
  assert.deepEqual(pending[1].editing!.points, [[3, 4]]);
  assert.deepEqual(sketchDrawings(doc, null).map((d) => d.editing), [undefined, undefined], "nothing edited");
});

test("the plane prompt offers only the ground plane until step 24, and each plane is looked at straight down", () => {
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

test("tools: Escape ends what is part way, switching starts afresh, L and R choose them", () => {
  const f = freshRectangle();
  assert.equal(toolBusy(f.tool), false);
  assert.equal(toolBusy(clickAt(f.doc, f.tool, [0, 0]).tool), true, "a first corner down");
  assert.equal(toolBusy(fresh().tool), false);
  assert.equal(toolBusy(clickAt(fresh().doc, fresh().tool, [0, 0]).tool), true, "a chain started");
  assert.deepEqual(startTool("line", "sketch-2"), { kind: "line", sketch: "sketch-2", from: null });
  assert.deepEqual(startTool("rectangle", "sketch-2"), { kind: "rectangle", sketch: "sketch-2", corner: null });
  assert.deepEqual(SKETCH_TOOLS.map((t) => [t.kind, t.key]), [["line", "L"], ["rectangle", "R"]]);
  // The keys in Design's table are the ones the panel's buttons name, and they choose those tools.
  for (const t of SKETCH_TOOLS) {
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
  for (const seed of [1, 2, 3, 4, 5]) {
    const random = rng(seed);
    let { doc } = fresh();
    let tool: SketchTool = fresh().tool;
    let corner: string | null = null;
    // The model: where the chain is, the points there are (as "x,y"), the segments drawn.
    let from: string | null = null;
    const points = new Set<string>();
    const segments: string[] = [];
    for (let step = 0; step < 400; step++) {
      const roll = random();
      if (roll < 0.1) {
        tool = startTool(tool.kind, tool.sketch); // Escape
        from = corner = null;
        continue;
      }
      if (roll < 0.15) {
        tool = startTool(tool.kind === "line" ? "rectangle" : "line", tool.sketch); // the other tool
        from = corner = null;
        continue;
      }
      // A 5 × 5 grid of nodes 10 apart, so clicks often land on points already there.
      const at: SketchXY = [10 * Math.floor(random() * 5), 10 * Math.floor(random() * 5)];
      const key = `${at[0]},${at[1]}`;
      const r = clickAt(doc, tool, at);
      doc = r.doc;
      if (tool.kind === "line") {
        if (from === null) from = key;
        else if (from !== key) {
          const existed = points.has(key);
          segments.push(`${from} ${key}`);
          points.add(from).add(key);
          from = existed ? null : key;
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
      assert.deepEqual(sketchLines(sketch).map((l) => `${l.a[0]},${l.a[1]} ${l.b[0]},${l.b[1]}`), segments, `${where}: the lines`);
      assert.equal(new Set(sketch.points.map((p) => `${p.x},${p.y}`)).size, sketch.points.length, `${where}: no two points in one place`);
      assert.equal(sketch.points.length, points.size, `${where}: one point per place`);
      assert.equal(toolBusy(tool), tool.kind === "line" ? from !== null : corner !== null, `${where}: part way`);
    }
    assert.deepEqual(readDesignDocument(JSON.parse(JSON.stringify(doc))), doc, `seed ${seed}: the session opens as saved`);
  }
  assert.ok(rectangles >= 100, `the sessions drew ${rectangles} rectangles`);
});
