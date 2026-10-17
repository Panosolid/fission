// Step 21c: the line tool's clicks as document edits (sketch-tool.ts):
// chains share their corners, a click on an existing point ends the chain,
// and the drawing the viewport is given. A seeded random session is checked
// against a simple model that knows only coordinates.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SketchXY } from "@fission/core";
import { partDocument, readDesignDocument, type DesignDocument } from "../src/document.ts";
import { addSketch, sketchLines } from "../src/sketch.ts";
import { clickAt, DEFAULT_GRID, ORIGIN_PLANES, originPlanes, PLANE_VIEWS, previewLine, sketchDrawings, type LineTool } from "../src/sketch-tool.ts";

function fresh() {
  const s = addSketch(partDocument("box", 40, 30, 20));
  return { doc: s.doc, tool: { sketch: s.id, from: null } as LineTool };
}

function clicks(doc: DesignDocument, tool: LineTool, at: SketchXY[]) {
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
  const doc = clicks(other.doc, { sketch: other.id, from: null }, [[0, 0], [0, 5]]).doc;
  const [first, second] = sketchDrawings(doc, { tool: drawn.tool, grid: 5, pointer: [20, 10] });
  assert.deepEqual(first.lines, [[[0, 0], [10, 0]], [[10, 0], [10, 10]]]);
  assert.deepEqual(first.editing, { grid: 5, points: [[0, 0], [10, 0], [10, 10]], preview: [[10, 10], [20, 10]] });
  assert.deepEqual(first.plane.normal, [0, 0, 1]);
  assert.deepEqual(second, { plane: first.plane, lines: [[[0, 0], [0, 5]]] });
  // The pending first click is drawn as a point before it is one.
  const pending = sketchDrawings(other.doc, { tool: { sketch: other.id, from: [3, 4] }, grid: DEFAULT_GRID, pointer: null });
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

/** Mulberry32: a small seeded generator, so a failing session replays from its seed. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("seeded sessions of random clicks and Escapes match a model that knows only coordinates", () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const random = rng(seed);
    let { doc, tool } = fresh();
    // The model: where the chain is, the points there are (as "x,y"), the segments drawn.
    let from: string | null = null;
    const points = new Set<string>();
    const segments: string[] = [];
    for (let step = 0; step < 400; step++) {
      if (random() < 0.1) {
        tool = { ...tool, from: null }; // Escape
        from = null;
        continue;
      }
      // A 5 × 5 grid of nodes 10 apart, so clicks often land on points already there.
      const at: SketchXY = [10 * Math.floor(random() * 5), 10 * Math.floor(random() * 5)];
      const key = `${at[0]},${at[1]}`;
      const r = clickAt(doc, tool, at);
      doc = r.doc;
      tool = r.tool;
      if (from === null) from = key;
      else if (from !== key) {
        const existed = points.has(key);
        segments.push(`${from} ${key}`);
        points.add(from).add(key);
        from = existed ? null : key;
      }
      const where = `seed ${seed}, step ${step}`;
      const sketch = doc.sketches[0];
      assert.deepEqual(sketchLines(sketch).map((l) => `${l.a[0]},${l.a[1]} ${l.b[0]},${l.b[1]}`), segments, `${where}: the lines`);
      assert.equal(new Set(sketch.points.map((p) => `${p.x},${p.y}`)).size, sketch.points.length, `${where}: no two points in one place`);
      assert.equal(sketch.points.length, points.size, `${where}: one point per place`);
      assert.equal(tool.from === null, from === null, `${where}: the chain`);
    }
    assert.deepEqual(readDesignDocument(JSON.parse(JSON.stringify(doc))), doc, `seed ${seed}: the session opens as saved`);
  }
});
