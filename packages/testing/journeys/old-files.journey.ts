// The old-file corpus (daily bug hunt 3d): 17 projects saved by older
// versions of the app, each made by running that version's own code (its document
// functions, or its Design app through its design-app.ts on its own WASM
// kernel; old-files/make/ has the scripts and the commit each ran at), kept
// as they were saved. Each must open through today's reader, upgraded to
// Design's version 3, and build on the real kernel what it built then (or
// fail for the same reason), with every volume and cap centroid worked out
// by hand below. Then each is saved and opened again (the same document,
// the same text on a second save), opened in the Design app (its drawn
// volume and warning), and edited with today's tools (a new id repeats
// none of the file's). Run with `npm run journeys` after the app build.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { projectFromJson, projectToJson } from "@fission/core";
import { BodyCache, designWorkspace, insertPreset, moveMarker, rebuildTimeline, readDesignDocument, type DesignDocument } from "@fission/design";
import { app, kernel } from "./design-app.ts";

const DIR = new URL("../old-files/", import.meta.url);
const PI = Math.PI;

/** What one item builds: a body's exact volume (mm³) and, for an extrude, its start and end caps' centroids; or why it doesn't. */
type Want =
  | { volume: number; caps?: [number[], number[]]; warning?: string }
  | { status: "rolled-back" | "suppressed" }
  | { failed: string }
  | "sketch";

interface OldFile {
  /** The SpindleLabs that saved it: the commit and its step. */
  savedBy: string;
  /** Design's data version as saved. */
  version: 1 | 2 | 3;
  /** Each timeline item after the upgrade, in order: id, type, suppressed. */
  items: [string, string, boolean][];
  nextId: number;
  marker?: string;
  /** What each item builds on today's kernel. */
  build: Record<string, Want>;
  /** The Design app's warning when the file is opened (null for none). */
  warning: string | null;
}

/**
 * The corpus, with the working. Volumes: a prism is its outline's area ×
 * its distance; a cylinder πr²h; a sphere 4/3 πr³. A cap's centroid is
 * its outline's centroid on the cap's plane.
 */
