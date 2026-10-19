// Journey: with several bodies, the browser's Body rows, the viewport's
// highlight, the selection list and the properties panel all mean the same
// body (bug fix, Ben 2026-10-18: selecting Body 3 showed another body's
// volume, area and topology, because the panel always showed the last
// body). On the real WASM kernel, each design is rebuilt and drawn as
// workspace.ts does (`rebuildTimeline`, `shownBodies`, `joinBodies`); then
// for every Body row: the row's label, the body its reference selects, the
// faces lit (every lit triangle inside that body's region, worked out from
// the design, and every triangle there lit), the selection list's name and
// the panel's body (`panelFocus`: its feature, number and volume against a
// hand-worked formula) must agree. A feature that failed has no Body row,
// its Timeline row selects nothing, and selected it is described as having
// no body (timeline bug hunt 2026-10-19, finding 5: its row selected a body
// that did not exist and the panel described another). Ben's design is
// worked by hand, then seeded random designs (a preset, then up to four
// extrudes of rectangles and circles, each in its own 100 mm cell along x,
// some suppressed, some failing because a line was deleted with no kept
// shape, the last one too), then seven planted bugs, each caught. Run with
// `npm run journeys` after the app build.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { GeometryReference } from "@fission/core";
import {
  addSketch,
  BodyCache,
  bodyReference,
  bodyOf,
  bodyRows,
  deleteCurve,
  drawCircle,
  drawRectangle,
  extrudeSketch,
  highlightOf,
  joinBodies,
  panelFocus,
  partDocument,
  rebuildTimeline,
  rowReference,
  sceneReference,
  selectionRows,
  shownBodies,
  suppressItem,
  type DesignDocument,
  type Scene,
} from "@fission/design";
import { seeded, type SeededRandom } from "../src/index.ts";
import { nodeKernel } from "../src/node-kernel.ts";

const kernel = nodeKernel();
/** Exact volumes from the kernel's B-rep against closed forms: only rounding apart. */
const close = (got: number, want: number) => Math.abs(got - want) <= 1e-9 * Math.max(1, Math.abs(want));
/**
 * A mesh point counts as inside a region within this (mm). The display mesh
 * is single precision: at x = 500 mm a step is 2^-15 ≈ 3e-5 mm, so 1e-3 mm
 * covers its rounding and is still far below any gap between two bodies'
 * regions (40 mm at least).
 */
const SLACK = 1e-3;

type Point = readonly [number, number, number];

/** What the design says each Body row is, worked out apart from Design's code. */
interface Expected {
  /** n in "Body n": its place among the solid features that build. */
  place: number;
  feature: string;
  /** null when the feature fails to build (no body). */
  volume: number | null;
  faces: number;
  inside(p: Point): boolean;
}

/** The functions under test, so a planted bug can stand in for one. */
interface Under {
  bodyRows: typeof bodyRows;
  rowReference: (node: string, doc: DesignDocument, failed: ReadonlySet<string>, scene: Scene) => GeometryReference | null;
  highlightOf: typeof highlightOf;
  selectionRows: typeof selectionRows;
  panelFocus: typeof panelFocus;
}
const REAL: Under = { bodyRows, rowReference: (node, doc, failed) => rowReference(node, doc, failed), highlightOf, selectionRows, panelFocus };

/** The design rebuilt and drawn as the app does, on a fresh cache freed after; `look` reads it, with the ids the rebuild failed (workspace.ts's `failedNow`), before the bodies go. */
async function drawn<T>(doc: DesignDocument, look: (scene: Scene, failed: ReadonlySet<string>) => T): Promise<T> {
  const cache = new BodyCache(kernel);
  try {
    const build = await rebuildTimeline(doc, cache, kernel);
    const failed = new Set(Object.keys(build.results).filter((id) => build.results[id].status === "failed"));
    return look(joinBodies(await shownBodies(doc, build, cache)), failed);
  } finally {
    await cache.clear();
  }
}

