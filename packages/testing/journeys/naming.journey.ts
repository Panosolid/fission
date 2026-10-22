// Sketch on a face (step 26) on the real kernel: Design as a subject of the
// naming harness (src/naming-design.ts) against the model
// (src/naming-model.ts), step 26c. Every one of Ben's Fusion answers that
// holds without a cut (the cut waits for booleans, 44/48), seeded sessions
// against the model with their failures shrunk and saved, hand-worked
// placed bodies on XZ, YZ and faces, flipped, kept and lost, and bugs
// planted in the subject to prove the checks catch them. The bugs planted
// in Design's own code are planted/model-faults.ts's `NAMING_PLANTS`, run by
// planted/run.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { emptyProject, projectFromJson, projectToJson, type BodySpec, type KernelCalls, type StableId } from "@fission/core";
import {
  addFaceSketch,
  addSketch,
  BodyCache,
  changePreset,
  deleteItem,
  drawCircle,
  drawnOnFace,
  drawRectangle,
  extrudeSketch,
  facePlane,
  featureSpec,
  findInScene,
  joinBodies,
  partDocument,
  readDesignDocument,
  rebuildTimeline,
  sceneHit,
  setExtrudeFlip,
  settleKept,
  shownBodies,
  type DesignDocument,
  type FeatureResult,
} from "@fission/design";
import { nodeKernel } from "../src/node-kernel.ts";
import { NAMING_DESIGN_FAULTS, namingDesignSubject, prismCentroid, type NamingDesignFault } from "../src/naming-design.ts";
import { FUSION_CASES, NamingFailure, namingFailureOf, randomNamingSession, runFusionCase, runNamingSession, setupOps, shrinkNaming, BEN, type NamingCounts, type NamingSession } from "../src/naming-session.ts";

const kernel: KernelCalls = nodeKernel();
const near = (a: readonly number[], b: readonly number[]) => a.every((x, k) => Math.abs(x - b[k]) <= 1e-9 * Math.max(1, Math.abs(b[k])));
const DESIGN = [{ id: "design" as const, readData: readDesignDocument }];
const reopen = (doc: DesignDocument) => projectFromJson(projectToJson({ ...emptyProject("Naming"), workspaces: { design: doc } }), DESIGN).workspaces.design as DesignDocument;

/** A rebuild's bodies: each built solid's volume and centroid (a prism's: halfway between its caps). */
async function solids(doc: DesignDocument): Promise<{ results: Record<string, FeatureResult>; bodies: Record<string, { volume: number; centroid: number[] }> }> {
  const cache = new BodyCache(kernel);
  try {
    const b = await rebuildTimeline(doc, cache, kernel);
    const bodies: Record<string, { volume: number; centroid: number[] }> = {};
    // Extrudes only: a preset has no caps to take the middle between.
    for (const s of await shownBodies(doc, b, cache)) if (s.view.face_roles.some((r) => r?.role === "start")) bodies[s.feature] = { volume: s.view.volume, centroid: prismCentroid(s.view) };
    return { results: b.results, bodies };
  } finally {
    await cache.clear();
  }
}

/** An empty design with a 40 × 30 rectangle sketched on `plane`, corners (0, 0) and (40, 30) in the sketch's own coordinates. */
function rectangleOn(plane: "XY" | "XZ" | "YZ"): { doc: DesignDocument; sketch: string } {
  const empty: DesignDocument = { version: 3, nextId: 1, profiles: [], sketches: [], timeline: { features: [] } };
  const s = addSketch(empty, plane);
  return { doc: drawRectangle(s.doc, s.id, [0, 0], [40, 30]).doc, sketch: s.id };
}

// ---------------------------------------------------------------- hand-worked

