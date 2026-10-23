// The golden models (step 28a; src/golden.ts has the format): each project
// file in tests/golden opened through today's reader and rebuilt through
// Design's own rebuild on the real kernel, every body, face sketch and pin
// checked against its hand-worked expect.json; saved and opened again to
// the same document. Then the proof the check can fail: a wrong volume, a
// wrong face name and a tolerance tighter than the body carries, each
// written into a real expectation, and bugs planted in the kernel's
// answers, each caught on the real models. Run with `npm run journeys`
// after the app build.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { projectFromJson, projectToJson, type BodyView, type GeometryReference, type KernelCalls, type StableId } from "@fission/core";
import { BodyCache, bodyRows, designWorkspace, findInScene, isFaceSketch, joinBodies, rebuildTimeline, shownBodies, type DesignDocument } from "@fission/design";
import { bodyTolerance, compare, LINEAR, plan, planeGap, readExpect, type GoldenExpect, type Measured, type Vec3 } from "../src/golden.ts";
import { nodeKernel } from "../src/node-kernel.ts";

const DIR = new URL("../../../tests/golden/", import.meta.url);
const kernel = nodeKernel();

const expects = (): GoldenExpect[] =>
  readdirSync(DIR)
    .filter((f) => f.endsWith(".expect.json"))
    .sort()
    .map((f) => readExpect(readFileSync(new URL(f, DIR), "utf8"), f));
const projectFiles = () =>
  readdirSync(DIR)
    .filter((f) => f.endsWith(".panosolid.json"))
    .map((f) => f.slice(0, -".panosolid.json".length))
    .sort();
const open = (model: string) => projectFromJson(readFileSync(new URL(`${model}.panosolid.json`, DIR), "utf8"), [designWorkspace]);
const designOf = (model: string) => open(model).workspaces.design as DesignDocument;

const cross = (a: readonly number[], b: readonly number[]): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** A rebuild of `doc` through Design on `calls`, measured as the expectations are written, and how long the rebuild took. */
async function measure(doc: DesignDocument, calls: KernelCalls = kernel): Promise<{ got: Measured; ms: number }> {
  const cache = new BodyCache(calls);
  try {
    const start = performance.now();
    const build = await rebuildTimeline(doc, cache, calls);
    const shown = await shownBodies(doc, build, cache);
    const ms = performance.now() - start;
    const scene = joinBodies(shown);
    const trouble: string[] = [];
    const failed = new Set<string>();
    for (const id of build.order) {
      const r = build.results[id];
      if (r.status === "failed") {
        failed.add(id);
        trouble.push(`${id} failed: ${r.message}`);
      } else if (r.status !== "built") trouble.push(`${id} is ${r.status}`);
      else for (const w of [r.warning, r.plane, r.source, r.points, r.projections]) if (w) trouble.push(`${id} warns: ${w.message}`);
    }
    const rows = bodyRows(doc, failed);
    const bodies = shown.map((s) => {
      const v = s.view;
      return {
        body: rows.find((r) => r.feature.id === s.feature)?.label ?? "no row",
        item: s.feature,
        volume: v.volume,
        area: v.area,
        faces: v.faces,
        edges: v.edges,
        vertices: v.vertices,
        box: v.bounds,
        tolerance: bodyTolerance(v),
        gap: planeGap(v),
        errors: v.errors,
      };
    });
    const sketches = doc.timeline.features.filter(isFaceSketch).map((f) => {
      const face = f.intent.parameters.plane as string;
      const found = findInScene({ kind: "face", id: face as StableId } as GeometryReference, scene);
      let normal: Vec3 | null = null;
      let centroid: Vec3 | null = null;
      if (found.status === "found") {
        const b = shown.findIndex((_, i) => found.index >= scene.faceStart[i] && (i + 1 === shown.length || found.index < scene.faceStart[i + 1]));
        const i = found.index - scene.faceStart[b];
        normal = shown[b].view.face_normals[i] ?? null;
        centroid = shown[b].view.face_centroids[i];
      }
      const r = build.results[f.id];
      const p = r?.status === "built" ? r.placement : undefined;
      return {
        sketch: f.id,
        face,
        found: found.status === "found" ? 1 : found.status === "shared" ? found.count : 0,
        normal,
        centroid,
        placed: p ? { normal: p.plane.normal.map((c) => c * p.side) as Vec3, origin: p.plane.origin } : null,
      };
    });
    const pins = doc.sketches.flatMap((s) =>
      (s.pins ?? []).map((pin) => {
        const r = build.results[s.id];
        const p = r?.status === "built" ? r.placement : undefined;
        const xy = r?.status === "built" ? r.pinned?.find((q) => q.point === pin.point)?.at : undefined;
        let at: Vec3 | null = null;
        if (p && xy) {
          const { origin, xAxis, normal } = p.plane;
          const y = cross(normal, xAxis);
          at = [0, 1, 2].map((k) => origin[k] + xy[0] * xAxis[k] + xy[1] * y[k]) as Vec3;
        }
        return { sketch: s.id, point: pin.point, kind: pin.kind, name: pin.name, ...(pin.feature !== undefined ? { feature: pin.feature } : {}), at };
      }),
    );
    return { got: { bodies, sketches, pins, trouble }, ms };
  } finally {
    await cache.clear();
  }
}

test("every golden model has its expectation, and runs unless the step it needs is still to come", () => {
  const runs = plan(expects(), projectFiles());
  assert.ok(runs.filter((r) => r.run === "build").length >= 6, "the six models today's app builds");
});