/** The points of joined triangle t. */
const corners = (scene: Scene, t: number): Point[] =>
  [0, 1, 2].map((k) => {
    const i = scene.mesh.indices[3 * t + k];
    return [scene.mesh.positions[3 * i], scene.mesh.positions[3 * i + 1], scene.mesh.positions[3 * i + 2]] as const;
  });

/** Every way the rows, highlight, selection list and panel disagree with `expected` (empty when they all agree). */
function problems(doc: DesignDocument, scene: Scene, failed: ReadonlySet<string>, expected: readonly Expected[], fns: Under, random?: SeededRandom): string[] {
  const out: string[] = [];
  // The design's own answer to which features fail, worked out apart from the rebuild, must be the rebuild's.
  const fails = expected.filter((e) => e.volume === null).map((e) => e.feature);
  if (fails.join() !== [...failed].sort((a, b) => doc.timeline.features.findIndex((f) => f.id === a) - doc.timeline.features.findIndex((f) => f.id === b)).join()) out.push(`the rebuild failed ${[...failed]}, the design fails ${fails}`);
  const built = expected.filter((e) => e.volume !== null);
  // Only bodies that built have rows (finding 5), each keeping its place among the features that build.
  const rows = fns.bodyRows(doc, failed);
  if (rows.length !== built.length) out.push(`${rows.length} Body rows, the design builds ${built.length} bodies`);
  // The part (the last solid feature that builds) is the last row expected, built or not.
  const part = expected[expected.length - 1];
  const triangles = scene.mesh.triangle_faces.length;
  for (const e of expected.filter((x) => x.volume === null)) {
    const name = `Body ${e.place}`;
    // A failed feature: no row selects it, its Timeline row neither; selected anyway (from before it failed), the panel says it has no body.
    if (rows.some((r) => r.feature.id === e.feature)) out.push(`${name} did not build but has a Body row`);
    for (const node of [`body-${e.place}`, e.feature]) {
      const ref = fns.rowReference(node, doc, failed, scene);
      if (ref !== null) out.push(`${name} did not build, yet row ${node} selects ${ref.id}`);
    }
    const ref = bodyReference(e.feature);
    const lit = fns.highlightOf([ref], scene).faces;
    if (lit.length > 0) out.push(`${name} did not build but lights faces ${lit}`);
    const panel = fns.panelFocus([ref], scene, doc);
    if (panel?.feature.id !== e.feature || panel.body !== null) out.push(`${name} did not build, so the panel should describe it with no body, not ${panel?.feature.id} with Body ${panel?.body?.place}`);
  }
  for (const [i, row] of rows.entries()) {
    const e = built[i];
    if (!e) break;
    const name = `Body ${e.place}`;
    if (row.label !== name || row.id !== `body-${e.place}`) out.push(`row ${row.id} says ${row.label}, it is ${name}`);
    const ref = fns.rowReference(row.id, doc, failed, scene);
    if (ref?.id !== bodyReference(e.feature).id) {
      out.push(`${name}'s row selects ${ref?.id}, not ${e.feature}`);
      continue;
    }
    if (fns.rowReference(e.feature, doc, failed, scene)?.id !== ref.id) out.push(`${name}'s Timeline row selects another body than its Body row`);
    // The only body shown, selected, is the whole highlight's body (scene.ts): every face lit.
    const h = fns.highlightOf([ref], scene);
    const lit = new Set(h.body ? [...new Set(scene.mesh.triangle_faces)] : h.faces);
    if (h.body && scene.bodies.length > 1) out.push(`${name} alone selected lights every body`);
    const panel = fns.panelFocus([ref], scene, doc)?.body;
    if (lit.size !== e.faces) out.push(`${name} lights ${lit.size} faces, it has ${e.faces}`);
    for (let t = 0; t < triangles; t++) {
      const on = lit.has(scene.mesh.triangle_faces[t]);
      const inside = corners(scene, t).every((p) => e.inside(p));
      if (on !== inside) {
        out.push(`${name}: triangle ${t} ${on ? "is lit outside it" : "inside it is not lit"}`);
        break;
      }
    }
    const listed = fns.selectionRows([ref], scene)[0]?.name;
    if (listed !== name) out.push(`${name} is listed as ${listed}`);
    if (panel?.feature !== e.feature || panel.place !== e.place) out.push(`${name} selected, the panel shows ${panel?.feature} as Body ${panel?.place}`);
    else if (!close(panel.view.volume, e.volume)) out.push(`${name}'s panel volume ${panel.view.volume}, by hand ${e.volume}`);
  }
  // Nothing selected: the part the parameters edit, with its body when it built and none when it failed.
  const none = fns.panelFocus([], scene, doc);
  if (none?.feature.id !== part.feature || (none.body === null) !== (part.volume === null)) out.push(`nothing selected, the panel shows ${none?.feature.id} with Body ${none?.body?.place}, not the part ${part.feature}${part.volume === null ? " with no body" : ""}`);
  else if (none.body && none.body.place !== part.place) out.push(`nothing selected, the panel calls the part Body ${none.body.place}, it is Body ${part.place}`);
  // A random face, picked after another body: the panel follows the newest pick, the body that face lies in.
  if (random && built.length > 1 && triangles > 0) {
    for (let k = 0; k < 4; k++) {
      const t = Math.floor(random.next() * triangles);
      const owner = built.find((e) => corners(scene, t).every((p) => e.inside(p)));
      const face = sceneReference("face", scene, scene.mesh.triangle_faces[t]);
      const other = built.find((e) => e !== owner)!;
      if (!owner || !face) {
        out.push(`triangle ${t} is in no body's region, or its face has no name`);
        continue;
      }
      const panel = fns.panelFocus([bodyReference(other.feature), face], scene, doc)?.body;
      if (panel?.feature !== owner.feature) out.push(`Body ${other.place} then a face of Body ${owner.place} picked, the panel shows ${panel?.feature}`);
      if (bodyOf(scene, face) < 0) out.push(`a face of Body ${owner.place} is on no shown body`);
    }
  }
  return out;
}