test("hand-worked: a 40 × 30 rectangle on XZ and on YZ, extruded 10, stands upright in its plane's frame, and Flip sends it the other way", async () => {
  // XZ: x along X, normal −Y, so y = −Y × X = Z: the rectangle spans X 0..40 and Z 0..30 at y = 0 and goes 10 along −Y,
  // middle (20, −5, 15), volume 40 · 30 · 10 = 12000. Flipped, the same from y = 0 to +10: middle (20, 5, 15).
  // YZ: x along Y, normal X, y = X × Y = Z: Y 0..40, Z 0..30, 10 along +X: middle (5, 20, 15); flipped (−5, 20, 15).
  for (const [plane, want, flipped] of [
    ["XZ", [20, -5, 15], [20, 5, 15]],
    ["YZ", [5, 20, 15], [-5, 20, 15]],
  ] as const) {
    const { doc, sketch } = rectangleOn(plane);
    const e = extrudeSketch(doc, sketch, 10);
    let got = (await solids(e.doc)).bodies[e.id];
    assert.ok(Math.abs(got.volume - 12000) <= 12000 * 1e-9 && near(got.centroid, want), `${plane}: ${JSON.stringify(got)}`);
    got = (await solids(setExtrudeFlip(e.doc, true, e.id))).bodies[e.id];
    assert.ok(Math.abs(got.volume - 12000) <= 12000 * 1e-9 && near(got.centroid, flipped), `${plane} flipped: ${JSON.stringify(got)}`);
  }
  // On XY, flipped: down from z = 0 to −10, middle (20, 15, −5).
  const { doc, sketch } = rectangleOn("XY");
  const e = extrudeSketch(doc, sketch, 10, true);
  assert.ok(near((await solids(e.doc)).bodies[e.id].centroid, [20, 15, -5]));
});

test("hand-worked: the XZ sketch deleted, its extrude keeps its last shape where it stood (not laid flat on XY), through save and open", async () => {
  const { doc, sketch } = rectangleOn("XZ");
  const e = extrudeSketch(doc, sketch, 10);
  const gone = await settleKept(kernel, e.doc, deleteItem(e.doc, sketch));
  assert.deepEqual(gone.kept?.[e.id].placement, { plane: { origin: [0, 0, 0], xAxis: [1, 0, 0], normal: [0, -1, 0] }, side: 1 });
  for (const d of [gone, reopen(gone)]) {
    const { results, bodies } = await solids(d);
    const r = results[e.id];
    assert.ok(r.status === "built" && r.warning?.cause === "deleted-input", JSON.stringify(r));
    // Still upright: middle (20, −5, 15), as before the delete (laid on XY it would be (20, 15, 5)).
    assert.ok(near(bodies[e.id].centroid, [20, -5, 15]), JSON.stringify(bodies[e.id]));
  }
});

test("hand-worked: a sketch on a cylinder's flat top is placed there; its round side can't be sketched on, and a file naming it holds the sketch with its plane lost", async () => {
  // A cylinder 20 across and 10 high: its top is the disc z = 10, so the frame is XY's at (0, 0, 10). A circle of radius 2
  // at (3, 4) extruded 5 is the cylinder z 10..15: middle (3, 4, 12.5), volume π · 4 · 5 = 20π.
  let doc = partDocument("cylinder", 20, 20, 10);
  const cache = new BodyCache(kernel);
  try {
    const scene = joinBodies(await shownBodies(doc, await rebuildTimeline(doc, cache, kernel), cache));
    const at = (part: string) => {
      const found = findInScene({ kind: "face", id: `face:feature-1/${part}` as StableId }, scene);
      assert.equal(found.status, "found", part);
      const hit = sceneHit(scene, "face", (found as { index: number }).index)!;
      return drawnOnFace(scene.bodies[hit.body].view, hit.index);
    };
    // Q5: the round side has no plane.
    assert.equal(at("side"), null);
    const top = at("top")!;
    assert.ok(near(top.plane.origin, [0, 0, 10]) && near(top.plane.xAxis, [1, 0, 0]) && near(top.plane.normal, [0, 0, 1]) && top.side === 1, JSON.stringify(top));
    const s = addFaceSketch(doc, { plane: facePlane("feature-1", "top"), feature: "feature-1" }, top);
    doc = drawCircle(s.doc, s.id, [3, 4], 2).doc;
    const e = extrudeSketch(doc, s.id, 5);
    let got = await solids(e.doc);
    assert.ok(Math.abs(got.bodies[e.id].volume - 20 * Math.PI) <= 1e-6 * 20 * Math.PI && near(got.bodies[e.id].centroid, [3, 4, 12.5]), JSON.stringify(got.bodies));
    // The same extrude asked for outside a rebuild (another workspace's solid, the STL) is the same spec.
    const b = await rebuildTimeline(e.doc, cache, kernel);
    assert.deepEqual(await featureSpec(kernel, e.doc, e.doc.timeline.features.at(-1)!), (b.results[e.id] as { spec: BodySpec }).spec);
    // A file naming the round side: no flat face of that name, so held where it was drawn, plane lost, and its extrude says its source is lost.
    const side = structuredClone(e.doc);
    side.timeline.features[1].intent.parameters.plane = facePlane("feature-1", "side");
    got = await solids(side);
    const sk = got.results[s.id];
    assert.ok(sk.status === "built" && sk.plane?.cause === "plane-lost" && near(sk.placement!.plane.origin, [0, 0, 10]), JSON.stringify(sk));
    assert.equal((got.results[e.id] as { source?: { cause: string } }).source?.cause, "plane-lost");
  } finally {
    await cache.clear();
  }
});

