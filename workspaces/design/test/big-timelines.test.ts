// Security re-check S2: past the reader, a big valid design still froze the
// tab, from searches repeated once per item (which items build, the
// browser's rows, each sketch's plane) and from the rebuild waiting a round
// trip to the kernel for every outline, body and view in turn. These check
// that each replacement answers exactly as before (against the old code
// path, kept as the model), in time in proportion to the timeline, and that
// the rebuild asks the kernel for everything at once and nothing extra.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { BodyHandle, Feature, KernelCalls } from "@fission/core";
import { buildingItems, builds, type DesignDocument } from "../src/document.ts";
import { bodyFeatures, browserTree, rowReference, rowReferences } from "../src/browser.ts";
import { BodyCache, rebuildTimeline } from "../src/rebuild.ts";
import { shownBodies } from "../src/scene.ts";

const item = (id: string, type: string, parameters: Record<string, unknown>, suppressed = false): Feature => ({
  id,
  intent: { type, parameters, summary: type },
  provenance: { self: { workspace: "design", id, label: id }, from: [] },
  dependsOn: typeof parameters.sketch === "string" ? [parameters.sketch] : [],
  suppressed,
});
/** A closed triangle, its ids from `n`, its legs `size` long. */
const triangle = (n: number, size = 10) => {
  const points = [0, 1, 2].map((k) => ({ id: `point-${n + k}`, x: [0, size, 0][k], y: [0, 0, size][k] }));
  return { points, curves: [0, 1, 2].map((k) => ({ id: `line-${n + 3 + k}`, kind: "line" as const, start: points[k].id, end: points[(k + 1) % 3].id })) };
};

test("buildingItems worked by hand: the marker, suppression, a lost sketch with and without a kept shape", () => {
  // Items: sketch-1, feature-2 (extrudes it), sketch-3 suppressed, feature-4 (extrudes sketch-3),
  // feature-5 (extrudes sketch-9, deleted, kept shape), feature-6 (extrudes sketch-8, deleted, none),
  // feature-7 a box, then the marker on feature-7, then feature-8 a box after it.
  const doc: DesignDocument = {
    version: 3,
    nextId: 30,
    profiles: [],
    sketches: [{ id: "sketch-1", ...triangle(10), constraints: [] }, { id: "sketch-3", ...triangle(20), constraints: [] }],
    kept: { "feature-5": triangle(40) },
    timeline: {
      features: [
        item("sketch-1", "sketch", { plane: "XY" }),
        item("feature-2", "extrude", { sketch: "sketch-1", distance: 1 }),
        item("sketch-3", "sketch", { plane: "XY" }, true),
        item("feature-4", "extrude", { sketch: "sketch-3", distance: 1 }),
        item("feature-5", "extrude", { sketch: "sketch-9", distance: 1 }),
        item("feature-6", "extrude", { sketch: "sketch-8", distance: 1 }),
        item("feature-7", "box", { width: 1, depth: 1, height: 1 }),
        item("feature-8", "box", { width: 1, depth: 1, height: 1 }),
      ],
      marker: "feature-7",
    },
  };
  // Builds: sketch-1 and its extrude; not sketch-3 (suppressed) nor feature-4 (its sketch suppressed);
  // feature-5 from its kept shape; not feature-6 (nothing kept); feature-7 at the marker; not feature-8 after it.
  const ids = (s: Set<Feature>) => [...s].map((f) => f.id).sort();
  assert.deepEqual(ids(buildingItems(doc)), ["feature-2", "feature-5", "feature-7", "sketch-1"]);
  assert.deepEqual(bodyFeatures(doc).map((f) => f.id), ["feature-2", "feature-5", "feature-7"]);
  assert.deepEqual(ids(buildingItems({ ...doc, timeline: { ...doc.timeline, marker: "start" } })), []);
  assert.deepEqual(ids(buildingItems({ ...doc, timeline: { ...doc.timeline, marker: "feature-99" } })), [], "a marker naming no item: as builds, none");
});

/** splitmix64: the same seed gives the same designs. */
function rng(seed: bigint) {
  let s = seed;
  const M = (1n << 64n) - 1n;
  return (n: number) => {
    s = (s + 0x9e3779b97f4a7c15n) & M;
    let z = s;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & M;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & M;
    return Number((z ^ (z >> 31n)) % BigInt(n));
  };
}