const inBox = (x0: number, y0: number, x1: number, y1: number, h: number) => ([x, y, z]: Point) =>
  x >= x0 - SLACK && x <= x1 + SLACK && y >= y0 - SLACK && y <= y1 + SLACK && z >= -SLACK && z <= h + SLACK;
const inCylinder = (cx: number, cy: number, r: number, h: number) => ([x, y, z]: Point) =>
  Math.hypot(x - cx, y - cy) <= r + SLACK && z >= -SLACK && z <= h + SLACK;

test("Ben's design by hand: each Body row selects, lights, lists and shows its own body", async () => {
  // Cylinder ⌀40 × 20 (feature-1): π · 20² · 20 = 8000π ≈ 25,132.74 mm³, 3 faces.
  // Sketch 1: a circle of radius 4.2 round (-10, 0), extruded 30: π · 4.2² · 30 = 529.2π ≈ 1,662.53 mm³,
  // the number Ben's panel showed for every body. Sketch 2: a 12 × 10 rectangle from (2, -5), extruded 30:
  // 12 · 10 · 30 = 3600 mm³, 6 faces. The two extrudes stand on the cylinder's base, inside it below z = 20.
  const start = await kernel.call("body_count");
  let doc = partDocument("cylinder", 40, 40, 20);
  const s1 = addSketch(doc);
  doc = drawCircle(s1.doc, s1.id, [-10, 0], 4.2).doc;
  const e1 = extrudeSketch(doc, s1.id, 30);
  const s2 = addSketch(e1.doc);
  doc = drawRectangle(s2.doc, s2.id, [2, -5], [14, 5]).doc;
  const e2 = extrudeSketch(doc, s2.id, 30);
  doc = e2.doc;
  // The regions overlap (both extrudes start inside the cylinder), so here the faces are checked by count and by
  // each lit triangle lying in its own body's region, which the other two bodies' triangles partly leave.
  const smallTop = ([, , z]: Point) => z > 20 + SLACK;
  const expected: Expected[] = [
    { place: 1, feature: "feature-1", volume: 8000 * Math.PI, faces: 3, inside: inCylinder(0, 0, 20, 20) },
    { place: 2, feature: e1.id, volume: 529.2 * Math.PI, faces: 3, inside: inCylinder(-10, 0, 4.2, 30) },
    { place: 3, feature: e2.id, volume: 3600, faces: 6, inside: inBox(2, -5, 14, 5, 30) },
  ];
  await drawn(doc, (scene, failed) => {
    assert.deepEqual([...failed], [], "every body builds");
    for (const e of expected) {
      const ref = rowReference(`body-${e.place}`, doc, failed)!;
      assert.equal(ref.id, bodyReference(e.feature).id);
      const lit = new Set(highlightOf([ref], scene).faces);
      assert.equal(lit.size, e.faces, `Body ${e.place}'s faces`);
      for (let t = 0; t < scene.mesh.triangle_faces.length; t++) {
        if (lit.has(scene.mesh.triangle_faces[t])) assert.ok(corners(scene, t).every(e.inside), `Body ${e.place}: lit triangle ${t} lies in it`);
      }
      assert.equal(selectionRows([ref], scene)[0].name, `Body ${e.place}`);
      const panel = panelFocus([ref], scene, doc)!.body!;
      assert.equal(panel.feature, e.feature);
      assert.equal(panel.place, e.place);
      assert.ok(close(panel.view.volume, e.volume!), `Body ${e.place}: ${panel.view.volume} against ${e.volume}`);
    }
    // Body 2 and Body 3 rise above the cylinder (z > 20): each one's triangles up there are lit only with it.
    for (const [b, other] of [
      [2, 3],
      [3, 2],
    ]) {
      const lit = new Set(highlightOf([bodyReference(expected[b - 1].feature)], scene).faces);
      const up = scene.mesh.triangle_faces.flatMap((f, t) => (corners(scene, t).every(smallTop) && expected[other - 1].inside(corners(scene, t)[0]) ? [f] : []));
      assert.ok(up.length > 0 && up.every((f) => !lit.has(f)), `Body ${b} lights none of Body ${other}'s top`);
    }
    assert.equal(panelFocus([], scene, doc)?.body?.place, 3, "nothing selected: the last body");
  });
  assert.equal(await kernel.call("body_count"), start);
});