test("hand-worked: a box's top sketched on, then the box made a sphere: the top is gone, so the sketch is held at z = 20 and its body stays, saying its source is lost", async () => {
  let doc = partDocument("box", 40, 30, 20);
  const cache = new BodyCache(kernel);
  try {
    const scene = joinBodies(await shownBodies(doc, await rebuildTimeline(doc, cache, kernel), cache));
    const found = findInScene({ kind: "face", id: "face:feature-1/top" as StableId }, scene);
    const hit = sceneHit(scene, "face", (found as { index: number }).index)!;
    const s = addFaceSketch(doc, { plane: facePlane("feature-1", "top"), feature: "feature-1" }, drawnOnFace(scene.bodies[hit.body].view, hit.index)!);
    doc = drawCircle(s.doc, s.id, [20, 15], 5).doc;
    const e = extrudeSketch(doc, s.id, 10);
    // A sphere has an upper and a lower half, no top: settling holds the top's placement, z = 20.
    const sphere = await settleKept(kernel, e.doc, changePreset(e.doc, "feature-1", "sphere", 40, 40, 40));
    const held = sphere.sketches.find((x) => x.id === s.id)!.face!.held!;
    assert.ok(near(held.origin, [0, 0, 20]) && near(held.normal, [0, 0, 1]), JSON.stringify(held));
    const got = await solids(sphere);
    assert.equal((got.results[s.id] as { plane?: { cause: string } }).plane?.cause, "plane-lost");
    // The cylinder stays where it was: middle (20, 15, 25).
    assert.ok(near(got.bodies[e.id].centroid, [20, 15, 25]) && (got.results[e.id] as { source?: unknown }).source !== undefined, JSON.stringify(got.bodies));
    // A box again: the top is back, the hold is forgotten, nothing warns.
    const back = await settleKept(kernel, sphere, changePreset(sphere, "feature-1", "box", 40, 30, 20));
    assert.equal(back.sketches.find((x) => x.id === s.id)!.face!.held, undefined);
    const again = await solids(back);
    assert.equal((again.results[s.id] as { plane?: unknown }).plane, undefined);
  } finally {
    await cache.clear();
  }
});

test("hand-worked: the outline's sketch deleted, its extrude keeps the sketch's line ids, so a sketch on its right side keeps its face (kept extrudes keep their names)", async () => {
  // Ben's part with the circle on the right side (line 2, x = 40): after Sketch 1 is deleted, Extrude 2 is built from
  // its kept shape, whose lines are the sketch's, so "side:line-2" still names the right side: no plane lost, the frame
  // the side plane's at (40, 0, 0), and the cylinder still 40 to 50 along X: middle (45, 15, 10).
  const subject = namingDesignSubject(kernel);
  try {
    const made = async (op: Parameters<typeof subject.apply>[0]) => {
      const r = await subject.apply(op);
      assert.equal(r.kind, "done", JSON.stringify(op));
      return r.kind === "done" ? r.ids : [];
    };
    const outline = await made({ op: "add-sketch", corners: BEN.corners });
    const [extrude] = await made({ op: "add-extrude", sketch: outline[0], distance: 20 });
    const [onSide] = await made({ op: "add-face-sketch", face: { feature: extrude, role: "side", line: outline[2] }, centre: [15, 10], radius: 5 });
    const [cylinder] = await made({ op: "add-face-extrude", sketch: onSide, distance: 10 });
    const ids = [...outline, extrude, onSide, cylinder];
    // ids: sketch, its four lines, the extrude, the face sketch, its extrude.
    const [sketch1] = ids;
    assert.equal((await subject.planDelete(sketch1)).ask, true);
    await subject.apply({ op: "delete", item: sketch1 });
    const r = await subject.read();
    const sk = r.results[ids[6]];
    assert.ok(sk.kind === "sketch" && sk.warning === undefined && near(sk.placement.origin, [40, 0, 0]) && near(sk.placement.normal, [1, 0, 0]), JSON.stringify(sk));
    const body = r.results[ids[7]];
    assert.ok(body.kind === "solid" && body.warning === undefined && near(body.centroid, [45, 15, 10]), JSON.stringify(body));
    const base = r.results[ids[5]];
    assert.equal(base.kind === "solid" && base.warning?.cause, "deleted-input");
  } finally {
    await subject.dispose();
  }
});

