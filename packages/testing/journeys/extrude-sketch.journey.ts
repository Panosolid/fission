// Journey: extruding a sketch through the real WASM kernel (step 21d), the
// same calls Design makes: the extrude feature's outline asked of the
// kernel from the saved lines each build, then make_extrude. Hand-worked
// volumes first, then seeded sessions of sketch and extrude edits checked
// against a model that only keeps the corners as coordinates. Run with
// `npm run journeys` after the app build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyProject, projectFromJson, projectToJson } from "@fission/core";
import { addSketch, buildSpec, clickAt, deleteCurve, designWorkspace, drawCircle, drawLine, drawRectangle, extrudeSketch, startTool, featureSpec, lastFeature, movePoint, partDocument, setExtrudeDistance, withPart, type DesignDocument } from "@fission/design";
import { nodeKernel } from "../src/node-kernel.ts";
import { seeded, type SeededRandom } from "../src/index.ts";

const kernel = nodeKernel();

/** The part's body, built as Design builds it. */
const build = async (doc: DesignDocument) => buildSpec(kernel, await featureSpec(kernel, doc, lastFeature(doc)));

/** Saved and opened again, as the file holds it. */
const reopened = (doc: DesignDocument) =>
  projectFromJson(projectToJson({ ...emptyProject("Extrude"), workspaces: { design: doc } }), [designWorkspace]).workspaces.design as DesignDocument;

/** A closed chain through these corners in Sketch 1 on a box part; returns the document, the sketch and the corners' point ids in order. */
function polygon(corners: readonly (readonly [number, number])[]) {
  const s = addSketch(partDocument("box", 10, 10, 10));
  let doc = drawLine(s.doc, s.id, corners[0], corners[1]).doc;
  const ids = [...doc.sketches[0].points.map((p) => p.id)];
  for (const c of corners.slice(2)) {
    doc = drawLine(doc, s.id, ids.at(-1)!, c).doc;
    ids.push(doc.sketches[0].points.at(-1)!.id);
  }
  doc = drawLine(doc, s.id, ids.at(-1)!, ids[0]).doc;
  return { doc, sketch: s.id, ids };
}

/** Shoelace area: ½ |Σ x_i y_{i+1} − x_{i+1} y_i|. */
const area = (pts: readonly (readonly [number, number])[]) =>
  Math.abs(pts.reduce((s, [x, y], i) => s + x * pts[(i + 1) % pts.length][1] - pts[(i + 1) % pts.length][0] * y, 0)) / 2;

const near = (got: number, want: number, what: string) => assert.ok(Math.abs(got - want) <= 1e-9 * Math.max(1, Math.abs(want)), `${what}: ${got}, expected ${want}`);

test("hand-worked: a 40 × 30 rectangle extruded 10 mm, then a corner moved, then a side deleted", async () => {
  const { doc, sketch, ids } = polygon([[0, 0], [40, 0], [40, 30], [0, 30]]);
  let part = extrudeSketch(doc, sketch, 10).doc;
  // A box 40 × 30 × 10: volume 40·30·10 = 12000 mm³; area 2(40·30) + 2(40·10)
  // + 2(30·10) = 2400 + 800 + 600 = 3800 mm²; 8 corners, 12 edges, 6 faces.
  let body = await build(reopened(part));
  near(body.volume, 12000, "volume");
  near(body.area, 3800, "area");
  assert.deepEqual([body.vertices, body.edges, body.faces, body.errors], [8, 12, 6, []]);
  // Typed 2.5 mm: 1200 mm² · 2.5 = 3000 mm³.
  body = await build(setExtrudeDistance(part, 2.5));
  near(body.volume, 3000, "volume at 2.5 mm");
  // Corner (40, 30) moved to (40, 50): a trapezium with parallel sides 30 (x = 0)
  // and 50 (x = 40), 40 apart, ½ (30 + 50) · 40 = 1600 mm²; by 10 mm, 16000 mm³.
  part = movePoint(part, sketch, ids[2], 40, 50);
  near((await build(reopened(part))).volume, 16000, "volume after the move");
  // One side deleted: the sketch is open, and the extrude says why in the kernel's words.
  const open = deleteCurve(part, sketch, part.sketches[0].curves[1].id);
  await assert.rejects(build(open), /^Error: Sketch 1 has no closed outline: the line end at \(40, 0\) is not joined to another line$/);
});

