// Journey: with several bodies, the browser's Body rows, the viewport's
// highlight, the selection list and the properties panel all mean the same
// body (bug fix, Ben 2026-10-18: selecting Body 3 showed another body's
// volume, area and topology, because the panel always showed the last
// body). On the real WASM kernel, each design is rebuilt and drawn as
// workspace.ts does (`rebuildTimeline`, `shownBodies`, `joinBodies`); then
// for every Body row: the row's label, the body its reference selects, the
// faces lit (every lit triangle inside that body's region, worked out from
// the design, and every triangle there lit), the selection list's name and
// the panel's body (`panelBody`: its feature, number and volume against a
// hand-worked formula) must agree. Ben's design is worked by hand, then
// seeded random designs (a preset, then up to four extrudes of rectangles
// and circles, each in its own 100 mm cell along x, some suppressed, some
// failing because a line was deleted with no kept shape), then four planted
// bugs, each caught. Run with `npm run journeys` after the app build.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { GeometryReference } from "@fission/core";
import {
  addSketch,
  BodyCache,
  bodyReference,
  bodyOf,
  browserTree,
  deleteCurve,
  drawCircle,
  drawRectangle,
  extrudeSketch,
  highlightOf,
  joinBodies,
  panelBody,
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
  rowReference: (node: string, doc: DesignDocument, scene: Scene) => GeometryReference | null;
  highlightOf: typeof highlightOf;
  selectionRows: typeof selectionRows;
  panelBody: typeof panelBody;
}
const REAL: Under = { rowReference: (node, doc) => rowReference(node, doc), highlightOf, selectionRows, panelBody };

/** The design rebuilt and drawn as the app does, on a fresh cache freed after; `look` reads it before the bodies go. */
async function drawn<T>(doc: DesignDocument, look: (scene: Scene) => T): Promise<T> {
  const cache = new BodyCache(kernel);
  try {
    const build = await rebuildTimeline(doc, cache, kernel);
    return look(joinBodies(await shownBodies(doc, build, cache)));
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
function problems(doc: DesignDocument, scene: Scene, expected: readonly Expected[], fns: Under, random?: SeededRandom): string[] {
  const out: string[] = [];
  const rows = browserTree(doc).find((g) => g.id === "bodies")!.children!;
  if (rows.length !== expected.length) out.push(`${rows.length} Body rows, the design has ${expected.length}`);
  const built = expected.filter((e) => e.volume !== null);
  const last = built[built.length - 1];
  const triangles = scene.mesh.triangle_faces.length;
  for (const [i, row] of rows.entries()) {
    const e = expected[i];
    if (!e) break;
    const name = `Body ${e.place}`;
    if (row.label !== name) out.push(`row ${row.id} says ${row.label}, it is ${name}`);
    const ref = fns.rowReference(row.id, doc, scene);
    if (ref?.id !== bodyReference(e.feature).id) {
      out.push(`${name}'s row selects ${ref?.id}, not ${e.feature}`);
      continue;
    }
    const lit = new Set(fns.highlightOf([ref], scene).faces);
    const panel = fns.panelBody([ref], scene);
    if (e.volume === null) {
      if (lit.size > 0) out.push(`${name} did not build but lights faces ${[...lit]}`);
      if (panel?.feature !== last?.feature) out.push(`${name} did not build, so the panel should show Body ${last?.place}, not ${panel?.feature}`);
      continue;
    }
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
  // Nothing selected: the last body, the part the parameters edit.
  const none = fns.panelBody([], scene);
  if (none?.feature !== last?.feature) out.push(`nothing selected, the panel shows ${none?.feature}, not the last body ${last?.feature}`);
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
      const panel = fns.panelBody([bodyReference(other.feature), face], scene);
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
  await drawn(doc, (scene) => {
    for (const e of expected) {
      const ref = rowReference(`body-${e.place}`, doc)!;
      assert.equal(ref.id, bodyReference(e.feature).id);
      const lit = new Set(highlightOf([ref], scene).faces);
      assert.equal(lit.size, e.faces, `Body ${e.place}'s faces`);
      for (let t = 0; t < scene.mesh.triangle_faces.length; t++) {
        if (lit.has(scene.mesh.triangle_faces[t])) assert.ok(corners(scene, t).every(e.inside), `Body ${e.place}: lit triangle ${t} lies in it`);
      }
      assert.equal(selectionRows([ref], scene)[0].name, `Body ${e.place}`);
      const panel = panelBody([ref], scene)!;
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
    assert.equal(panelBody([], scene)?.place, 3, "nothing selected: the last body");
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
      // A line deleted with no kept shape recorded (no settleKept): the extrude fails, so its row has no body.
      const fails = !lastOne && random.next() < 0.25;
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
  let withSuppressed = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const random = seeded(BigInt(seed));
    for (let n = 0; n < DESIGNS; n++) {
      const { doc, expected } = randomDesign(random);
      if (expected.some((e) => e.volume === null)) failing++;
      if (expected.length < doc.timeline.features.filter((f) => !f.id.startsWith("sketch")).length) withSuppressed++;
      const found = await drawn(doc, (scene) => problems(doc, scene, expected, REAL, random));
      assert.deepEqual(found, [], `seed ${seed}, design ${n}`);
    }
  }
  // The random designs reach the cases the bug was about: bodies that failed and rows renumbered by suppression.
  assert.ok(failing >= 10, `${failing} designs with a body that failed`);
  assert.ok(withSuppressed >= 10, `${withSuppressed} designs with a suppressed body`);
  assert.equal(await kernel.call("body_count"), start);
});

/** Bugs planted in the functions under test, each the kind of mistake that would bring Ben's report back. */
const PLANTED: Record<string, Partial<Under>> = {
  // The bug Ben found: the panel always describes the last body.
  "panel-shows-last": { panelBody: (_items, scene) => (scene && scene.bodies.length > 0 ? scene.bodies[scene.bodies.length - 1] : null) },
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
  "row-by-scene-order": { rowReference: (node, _doc, scene) => ((m) => (m && scene.bodies[Number(m[1]) - 1] ? bodyReference(scene.bodies[Number(m[1]) - 1].feature) : null))(/^body-(\d+)$/.exec(node)) },
};

for (const [name, plant] of Object.entries(PLANTED)) {
  test(`planted bug "${name}" is caught`, async () => {
    const fns = { ...REAL, ...plant };
    let caught = 0;
    for (let seed = 1; seed <= SEEDS && caught === 0; seed++) {
      const random = seeded(BigInt(seed));
      for (let n = 0; n < DESIGNS && caught === 0; n++) {
        const { doc, expected } = randomDesign(random);
        caught += (await drawn(doc, (scene) => problems(doc, scene, expected, fns, random))).length;
      }
    }
    assert.ok(caught > 0, `${name} went unnoticed`);
  });
}
