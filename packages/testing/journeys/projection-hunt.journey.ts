// Step 27e, the bug hunt for projected edges, on the real kernel: what it
// found, each test failing before its fix. A line drawn from a projected
// line's end stayed on the kernel's "start" of the edge, so a flipped
// extrude (which runs the edge the other way) swung it onto the other
// corner (C, and C2 for a round edge seen edge on); a line's ends now go by
// their corners' names (C3: by name even when the other end is nearer).
// A projected curve lying on another (a rectangle traced over a projected
// face, a face projected with the one under it) made four ends meet at
// every corner and the kernel refuse the outline (B, D); a face seen edge
// on, two lines on one, said the sketch had no lines yet (A). A diagonal
// across a projected face is refused in words (B2: a sketch makes one loop
// for now). Checked clean: a 1 µm cube's, a 1 µm sliver's and a 998 m
// bar's top faces extrude to their footprints (F); a projected arc closed
// by an own line 0.9 × SAME_PLACE off its ends, not at 1.1 × (G); two
// Project clicks while the kernel is held add a face once (H). Run with
// `npm run journeys` after the app build.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addSketch,
  BodyCache,
  drawArc,
  drawCircle,
  drawLine,
  drawRectangle,
  extrudeSketch,
  followedDoc,
  joinBodies,
  PROJECTED_OPEN,
  movePoint,
  partDocument,
  projectEdges,
  projectPick,
  rebuildTimeline,
  setExtrudeFlip,
  shownBodies,
  type DesignDocument,
  type TimelineBuild,
} from "@fission/design";
import type { BodyView, Plane } from "@fission/core";
import { app, kernel } from "./design-app.ts";

/** Where Design and the kernel take two ends as one (snap.ts SAME_PLACE, kernel/src/tolerance.rs LINEAR): 10 nm, in mm. */
const SAME_PLACE = 1e-5;

async function built(doc: DesignDocument) {
  const cache = new BodyCache(kernel);
  try {
    const build = await rebuildTimeline(doc, cache, kernel);
    const volumes: Record<string, number> = {};
    for (const [id, r] of Object.entries(build.results)) if (r.status === "built" && r.body !== undefined) volumes[id] = (await cache.view(r.body))!.volume;
    return { build, scene: joinBodies(await shownBodies(doc, build, cache)), followed: followedDoc(doc, build), volumes };
  } finally {
    await cache.clear();
  }
}
function frameOf(build: TimelineBuild, id: string): Plane {
  const r = build.results[id];
  assert.ok(r?.status === "built" && r.placement, `${id} is placed: ${JSON.stringify(r)}`);
  return r.placement.plane;
}
async function project(doc: DesignDocument, sketch: string, feature: string, pick: (v: BodyView) => { edge?: number; face?: number }) {
  const { build, scene } = await built(doc);
  const k = scene.bodies.findIndex((b) => b.feature === feature);
  assert.ok(k >= 0);
  const under = pick(scene.bodies[k].view);
  const got = projectPick(doc, sketch, scene, frameOf(build, sketch), under.edge !== undefined ? { edge: scene.edgeStart[k] + under.edge } : { face: scene.faceStart[k] + under.face! });
  return { ...projectEdges(doc, sketch, got.edges), note: got.note };
}
/** A box 40 × 30 × 20 built by extruding a rectangle on XY, then a sketch on XY after it. */
function box() {
  const a = addSketch(partDocument("box", 1, 1, 1));
  const r = drawRectangle(a.doc, a.id, [0, 0], [40, 30]);
  const e = extrudeSketch(r.doc, a.id, 20);
  const b = addSketch(e.doc, "XY");
  return { doc: b.doc, base: a.id, box: e.id, sketch: b.id };
}
const faceWhere = (v: BodyView, test: (p: number[]) => boolean) =>
  v.face_roles.findIndex((_, f) => v.edge_faces.some((pair) => pair.includes(f)) && v.edge_faces.every((pair, e) => !pair.includes(f) || v.edge_vertices[e].every((x) => test(v.vertex_points[x]))));