const CORPUS: Record<string, OldFile> = {
  // Version 1 (steps 19 to 21a): one ready-made part, ids without a counter; the counter starts above "feature-1" and "profile-1", at 2.
  "v1-plate.panosolid.json": {
    savedBy: "63113192, step 19d",
    version: 1,
    items: [["feature-1", "extrude", false]],
    nextId: 2,
    // Plate 60 × 40 × 5 with two holes of radius 0.15 · min(60, 40) = 6: 5 · (60 · 40 − 2 · 36π) = 12000 − 360π.
    // Symmetric about its middle (30, 20): the holes sit at x = 15 and 45, both on y = 20.
    build: { "feature-1": { volume: 12000 - 360 * PI, caps: [[30, 20, 0], [30, 20, 5]] } },
    warning: null,
  },
  "v1-slot.panosolid.json": {
    savedBy: "63113192, step 19d",
    version: 1,
    items: [["feature-1", "extrude", false]],
    nextId: 2,
    // Slot 50 × 20: a 30 × 20 rectangle and two half circles of radius 10, so 600 + 100π; × 10 = 6000 + 1000π. Middle (25, 10).
    build: { "feature-1": { volume: 6000 + 1000 * PI, caps: [[25, 10, 0], [25, 10, 10]] } },
    warning: null,
  },
  "v1-star.panosolid.json": {
    savedBy: "63113192, step 19d",
    version: 1,
    items: [["feature-1", "extrude", false]],
    nextId: 2,
    // Star in 40 × 40: R = 20, inner corners at 0.4R = 8, ten triangles from the middle, each ½ · 20 · 8 · sin 36°:
    // area 800 sin 36°, × 10 = 8000 sin 36°. Symmetric under a fifth of a turn about (20, 20), so its centroid is there.
    build: { "feature-1": { volume: 8000 * Math.sin(PI / 5), caps: [[20, 20, 0], [20, 20, 10]] } },
    warning: null,
  },
  "v1-sphere.panosolid.json": {
    savedBy: "63113192, step 19d",
    version: 1,
    items: [["feature-1", "sphere", false]],
    nextId: 2,
    // ⌀30: 4/3 · π · 15³ = 4500π.
    build: { "feature-1": { volume: 4500 * PI } },
    warning: null,
  },
  // Version 2 (steps 21b to 24c): sketches and a counter; one part, the last solid (an extrude replaced the part before it).
  "v2-wedge-xz.panosolid.json": {
    savedBy: "5f7a1d32, step 21d",
    version: 2,
    items: [["sketch-2", "sketch", false], ["feature-11", "extrude", false]],
    nextId: 12,
    // A right triangle (0,0), (30,0), (0,40) on XZ (a stray line drawn and deleted, a corner dragged from x = 25), extruded 10 then
    // edited to 12: ½ · 30 · 40 · 12 = 7200. Its centroid (10, 40/3) in the sketch is X = 10, Z = 40/3 in the world;
    // XZ's normal is X × Z = −Y, so the end cap is at y = −12.
    build: { "sketch-2": "sketch", "feature-11": { volume: 7200, caps: [[10, 0, 40 / 3], [10, -12, 40 / 3]] } },
    warning: null,
  },
  "v2-plate-hole.panosolid.json": {
    savedBy: "9de34d8a, step 22b",
    version: 2,
    items: [["sketch-2", "sketch", false], ["feature-13", "extrude", false]],
    nextId: 14,
    // A 60 × 40 rectangle with a circle inside: two loops, which a sketch can't make one outline of yet. That SpindleLabs refused it
    // in the same words (checked at 9de34d8a on its own kernel), so the file opens and the extrude fails, naming why.
    build: { "sketch-2": "sketch", "feature-13": { failed: "open-outline" } },
    warning: null,
  },
  "v2-two-sketches.panosolid.json": {
    savedBy: "9de34d8a, step 22b",
    version: 2,
    items: [["sketch-2", "sketch", false], ["sketch-14", "sketch", false], ["feature-17", "extrude", false]],
    nextId: 18,
    // The second sketch's circle r 5 round (0, 50) on YZ (sketch x = Y, y = Z, normal Y × Z = +X), extruded 20: 25π · 20 = 500π,
    // caps round (0, 0, 50) and (20, 0, 50). That SpindleLabs only extruded XY sketches; today's builds this one.
    build: { "sketch-2": "sketch", "sketch-14": "sketch", "feature-17": { volume: 500 * PI, caps: [[0, 0, 50], [20, 0, 50]] } },
    warning: null,
  },
  "v2-arc-slot.panosolid.json": {
    savedBy: "087917ce, step 23a",
    version: 2,
    items: [["sketch-2", "sketch", false], ["feature-13", "extrude", false]],
    nextId: 14,
    // Lines (0,0)–(30,0) and (30,20)–(0,20), half circles counter-clockwise round (30, 10) and (0, 10), bulging out to x = 40 and −10:
    // 30 · 20 + π · 10² = 600 + 100π; × 5 = 3000 + 500π. Symmetric about (15, 10).
    build: { "sketch-2": "sketch", "feature-13": { volume: 3000 + 500 * PI, caps: [[15, 10, 0], [15, 10, 5]] } },
    warning: null,
  },
  "v2-sketch-then-cylinder.panosolid.json": {
    savedBy: "087917ce, step 23a",
    version: 2,
    items: [["sketch-2", "sketch", false], ["feature-14", "cylinder", false]],
    nextId: 15,
    // The slot above, then the part changed to a cylinder ⌀20 × 30 (it replaced the extrude): π · 10² · 30 = 3000π; the sketch stays.
    build: { "sketch-2": "sketch", "feature-14": { volume: 3000 * PI } },
    warning: null,
  },
  // Version 3 (24d1 on): every solid is a body.
  "v3-three-bodies.panosolid.json": {
    savedBy: "453785dd, step 24d1",
    version: 3,
    items: [["feature-1", "box", false], ["feature-2", "cylinder", false], ["sketch-3", "sketch", false], ["feature-12", "extrude", false]],
    nextId: 13,
    // Box made 50 × 30 × 20 = 30000; cylinder ⌀20 × 30 = 3000π; a 10 × 10 square at x 100 to 110, z 0 to 10 on XZ, extruded 10
    // towards −Y: 1000, caps round (105, 0, 5) and (105, −10, 5).
    build: { "feature-1": { volume: 30000 }, "feature-2": { volume: 3000 * PI }, "sketch-3": "sketch", "feature-12": { volume: 1000, caps: [[105, 0, 5], [105, -10, 5]] } },
    warning: null,
  },
  "v3-suppressed-marker.panosolid.json": {
    savedBy: "498923df, step 24e",
    version: 3,
    items: [["feature-1", "box", false], ["feature-2", "cylinder", true], ["feature-3", "sphere", false], ["sketch-4", "sketch", false], ["feature-7", "extrude", false]],
    nextId: 8,
    marker: "feature-3",
    // Box 40 · 30 · 20 = 24000; the cylinder suppressed; sphere ⌀30 = 4500π; the disc after the marker isn't built.
    build: { "feature-1": { volume: 24000 }, "feature-2": { status: "suppressed" }, "feature-3": { volume: 4500 * PI }, "sketch-4": { status: "rolled-back" }, "feature-7": { status: "rolled-back" } },
    warning: null,
  },
  "v3-marker-start.panosolid.json": {
    savedBy: "498923df, step 24e",
    version: 3,
    items: [["feature-1", "box", false], ["feature-2", "cylinder", true], ["feature-3", "sphere", false], ["sketch-4", "sketch", false], ["feature-7", "extrude", false]],
    nextId: 8,
    marker: "start",
    // The same design rolled back to the start: nothing built.
    build: { "feature-1": { status: "rolled-back" }, "feature-2": { status: "rolled-back" }, "feature-3": { status: "rolled-back" }, "sketch-4": { status: "rolled-back" }, "feature-7": { status: "rolled-back" } },
    warning: null,
  },
  "v3-kept-shape.panosolid.json": {
    savedBy: "b356a35a, step 25 (its own kernel)",
    version: 3,
    items: [["feature-1", "box", false], ["feature-15", "extrude", false]],
    nextId: 16,
    // The L (50,0) (80,0) (80,10) (60,10) (60,30) (50,30), its sketch deleted, so the extrude keeps it: a 30 × 10 bar (centroid (65, 5))
    // and a 10 × 20 upright (centroid (55, 20)): area 300 + 200 = 500, × 6 = 3000; centroid ((300 · 65 + 200 · 55) / 500,
    // (300 · 5 + 200 · 20) / 500) = (61, 11). The box 24000.
    build: { "feature-1": { volume: 24000 }, "feature-15": { volume: 3000, caps: [[61, 11, 0], [61, 11, 6]], warning: "deleted-input" } },
    warning: "Extrude 1 keeps its last shape. Sketch 1 was deleted.",
  },
  "v3-face-flip.panosolid.json": {
    savedBy: "acc1385f, step 26e (its Design app and kernel)",
    version: 3,
    items: [["feature-1", "box", false], ["sketch-2", "sketch", false], ["feature-5", "extrude", false]],
    nextId: 6,
    // Box 24000. A circle r 5 round the top face's middle (20, 15) at z = 20, extruded 8 with Flip: down into the box, so the start cap
    // at z = 20 and the end at z = 12: 25π · 8 = 200π (the bodies overlap: no booleans yet).
    build: { "feature-1": { volume: 24000 }, "sketch-2": "sketch", "feature-5": { volume: 200 * PI, caps: [[20, 15, 20], [20, 15, 12]] } },
    warning: null,
  },
  "v3-face-pin.panosolid.json": {
    savedBy: "ddbb27ca, step 26f (its Design app and kernel)",
    version: 3,
    items: [["feature-1", "box", false], ["sketch-2", "sketch", false], ["feature-5", "extrude", false]],
    nextId: 6,
    // A circle r 5 on the box's top, pinned to its back right corner, extruded 10, then the box made 60 wide: the corner is at
    // (60, 30, 20). Box 60 · 30 · 20 = 36000; cylinder 25π · 10 = 250π from z 20 to 30.
    build: { "feature-1": { volume: 36000 }, "sketch-2": "sketch", "feature-5": { volume: 250 * PI, caps: [[60, 30, 20], [60, 30, 30]] } },
    warning: null,
  },
  "v3-body-pin.panosolid.json": {
    savedBy: "998ebb8c, step 27c (its Design app and kernel)",
    version: 3,
    items: [["feature-1", "box", false], ["sketch-2", "sketch", false], ["feature-5", "extrude", false]],
    nextId: 6,
    // A circle r 2 on the ground plane pinned to the box's bottom back right corner, extruded 5, the box made 60 wide: centre (60, 30).
    // Box 36000; cylinder 4π · 5 = 20π.
    build: { "feature-1": { volume: 36000 }, "sketch-2": "sketch", "feature-5": { volume: 20 * PI, caps: [[60, 30, 0], [60, 30, 5]] } },
    warning: null,
  },
  "v3-pin-lost.panosolid.json": {
    savedBy: "998ebb8c, step 27c (its Design app and kernel)",
    version: 3,
    items: [["sketch-2", "sketch", false], ["feature-5", "extrude", false]],
    nextId: 6,
    // The same with the box deleted: the pinned point has lost its edge and stays at (60, 30); the cylinder alone, 20π.
    build: { "sketch-2": "sketch", "feature-5": { volume: 20 * PI, caps: [[60, 30, 0], [60, 30, 5]] } },
    warning: "Sketch 1: a point snapped to an edge has lost that edge, so it stays where it was.",
  },
};