/** A random timeline of sketches, extrudes (of a sketch that may be gone, some with kept shapes) and boxes, some suppressed, with a random marker. */
function randomDesign(pick: (n: number) => number, length: number): DesignDocument {
  const features: Feature[] = [];
  const sketches: DesignDocument["sketches"] = [];
  const kept: NonNullable<DesignDocument["kept"]> = {};
  let n = 1;
  for (let i = 0; i < length; i++) {
    const id = n++;
    const kind = pick(3);
    if (kind === 0) {
      features.push(item(`sketch-${id}`, "sketch", { plane: "XY" }, pick(4) === 0));
      if (pick(5) !== 0) sketches.push({ id: `sketch-${id}`, points: [], curves: [], constraints: [] });
    } else if (kind === 1) {
      const target = `sketch-${1 + pick(Math.max(1, n))}`;
      features.push(item(`feature-${id}`, "extrude", { sketch: target, distance: 1 }, pick(4) === 0));
      if (pick(3) === 0) kept[`feature-${id}`] = { points: [], curves: [] };
    } else features.push(item(`feature-${id}`, "box", { width: 1, depth: 1, height: 1 }, pick(4) === 0));
  }
  const m = pick(5);
  const marker = m === 0 ? "start" : m === 1 ? undefined : m === 2 ? "feature-99999" : features[pick(features.length)]?.id;
  return { version: 3, nextId: n, profiles: [], sketches, kept, timeline: marker === undefined ? { features } : { features, marker } };
}

test("seeded random timelines: buildingItems is builds asked of every item, and the browser's rows agree", () => {
  let reached = 0;
  for (const seed of [1n, 2n, 3n, 0x5eedn, 0xdeadbeefn]) {
    const pick = rng(seed);
    for (let run = 0; run < 400; run++) {
      const doc = randomDesign(pick, 1 + pick(25));
      const model = new Set(doc.timeline.features.filter((f) => builds(doc, f)));
      assert.deepEqual([...buildingItems(doc)].map((f) => f.id).sort(), [...model].map((f) => f.id).sort(), `seed ${seed}, run ${run}`);
      reached += model.size;
      // The browser's rows, one way and the other.
      const refOf = rowReferences(doc);
      const rows = browserTree(doc).flatMap((g) => g.children ?? []).map((r) => r.id);
      for (const row of [...rows, "body-0", "body-999", "nothing"]) assert.deepEqual(refOf(row), rowReference(row, doc), `seed ${seed}, run ${run}, row ${row}`);
    }
  }
  assert.ok(reached > 2000, `${reached} building items`);
});

test("asked about a 5,000-item timeline, buildingItems and the browser's rows read each item a few times, not the timeline's length", () => {
  // Counts reads of the timeline's items through a proxy: the old code read
  // about 5,000² / 2 = 12.5 million items here; linear code a small multiple of 5,000.
  const doc = randomDesign(rng(7n), 5000);
  let reads = 0;
  const features = new Proxy(doc.timeline.features, {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) reads++;
      return Reflect.get(target, key, receiver);
    },
  });
  const counted = { ...doc, timeline: { ...doc.timeline, features } };
  buildingItems(counted);
  const tree = browserTree(counted);
  const refOf = rowReferences(counted);
  for (const g of tree) for (const r of g.children ?? []) refOf(r.id);
  assert.ok(reads < 20 * 5000, `${reads} reads for 5,000 items`);
});

/** A kernel that answers only after the test lets it, recording when each call came and how many were waiting at once. */
function heldKernel() {
  const calls: { op: string; args: unknown[] }[] = [];
  const waiting: (() => void)[] = [];
  let most = 0;
  let next = 1;
  const views = new Map<number, number>();
  const kernel = {
    call(op: string, ...args: unknown[]) {
      calls.push({ op, args });
      return new Promise((resolve) => {
        waiting.push(() => {
          if (op === "sketch_outline") resolve({ closed: { args } });
          else if (op === "body_build") resolve(next++);
          else if (op === "body_view") resolve({ volume: views.set(args[0] as number, 1) && 1, area: 1, mesh: { positions: [], normals: [], indices: [], triangle_faces: [], edge_lines: [], edge_line_edges: [] }, faces: [], edges: [], face_roles: [], edge_faces: [] });
          else resolve(undefined);
        });
        most = Math.max(most, waiting.length);
      });
    },
  } as unknown as KernelCalls;
  /** Answers everything waiting, again and again, until nothing is. */
  const answerAll = async () => {
    for (let i = 0; i < 10_000; i++) {
      await new Promise((r) => setImmediate(r));
      if (waiting.length === 0) return;
      for (const go of waiting.splice(0)) go();
    }
  };
  return { kernel, calls, answerAll, most: () => most, startCounting: () => void (most = 0) };
}