test("each golden model rebuilds to its hand-worked answers through Design on the real kernel, and reads back the same after a save", async () => {
  const lines: string[] = [];
  for (const want of expects()) {
    if (want.from !== undefined && plan([want], projectFiles().filter((f) => f === want.model))[0].run === "waits") continue;
    const doc = designOf(want.model);
    const { got, ms } = await measure(doc);
    assert.deepEqual(compare(want, got), [], want.model);
    // Saved and opened again: the same document (what a user's save and reopen does to it).
    const again = projectFromJson(projectToJson(open(want.model)), [designWorkspace]).workspaces.design;
    assert.deepEqual(again, doc, `${want.model}: a save and reopen changed it`);
    lines.push(`${want.model}: ${got.bodies.length} bodies, rebuilt in ${ms.toFixed(0)} ms`);
  }
  console.log(lines.join("\n"));
  assert.equal(await kernel.call("body_count"), 0, "every body built was freed");
});

test("the runner reads every tolerance the kernel's view carries (step 31 adds them; until then a body that validates carries LINEAR)", async () => {
  const view = (await kernel.call("make_box", 1, 1, 1)) as BodyView;
  assert.deepEqual(Object.keys(view).filter((k) => /tol/i.test(k)), [], "the view now carries tolerances: make bodyTolerance read them, and this list");
  assert.equal(bodyTolerance(view), LINEAR);
  assert.equal(bodyTolerance({ errors: ["vertex 7 is 0.5 mm off edge 3"] }), Infinity, "a body that fails validation carries no tolerance it can be held to");
});

/** A copy of the model's expectation with one change. */
const planted = (model: string, change: (e: GoldenExpect) => void): GoldenExpect => {
  const e = structuredClone(expects().find((x) => x.model === model)!);
  change(e);
  return e;
};

test("a planted wrong expectation fails: a volume a millionth out, a face's name, a tolerance tighter than the body carries", async () => {
  const { got } = await measure(designOf("stepped-boss"));
  const volume = planted("stepped-boss", (e) => (e.bodies[1].volume.is = `(${e.bodies[1].volume.is}) * (1 + 1e-6)`));
  assert.match(compare(volume, got).join("\n"), /^Body 2 \(feature-5\): volume /m);
  const name = planted("stepped-boss", (e) => (e.sketches[1].face = "face:feature-5/start"));
  assert.match(compare(name, got).join("\n"), /^sketch-6: on the face named face:feature-5\/end, not face:feature-5\/start$/m);
  // Half of LINEAR: today every entity carries LINEAR, so a model saying it may carry only half is wrong.
  const tolerance = planted("stepped-boss", (e) => (e.bodies[0].tolerance.is = "1e-5 / 2"));
  assert.match(compare(tolerance, got).join("\n"), /^Body 1 \(feature-1\): carries a tolerance of 0\.00001 mm, more than the 0\.000005 it may$/m);
  // A pin's name, and where the point lands.
  const pin = planted("stepped-boss", (e) => (e.pins[0].name = "end+side:circle-3"));
  assert.match(compare(pin, got).join("\n"), /^sketch-6\/point-7: pinned to centre end\+side:circle-4, not centre end\+side:circle-3$/m);
});

/** The real kernel with one bug planted in its views (as body-store.journey.ts plants them), the rest of its answers untouched. */
function plantedKernel(bug: (view: BodyView) => BodyView): KernelCalls {
  return {
    call: (async (op: string, ...args: unknown[]) => {
      const out = await (kernel.call as (op: string, ...a: unknown[]) => Promise<unknown>)(op, ...args);
      return op === "body_view" ? bug(structuredClone(out as BodyView)) : out;
    }) as KernelCalls["call"],
  };
}

test("bugs planted in the kernel's answers are caught on the real models", async () => {
  const caught = async (model: string, bug: (v: BodyView) => BodyView, pattern: RegExp) => {
    const want = expects().find((e) => e.model === model)!;
    const { got } = await measure(designOf(model), plantedKernel(bug));
    assert.match(compare(want, got).join("\n"), pattern, model);
  };
  // A volume a millionth too big.
  await caught("l-bracket", (v) => ({ ...v, volume: v.volume * (1 + 1e-6) }), /^Body 1 \(feature-15\): volume /m);
  // One corner lifted 2 LINEAR off the faces it bounds (validation in the kernel didn't see it: the view says no errors).
  await caught("l-bracket", (v) => ({ ...v, vertex_points: v.vertex_points.map((p, i) => (i === 0 ? [p[0], p[1], p[2] + 2 * LINEAR] : p)) as BodyView["vertex_points"] }), /off a flat face it bounds/);
  // A box from the corners only, missing how far a circle reaches between them: the boss's only corners are its seams at x = 40.
  // (The gear can't catch this one: its tips start at 0, π/2, π and 3π/2, corners on every side of its box.)
  await caught("stepped-boss", (v) => {
    const lo = [0, 1, 2].map((k) => Math.min(...v.vertex_points.map((p) => p[k])));
    const hi = [0, 1, 2].map((k) => Math.max(...v.vertex_points.map((p) => p[k])));
    return { ...v, bounds: [lo, hi] as BodyView["bounds"] };
  }, /^Body 2 \(feature-5\): box \(40, 20, 10\) to \(40, 20, 18\), not \(20, 10, 10\) to \(40, 30, 18\)$/m);
  // A face's normal turned round: the sketch on the plate's top is placed facing down.
  await caught("stepped-boss", (v) => ({ ...v, face_normals: v.face_normals.map((n) => (n && n[2] === 1 ? [0, 0, -1] : n)) as BodyView["face_normals"] }), /sketch-2: face:feature-1\/top faces \(0, 0, -1\)/);
  // A validation error the kernel reports.
  await caught("bracket-two-holes", (v) => ({ ...v, errors: ["edge 3 is 1e-4 mm off face 2"] }), /fails validation: edge 3/);
});
