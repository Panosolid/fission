// Journey: references re-found by name after an edit to an earlier item
// (step 25a4), in the real Design workspace on the real WASM kernel
// (design-app.ts), and a live link another workspace holds through Design's
// lookup. Every position is checked on what the viewport was asked to draw:
// the highlighted face's triangles and the highlighted edge's lines, worked
// out by hand from the sizes, never read from the names. Two faces sharing a
// name can't be made on the real kernel yet (every sketch curve gives one
// side; a face split in two comes with cuts, booleans 44/48), so that case
// is in Design's own tests (workspaces/design/test/refind*.ts) on views
// written out by hand. Run with `npm run journeys`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { linkTo, RepresentationRegistry, resolveLink, type DisplayMesh, type GeometryReference, type StableId } from "@fission/core";
import {
  addSketch,
  BodyCache,
  deleteCurve,
  designLookup,
  drawLine,
  drawRectangle,
  editFeature,
  extrudeSketch,
  insertPreset,
  joinBodies,
  movePoint,
  partDocument,
  rebuildTimeline,
  registerDesign,
  settleKept,
  shownBodies,
  type DesignDocument,
} from "@fission/design";
import { app, kernel } from "./design-app.ts";

/** Every corner of the triangles on joined face `face`. */
function faceCorners(mesh: DisplayMesh, face: number): number[][] {
  const out: number[][] = [];
  mesh.triangle_faces.forEach((f, t) => {
    if (f !== face) return;
    for (let k = 0; k < 3; k++) {
      const i = mesh.indices[3 * t + k];
      out.push([mesh.positions[3 * i], mesh.positions[3 * i + 1], mesh.positions[3 * i + 2]]);
    }
  });
  return out;
}

/** Every end of the lines drawn for joined edge `edge`. */
function edgeEnds(mesh: DisplayMesh, edge: number): number[][] {
  const out: number[][] = [];
  mesh.edge_line_edges.forEach((e, s) => {
    if (e === edge) out.push(mesh.edge_lines.slice(6 * s, 6 * s + 3), mesh.edge_lines.slice(6 * s + 3, 6 * s + 6));
  });
  return out;
}

const near = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));
const span = (pts: number[][], k: number) => [Math.min(...pts.map((p) => p[k])), Math.max(...pts.map((p) => p[k]))];

/** The one face the highlight lights whose corners all have coordinate `k` equal to `at`. */
function litFace(a: Awaited<ReturnType<typeof app>>, k: number, at: number): number[][] {
  const mesh = a.mesh()!;
  const hits = a.highlight().faces.map((f) => faceCorners(mesh, f)).filter((c) => c.length > 0 && c.every((p) => near(p[k], at)));
  assert.equal(hits.length, 1, `one lit face lies at ${"xyz"[k]} = ${at}: ${JSON.stringify(a.highlight())}`);
  return hits[0];
}

const ref = (kind: "face" | "edge", feature: string, part: string) => ({ kind, id: `${kind}:${feature}/${part}` as StableId }) as GeometryReference;

/**
 * The box (feature-1, 10 × 10 × 10 from the origin), Sketch 1 with a 40 × 30
 * rectangle from (100, 0) to (140, 30) extruded by 20 (Extrude 1), then a
 * 4 × 5 × 6 box after it, so an item follows the edited one.
 */
function design() {
  const made = addSketch(partDocument("box", 10, 10, 10));
  const rect = drawRectangle(made.doc, made.id, [100, 0], [140, 30]);
  const ex = extrudeSketch(rect.doc, made.id, 20);
  // The rectangle's lines run (100,0)→(140,0)→(140,30)→(100,30)→(100,0): bottom, right, top, left.
  const [bottom, right, , left] = rect.ids;
  return { doc: insertPreset(ex.doc, "box", 4, 5, 6).doc, sketch: made.id, extrude: ex.id, bottom, right, left };
}