// ---------------------------------------------------------------- Ben's answers

test("every one of Ben's Fusion answers that holds without a cut holds on Design (1, 2, 5, 7, Q1, Q2, Q3, Q4, and from step 27 R11 to R13)", async () => {
  // Step 27's cases (rules 11 to 13), each from the substep that gave Design what it needs (`from`): 27c's pins and 27d's projections.
  const cases = FUSION_CASES.filter((c) => !c.cuts && (c.from === undefined || c.from === "27c" || c.from === "27d"));
  assert.equal(cases.filter((c) => c.from === "27d").length, 6, "every projection case of 27a's plan");
  assert.deepEqual([...new Set(cases.map((c) => c.answer))].sort(), ["1", "2", "5", "7", "Q1", "Q2", "Q3", "Q4", "R11", "R12", "R13"]);
  const start = await kernel.call("body_count");
  for (const c of cases) {
    const subject = namingDesignSubject(kernel);
    try {
      await runFusionCase(subject, c);
    } catch (e) {
      assert.fail(`answer ${c.answer} (${c.title}): ${e instanceof Error ? e.message : e}`);
    } finally {
      await subject.dispose();
    }
  }
  assert.equal(await kernel.call("body_count"), start);
});

// ---------------------------------------------------------------- seeded

/** 100 seeds (FISSION_SESSIONS): a session takes about 60 ms, and the rarest path (a face redrawn away while greyed, then back on) comes about once in 18 sessions. */
const SEEDS = Number(process.env.FISSION_SESSIONS ?? 100);
const STEPS = Number(process.env.FISSION_SESSION_STEPS ?? 150);
const REGRESSIONS = new URL("../test/regressions/naming/", import.meta.url);

test(`seeded: ${SEEDS} sessions × ${STEPS} steps on Design agree with the model at every step and reach every case`, async () => {
  const start = await kernel.call("body_count");
  const total: NamingCounts = {};
  for (let k = 0; k < SEEDS; k++) {
    const seed = BigInt(2500 + k);
    // From step 27c with a second body and pins on any earlier extrude's edges, and from 27d edges projected (rules 11 to 13; "all").
    const session = randomNamingSession(seed, STEPS, false, "all");
    const subject = namingDesignSubject(kernel);
    try {
      const counts = await runNamingSession(subject, session);
      for (const [key, v] of Object.entries(counts)) total[key] = (total[key] ?? 0) + v;
    } catch (e) {
      if (!(e instanceof NamingFailure)) throw e;
      const shrunk = await shrinkNaming(() => namingDesignSubject(kernel), session);
      const saved = JSON.stringify({ subject: "design", seed: String(seed), cuts: false, ...shrunk }, null, 1) + "\n";
      // Saved for good (the CLAUDE.md rule), except while planted/run.ts plants a bug on purpose (FISSION_PLANTED).
      if (process.env.FISSION_PLANTED) assert.fail(`seed ${seed}: ${e.message}`);
      mkdirSync(REGRESSIONS, { recursive: true });
      const file = new URL(`design-${seed}.json`, REGRESSIONS);
      writeFileSync(file, saved);
      assert.fail(`seed ${seed}: ${e.message}\nshrunk to ${shrunk.steps.length} steps, saved in ${file.pathname}`);
    } finally {
      await subject.dispose();
    }
  }
  assert.equal(await kernel.call("body_count"), start, "every body freed");
  const reached = [
    "sketch:followed",
    "sketch:side",
    "sketch:turned",
    "sketch:facing-in",
    "sketch:plane-lost",
    "solid:source-lost",
    "solid:kept",
    "extrude:flipped",
    "off:suppressed",
    "off:greyed",
    "delete:ask",
    "delete:quiet",
    "plan:ask",
    "plan:quiet",
    "op:reorder:before-dependency",
    "op:reorder:after-dependent",
    "op:reorder:done",
    "op:set-corners:done",
    "op:move-corner:done",
    "op:set-distance:done",
    "op:set-circle:done",
    "op:suppress:done",
    "op:undo:done",
    "op:redo:done",
    "save-open",
    "pin:corner",
    "pin:middle",
    "pin:moved",
    "sketch:point-lost",
    // Step 27c (rules 11 and 13): pins on another body, on another face of its own, on an upright; drags refused,
    // deletes asked and sketches greyed only because of what a pin names.
    "pin:upright",
    "pin:other-feature",
    "pin:other-face",
    "reorder:refused-by-ref",
    "delete:ask-by-ref",
    "off:greyed-by-ref",
    // Step 27d (rule 12): lines and points, from another extrude, followed somewhere new, lost and held; projected twice; removed.
    "projection:line",
    "projection:point",
    "projection:other-feature",
    "projection:moved",
    "sketch:projection-lost",
    "op:project:done",
    "op:project:unchanged",
    "op:unproject:done",
  ];
  if (SEEDS >= 12) for (const key of reached) assert.ok((total[key] ?? 0) >= 3, `${key} reached ${total[key] ?? 0} times: ${JSON.stringify(total)}`);
});