const edgeWhere = (v: BodyView, a: number[], b: number[]) => {
  const same = (p: number[], q: number[]) => p.every((x, k) => Math.abs(x - q[k]) < 1e-9);
  return v.edge_vertices.findIndex(([s, t]) => (same(v.vertex_points[s], a) && same(v.vertex_points[t], b)) || (same(v.vertex_points[s], b) && same(v.vertex_points[t], a)));
};
const sketchOf = (doc: DesignDocument, id: string) => doc.sketches.find((s) => s.id === id)!;

test("A: the box's front face projected into XY (two coincident lines, two points), extruded: refused, never a body", async () => {
  const s = box();
  const p = await project(s.doc, s.sketch, s.box, (v) => ({ face: faceWhere(v, (q) => q[1] === 0) }));
  const up = extrudeSketch(p.doc, s.sketch, 5);
  const r = (await built(up.doc)).build.results[up.id];
  assert.ok(r?.status === "failed" && r.cause === "open-outline", JSON.stringify(r));
  assert.equal(r.message, `Sketch 2 has no closed outline: ${PROJECTED_OPEN}`);
});

test("B: the top face projected into a sketch on XY, then a rectangle drawn over its corners: the extrude is the 40 × 30 rectangle", async () => {
  const s = box();
  const p = await project(s.doc, s.sketch, s.box, (v) => ({ face: faceWhere(v, (q) => q[2] === 20) }));
  const sk = sketchOf(p.doc, s.sketch);
  const r = drawRectangle(p.doc, s.sketch, [0, 0], [40, 30]);
  const sk2 = sketchOf(r.doc, s.sketch);
  const up = extrudeSketch(r.doc, s.sketch, 5);
  const b = await built(up.doc);
  // By hand: the rectangle 40 × 30 extruded 5 is 40 · 30 · 5 = 6000 mm³.
  assert.ok(Math.abs(b.volumes[up.id] - 40 * 30 * 5) < 1e-6, `${b.volumes[up.id]}`);
});

test("B2: the top face projected, then a diagonal drawn between two projected corners: refused or two triangles, never a wrong body", async () => {
  const s = box();
  const p = await project(s.doc, s.sketch, s.box, (v) => ({ face: faceWhere(v, (q) => q[2] === 20) }));
  const r = drawLine(p.doc, s.sketch, [0, 0], [40, 30]);
  const up = extrudeSketch(r.doc, s.sketch, 5);
  const res = (await built(up.doc)).build.results[up.id];
  // The diagonal's ends meet two projected sides each: three ends at (0, 0). A sketch makes one closed loop for now, so the
  // kernel refuses it and says where, and nothing is built (when sketches hold several loops, two triangles of 600 mm² each).
  assert.ok(res?.status === "failed" && res.cause === "open-outline" && res.message.endsWith("3 ends meet at (0, 0); every corner of an outline joins exactly two"), JSON.stringify(res));
});

test("D: the top face and the bottom face both projected into XY (two coincident squares), extruded", async () => {
  const s = box();
  const p = await project(s.doc, s.sketch, s.box, (v) => ({ face: faceWhere(v, (q) => q[2] === 20) }));
  const q = await project(p.doc, s.sketch, s.box, (v) => ({ face: faceWhere(v, (x) => x[2] === 0) }));
  const up = extrudeSketch(q.doc, s.sketch, 5);
  const b = await built(up.doc);
  assert.ok(Math.abs(b.volumes[up.id] - 40 * 30 * 5) < 1e-6);
});