test("hand-worked: a 3-4-5 triangle extruded 2 mm is 12 mm³, with 5 faces", async () => {
  // ½ · 4 · 3 = 6 mm², times 2 = 12 mm³; 3 sides and 2 caps.
  const { doc, sketch } = polygon([[0, 0], [4, 0], [0, 3]]);
  const body = await build(extrudeSketch(doc, sketch, 2).doc);
  near(body.volume, 12, "volume");
  assert.equal(body.faces, 5);
});

/**
 * A star-shaped polygon round a centre: corners at increasing angles, no
 * gap between neighbours as wide as a half turn, so it is simple, and
 * stays simple when a corner moves along its own ray.
 */
function star(r: SeededRandom) {
  const n = 3 + Math.floor(r.next() * 8);
  let gaps: number[];
  do {
    const w = Array.from({ length: n }, () => 0.2 + r.next());
    const sum = w.reduce((a, b) => a + b, 0);
    gaps = w.map((x) => (x / sum) * 2 * Math.PI);
  } while (gaps.some((g) => g >= 0.9 * Math.PI));
  const centre: [number, number] = [(r.next() - 0.5) * 400, (r.next() - 0.5) * 400];
  let t = r.next() * 2 * Math.PI;
  const angles = gaps.map((g) => (t += g));
  const radii = angles.map(() => 5 + r.next() * 45);
  return { centre, angles, radii };
}

const cornerAt = (centre: [number, number], angle: number, radius: number): [number, number] => [centre[0] + radius * Math.cos(angle), centre[1] + radius * Math.sin(angle)];

test("seeded sessions: sketch edits, extrudes, distances and presets against a model of the corners", async () => {
  let built = 0;
  let refused = 0;
  for (const seed of [1n, 2n, 3n, 4n, 5n]) {
    const r = seeded(seed);
    for (let session = 0; session < 8; session++) {
      const shape = star(r);
      // The model: corners as coordinates, which side is deleted (if any), and what the part is.
      const corners = shape.angles.map((a, i) => cornerAt(shape.centre, a, shape.radii[i]));
      const made = polygon(corners);
      let { doc } = made;
      const { sketch, ids } = made;
      let gap: number | null = null;
      let part: { kind: "extrude"; d: number } | { kind: "box"; w: number; d: number; h: number } = { kind: "box", w: 10, d: 10, h: 10 };
      for (let step = 0; step < 25; step++) {
        const roll = r.next();
        let op: string;
        if (roll < 0.25) {
          const d = Math.round((0.5 + r.next() * 99.5) * 10) / 10;
          op = `extrude by ${d}`;
          doc = extrudeSketch(doc, sketch, d).doc;
          part = { kind: "extrude", d };
        } else if (roll < 0.4 && part.kind === "extrude") {
          const d = Math.round((0.5 + r.next() * 99.5) * 100) / 100;
          op = `distance ${d}`;
          doc = setExtrudeDistance(doc, d);
          part = { kind: "extrude", d };
        } else if (roll < 0.7) {
          const i = Math.floor(r.next() * corners.length);
          const radius = 5 + r.next() * 45;
          corners[i] = cornerAt(shape.centre, shape.angles[i], radius);
          op = `move corner ${i} to ${corners[i]}`;
          doc = movePoint(doc, sketch, ids[i], ...corners[i]);
        } else if (roll < 0.8) {
          const [w, d, h] = [1 + r.next() * 50, 1 + r.next() * 50, 1 + r.next() * 50];
          op = `box ${w} × ${d} × ${h}`;
          doc = withPart(doc, "box", w, d, h);
          part = { kind: "box", w, d, h };
        } else if (gap === null) {
          // Delete side i (corner i to corner i + 1): the outline opens.
          gap = Math.floor(r.next() * corners.length);
          const line = doc.sketches[0].curves.find((c) => [c.start, c.end].sort().join() === [ids[gap!], ids[(gap! + 1) % ids.length]].sort().join())!;
          op = `delete side ${gap}`;
          doc = deleteCurve(doc, sketch, line.id);
        } else {
          // Draw it again between the same corners, the other way round: closed again.
          op = `close side ${gap}`;
          doc = drawLine(doc, sketch, ids[(gap + 1) % ids.length], ids[gap]).doc;
          gap = null;
        }
        const context = `seed ${seed} session ${session} step ${step} (${op})`;
        // Every few steps the build reads the document as a saved file holds it.
        const shown = r.next() < 0.3 ? reopened(doc) : doc;
        if (part.kind === "box") {
          near((await build(shown)).volume, part.w * part.d * part.h, context);
          built++;
        } else if (gap !== null) {
          await assert.rejects(build(shown), /Sketch 1 has no closed outline: /, context);
          refused++;
        } else {
          const body = await build(shown);
          near(body.volume, area(corners) * part.d, context);
          // n sides and two caps; a valid solid.
          assert.equal(body.faces, corners.length + 2, context);
          assert.deepEqual(body.errors, [], context);
          built++;
        }
      }
    }
  }
  // The sessions must reach every outcome, not pass by never building.
  assert.ok(built >= 500 && refused >= 20, `built ${built}, refused ${refused}`);
});