test("finding 5 by hand: the box fails, Extrude 1 builds; Body 1 has no row and, selected, no body", async () => {
  // The bug hunt's repro: a box, then a 10 × 10 square extruded 10 (10 · 10 · 10 = 1,000 mm³), then the box's width -5.
  // Before the fix: rows Body 1 and Body 2; Body 1 selected the box, and the panel showed Extrude 1 with 1,000 mm³.
  const start = await kernel.call("body_count");
  const s = addSketch(partDocument("box", -5, 30, 20));
  const sq = drawRectangle(s.doc, s.id, [100, 0], [110, 10]);
  const e = extrudeSketch(sq.doc, s.id, 10);
  const doc = e.doc;
  await drawn(doc, (scene, failed) => {
    assert.deepEqual([...failed], ["feature-1"], "the box fails");
    // One row, Body 2: the extrude keeps its number.
    assert.deepEqual(bodyRows(doc, failed).map((r) => [r.id, r.label, r.feature.id]), [["body-2", "Body 2", e.id]]);
    // The box's rows select nothing.
    assert.equal(rowReference("body-1", doc, failed), null);
    assert.equal(rowReference("feature-1", doc, failed), null);
    // Body 2's row: Extrude 1, 1,000 mm³.
    const ref = rowReference("body-2", doc, failed)!;
    assert.equal(ref.id, bodyReference(e.id).id);
    const panel = panelFocus([ref], scene, doc)!;
    assert.equal(panel.feature.id, e.id);
    assert.ok(close(panel.body!.view.volume, 1000), `${panel.body!.view.volume} against 1000`);
    // The box still selected from before it failed: the box, with no body, not Extrude 1's 1,000 mm³.
    const box = panelFocus([bodyReference("feature-1")], scene, doc)!;
    assert.equal(box.feature.id, "feature-1");
    assert.equal(box.body, null);
  });
  assert.equal(await kernel.call("body_count"), start);
});

