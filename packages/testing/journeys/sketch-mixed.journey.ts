// Journey: sketches drawn with the tools mixed (lines, rectangles and
// circles in one sketch, curves deleted along the way), on the real WASM
// kernel through the same calls Design makes: the tools' clickAt, then
// sketch_outline on the sketch's curves, then the extrude's volume. Every
// answer is checked against src/outline-model.ts, a model of the outline
// rules written apart from the kernel. Hand-worked cases first, then
// seeded random sessions, then seeded closed outlines built from more than
// one tool. Arcs join the mixes when the arc tools land (step 23).
// Run with `npm run journeys` after the app build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { addSketch, buildSpec, clickAt, deleteCurve, extrudeSketch, featureSpec, lastFeature, partDocument, sketchCurves, startTool, type DesignDocument, type SketchTool, type ToolKind } from "@fission/design";
import { nodeKernel } from "../src/node-kernel.ts";
import { seeded, type SeededRandom } from "../src/index.ts";
import { compareOutline, isClosed, modelOutline, type ModelOutline, type XY } from "../src/outline-model.ts";

const kernel = nodeKernel();
const D = 10; // every extrude here is 10 mm

/** A box part with an empty Sketch 1, and the line tool on it. */
function fresh() {
  const s = addSketch(partDocument("box", 10, 10, 10));
  return { doc: s.doc, sketch: s.id, tool: startTool("line", s.id) as SketchTool };
}

/** Clicks with the tool at each point in turn (already on the grid, as the kernel would snap them). */
function clicks(doc: DesignDocument, tool: SketchTool, pts: XY[]) {
  for (const p of pts) ({ doc, tool } = clickAt(doc, tool, [p[0], p[1]]));
  return { doc, tool };
}

/** The model's answer for the sketch as it stands. */
const modelOf = (doc: DesignDocument): ModelOutline => {
  const { lines, circles } = sketchCurves(doc.sketches[0]);
  return modelOutline(lines, circles);
};

/** The kernel's answer, checked against the model; a closed one is extruded 10 mm and its volume checked too. */
async function agree(doc: DesignDocument, sketch: string, where: string): Promise<ModelOutline> {
  const model = modelOf(doc);
  const { lines, circles } = sketchCurves(doc.sketches[0]);
  compareOutline(model, await kernel.call("sketch_outline", lines, circles), where);
  if (isClosed(model)) {
    const part = extrudeSketch(doc, sketch, D).doc;
    const body = await buildSpec(kernel, await featureSpec(kernel, part, lastFeature(part)));
    const want = (model.kind === "closed" || model.kind === "circle" ? model.area : NaN) * D;
    assert.ok(Math.abs(body.volume - want) <= 1e-9 * want, `${where}: volume ${body.volume}, the model's area × 10 is ${want}`);
    assert.deepEqual(body.errors, [], `${where}: the body is valid`);
  }
  return model;
}

/** The id of the line between these two places, either way round. */
function lineBetween(doc: DesignDocument, p: XY, q: XY): string {
  const sk = doc.sketches[0];
  const at = new Map(sk.points.map((pt) => [pt.id, `${pt.x},${pt.y}`]));
  const want = [`${p[0]},${p[1]}`, `${q[0]},${q[1]}`].sort().join(" ");
  const line = sk.curves.find((c) => c.kind === "line" && [at.get(c.start), at.get(c.end)].sort().join(" ") === want);
  if (!line) throw new Error(`no line from ${p} to ${q}`);
  return line.id;
}

test("hand-worked: a rectangle and a circle in it are two loops (holes come with regions, step 26)", async () => {
  let { doc, sketch, tool } = fresh();
  ({ doc, tool } = clicks(doc, startTool("rectangle", sketch), [[0, 0], [40, 30]]));
  ({ doc, tool } = clicks(doc, startTool("circle", sketch), [[20, 15], [25, 15]]));
  assert.deepEqual(await agree(doc, sketch, "rectangle + circle"), { kind: "loops", loops: 2 });
});

test("hand-worked: a line chain started on a rectangle's corner makes a branch there", async () => {
  let { doc, sketch, tool } = fresh();
  ({ doc } = clicks(doc, startTool("rectangle", sketch), [[0, 0], [40, 30]]));
  // The rectangle's lines run (0,0)→(40,0)→(40,30)→(0,30)→(0,0); the chain (40,30)→(60,30)→(60,0)→(40,0)
  // ends on (40, 0), where the first two rectangle sides already meet: three ends, at the rectangle's
  // first line's end (end 1), the first end in drawing order with a problem.
  ({ doc, tool } = clicks(doc, tool, [[40, 30], [60, 30], [60, 0], [40, 0]]));
  assert.deepEqual(await agree(doc, sketch, "rectangle + chain"), { kind: "branch", at: [40, 0], ends: 3 });
});