// Step 22a: the rectangle tool, through the same kernel calls.

test("hand-worked: the rectangle tool's two clicks, extruded 10 mm, make a 40 × 30 × 10 box", async () => {
  // The clicks are snapped as Design snaps them: (0.4, −0.3) to (0, 0) and
  // (39.6, 30.2) to (40, 30) on the 10 mm grid. A 40 × 30 rectangle by 10:
  // 40·30·10 = 12000 mm³, area 2·1200 + 2·400 + 2·300 = 3800 mm², 6 faces.
  const s = addSketch(partDocument("box", 10, 10, 10));
  let tool = startTool("rectangle", s.id);
  let doc = s.doc;
  for (const [x, y] of [[0.4, -0.3], [39.6, 30.2]]) {
    const snapped = await kernel.call("snap_to_grid", x, y, 10);
    ({ doc, tool } = clickAt(doc, tool, snapped));
  }
  assert.deepEqual(doc.sketches[0].points.map((p) => [p.x, p.y]), [[0, 0], [40, 0], [40, 30], [0, 30]]);
  const body = await build(reopened(extrudeSketch(doc, s.id, 10).doc));
  near(body.volume, 12000, "volume");
  near(body.area, 3800, "area");
  assert.deepEqual([body.vertices, body.edges, body.faces, body.errors], [8, 12, 6, []]);
});

test("a rectangle's sides at 0.9× and 1.1× of the kernel's shortest line (MIN_FEATURE, 0.001 mm)", async () => {
  // 1.1 µm × 1 mm by 1 mm: 0.0011 mm³. 0.9 µm wide: line 1 (the width) is refused, in the kernel's words.
  const at = (w: number) => {
    const s = addSketch(partDocument("box", 10, 10, 10));
    return extrudeSketch(drawRectangle(s.doc, s.id, [0, 0], [w, 1]).doc, s.id, 1).doc;
  };
  near((await build(at(0.0011))).volume, 0.0011, "1.1× wide");
  await assert.rejects(build(at(0.0009)), /^Error: line 1 must be between 0\.001 and \d+ mm long, got 0\.0009/);
});

test("seeded: rectangles from random grid corners, clicked in any order, extrude to |dx|·|dy|·d with 6 faces", async () => {
  let built = 0;
  for (const seed of [11n, 12n, 13n, 14n, 15n]) {
    const r = seeded(seed);
    for (let i = 0; i < 40; i++) {
      const grid = [0.5, 1, 2.5, 10][Math.floor(r.next() * 4)];
      const pick = async () => kernel.call("snap_to_grid", (r.next() - 0.5) * 900, (r.next() - 0.5) * 900, grid);
      const a = await pick();
      const c = await pick();
      const d = Math.round((0.5 + r.next() * 99.5) * 10) / 10;
      const s = addSketch(partDocument("box", 10, 10, 10));
      const context = `seed ${seed} rectangle ${i}: ${a} to ${c} on a ${grid} mm grid, by ${d}`;
      let { doc, tool } = { doc: s.doc, tool: startTool("rectangle", s.id) };
      ({ doc, tool } = clickAt(doc, tool, a));
      const second = clickAt(doc, tool, c);
      // The model: on one row or column nothing is drawn; otherwise a closed rectangle.
      if (a[0] === c[0] || a[1] === c[1]) {
        assert.equal(second.drew, false, context);
        continue;
      }
      const body = await build(reopened(extrudeSketch(second.doc, s.id, d).doc));
      near(body.volume, Math.abs(c[0] - a[0]) * Math.abs(c[1] - a[1]) * d, context);
      assert.deepEqual([body.faces, body.errors], [6, []], context);
      built++;
    }
  }
  assert.ok(built >= 190, `built ${built}`);
});

