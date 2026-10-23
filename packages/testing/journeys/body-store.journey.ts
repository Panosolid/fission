// The kernel's body store and structured errors, on the real WASM kernel
// (the design step before the timeline rebuild, 24d): a body is built and
// kept, read back by its handle exactly as the one-shot calls give it, and
// freed; a freed or malformed handle is refused with its kind; every
// refusal says which input is at fault. Then seeded sessions of builds,
// views and frees against a simple model, and each planted bug in the
// kernel's answers caught by the session check. Run with `npm run journeys`
// after the app build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { KernelError, type BodyHandle, type BodySpec, type BodyView, type Frame, type KernelCalls, type KernelInput } from "@fission/core";
import { nodeKernel } from "../src/node-kernel.ts";
import { seeded, type SeededRandom } from "../src/index.ts";

const close = (a: number, b: number) => Math.abs(a - b) <= 1e-12 * Math.abs(b);

/** A STEP file's corners, each VERTEX_POINT's CARTESIAN_POINT as "x,y,z", sorted. */
function stepCorners(step: string): string[] {
  const points = new Map<string, string>();
  for (const m of step.matchAll(/^(#\d+) = CARTESIAN_POINT\('',\(([^()]+)\)\);$/gm)) points.set(m[1], m[2].split(",").map(Number).join(","));
  return [...step.matchAll(/^#\d+ = VERTEX_POINT\('',(#\d+)\);$/gm)].map((m) => points.get(m[1]) ?? "missing").sort();
}

/** The KernelError a call rejects with (fails if it resolves or throws anything else). */
async function refusal(call: Promise<unknown>): Promise<KernelError> {
  try {
    await call;
  } catch (e) {
    assert.ok(e instanceof KernelError, `not a KernelError: ${e}`);
    return e;
  }
  assert.fail("the call was accepted");
}

test("a stored 40 × 30 × 20 box gives hand-worked numbers, the same view and STL as the one-shot calls, until freed", async () => {
  const kernel = nodeKernel();
  const before = await kernel.call("body_count");
  const spec: BodySpec = { box: { width: 40, depth: 30, height: 20 } };
  const box = await kernel.call("body_build", spec);
  assert.equal(await kernel.call("body_count"), before + 1);
  // 40·30·20 = 24000 mm³; area 2(40·30 + 40·20 + 30·20) = 5200 mm².
  const view = await kernel.call("body_view", box);
  assert.ok(close(view.volume, 24000) && close(view.area, 5200), `${view.volume} ${view.area}`);
  assert.deepEqual(view, await kernel.call("make_box", 40, 30, 20));
  const stl = await kernel.call("body_stl", box, "part");
  assert.deepEqual(stl, await kernel.call("export_stl", spec, "part"));
  // Its STEP file (step 29b3): make_box's box runs from (0, 0, 0) to
  // (40, 30, 20), so its eight VERTEX_POINTs are every corner
  // {0, 40} × {0, 30} × {0, 20}, and it has six faces.
  const step = await kernel.call("body_step", box);
  assert.deepEqual(stepCorners(step), [0, 40].flatMap((x) => [0, 30].flatMap((y) => [0, 20].map((z) => `${x},${y},${z}`))).sort());
  assert.equal(step.match(/= ADVANCED_FACE\(/g)?.length, 6);
  await kernel.call("body_free", box);
  assert.equal(await kernel.call("body_count"), before);
  // Gone for good: refused by name, and so is a second free.
  const gone = await refusal(kernel.call("body_view", box));
  assert.equal(gone.kind, "unknown-body");
  assert.deepEqual(gone.inputs, [{ input: "param", name: "body" }]);
  assert.equal(gone.message, `body ${box} is not in the kernel (it was freed, or never made)`);
  assert.equal((await refusal(kernel.call("body_free", box))).kind, "unknown-body");
  assert.equal((await refusal(kernel.call("body_step", box))).kind, "unknown-body");
  // The next body never gets that handle again.
  const next = await kernel.call("body_build", spec);
  assert.ok(next > box);
  await kernel.call("body_free", next);
});

test("handles that aren't whole numbers from 1 are the app's bug, never rounded onto another body", async () => {
  const kernel = nodeKernel();
  const kept = await kernel.call("body_build", { sphere: { radius: 2 } });
  for (const bad of [0, -1, kept + 0.5, kept - 0.5, Number.NaN, Infinity, 2 ** 53]) {
    const e = await refusal(kernel.call("body_view", bad));
    assert.equal(e.kind, "bad-request", `${bad}`);
    assert.deepEqual(e.inputs, [{ input: "param", name: "body" }]);
  }
  // 4πr³/3 with r = 2: 32π/3, untouched by the refusals.
  assert.ok(close((await kernel.call("body_view", kept)).volume, (32 * Math.PI) / 3));
  await kernel.call("body_free", kept);
});

test("every refusal says which input is at fault, with the message the app always showed", async () => {
  const kernel = nodeKernel();
  const width = await refusal(kernel.call("make_box", -1, 30, 20));
  assert.equal(width.kind, "invalid-input");
  assert.deepEqual(width.inputs, [{ input: "param", name: "width" }]);
  assert.equal(width.message, "width must be between 0.001 and 1000000 mm, got -1");
  const distance = await refusal(kernel.call("body_build", { extrude: { profile: { outer: { circle: { center: [0, 0], radius: 3 } }, holes: [] }, distance: 0 } }));
  assert.deepEqual(distance.inputs, [{ input: "param", name: "distance" }]);
  // A hole whose left side is 0.9 µm (0.9 × the smallest feature) from the
  // outer square's: the outer square's piece 3 (from (0, 10) down to
  // (0, 0)) and the hole's piece 0 (from (g, 1) up to (g, 5)).
  const g = 0.0009;
  const square = [0, 0, 10, 0, 10, 10, 0, 10];
  const hole = [g, 1, g, 5, g + 4, 5, g + 4, 1];
  const near = await refusal(kernel.call("make_extrude", { outer: { path: { corners: square, bulges: [] } }, holes: [{ path: { corners: hole, bulges: [] } }] }, 5));
  const pieces: KernelInput[] = [
    { input: "piece", boundary: 0, piece: 3 },
    { input: "piece", boundary: 1, piece: 0 },
  ];
  assert.deepEqual([near.kind, near.inputs], ["invalid-input", pieces]);
  // The second line drawn ("line 2" to a person) is index 1.
  const line = await refusal(kernel.call("sketch_outline", [{ a: [0, 0], b: [1, 0] }, { a: [1, 0], b: [1, 0] }], [], []));
  assert.deepEqual(line.inputs, [{ input: "line", index: 1 }]);
  assert.match(line.message, /^line 2 must be/);
  // An argument of the wrong form is a bad request naming it.
  const form = await refusal(kernel.call("make_extrude", "nonsense" as never, 5));
  assert.deepEqual([form.kind, form.inputs], ["bad-request", [{ input: "param", name: "profile" }]]);
  assert.match(form.message, /^bad profile: /);
});

/** One body the session model expects: its spec's volume by formula. */
type Expected = { handle: BodyHandle; volume: number };

/** A random spec with whole-mm sizes and its volume by formula (box w·d·h, cylinder πr²h, sphere 4πr³/3, rectangle extruded w·d·h). */
function randomSpec(r: SeededRandom): { spec: BodySpec; volume: number } {
  const size = () => 1 + Math.floor(r.next() * 40);
  const kind = Math.floor(r.next() * 4);
  const [a, b, c] = [size(), size(), size()];
  if (kind === 0) return { spec: { box: { width: a, depth: b, height: c } }, volume: a * b * c };
  if (kind === 1) return { spec: { cylinder: { radius: a, height: b } }, volume: Math.PI * a * a * b };
  if (kind === 2) return { spec: { sphere: { radius: a } }, volume: (4 * Math.PI * a * a * a) / 3 };
  const corners = [0, 0, a, 0, a, b, 0, b];
  return { spec: { extrude: { profile: { outer: { path: { corners, bulges: [] } }, holes: [] }, distance: c } }, volume: a * b * c };
}

/**
 * A seeded session of builds, views and frees, each answer checked against
 * the model (live handles with their volumes); at the end every body is
 * freed and the kernel must hold what it held before. Returns the first
 * disagreement, or null.
 */
async function session(kernel: KernelCalls, seed: bigint, steps: number): Promise<string | null> {
  const r = seeded(seed);
  const start = await kernel.call("body_count");
  const live: Expected[] = [];
  const freed: BodyHandle[] = [];
  let last = 0;
  for (let step = 0; step < steps; step++) {
    const at = (m: string) => `seed ${seed}, step ${step}: ${m}`;
    const roll = r.next();
    if (roll < 0.45 || live.length === 0) {
      const { spec, volume } = randomSpec(r);
      const handle = await kernel.call("body_build", spec);
      if (!(handle > last) || freed.includes(handle)) return at(`handle ${handle} was handed out before`);
      last = handle;
      live.push({ handle, volume });
    } else if (roll < 0.7) {
      const { handle, volume } = live[Math.floor(r.next() * live.length)];
      const got = (await kernel.call("body_view", handle)).volume;
      if (!close(got, volume)) return at(`body ${handle} has volume ${got}, its spec ${volume}`);
    } else if (roll < 0.9) {
      const [{ handle }] = live.splice(Math.floor(r.next() * live.length), 1);
      await kernel.call("body_free", handle);
      freed.push(handle);
    } else if (freed.length > 0) {
      const handle = freed[Math.floor(r.next() * freed.length)];
      const e = await kernel.call("body_view", handle).then(
        () => null,
        (e: unknown) => e,
      );
      if (!(e instanceof KernelError && e.kind === "unknown-body")) return at(`freed body ${handle} was answered`);
    }
    const count = await kernel.call("body_count");
    if (count !== start + live.length) return at(`the kernel holds ${count - start} bodies, the model ${live.length}`);
  }
  for (const { handle } of live) await kernel.call("body_free", handle);
  const left = (await kernel.call("body_count")) - start;
  return left === 0 ? null : `seed ${seed}: ${left} bodies left after freeing every one`;
}

test("5 seeds × 60 steps of builds, views and frees agree with the model and leave nothing behind", async () => {
  const kernel = nodeKernel();
  for (let seed = 1n; seed <= 5n; seed++) assert.equal(await session(kernel, seed, 60), null);
});

test("each bug planted in the kernel's answers is caught by the session check", async () => {
  // A kernel whose answers are tampered with on the way out, one way per
  // fault; each must make some seed's session fail, else its passes prove
  // nothing.
  const real = nodeKernel();
  const faults: Record<string, (op: string, args: unknown[], call: () => Promise<unknown>) => Promise<unknown>> = {
    // free does nothing: bodies leak.
    "free leaks": (op, _args, call) => (op === "body_free" ? Promise.resolve(undefined) : call()),
    // view answers for the body made just before.
    "view off by one": (op, args, call) => (op === "body_view" && (args[0] as number) > 1 ? real.call("body_view", (args[0] as number) - 1).catch(call) : call()),
    // build hands back the previous handle.
    "handle reused": (op, _args, call) => (op === "body_build" ? call().then((h) => Math.max(1, (h as number) - 1)) : call()),
  };
  for (const [name, tamper] of Object.entries(faults)) {
    const faulty: KernelCalls = { call: ((op: never, ...args: never[]) => tamper(op, args, () => real.call(op, ...args))) as KernelCalls["call"] };
    let caught = false;
    for (let seed = 1n; seed <= 5n && !caught; seed++) caught = (await session(faulty, seed, 60).catch((e) => String(e))) !== null;
    assert.ok(caught, `${name} went unnoticed`);
  }
});

test("an extrude on the front plane (step 26b), through the real kernel: hand-worked faces, flipped, refused frames, and no frame as before", async () => {
  const kernel = nodeKernel();
  const before = await kernel.call("body_count");
  const profile = { outer: { path: { corners: [0, 0, 40, 0, 40, 30, 0, 30], bulges: [] } }, holes: [], pieces: [] };
  const front: Frame = { origin: [0, 0, 0], x: [1, 0, 0], normal: [0, -1, 0] };
  const near = (a: readonly number[], b: readonly number[]) => a.every((v, k) => Math.abs(v - b[k]) <= 1e-9);
  const face = (view: BodyView, role: string, piece?: number) => view.face_roles.findIndex((r) => r?.role === role && (piece === undefined || (r.role === "side" && r.piece === piece)));
  // Front plane: sketch (u, v) is world (u, 0, v), the normal −Y, so local
  // (u, v, w) → (u, −w, v). The 40 × 30 rectangle extruded 20 spans x 0..40,
  // y −20..0, z 0..30: 24000 mm³. Its start cap is on the sketch plane
  // (y = 0) facing +Y, centroid (20, 0, 15); its end cap y = −20 facing −Y;
  // the side from (0, 0) → (40, 0) is the bottom, z = 0, facing −Z, centroid
  // (20, −10, 0).
  const h = await kernel.call("body_build", { extrude: { profile, distance: 20, frame: front } });
  const v = await kernel.call("body_view", h);
  assert.ok(close(v.volume, 24000) && close(v.area, 5200), `${v.volume} ${v.area}`);
  for (const [role, piece, centroid, normal] of [
    ["start", undefined, [20, 0, 15], [0, 1, 0]],
    ["end", undefined, [20, -20, 15], [0, -1, 0]],
    ["side", 0, [20, -10, 0], [0, 0, -1]],
  ] as const) {
    const f = face(v, role, piece);
    assert.ok(near(v.face_centroids[f], centroid), `${role} ${piece}: ${v.face_centroids[f]}`);
    assert.ok(near(v.face_normals[f]!, normal), `${role} ${piece}: ${v.face_normals[f]}`);
  }
  // The stored body and the one-shot export agree on the STL, which is placed.
  const spec: BodySpec = { extrude: { profile, distance: 20, frame: front } };
  assert.deepEqual(await kernel.call("body_stl", h, "front"), await kernel.call("export_stl", spec, "front"));
  // Flipped, it goes away from the viewer (y 0..20), the start cap still on the plane, now facing −Y.
  const down = await kernel.call("body_build", { extrude: { profile, distance: 20, frame: front, flip: true } });
  const flipped = await kernel.call("body_view", down);
  const start = face(flipped, "start");
  assert.ok(near(flipped.face_centroids[start], [20, 0, 15]) && near(flipped.face_normals[start]!, [0, -1, 0]), `${flipped.face_normals[start]}`);
  assert.ok(near(flipped.face_centroids[face(flipped, "end")], [20, 20, 15]));
  // No frame is the XY plane going up, exactly as before frames: make_extrude's view, bit for bit.
  const plain = await kernel.call("body_build", { extrude: { profile, distance: 20 } });
  assert.deepEqual(await kernel.call("body_view", plain), await kernel.call("make_extrude", profile, 20));
  // A bad frame is the app's to fix, refused with the parts at fault named.
  const parallel = await refusal(kernel.call("body_build", { extrude: { profile, distance: 20, frame: { origin: [0, 0, 0], x: [1, 0, 0], normal: [1, 0, 0] } } }));
  assert.equal(parallel.kind, "invalid-input");
  assert.deepEqual(parallel.inputs, [{ input: "param", name: "x" }, { input: "param", name: "normal" }]);
  const long = await refusal(kernel.call("body_build", { extrude: { profile, distance: 20, frame: { ...front, normal: [0, -2, 0] } } }));
  assert.deepEqual(long.inputs, [{ input: "param", name: "normal" }]);
  // Anything not a frame at all is a bad request, as a malformed spec always was.
  const malformed = await refusal(kernel.call("body_build", { extrude: { profile, distance: 20, frame: { origin: [0, 0] } } } as unknown as BodySpec));
  assert.equal(malformed.kind, "bad-request");
  assert.equal(await kernel.call("body_count"), before + 3, "only the three good builds are kept");
  for (const body of [h, down, plain]) await kernel.call("body_free", body);
  assert.equal(await kernel.call("body_count"), before);
});