test("hand-worked: a rectangle with its top deleted and a roof drawn with lines is a closed house of 1600 mm², 16,000 mm³", async () => {
  let { doc, sketch, tool } = fresh();
  ({ doc } = clicks(doc, startTool("rectangle", sketch), [[0, 0], [40, 30]]));
  doc = deleteCurve(doc, sketch, lineBetween(doc, [40, 30], [0, 30]));
  assert.deepEqual(await agree(doc, sketch, "the top deleted"), { kind: "loose", at: [40, 30] });
  // Rectangle 40 · 30 = 1200, roof triangle ½ · 40 · (50 − 30) = 400: 1600 mm², by 10 mm 16,000 mm³.
  ({ doc, tool } = clicks(doc, tool, [[40, 30], [20, 50], [0, 30]]));
  const m = await agree(doc, sketch, "house");
  assert.equal(m.kind === "closed" && m.area, 1600);
  // A circle beside it makes two loops; deleting the circle closes it again.
  ({ doc } = clicks(doc, startTool("circle", sketch), [[100, 0], [110, 0]]));
  assert.deepEqual(await agree(doc, sketch, "house + circle"), { kind: "loops", loops: 2 });
  doc = deleteCurve(doc, sketch, doc.sketches[0].curves.at(-1)!.id);
  assert.equal((await agree(doc, sketch, "circle deleted")).kind, "closed");
});

test("hand-worked: a flat roof drawn as two lines goes straight on at (20, 30): the 1200 mm² rectangle again", async () => {
  let { doc, sketch, tool } = fresh();
  ({ doc } = clicks(doc, startTool("rectangle", sketch), [[0, 0], [40, 30]]));
  doc = deleteCurve(doc, sketch, lineBetween(doc, [40, 30], [0, 30]));
  ({ doc, tool } = clicks(doc, tool, [[40, 30], [20, 30], [0, 30]]));
  const m = await agree(doc, sketch, "flat roof");
  assert.equal(m.kind === "closed" && m.area, 1200);
});

test("hand-worked: a roof dipping to (20, 10) is 1200 − ½ · 40 · 20 = 800 mm²; one dipping to the floor at (20, 0) is refused", async () => {
  let { doc, sketch, tool } = fresh();
  ({ doc } = clicks(doc, startTool("rectangle", sketch), [[0, 0], [40, 30]]));
  doc = deleteCurve(doc, sketch, lineBetween(doc, [40, 30], [0, 30]));
  const opened = doc;
  ({ doc } = clicks(doc, tool, [[40, 30], [20, 10], [0, 30]]));
  const m = await agree(doc, sketch, "dipping roof");
  assert.equal(m.kind === "closed" && m.area, 800);
  // The corner (20, 0) lies on the floor (0,0)–(40,0): the outline touches itself.
  ({ doc } = clicks(opened, startTool("line", sketch), [[40, 30], [20, 0], [0, 30]]));
  assert.equal((await agree(doc, sketch, "roof on the floor")).kind, "not a profile");
});

test("hand-worked: lines that run back over themselves close up but are refused: a flat triangle, and a line there and back", async () => {
  // (0,0) → (40,0) → (20,0) → (0,0): three corners in a line, turning straight back at (40, 0) and (0, 0).
  let { doc, sketch, tool } = fresh();
  ({ doc, tool } = clicks(doc, tool, [[0, 0], [40, 0], [20, 0], [0, 0]]));
  assert.equal((await agree(doc, sketch, "flat triangle")).kind, "not a profile");
  // (0,0) → (10,0) → (0,0): a loop of two corners.
  ({ doc, sketch, tool } = fresh());
  ({ doc } = clicks(doc, tool, [[0, 0], [10, 0], [0, 0]]));
  const m = await agree(doc, sketch, "there and back");
  assert.deepEqual([m.kind, m.kind === "not a profile" && m.why], ["not a profile", "2 corners"]);
});

test("hand-worked: a circle stays the outline after a rectangle is drawn and its four sides deleted: π · 10² · 10 = 1000π mm³", async () => {
  let { doc, sketch } = fresh();
  ({ doc } = clicks(doc, startTool("circle", sketch), [[0, 0], [10, 0]]));
  ({ doc } = clicks(doc, startTool("rectangle", sketch), [[20, 20], [40, 40]]));
  assert.deepEqual(await agree(doc, sketch, "circle + rectangle"), { kind: "loops", loops: 2 });
  for (const c of doc.sketches[0].curves.filter((c) => c.kind === "line")) doc = deleteCurve(doc, sketch, c.id);
  assert.deepEqual(await agree(doc, sketch, "the circle alone"), { kind: "circle", area: 100 * Math.PI });
});

