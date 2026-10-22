// Step 27d on the real kernel: edges projected into a sketch (the Project
// tool) and followed. A cylinder's top circle seen from a parallel plane
// (XY, and a box's top, whose frame is not the world's) is the same circle,
// and seen from the side (XZ) a line 2r long; when the cylinder's radius
// changes each follows, and what is extruded from the projected circle
// grows with it; when the circle is redrawn as a rectangle the rim is gone,
// so each projection stays where it was and its sketch says "projection
// lost"; suppressing the cylinder greys every sketch projecting it. A box's
// front face picked from XZ projects its four edges, which extrude; from XY
// its uprights are points. Against
// the naming model (rule 12, R12): naming.journey.ts. Run with
// `npm run journeys` after the app build.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addFaceSketch,
  addSketch,
  BodyCache,
  deleteCurve,
  drawCircle,
  drawnFrame,
  drawRectangle,
  extrudeSketch,
  facePlane,
  followedDoc,
  greyedBy,
  joinBodies,
  partDocument,
  projectEdges,
  projectPick,
  readDesignDocument,
  rebuildTimeline,
  shownBodies,
  suppressItem,
  type DesignDocument,
  type TimelineBuild,
} from "@fission/design";
import { emptyProject, projectFromJson, projectToJson, type Plane } from "@fission/core";
import { kernel } from "./design-app.ts";

/** The rebuild of `doc`, its bodies as the app joins them, and `doc` with every followed point taken in (as the app does after an edit). */
async function built(doc: DesignDocument) {
  const cache = new BodyCache(kernel);
  try {
    const build = await rebuildTimeline(doc, cache, kernel);
    return { build, scene: joinBodies(await shownBodies(doc, build, cache)), followed: followedDoc(doc, build) };
  } finally {
    await cache.clear();
  }
}

/** A sketch's frame as the rebuild placed it. */
function frameOf(build: TimelineBuild, id: string): Plane {
  const r = build.results[id];
  assert.ok(r?.status === "built" && r.placement, `${id} is placed: ${JSON.stringify(r)}`);
  return r.placement.plane;
}

/**
 * The box 40 × 30 × 20 (feature-1), then a circle of radius 5 round
 * (60, 15) on XY extruded 10 (a cylinder beside it, its top rim at z = 10),
 * then a sketch on XY, one on XZ, and one on the box's top.
 */
function start() {
  let doc = partDocument("box", 40, 30, 20);
  const base = addSketch(doc);
  const circle = drawCircle(base.doc, base.id, [60, 15], 5);
  const cylinder = extrudeSketch(circle.doc, base.id, 10);
  const xy = addSketch(cylinder.doc, "XY");
  const xz = addSketch(xy.doc, "XZ");
  const top = addFaceSketch(xz.doc, { plane: facePlane("feature-1", "top"), feature: "feature-1" }, drawnFrame([0, 0, 1], [20, 15, 20]));
  doc = top.doc;
  return { doc, base: base.id, circle: circle.id, cylinder: cylinder.id, xy: xy.id, xz: xz.id, top: top.id };
}

/** `doc` with the cylinder's top rim (the circle edge round (60, 15, 10)) projected into sketch `sketch`, by a click on it. */
async function projectRim(doc: DesignDocument, sketch: string, cylinder: string): Promise<DesignDocument> {
  const { build, scene } = await built(doc);
  const k = scene.bodies.findIndex((b) => b.feature === cylinder);
  assert.ok(k >= 0, "the cylinder is shown");
  const view = scene.bodies[k].view;
  const e = view.edge_types.findIndex((t, j) => t === "circle" && Math.abs(view.edge_centres[j]![2] - 10) < 1e-9);
  assert.ok(e >= 0, "the cylinder has a top rim");
  const pick = projectPick(doc, sketch, scene, frameOf(build, sketch), { edge: scene.edgeStart[k] + e });
  assert.equal(pick.note, null);
  assert.equal(pick.edges.length, 1);
  const made = projectEdges(doc, sketch, pick.edges);
  assert.equal(made.ids.length, 1);
  return made.doc;
}