test("hand-worked: a circle of radius 5 extruded 2 mm is πr²h = 50π mm³, and a line beside it makes two loops (22b)", async () => {
  const s = addSketch(partDocument("box", 10, 10, 10));
  const circle = drawCircle(s.doc, s.id, [3, -4], 5);
  const part = extrudeSketch(circle.doc, s.id, 2).doc;
  // V = π·5²·2 = 50π; A = two discs 2·π·5² = 50π plus the side 2π·5·2 = 20π,
  // so 70π; a cylinder: one side, two discs, each rim one closed edge with
  // its one vertex.
  let body = await build(reopened(part));
  near(body.volume, 50 * Math.PI, "volume");
  near(body.area, 70 * Math.PI, "area");
  assert.deepEqual([body.vertices, body.edges, body.faces, body.errors], [2, 2, 3, []]);
  // The centre moved to (100, 250): the same cylinder somewhere else.
  const moved = movePoint(part, s.id, part.sketches[0].points[0].id, 100, 250);
  near((await build(reopened(moved))).volume, 50 * Math.PI, "volume after the move");
  // Typed 0.5 mm: 25π · 0.5 = 12.5π.
  near((await build(setExtrudeDistance(part, 0.5))).volume, 12.5 * Math.PI, "volume at 0.5 mm");
  // A line beside it: its loose end is what to fix first, in the kernel's words.
  const withLine = drawLine(part, s.id, [20, 0], [30, 0]);
  await assert.rejects(build(withLine.doc), /^Error: Sketch 1 has no closed outline: the line end at \(20, 0\) is not joined to another line$/);
  // A closed rectangle beside it: until regions (step 26) that is two loops.
  const withSquare = drawRectangle(part, s.id, [20, 0], [30, 10]);
  await assert.rejects(build(withSquare.doc), /^Error: Sketch 1 has no closed outline: the sketch makes 2 separate loops; for now a sketch makes one outline$/);
  // Two circles likewise; deleting the line closes the sketch again.
  await assert.rejects(build(drawCircle(part, s.id, [50, 0], 1).doc), /the sketch makes 2 separate loops/);
  near((await build(deleteCurve(withLine.doc, s.id, withLine.id))).volume, 50 * Math.PI, "the line deleted");
});

test("a circle's radius at 0.9× and 1.1× of the kernel's limits (MIN_FEATURE 0.001 mm, MAX_SIZE / 2 = 500000 mm)", async () => {
  const at = (r: number) => {
    const s = addSketch(partDocument("box", 10, 10, 10));
    return extrudeSketch(drawCircle(s.doc, s.id, [0, 0], r).doc, s.id, 1).doc;
  };
  // Extruded 1 mm, the volume is πr².
  near((await build(at(0.0011))).volume, Math.PI * 0.0011 ** 2, "1.1× MIN_FEATURE");
  near((await build(at(450000))).volume, Math.PI * 450000 ** 2, "0.9× MAX_SIZE / 2");
  await assert.rejects(build(at(0.0009)), /^Error: circle 1's radius must be between 0\.001 and 500000 mm, got 0\.0009$/);
  await assert.rejects(build(at(550000)), /^Error: circle 1's radius must be between 0\.001 and 500000 mm, got 550000$/);
});

test("seeded: circles from two random snapped clicks (centre, then a point on it) extrude to πr²d with 3 faces (22b)", async () => {
  // What the circle tool (22c) will draw: the radius is the distance
  // between the two snapped clicks, worked out here independently of Design.
  let built = 0;
  for (const seed of [21n, 22n, 23n, 24n, 25n]) {
    const r = seeded(seed);
    for (let i = 0; i < 40; i++) {
      const grid = [0.5, 1, 2.5, 10][Math.floor(r.next() * 4)];
      const pick = async () => kernel.call("snap_to_grid", (r.next() - 0.5) * 900, (r.next() - 0.5) * 900, grid);
      const c = await pick();
      const p = await pick();
      const radius = Math.hypot(p[0] - c[0], p[1] - c[1]);
      const d = Math.round((0.5 + r.next() * 99.5) * 10) / 10;
      const context = `seed ${seed} circle ${i}: round ${c} through ${p} on a ${grid} mm grid, by ${d}`;
      if (radius === 0) continue;
      const s = addSketch(partDocument("box", 10, 10, 10));
      const body = await build(reopened(extrudeSketch(drawCircle(s.doc, s.id, c, radius).doc, s.id, d).doc));
      near(body.volume, Math.PI * radius * radius * d, context);
      assert.deepEqual([body.faces, body.errors], [3, []], context);
      built++;
    }
  }
  assert.ok(built >= 190, `built ${built}`);
});