test("C: a line drawn from a projected edge's end stays on that corner when the box is flipped", async () => {
  const s = box();
  const p = await project(s.doc, s.sketch, s.box, (v) => ({ edge: edgeWhere(v, [0, 30, 20], [40, 30, 20]) }));
  const sk = sketchOf(p.doc, s.sketch);
  const corner = sk.points.find((q) => q.x === 40 && q.y === 30)!;
  const l = drawLine(p.doc, s.sketch, corner.id, [60, 60]);
  // Flipped, the box runs from z = 0 down to −20: the edge is at z = −20, seen from XY still (0, 30) to (40, 30), but the
  // kernel runs it the other way. Flipped back, as it was.
  let doc = l.doc;
  for (const flip of [true, false]) {
    doc = (await built(setExtrudeFlip(doc, flip, s.box))).followed;
    const q = sketchOf(doc, s.sketch).points.find((x) => x.id === corner.id)!;
    assert.deepEqual([q.x, q.y], [40, 30], `flip ${flip}: the line's end stays on the corner it was drawn from`);
  }
});

test("C2: a line drawn from the end of a cylinder's rim seen edge on (from XZ) stays on that end when the cylinder is flipped", async () => {
  const a = addSketch(partDocument("box", 1, 1, 1));
  const c = drawCircle(a.doc, a.id, [60, 15], 5);
  const e = extrudeSketch(c.doc, a.id, 10);
  const b = addSketch(e.doc, "XZ");
  const p = await project(b.doc, b.id, e.id, (v) => ({ edge: v.edge_types.findIndex((t, j) => t === "circle" && Math.abs(v.edge_centres[j]![2] - 10) < 1e-9) }));
  const sk = sketchOf(p.doc, b.id);
  const end = sk.points.find((q) => q.x === 65 && q.y === 10)!;
  const l = drawLine(p.doc, b.id, end.id, [80, 30]);
  const f = setExtrudeFlip(l.doc, true, e.id);
  const built2 = await built(f);
  const after = sketchOf(built2.followed, b.id);
  // Flipped, the cylinder runs from z = 0 down to −10: its top rim (the end cap away from the sketch) is at z = −10, so
  // the projection's ends are (55, −10) and (65, −10); the line drawn from (65, 10) goes with that end, to (65, −10).
  const q = after.points.find((x) => x.id === end.id)!;
  assert.deepEqual([q.x, q.y], [65, -10]);
});

test("C3: the box's right side moved past its left (x = 40 to −60): a line drawn from the projected corner at (40, 30) goes with that corner to (−60, 30), by its name, though the other end is nearer", async () => {
  const s = box();
  const p = await project(s.doc, s.sketch, s.box, (v) => ({ edge: edgeWhere(v, [0, 30, 20], [40, 30, 20]) }));
  const sk = sketchOf(p.doc, s.sketch);
  const corner = sk.points.find((q) => q.x === 40 && q.y === 30)!;
  let doc = drawLine(p.doc, s.sketch, corner.id, [60, 60]).doc;
  const base = sketchOf(doc, s.base);
  for (const q of base.points.filter((x) => x.x === 40)) doc = movePoint(doc, s.base, q.id, -60, q.y);
  const b = await built(doc);
  const r = b.build.results[s.sketch];
  assert.ok(r?.status === "built" && r.projections === undefined, JSON.stringify(r));
  const after = sketchOf(b.followed, s.sketch);
  const q = after.points.find((x) => x.id === corner.id)!;
  assert.deepEqual([q.x, q.y], [-60, 30]);
});

