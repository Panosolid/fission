// Journey: extruding a sketch through the real WASM kernel (step 21d), the
// same calls Design makes: the extrude feature's outline asked of the
// kernel from the saved lines each build, then make_extrude. Hand-worked
// volumes first, then seeded sessions of sketch and extrude edits checked
// against a model that only keeps the corners as coordinates. Run with
// `npm run journeys` after the app build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyProject, projectFromJson, projectToJson } from "@fission/core";
import { addSketch, buildSpec, deleteCurve, designWorkspace, drawLine, extrudeSketch, featureSpec, lastFeature, movePoint, partDocument, setExtrudeDistance, withPart, type DesignDocument } from "@fission/design";
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