/** A seeded design and what it should show: a preset at the origin, then extrudes, each in its own cell. */
function randomDesign(random: SeededRandom): { doc: DesignDocument; expected: Expected[] } {
  const pick = (lo: number, hi: number) => Math.round((lo + random.next() * (hi - lo)) * 10) / 10;
  const expected: Omit<Expected, "place">[] = [];
  let doc: DesignDocument;
  const [w, d, h] = [pick(5, 40), pick(5, 40), pick(5, 40)];
  if (random.next() < 0.5) {
    // A box from the origin to (w, d, h): w·d·h, 6 faces.
    doc = partDocument("box", w, d, h);
    expected.push({ feature: "feature-1", volume: w * d * h, faces: 6, inside: inBox(0, 0, w, d, h) });
  } else {
    // A cylinder ⌀w standing on the origin: π(w/2)²h, 3 faces.
    doc = partDocument("cylinder", w, w, h);
    expected.push({ feature: "feature-1", volume: Math.PI * (w / 2) ** 2 * h, faces: 3, inside: inCylinder(0, 0, w / 2, h) });
  }
  const extrudes = 1 + Math.floor(random.next() * 4);
  const suppressed: string[] = [];
  for (let k = 1; k <= extrudes; k++) {
    // Cell k: x from 100k to 100k + 60, y from 0 to 60.
    const x0 = 100 * k;
    const dist = pick(1, 50);
    const s = addSketch(doc);
    const lastOne = k === extrudes;
    if (random.next() < 0.5) {
      const [ax, ay] = [x0 + pick(0, 25), pick(0, 25)];
      const [cx, cy] = [ax + pick(1, 35), ay + pick(1, 35)];
      const r = drawRectangle(s.doc, s.id, [ax, ay], [cx, cy]);
      const e = extrudeSketch(r.doc, s.id, dist);
      doc = e.doc;
      // A line deleted with no kept shape recorded (no settleKept): the extrude fails, so it has no row; the last one too (the part fails).
      const fails = random.next() < 0.25;
      if (fails) doc = deleteCurve(doc, s.id, r.ids[Math.floor(random.next() * 4)]);
      expected.push({ feature: e.id, volume: fails ? null : (cx - ax) * (cy - ay) * dist, faces: 6, inside: inBox(ax, ay, cx, cy, dist) });
    } else {
      const radius = pick(1, 25);
      const [cx, cy] = [x0 + 30, 30];
      const c = drawCircle(s.doc, s.id, [cx, cy], radius);
      const e = extrudeSketch(c.doc, s.id, dist);
      doc = e.doc;
      expected.push({ feature: e.id, volume: Math.PI * radius ** 2 * dist, faces: 3, inside: inCylinder(cx, cy, radius, dist) });
    }
    // Suppressed: no row at all, so the bodies after it move up a number.
    if (!lastOne && random.next() < 0.2) suppressed.push(expected[expected.length - 1].feature);
  }
  for (const id of suppressed) doc = suppressItem(doc, id, true);
  const rows = expected.filter((e) => !suppressed.includes(e.feature)).map((e, i) => ({ ...e, place: i + 1 }));
  return { doc, expected: rows };
}

const SEEDS = 5;
const DESIGNS = 30;