const KINDS: readonly ToolKind[] = ["line", "rectangle", "circle"];
const pick = <T>(r: SeededRandom, xs: readonly T[]): T => xs[Math.floor(r.next() * xs.length)];

test("seeded sessions: random clicks with all three tools, Escapes and deletes, every outline as the model says", async () => {
  const seen = new Map<string, number>();
  for (const seed of [1n, 2n, 3n, 4n, 5n]) {
    const r = seeded(seed);
    for (let session = 0; session < 60; session++) {
      let { doc, sketch, tool } = fresh();
      const steps: string[] = [];
      for (let step = 0; step < 14; step++) {
        const roll = r.next();
        let changed = false;
        if (roll < 0.08) {
          tool = startTool(tool.kind, sketch);
          steps.push("Escape");
        } else if (roll < 0.2) {
          tool = startTool(pick(r, KINDS), sketch);
          steps.push(tool.kind);
        } else if (roll < 0.3 && doc.sketches[0].curves.length > 0) {
          const c = pick(r, doc.sketches[0].curves);
          doc = deleteCurve(doc, sketch, c.id);
          // The tool may be holding a point the delete took away: start it afresh, as Design does after an edit.
          tool = startTool(tool.kind, sketch);
          steps.push(`delete ${c.id}`);
          changed = true;
        } else {
          // A 5 × 5 grid of nodes 10 apart, so clicks often land on points already there.
          const at: XY = [10 * Math.floor(r.next() * 5), 10 * Math.floor(r.next() * 5)];
          const done = clickAt(doc, tool, [at[0], at[1]]);
          ({ doc, tool } = done);
          steps.push(`${tool.kind} ${at}`);
          changed = done.drew;
        }
        if (!changed) continue;
        const m = await agree(doc, sketch, `seed ${seed}, session ${session}: ${steps.join("; ")}`);
        seen.set(m.kind, (seen.get(m.kind) ?? 0) + 1);
      }
    }
  }
  // The sessions must reach every answer often, or they test less than they seem to.
  for (const kind of ["empty", "loose", "branch", "loops", "not a profile", "closed", "circle"]) {
    assert.ok((seen.get(kind) ?? 0) >= 10, `${kind}: ${seen.get(kind) ?? 0} times (${JSON.stringify([...seen])})`);
  }
});

test("seeded closed outlines from two tools: a rectangle, its top deleted, a roof of lines either way round, a circle added and deleted", async () => {
  let built = 0;
  for (const seed of [1n, 2n, 3n, 4n, 5n]) {
    const r = seeded(seed);
    for (let n = 0; n < 30; n++) {
      // Corners on the 10 mm grid: 20 to 60 wide, 10 to 40 tall, anywhere in ±100.
      const x0 = 10 * Math.floor(r.next() * 21 - 10);
      const y0 = 10 * Math.floor(r.next() * 21 - 10);
      const x1 = x0 + 10 * (2 + Math.floor(r.next() * 5));
      const y1 = y0 + 10 * (1 + Math.floor(r.next() * 4));
      let { doc, sketch } = fresh();
      ({ doc } = clicks(doc, startTool("rectangle", sketch), [[x0, y0], [x1, y1]]));
      doc = deleteCurve(doc, sketch, lineBetween(doc, [x1, y1], [x0, y1]));
      // The roof: one corner per grid column strictly between the sides, each above the floor (y > y0),
      // so it goes one way in x and can't touch the floor or the sides: always a simple outline.
      const roof: XY[] = [];
      for (let x = x1 - 10; x > x0; x -= 10) if (r.next() < 0.6) roof.push([x, y0 + 10 * (1 + Math.floor(r.next() * 6))]);
      const path: XY[] = [[x1, y1], ...roof, [x0, y1]];
      if (r.next() < 0.5) path.reverse();
      ({ doc } = clicks(doc, startTool("line", sketch), path));
      const where = `seed ${seed}, outline ${n}: (${x0}, ${y0})–(${x1}, ${y1}), roof ${JSON.stringify(path)}`;
      const m = await agree(doc, sketch, where);
      assert.equal(m.kind, "closed", where);
      ({ doc } = clicks(doc, startTool("circle", sketch), [[x0 - 30, y0], [x0 - 25, y0]]));
      assert.deepEqual(await agree(doc, sketch, `${where}, circle added`), { kind: "loops", loops: 2 });
      doc = deleteCurve(doc, sketch, doc.sketches[0].curves.at(-1)!.id);
      assert.deepEqual(await agree(doc, sketch, `${where}, circle deleted`), m);
      built++;
    }
  }
  assert.equal(built, 150);
});
