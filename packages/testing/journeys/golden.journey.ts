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
import { projectFromJson, projectToJson, type BodyView, type KernelCalls } from "@fission/core";
import { designWorkspace, type DesignDocument } from "@fission/design";
import { bodyTolerance, compare, LINEAR, plan, type GoldenExpect } from "../src/golden.ts";
import { goldenDesign as designOf, goldenExpects as expects, goldenFiles as projectFiles, measureGolden, openGolden as open } from "../src/golden-rebuild.ts";
import { nodeKernel } from "../src/node-kernel.ts";

const kernel = nodeKernel();
const measure = (doc: DesignDocument, calls: KernelCalls = kernel) => measureGolden(doc, calls);

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
  // A void that isn't there (28a2's hollow box says 2).
  const shells = planted("stepped-boss", (e) => (e.bodies[0].topology.shells = 2));
  assert.match(compare(shells, got).join("\n"), /^Body 1 \(feature-1\): 1 shells, not 2$/m);
});

test("a refusal is checked on a real rebuild: the L bracket's extrude made 2 km long fails with the kernel's words", async () => {
  const doc = designOf("l-bracket");
  const extrude = doc.timeline.features.find((f) => f.id === "feature-15")!;
  extrude.intent.parameters.distance = 2e6;
  const { got } = await measure(doc);
  assert.deepEqual(got.bodies, [], "the only body failed");
  const want = (says: string[]): GoldenExpect => ({ ...expects().find((e) => e.model === "l-bracket")!, bodies: [], refused: [{ item: "feature-15", says, why: "2 km is past MAX_SIZE, 1 km" }] });
  assert.deepEqual(compare(want(["extrude distance", "1000000 mm"]), got), []);
  assert.match(compare(want(["1 µm"]), got).join("\n"), /^feature-15 failed, but its message ".*" doesn't say "1 µm"$/m);
  // And expecting a refusal of a model that builds fails.
  const { got: built } = await measure(designOf("l-bracket"));
  assert.match(compare({ ...expects().find((e) => e.model === "l-bracket")!, refused: [{ item: "feature-15", says: ["km"], why: "a test" }] }, built).join("\n"), /^feature-15 built, but must be refused: a test$/m);
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
  // The edges round the kernel's face 0 lost (each said used other than once each way): that face falls away from the rest, two shells.
  await caught("l-bracket", (v) => ({ ...v, edge_faces: v.edge_faces.map((pair) => (pair?.includes(0) ? null : pair)) }), /^Body 1 \(feature-15\): 2 shells, not 1$/m);
});