test("hand-worked: Edit feature on Extrude 1 (20 → 35): its top face, right side and the edge between follow their names; the box before it is untouched", async () => {
  const d = design();
  const a = await app(d.doc);
  const top = ref("face", d.extrude, "end");
  const side = ref("face", d.extrude, `side:${d.right}`);
  const rim = ref("edge", d.extrude, `end+side:${d.right}`);
  const boxTop = ref("face", "feature-1", "top");
  a.selection.set([top, side, rim, boxTop]);
  await a.settle();
  // Before: Extrude 1's top at z = 20 spanning x 100 to 140; its right side at x = 140, z 0 to 20; the box's top at z = 10.
  assert.deepEqual(span(litFace(a, 2, 20), 0), [100, 140]);
  assert.deepEqual(span(litFace(a, 0, 140), 2), [0, 20]);
  assert.deepEqual(span(litFace(a, 2, 10), 0), [0, 10]);
  // The edge between the top and the right side: the line x = 140, z = 20, from y = 0 to 30.
  assert.equal(a.highlight().edges.length, 1);
  const ends = edgeEnds(a.mesh()!, a.highlight().edges[0]);
  assert.ok(ends.every((p) => near(p[0], 140) && near(p[2], 20)), JSON.stringify(ends));
  assert.deepEqual(span(ends, 1), [0, 30]);

  // Edit feature: Extrude 1's distance typed as 35, OK. One undo step; the selection is the same four names.
  assert.equal(await a.menu(d.extrude, "edit"), null);
  const box = a.$("#edit-height") as HTMLInputElement;
  box.value = "35";
  a.$("#feature-edit-ok")!.click();
  await a.settle();
  assert.equal(a.history.undoLabel(), "Edit Extrude 1");
  assert.deepEqual(a.selection.items, [top, side, rim, boxTop]);
  assert.equal(a.note(), "", "nothing was taken out");
  // After: the top at z = 35, the side up to 35, the edge at z = 35; the box's top still at z = 10.
  assert.deepEqual(span(litFace(a, 2, 35), 0), [100, 140]);
  assert.deepEqual(span(litFace(a, 0, 140), 2), [0, 35]);
  assert.deepEqual(span(litFace(a, 2, 10), 0), [0, 10]);
  const after = edgeEnds(a.mesh()!, a.highlight().edges[0]);
  assert.ok(after.every((p) => near(p[0], 140) && near(p[2], 35)), JSON.stringify(after));
  // Undo: back to 20, the same names lit there.
  await a.undo();
  assert.deepEqual(span(litFace(a, 0, 140), 2), [0, 20]);
  assert.deepEqual(a.selection.items, [top, side, rim, boxTop]);
  assert.ok(await a.close(), "every body freed");
});