test(`${SEEDS} seeds × ${DESIGNS} random designs: every Body row, highlight, list entry and panel agree`, async () => {
  const start = await kernel.call("body_count");
  let failing = 0;
  let partFails = 0;
  let withSuppressed = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const random = seeded(BigInt(seed));
    for (let n = 0; n < DESIGNS; n++) {
      const { doc, expected } = randomDesign(random);
      if (expected.some((e) => e.volume === null)) failing++;
      if (expected[expected.length - 1].volume === null) partFails++;
      if (expected.length < doc.timeline.features.filter((f) => !f.id.startsWith("sketch")).length) withSuppressed++;
      const found = await drawn(doc, (scene, failed) => problems(doc, scene, failed, expected, REAL, random));
      assert.deepEqual(found, [], `seed ${seed}, design ${n}`);
    }
  }
  // The random designs reach the cases the bug was about: bodies that failed and rows renumbered by suppression.
  assert.ok(failing >= 10, `${failing} designs with a body that failed`);
  assert.ok(partFails >= 5, `${partFails} designs whose last body failed`);
  assert.ok(withSuppressed >= 10, `${withSuppressed} designs with a suppressed body`);
  assert.equal(await kernel.call("body_count"), start);
});

/** Bugs planted in the functions under test, each the kind of mistake that would bring Ben's report back. */
const PLANTED: Record<string, Partial<Under>> = {
  // The bug Ben found: the panel always describes the last body.
  "panel-shows-last": { panelFocus: (_items, scene, doc) => (scene && scene.bodies.length > 0 ? { feature: doc.timeline.features.find((f) => f.id === scene.bodies.at(-1)!.feature)!, body: scene.bodies.at(-1)! } : null) },
  // Finding 5: every feature that builds in the data has a Body row, failed or not.
  "failed-row-kept": { bodyRows: (doc) => bodyRows(doc) },
  // Finding 5: a failed feature's rows still select its body (the rows read without the rebuild's failures).
  "failed-row-selects": { rowReference: (node, doc) => rowReference(node, doc) },
  // Finding 5: a selected body that did not build passed over, so the panel describes another body (as before the fix).
  "panel-skips-failed": {
    panelFocus: (items, scene, doc) => {
      const shown = items.filter((i) => scene !== null && bodyOf(scene, i) >= 0);
      const f = panelFocus(shown, scene, doc);
      return f && f.body === null && scene && scene.bodies.length > 0 ? { feature: doc.timeline.features.find((x) => x.id === scene.bodies.at(-1)!.feature)!, body: scene.bodies.at(-1)! } : f;
    },
  },
  // "Body n" from the body's place in the drawn scene, which skips a body that failed.
  "named-by-scene-order": { selectionRows: (items, scene, profiles) => selectionRows(items, scene, profiles).map((r, i) => (scene && bodyOf(scene, items[i]) >= 0 && r.type === "solid" ? { ...r, name: `Body ${bodyOf(scene, items[i]) + 1}` } : r)) },
  // A body's faces lit at its own kernel numbers, the joined mesh's offset forgotten.
  "highlight-without-offset": {
    highlightOf: (items, scene) => {
      const h = highlightOf(items, scene);
      const b = scene ? bodyOf(scene, items[0]) : -1;
      return b < 0 || h.body ? h : { ...h, faces: h.faces.map((f) => f - scene!.faceStart[b]) };
    },
  },
  // Row n selects the n-th body drawn, not the n-th that should build.
  "row-by-scene-order": { rowReference: (node, _doc, _failed, scene) => ((m) => (m && scene.bodies[Number(m[1]) - 1] ? bodyReference(scene.bodies[Number(m[1]) - 1].feature) : null))(/^body-(\d+)$/.exec(node)) },
};

for (const [name, plant] of Object.entries(PLANTED)) {
  test(`planted bug "${name}" is caught`, async () => {
    const fns = { ...REAL, ...plant };
    let caught = 0;
    for (let seed = 1; seed <= SEEDS && caught === 0; seed++) {
      const random = seeded(BigInt(seed));
      for (let n = 0; n < DESIGNS && caught === 0; n++) {
        const { doc, expected } = randomDesign(random);
        caught += (await drawn(doc, (scene, failed) => problems(doc, scene, failed, expected, fns, random))).length;
      }
    }
    assert.ok(caught > 0, `${name} went unnoticed`);
  });
}