/** Exact answers agree to a billionth of their size (the kernel's volumes and centroids are exact up to rounding). */
const REL = 1e-9;
/** A drawn body is within 1 % of its exact volume: circles are drawn as polygons inside them (a round body a little under, a round hole a little over). */
const DRAWN_REL = 0.01;
const drawnClose = (drawn: number, exact: number) => Math.abs(drawn - exact) <= DRAWN_REL * exact;
const near = (got: number, want: number, rel = REL) => Math.abs(got - want) <= rel * Math.max(1, Math.abs(want));
const nearAll = (got: readonly number[], want: readonly number[]) => got.length === want.length && got.every((g, k) => near(g, want[k]));
const files = () => readdirSync(DIR).filter((f) => f.endsWith(".panosolid.json")).sort();
const text = (file: string) => readFileSync(new URL(file, DIR), "utf8");
const open = (t: string) => projectFromJson(t, [designWorkspace]);

/** What each item builds on today's kernel, in Want's form (exact volumes and cap centroids). */
async function built(doc: DesignDocument): Promise<Record<string, Want>> {
  const cache = new BodyCache(kernel);
  try {
    const { order, results } = await rebuildTimeline(doc, cache, kernel);
    const out: Record<string, Want> = {};
    for (const id of order) {
      const r = results[id];
      if (r.status === "built" && r.body === undefined) out[id] = "sketch";
      else if (r.status === "built") {
        const view = await cache.view(r.body!);
        const cap = (role: string) => view.face_centroids[view.face_roles.findIndex((x) => x !== null && "role" in x && x.role === role)];
        const isExtrude = view.face_roles.some((x) => x !== null && "role" in x && x.role === "end");
        out[id] = { volume: view.volume, ...(isExtrude ? { caps: [cap("start"), cap("end")] as [number[], number[]] } : {}), ...(r.warning ? { warning: r.warning.cause } : {}) };
      } else if (r.status === "failed") out[id] = { failed: r.cause };
      else out[id] = { status: r.status as "rolled-back" | "suppressed" };
    }
    return out;
  } finally {
    await cache.clear();
  }
}