test("hand-worked: Edit Sketch draws a new left side on a ⊐ whose extrude kept its rectangle: the old left face is taken out with the note, the top follows to 60 wide", async () => {
  // Sketch 1's left side deleted and its right corners moved out to x = 160 (a ⊐ 60 wide, open): Extrude 1 keeps the 40 × 30 rectangle.
  const d = design();
  const sketch = d.doc.sketches.find((s) => s.id === d.sketch)!;
  const at = (x: number, y: number) => sketch.points.find((p) => p.x === x && p.y === y)!.id;
  const [r0, r1] = [at(140, 0), at(140, 30)];
  let doc = await settleKept(kernel, d.doc, deleteCurve(d.doc, d.sketch, d.left));
  doc = await settleKept(kernel, doc, movePoint(movePoint(doc, d.sketch, r0, 160, 0), d.sketch, r1, 160, 30));
  const a = await app(doc);
  assert.match(a.warning() ?? "", /^Extrude 1 keeps its last shape/);
  // The kept shape still names its sides by the curves it was built from, the deleted left line among them.
  const top = ref("face", d.extrude, "end");
  const oldLeft = ref("face", d.extrude, `side:${d.left}`);
  const bottomSide = ref("face", d.extrude, `side:${d.bottom}`);
  a.selection.set([top, oldLeft, bottomSide]);
  await a.settle();
  assert.deepEqual(span(litFace(a, 0, 100), 2), [0, 20], "the kept left side at x = 100");
  assert.deepEqual(span(litFace(a, 2, 20), 0), [100, 140]);

  // Edit Sketch, the left side drawn again from (100, 30) to (100, 0) (a new line, a new id), Finish Sketch.
  assert.equal(await a.menu(d.sketch, "edit-sketch"), null);
  await a.click(100, 30);
  await a.click(100, 0);
  await a.finish();
  assert.equal(a.warning(), null);
  // The old left face's curve is gone from the body: taken out, with the note; the top and the bottom side follow, 60 wide now.
  assert.deepEqual(a.selection.items, [top, bottomSide]);
  assert.equal(a.note(), `Taken out of the selection: Side of ${d.left} face. The edit took them off the body, so they could not be followed.`);
  assert.doesNotMatch(a.note(), /more than one/);
  assert.deepEqual(span(litFace(a, 2, 20), 0), [100, 160]);
  assert.deepEqual(span(litFace(a, 1, 0), 0), [100, 160], "the bottom side, y = 0, from x = 100 to 160");
  assert.ok(await a.close(), "every body freed");
});

test("hand-worked: a link another workspace holds to Extrude 1's top face follows Edit feature, and warns once its sketch's side is gone", async () => {
  const d = design();
  const cache = new BodyCache(kernel);
  const registry = new RepresentationRegistry();
  registerDesign(registry, kernel);
  const lookupOf = async (doc: DesignDocument) => designLookup(doc, joinBodies(await shownBodies(doc, await rebuildTimeline(doc, cache, kernel), cache)), kernel);
  const topLink = linkTo("load-1", { kind: "geometry", origin: { workspace: "design", id: d.extrude, label: "Top of Extrude 1" }, ref: ref("face", d.extrude, "end") }, ["solid"]);
  const sideLink = linkTo("load-2", { kind: "geometry", origin: { workspace: "design", id: d.extrude, label: "Right of Extrude 1" }, ref: ref("face", d.extrude, `side:${d.right}`) }, ["solid"]);
  // Delivered as the exact solid its face is on: Extrude 1, the 40 × 30 rectangle by 20.
  const solid = async (doc: DesignDocument) => {
    const s = resolveLink(topLink, await lookupOf(doc));
    assert.equal(s.state, "live");
    const rep = (await registry.deliver((s as { object: never }).object, ["solid"])).representation as { spec: { extrude: { distance: number } } };
    return rep.spec.extrude.distance;
  };
  assert.equal(await solid(d.doc), 20);
  // Edit feature, 20 → 35: the same link, now the 35 mm solid.
  const edited = editFeature(d.doc, d.extrude, { height: 35 });
  assert.equal(await solid(edited), 35);
  assert.equal(resolveLink(sideLink, await lookupOf(edited)).state, "live");
  // The right side deleted and drawn again (a new id): the closed outline builds, the top link still live, the side link warns.
  const gone = deleteCurve(edited, d.sketch, d.right);
  const sketch = gone.sketches.find((s) => s.id === d.sketch)!;
  const p = (x: number, y: number) => sketch.points.find((q) => q.x === x && q.y === y)!.id;
  const redrawn = await settleKept(kernel, edited, drawLine(gone, d.sketch, p(140, 0), p(140, 30)).doc);
  assert.equal(await solid(redrawn), 35);
  assert.deepEqual(resolveLink(sideLink, await lookupOf(redrawn)), {
    state: "unresolved",
    warning: "Linked to Right of Extrude 1 in Design, which can't be found after the last edit. Pick a new source or break the link to keep the last copy.",
  });
  await cache.clear();
});