const sketchOf = (doc: DesignDocument, id: string) => doc.sketches.find((s) => s.id === id)!;
/** A sketch's one projected curve, its points looked up: a circle's centre and radius, or a line's two ends. */
function projectedCurve(doc: DesignDocument, id: string) {
  const s = sketchOf(doc, id);
  const made = s.projected![0].made;
  const c = s.curves.find((x) => x.id === made)!;
  const at = (p: string) => {
    const q = s.points.find((x) => x.id === p)!;
    return [q.x, q.y];
  };
  return c.kind === "circle" ? { centre: at(c.centre), radius: c.radius } : c.kind === "line" ? { ends: [at(c.start), at(c.end)] } : { arc: c };
}
const near = (got: number[], want: number[], eps = 1e-9) => got.length === want.length && got.every((x, k) => Math.abs(x - want[k]) <= eps);
/** The world point of (x, y) in `frame`: origin + x·xAxis + y·(normal × xAxis). */
function world(frame: Plane, [x, y]: number[]): number[] {
  const [n, a] = [frame.normal, frame.xAxis];
  const b = [n[1] * a[2] - n[2] * a[1], n[2] * a[0] - n[0] * a[2], n[0] * a[1] - n[1] * a[0]];
  return [0, 1, 2].map((k) => frame.origin[k] + x * a[k] + y * b[k]);
}
/** `doc` with the cylinder's circle's radius `r`. */
const withRadius = (doc: DesignDocument, base: string, circle: string, r: number): DesignDocument => ({
  ...doc,
  sketches: doc.sketches.map((s) => (s.id === base ? { ...s, curves: s.curves.map((c) => (c.id === circle && c.kind === "circle" ? { ...c, radius: r } : c)) } : s)),
});

test("hand-worked: a cylinder's top circle projected from XY is the circle round (60, 15) of radius 5; from XZ, the line (55, 10) to (65, 10)", async () => {
  const s = start();
  let doc = await projectRim(s.doc, s.xy, s.cylinder);
  doc = await projectRim(doc, s.xz, s.cylinder);
  // XY: the rim is parallel, so it is seen as itself, dropped from z = 10 onto z = 0: (60, 15), radius 5.
  const xy = projectedCurve(doc, s.xy);
  assert.ok("centre" in xy && near(xy.centre, [60, 15]) && Math.abs(xy.radius - 5) <= 1e-9, JSON.stringify(xy));
  // XZ (x = X, y = Z, looking along +Y): the rim is square to the sketch, seen edge on from x = 55 to 65 at height 10.
  const xz = projectedCurve(doc, s.xz);
  assert.ok("ends" in xz && near(xz.ends.flat(), [55, 10, 65, 10]), JSON.stringify(xz));
  // Both depend on the cylinder now, so it can't be dragged after them and deleting it asks.
  for (const id of [s.xy, s.xz]) assert.ok(doc.timeline.features.find((f) => f.id === id)!.dependsOn.includes(s.cylinder));
  // Through save and open, unchanged.
  const save = projectToJson({ ...emptyProject("Projection"), workspaces: { design: doc } });
  assert.deepEqual(projectFromJson(save, [{ id: "design", readData: readDesignDocument }]).workspaces.design, doc);
});

test("hand-worked: the top rim projected onto the box's top (a parallel face) is a circle of radius 5 whose centre is (60, 15, 20) in the world; extruded, it builds", async () => {
  const s = start();
  let doc = await projectRim(s.doc, s.top, s.cylinder);
  const { build } = await built(doc);
  const frame = frameOf(build, s.top);
  // The top's frame is the box's top (z = 20, facing up), its origin and x wherever 26c put them: the rim's centre, seen
  // straight down onto z = 20, is (60, 15, 20), whatever its (x, y) in that frame.
  const c = projectedCurve(doc, s.top);
  assert.ok("centre" in c && Math.abs(c.radius - 5) <= 1e-9, JSON.stringify(c));
  assert.ok(near(world(frame, c.centre), [60, 15, 20]), `${world(frame, c.centre)}`);
  // A sketch of nothing but the projected circle: its outline is that circle, so an extrude of 5 builds.
  const up = extrudeSketch(doc, s.top, 5);
  doc = up.doc;
  const after = await built(doc);
  const r = after.build.results[up.id];
  assert.ok(r?.status === "built" && r.body !== undefined, JSON.stringify(r));
});