/** Whether a build matches the hand-worked one: the same items and outcomes, volumes and cap centroids to 1e-9. */
function buildDiff(got: Record<string, Want>, want: Record<string, Want>): string | null {
  if (JSON.stringify(Object.keys(got)) !== JSON.stringify(Object.keys(want))) return `items ${Object.keys(got)} not ${Object.keys(want)}`;
  for (const [id, w] of Object.entries(want)) {
    const g = got[id];
    if (typeof w === "string" || !("volume" in w)) {
      if (JSON.stringify(g) !== JSON.stringify(w)) return `${id}: ${JSON.stringify(g)} not ${JSON.stringify(w)}`;
      continue;
    }
    if (typeof g === "string" || !("volume" in g)) return `${id}: ${JSON.stringify(g)}, not a body`;
    if (!near(g.volume, w.volume)) return `${id}: volume ${g.volume} not ${w.volume}`;
    if (JSON.stringify(g.warning) !== JSON.stringify(w.warning)) return `${id}: warning ${g.warning} not ${w.warning}`;
    if (!!g.caps !== !!w.caps || (w.caps && !(nearAll(g.caps![0], w.caps[0]) && nearAll(g.caps![1], w.caps[1])))) return `${id}: caps ${JSON.stringify(g.caps)} not ${JSON.stringify(w.caps)}`;
  }
  return null;
}