test("saved regressions replay on Design", { skip: !existsSync(REGRESSIONS) && "none saved yet" }, async () => {
  for (const file of readdirSync(REGRESSIONS).filter((f) => f.endsWith(".json"))) {
    const saved = JSON.parse(readFileSync(new URL(file, REGRESSIONS), "utf8"));
    if (saved.cuts !== false) continue; // a cut needs booleans
    const subject = namingDesignSubject(kernel);
    try {
      await runNamingSession(subject, { setup: saved.setup, steps: saved.steps });
    } finally {
      await subject.dispose();
    }
  }
});

// ---------------------------------------------------------------- planted

/** The first seeded session (of the sessions above) a subject with `fault` fails, shrunk. */
async function caught(fault: NamingDesignFault): Promise<{ session: NamingSession; failure: NamingFailure } | null> {
  for (let k = 0; k < SEEDS; k++) {
    const session = randomNamingSession(BigInt(2500 + k), STEPS, false, "all");
    const subjects: { dispose(): Promise<void> }[] = [];
    const make = () => {
      const s = namingDesignSubject(kernel, [fault]);
      subjects.push(s);
      return s;
    };
    try {
      const failure = await namingFailureOf(make, session);
      if (failure) return { session: await shrinkNaming(make, session), failure };
    } finally {
      for (const s of subjects) await s.dispose();
    }
  }
  return null;
}

test("each bug planted in the subject is caught: no settle by the rebuild, a file losing its frames by save and open, a leak by body_count", async () => {
  for (const fault of NAMING_DESIGN_FAULTS) {
    if (fault === "leak-bodies") continue;
    const c = await caught(fault);
    assert.ok(c, `${fault} was never caught`);
    assert.equal(c.failure.check, fault === "no-settle" ? "rebuild" : "save and open", `${fault}: ${c.failure.message}`);
    assert.ok(c.session.steps.length <= 8, `${fault}: shrunk to ${c.session.steps.length} steps`);
  }
  // The leak: every rebuild on a cache of its own, never freed. The answers stay right; body_count doesn't come back.
  const start = await kernel.call("body_count");
  const leaky = namingDesignSubject(kernel, ["leak-bodies"]);
  await runFusionCase(leaky, FUSION_CASES.find((c) => !c.cuts)!);
  await leaky.dispose();
  const left = await kernel.call("body_count");
  assert.ok(left > start, `${left} bodies, ${start} before`);
  // Free what the planted leak kept, so later tests count from here.
  for (let h = 1; (await kernel.call("body_count")) > start && h < 100_000; h++) await kernel.call("body_free", h).catch(() => undefined);
});