test("the cylinder's radius made 8: each projection follows (a circle of radius 8, the line (52, 10) to (68, 10)), and the extrude of the projected circle with it", async () => {
  const s = start();
  let doc = await projectRim(s.doc, s.xy, s.cylinder);
  doc = await projectRim(doc, s.xz, s.cylinder);
  doc = await projectRim(doc, s.top, s.cylinder);
  const up = extrudeSketch(doc, s.top, 5);
  doc = withRadius(up.doc, s.base, s.circle, 8);
  const { build, followed } = await built(doc);
  for (const id of [s.xy, s.xz, s.top]) {
    const r = build.results[id];
    assert.ok(r?.status === "built" && r.projections === undefined, `${id}: ${JSON.stringify(r)}`);
  }
  const xy = projectedCurve(followed, s.xy);
  assert.ok("centre" in xy && near(xy.centre, [60, 15]) && Math.abs(xy.radius - 8) <= 1e-9, JSON.stringify(xy));
  const xz = projectedCurve(followed, s.xz);
  assert.ok("ends" in xz && near(xz.ends.flat(), [52, 10, 68, 10]), JSON.stringify(xz));
  const top = projectedCurve(followed, s.top);
  assert.ok("centre" in top && Math.abs(top.radius - 8) <= 1e-9, JSON.stringify(top));
  // The extrude was built from the followed circle: the spec it was built from has radius 8.
  const r = build.results[up.id];
  assert.ok(r?.status === "built" && r.spec !== undefined, JSON.stringify(r));
  assert.match(JSON.stringify(r.spec), /"radius":8\b/);
});

test("the cylinder's circle redrawn as a rectangle: its rim is gone, so each projection stays where it was and its sketch says projection lost; suppressed, each sketch is greyed", async () => {
  const s = start();
  let doc = await projectRim(s.doc, s.xy, s.cylinder);
  doc = await projectRim(doc, s.xz, s.cylinder);
  const before = doc;
  const square = drawRectangle(deleteCurve(doc, s.base, s.circle), s.base, [55, 10], [65, 20]).doc;
  const { build, followed } = await built(square);
  for (const id of [s.xy, s.xz]) {
    const r = build.results[id];
    assert.ok(r?.status === "built" && r.projections?.cause === "projection-lost", `${id}: ${JSON.stringify(r)}`);
    assert.deepEqual(r.projections.projections, [sketchOf(before, id).projected![0].id]);
    assert.match(r.projections.message, /a projected edge has lost its edge, so it stays where it was/);
    assert.deepEqual(sketchOf(followed, id), sketchOf(square, id), "held where it was");
  }
  // Suppressing the cylinder (the projections' feature) greys both sketches, in the data and in the rebuild (rule 13).
  const off = suppressItem(before, s.cylinder, true);
  const greyed = await built(off);
  for (const id of [s.xy, s.xz]) {
    assert.deepEqual(greyed.build.results[id], { status: "greyed", by: s.cylinder });
    assert.equal(greyedBy(off, off.timeline.features.find((f) => f.id === id)!), s.cylinder);
  }
});

test("hand-worked: the box's front face picked from XZ projects its four edges, a closed rectangle (0, 0) to (40, 20) that extrudes; from XY its uprights are points", async () => {
  const s = start();
  const { build, scene } = await built(s.doc);
  const k = scene.bodies.findIndex((b) => b.feature === "feature-1");
  const view = scene.bodies[k].view;
  // The front is the face whose every corner has y = 0; seen from XZ (x = X, y = Z) its corners are (0, 0), (40, 0), (0, 20), (40, 20).
  const front = view.face_roles.findIndex((_, f) => view.edge_faces.every((pair, e) => !pair.includes(f) || view.edge_vertices[e].every((v) => view.vertex_points[v][1] === 0)) && view.edge_faces.some((pair) => pair.includes(f)));
  assert.ok(front >= 0, "the box has a front at y = 0");
  const pick = projectPick(s.doc, s.xz, scene, frameOf(build, s.xz), { face: scene.faceStart[k] + front });
  assert.equal(pick.note, null);
  const ends = (sh: (typeof pick.edges)[number]["shape"]) => (sh.kind === "line" ? [sh.a, sh.b].map((p) => `${p}`).sort().join(" ") : sh.kind);
  assert.deepEqual(pick.edges.map((e) => ends(e.shape)).sort(), ["0,0 0,20", "0,0 40,0", "0,20 40,20", "40,0 40,20"]);
  const made = projectEdges(s.doc, s.xz, pick.edges).doc;
  const up = extrudeSketch(made, s.xz, 5);
  const r = (await built(up.doc)).build.results[up.id];
  assert.ok(r?.status === "built" && r.body !== undefined, JSON.stringify(r));
  // From XY the same face is seen edge on: its top and bottom edges both as (0, 0) to (40, 0), its uprights as the points
  // (0, 0) and (40, 0), each the end on the ground (z = 0).
  const flat = projectPick(s.doc, s.xy, scene, frameOf(build, s.xy), { face: scene.faceStart[k] + front });
  assert.deepEqual(flat.edges.map((e) => (e.shape.kind === "point" ? `point ${e.shape.at}` : ends(e.shape))).sort(), ["0,0 40,0", "0,0 40,0", "point 0,0", "point 40,0"]);
});