/** Every id the document holds (profiles, items, sketch points, curves and projections, kept shapes'), each once. */
function allIds(doc: DesignDocument): Set<string> {
  return new Set([
    ...doc.profiles.map((p) => p.id),
    ...doc.timeline.features.map((f) => f.id),
    ...doc.sketches.flatMap((s) => [...s.points.map((p) => p.id), ...s.curves.map((c) => c.id), ...(s.projected ?? []).map((p) => p.id)]),
    ...Object.values(doc.kept ?? {}).flatMap((k) => [...k.points.map((p) => p.id), ...k.curves.map((c) => c.id)]),
  ]);
}

test("the comparers: a volume or centroid 0.9 × REL off passes and 1.1 × off fails, a drawn volume at 0.9 × and 1.1 × DRAWN_REL likewise, and each kind of difference is named", () => {
  const want: Record<string, Want> = { "feature-1": { volume: 24000, caps: [[20, 15, 0], [20, 15, 10]] }, "sketch-2": "sketch", "feature-3": { status: "suppressed" } };
  const with1 = (w: Want): Record<string, Want> => ({ ...want, "feature-1": w });
  // 24000 · (1 ± 0.9e-9) is inside, 24000 · (1 + 1.1e-9) outside; a centroid's x of 20 off by 0.9e-9 and 1.1e-9 of max(1, 20).
  assert.equal(buildDiff(with1({ volume: 24000 * (1 + 0.9 * REL), caps: [[20, 15, 0], [20, 15, 10]] }), want), null);
  assert.equal(buildDiff(with1({ volume: 24000 * (1 - 0.9 * REL), caps: [[20, 15, 0], [20, 15, 10]] }), want), null);
  assert.match(buildDiff(with1({ volume: 24000 * (1 + 1.1 * REL), caps: [[20, 15, 0], [20, 15, 10]] }), want)!, /feature-1: volume/);
  assert.equal(buildDiff(with1({ volume: 24000, caps: [[20 * (1 + 0.9 * REL), 15, 0], [20, 15, 10]] }), want), null);
  assert.match(buildDiff(with1({ volume: 24000, caps: [[20, 15, 0], [20 * (1 + 1.1 * REL), 15, 10]] }), want)!, /feature-1: caps/);
  // A z of 0 is compared to 1e-9 mm (the scale is at least 1).
  assert.equal(buildDiff(with1({ volume: 24000, caps: [[20, 15, 0.9 * REL], [20, 15, 10]] }), want), null);
  assert.match(buildDiff(with1({ volume: 24000, caps: [[20, 15, 1.1 * REL], [20, 15, 10]] }), want)!, /caps/);
  // Every other way a build can differ.
  assert.match(buildDiff(with1({ volume: 24000 }), want)!, /feature-1: caps/, "caps missing");
  assert.match(buildDiff(with1({ volume: 24000, caps: [[20, 15, 0], [20, 15, 10]], warning: "deleted-input" }), want)!, /feature-1: warning/);
  assert.match(buildDiff(with1({ failed: "open-outline" }), want)!, /feature-1: .*not a body/);
  assert.match(buildDiff({ ...want, "feature-3": { status: "rolled-back" } }, want)!, /feature-3/);
  assert.match(buildDiff({ ...want, "sketch-2": { status: "rolled-back" } }, want)!, /sketch-2/);
  assert.match(buildDiff({ "sketch-2": "sketch", "feature-1": want["feature-1"], "feature-3": want["feature-3"] }, want)!, /items/, "another order");
  // Drawn: 1000 exact, so 990.1 and 1009.9 are in (0.9 %), 989 and 1011 out (1.1 %).
  assert.ok(drawnClose(1000 * (1 - 0.9 * DRAWN_REL), 1000) && drawnClose(1000 * (1 + 0.9 * DRAWN_REL), 1000));
  assert.ok(!drawnClose(1000 * (1 - 1.1 * DRAWN_REL), 1000) && !drawnClose(1000 * (1 + 1.1 * DRAWN_REL), 1000));
  assert.ok(drawnClose(0, 0), "nothing built, nothing drawn");
});