test("F: the top face of a 1 µm cube, a 40 mm × 1 µm sliver and a 998 m bar projected into XY and extruded 1 mm: each the box's footprint, w · d · 1", async () => {
  for (const [w, d, h] of [[0.001, 0.001, 0.001], [40, 0.001, 5], [998000, 30, 20]]) {
    const s = addSketch(partDocument("box", w, d, h));
    const p = await project(s.doc, s.id, "feature-1", (v) => ({ face: faceWhere(v, (q) => q[2] === h) }));
    assert.equal(p.note, null, `${w} × ${d} × ${h}: every edge taken`);
    assert.equal(sketchOf(p.doc, s.id).curves.length, 4);
    const up = extrudeSketch(p.doc, s.id, 1);
    const b = await built(up.doc);
    const r = b.build.results[up.id];
    assert.ok(r?.status === "built", `${w} × ${d} × ${h}: ${JSON.stringify(r)}`);
    // By hand: the footprint w × d extruded 1 mm is w · d mm³ (the kernel's volumes are exact to rounding).
    assert.ok(Math.abs(b.volumes[up.id] - w * d) <= 1e-9 * Math.max(1, w * d), `${w} × ${d}: ${b.volumes[up.id]}`);
  }
});

test("G: a half disc's arc projected, closed by a line of the sketch's own whose ends are 0.9 × SAME_PLACE off its ends: one outline, the half disc's area; at 1.1 × the arc is left out", async () => {
  // A half disc: the line (50, 0) to (70, 0) and the arc from (70, 0) round (60, 0) back, extruded 10; its top arc at z = 10.
  const a = addSketch(partDocument("box", 1, 1, 1));
  const line = drawLine(a.doc, a.id, [50, 0], [70, 0]);
  const pts = sketchOf(line.doc, a.id).points;
  const arc = drawArc(line.doc, a.id, pts[1].id, pts[0].id, [60, 0]);
  const disc = extrudeSketch(arc.doc, a.id, 10);
  for (const [k, closes] of [[0.9, true], [1.1, false]] as const) {
    const b = addSketch(disc.doc, "XY");
    const p = await project(b.doc, b.id, disc.id, (v) => ({ edge: v.edge_types.findIndex((t, j) => t === "circle" && Math.abs(v.edge_middles[j][2] - 10) < 1e-9) }));
    assert.equal(p.note, null);
    // The arc's ends are (70, 0) and (50, 0); the own line runs between points k · SAME_PLACE below each.
    const off = k * SAME_PLACE;
    const closed = drawLine(p.doc, b.id, [50, -off], [70, -off]);
    const up = extrudeSketch(closed.doc, b.id, 1);
    const r = (await built(up.doc));
    const res = r.build.results[up.id];
    if (closes) {
      // By hand: half a disc of radius 10, π · 10² / 2 = 50π, by 1 mm (the line's 9 nm off moves it by far less than 1e-6).
      assert.ok(res?.status === "built" && Math.abs(r.volumes[up.id] - 50 * Math.PI) < 1e-3, `${k}: ${JSON.stringify(res).slice(0, 300)} ${r.volumes[up.id]}`);
    } else assert.ok(res?.status === "failed" && res.cause === "open-outline", `${k}: ${JSON.stringify(res).slice(0, 300)}`);
  }
});

/** Turns of the event loop, for what the app does at once while the kernel is held. */
const turns = async (n: number) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

test("H: two Project clicks on one face while the kernel is slow add its four edges once, and say the second added nothing", async () => {
  const a = await app(partDocument("box", 40, 30, 20));
  a.$("#create-sketch")!.click();
  await a.settle();
  await a.pick({ plane: "XY" });
  await a.key("sketch-project");
  const { scene } = await built(a.doc());
  const top = scene.faceStart[0] + faceWhere(scene.bodies[0].view, (q) => q[2] === 20);
  const projected = () => a.doc().sketches.at(-1)!.projected?.length ?? 0;
  // Two clicks on the top before the kernel answers either: the second runs on the document the first left, so it adds nothing.
  a.hold();
  a.pointer("click", [20, 15], { face: top });
  a.pointer("click", [20, 15], { face: top });
  await turns(20);
  await a.release();
  assert.equal(projected(), 4);
  assert.match(a.$("#sketch-grid-error")?.textContent ?? "", /projected into this sketch already/);
  assert.match((await a.undo()) ?? "", /^Project/);
  assert.equal(projected(), 0);
  assert.ok(await a.close(), "every body freed");
});