test("the rebuild asks for every outline and body at once, each once, and builds what it built before", async () => {
  // 40 boxes of different heights, and 20 sketches each extruded once; sketch 2k+1 holds the same
  // triangle as sketch 2k+0 (legs 10(k+1) long, its ids different), so there are 10 different
  // outlines, but 20 different bodies (distances differ).
  const features: Feature[] = [];
  const sketches: DesignDocument["sketches"] = [];
  for (let i = 0; i < 40; i++) features.push(item(`feature-${1000 + i}`, "box", { width: 1, depth: 1, height: 1 + i }));
  for (let i = 0; i < 20; i++) {
    sketches.push({ id: `sketch-${2000 + i}`, ...triangle(100 * i, 10 * (1 + Math.floor(i / 2))), constraints: [] });
    features.push(item(`sketch-${2000 + i}`, "sketch", { plane: "XY" }), item(`feature-${3000 + i}`, "extrude", { sketch: `sketch-${2000 + i}`, distance: 1 + i }));
  }
  const doc: DesignDocument = { version: 3, nextId: 5000, profiles: [], sketches, timeline: { features } };
  const k = heldKernel();
  const cache = new BodyCache(k.kernel);
  const done = rebuildTimeline(doc, cache, k.kernel);
  await k.answerAll();
  const build = await done;
  const count = (op: string) => k.calls.filter((c) => c.op === op).length;
  assert.equal(count("sketch_outline"), 10, "one per different outline");
  assert.equal(count("body_build"), 60, "40 boxes and 20 extrudes, each once");
  assert.ok(k.most() >= 40, `the 40 boxes and 10 outlines were asked before any answer came back (at most ${k.most()} waiting)`);
  assert.equal(Object.values(build.results).filter((r) => r.status === "built" && r.body !== undefined).length, 60);
  assert.equal(cache.size, 60);
  // The views, all asked at once too.
  const before = k.calls.length;
  k.startCounting();
  const shown = shownBodies(doc, build, cache);
  await k.answerAll();
  assert.equal((await shown).length, 60);
  assert.equal(k.calls.length - before, 60, "one view per body");
  assert.equal(k.most(), 60, "all 60 views asked before any answer came back");
});

test("a body asked twice before its answer is built once, and a refusal reaches both", async () => {
  let builds = 0;
  let fail = false;
  const kernel = {
    call: async (op: string) => {
      if (op !== "body_build") return undefined;
      builds++;
      await new Promise((r) => setImmediate(r));
      if (fail) throw new Error("width must be more than 0");
      return 7 as BodyHandle;
    },
  } as unknown as KernelCalls;
  const cache = new BodyCache(kernel);
  const spec = { box: { width: 1, depth: 1, height: 1 } };
  assert.deepEqual(await Promise.all([cache.body(spec), cache.body(spec)]), [7, 7]);
  assert.equal(builds, 1);
  assert.equal(await cache.body(spec), 7, "kept: no third build");
  assert.equal(builds, 1);
  fail = true;
  const bad = { box: { width: 0, depth: 1, height: 1 } };
  const both = await Promise.allSettled([cache.body(bad), cache.body(bad)]);
  assert.deepEqual(both.map((r) => r.status), ["rejected", "rejected"]);
  assert.equal(builds, 2, "one build for both");
  await assert.rejects(cache.body(bad), /width must be more than 0/, "a refusal isn't kept: asked again, asked again");
  assert.equal(builds, 3);
});

test("Design closing frees every body, those still being built too, and builds nothing more", async () => {
  // The rebuild asks for every body at once, so closing (a project opened, Start fresh) can come
  // with builds still unanswered: each must be freed when it lands, or the kernel keeps it for good.
  const k = heldKernel();
  const cache = new BodyCache(k.kernel);
  const early = cache.body({ box: { width: 1, depth: 1, height: 1 } });
  await k.answerAll(); // handle 1, kept
  assert.equal(await early, 1);
  const late = [2, 3].map((h) => cache.body({ box: { width: 1, depth: 1, height: h } }));
  const settled = Promise.allSettled(late);
  const closing = cache.close();
  await k.answerAll(); // frees 1; the two late builds land as handles 2 and 3
  await closing;
  for (const r of await settled) assert.match(r.status === "rejected" ? String(r.reason) : "built", /Design was closed/);
  const frees = k.calls.filter((c) => c.op === "body_free").map((c) => c.args[0]).sort();
  assert.deepEqual(frees, [1, 2, 3], "the kept body and both late ones");
  assert.equal(cache.size, 0);
  const before = k.calls.length;
  await assert.rejects(cache.body({ box: { width: 9, depth: 9, height: 9 } }), /Design was closed/);
  assert.equal(k.calls.length, before, "nothing asked of the kernel once closed");
});