test("the corpus and its hand-worked answers list the same files", () => {
  assert.deepEqual(files(), Object.keys(CORPUS).sort());
  assert.equal(files().length, 17);
});

test("every old file is as its SpindleLabs saved it: the outer format 2 and Design's version as recorded", () => {
  for (const file of files()) {
    const raw = JSON.parse(text(file));
    assert.equal(raw.formatVersion, 2, file);
    assert.equal(raw.workspaces.design.version, CORPUS[file].version, file);
  }
});

test("every old file opens through today's reader, upgraded to version 3 with its items, flags, marker and counter as worked out", () => {
  for (const file of files()) {
    const want = CORPUS[file];
    const doc = open(text(file)).workspaces.design as DesignDocument;
    assert.equal(doc.version, 3, file);
    assert.deepEqual(doc.timeline.features.map((f) => [f.id, f.intent.type, f.suppressed]), want.items, file);
    assert.equal(doc.nextId, want.nextId, file);
    assert.equal(doc.timeline.marker, want.marker, file);
  }
});

test("every old file builds on today's kernel what was worked out by hand: each body's exact volume and cap centroids, or the same refusal", async () => {
  const start = await kernel.call("body_count");
  for (const file of files()) {
    const doc = open(text(file)).workspaces.design as DesignDocument;
    assert.equal(buildDiff(await built(doc), CORPUS[file].build), null, file);
  }
  assert.equal(await kernel.call("body_count"), start, "every body freed");
});

test("every old file saved and opened again is the same document, and a second save the same text", () => {
  for (const file of files()) {
    const first = open(text(file));
    const saved = projectToJson(first);
    const again = open(saved);
    assert.deepEqual(again, first, file);
    assert.equal(projectToJson(again), saved, file);
  }
});

test("every old file opens in the Design app: the bodies drawn (within 1 % where circles are drawn as polygons) and its warning", async () => {
  for (const file of files()) {
    const want = CORPUS[file];
    const doc = open(text(file)).workspaces.design as DesignDocument;
    const a = await app(doc);
    const volumes = Object.values(want.build).flatMap((w) => (typeof w !== "string" && "volume" in w ? [w.volume] : []));
    const exact = volumes.reduce((s, v) => s + v, 0);
    const drawn = a.volume();
    assert.ok(drawnClose(drawn, exact), `${file}: drawn ${drawn} mm³, exact ${exact}`);
    assert.equal(a.warning(), want.warning, file);
    assert.ok(await a.close(), `${file}: every body freed`);
  }
});

test("every old file takes today's edits: a new item's id repeats none of the file's, and the edited file opens", () => {
  for (const file of files()) {
    const doc = open(text(file)).workspaces.design as DesignDocument;
    // Built to the end first, so the cube goes in last whatever the marker was.
    const made = insertPreset(moveMarker(doc, null), "box", 10, 10, 10);
    assert.ok(!allIds(doc).has(made.id), `${file}: ${made.id} is new`);
    assert.equal(made.doc.nextId, doc.nextId + 1, file);
    assert.equal(made.doc.timeline.features.at(-1)!.id, made.id, file);
    readDesignDocument(JSON.parse(JSON.stringify(made.doc)));
  }
});

test("the marker files rolled forward build everything after the marker: the disc r 20 × 4 is 1600π, and from the start all four bodies", async () => {
  for (const file of ["v3-suppressed-marker.panosolid.json", "v3-marker-start.panosolid.json"]) {
    const doc = moveMarker(open(text(file)).workspaces.design as DesignDocument, null);
    const got = await built(doc);
    // π · 20² · 4 = 1600π; its caps round (100, 0) at z 0 and 4. The suppressed cylinder stays suppressed.
    assert.equal(
      buildDiff(got, {
        "feature-1": { volume: 24000 },
        "feature-2": { status: "suppressed" },
        "feature-3": { volume: 4500 * PI },
        "sketch-4": "sketch",
        "feature-7": { volume: 1600 * PI, caps: [[100, 0, 0], [100, 0, 4]] },
      }),
      null,
      file,
    );
  }
});
