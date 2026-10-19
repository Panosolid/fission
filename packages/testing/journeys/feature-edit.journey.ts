// Journey: editing an earlier feature from its timeline item (step 25a2) on
// the real WASM kernel. "Edit feature" opens the item's sizes; OK makes
// them the item's (`editFeature`), the kernel checks them (`refusedSizes`)
// and only an edit it takes is recorded, as one undo step; the rebuild then
// builds that item again and reuses every other body. Hand-worked volumes
// (the box's height edited under a later extrude, then the extrude's
// distance), the kernel's size limits at 0.9× and 1.1×, an extrude whose
// sketch is open, an edit that breaks a body for another reason, and 6
// seeds × 60 steps of random edits, refusals, suppressions, marker moves,
// undo and redo against a plain model of sizes and closed-form volumes,
// with the body_build count of each edit. Run with `npm run journeys`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHistory, type KernelCalls } from "@fission/core";
import {
  addSketch,
  BodyCache,
  deleteCurve,
  drawRectangle,
  editableFeature,
  editFeature,
  editStep,
  extrudeSketch,
  insertPreset,
  moveMarker,
  partDocument,
  rebuildTimeline,
  refusedSizes,
  suppressItem,
  type DesignDocument,
  type PartSizes,
} from "@fission/design";
import { nodeKernel } from "../src/node-kernel.ts";

const kernel = nodeKernel();
const close = (got: number, want: number) => Math.abs(got - want) <= 1e-9 * Math.max(1, Math.abs(want));

/** The starting box (feature-1, 40 × 30 × 20), Sketch 1 (sketch-2, a 40 × 30 rectangle from the origin) and Extrude 1 of it by 10 (feature-11). */
function part() {
  const s = addSketch(partDocument("box", 40, 30, 20));
  const rect = drawRectangle(s.doc, s.id, [0, 0], [40, 30]);
  const made = extrudeSketch(rect.doc, s.id, 10);
  return { doc: made.doc, sketch: s.id, extrude: made.id, lines: rect.ids };
}

/** A rebuild on a cache counting its body_build calls: each item's volume or status. */
function rebuilder() {
  let built = 0;
  const counted: KernelCalls = {
    call: ((op: string, ...args: unknown[]) => {
      if (op === "body_build") built++;
      return (kernel.call as (op: string, ...a: unknown[]) => Promise<unknown>)(op, ...args);
    }) as KernelCalls["call"],
  };
  const cache = new BodyCache(counted);
  return {
    async rebuild(doc: DesignDocument): Promise<{ volumes: Record<string, number | string>; builds: number }> {
      const from = built;
      const { order, results } = await rebuildTimeline(doc, cache, counted);
      const volumes: Record<string, number | string> = {};
      for (const id of order) {
        const r = results[id];
        volumes[id] = r.status === "built" && r.body !== undefined ? (await cache.view(r.body)).volume : r.status;
      }
      return { volumes, builds: built - from };
    },
    close: () => cache.clear(),
  };
}

/** What the app's OK does: the edit, refused with the kernel's words or the document to record. */
async function ok(doc: DesignDocument, id: string, sizes: PartSizes): Promise<{ refused: string } | { next: DesignDocument }> {
  const next = editFeature(doc, id, sizes);
  if (next === doc) return { next };
  const refused = await refusedSizes(kernel, doc, next, id);
  return refused === null ? { next } : { refused };
}

test("hand-worked: the box's height edited under Extrude 1, then Extrude 1's distance; each one undo step, rebuilding only the item edited", async () => {
  const start = await kernel.call("body_count");
  const { doc, extrude } = part();
  const r = rebuilder();
  try {
    const first = await r.rebuild(doc);
    // The box 40 · 30 · 20 = 24000 mm³; Extrude 1, the 40 × 30 rectangle by 10: 12000 mm³. Two bodies built.
    assert.deepEqual(first.volumes, { "feature-1": 24000, "sketch-2": "built", [extrude]: 12000 });
    assert.equal(first.builds, 2);

    let state = JSON.stringify(doc);
    const history = createHistory({ capture: () => state, restore: (s) => (state = s) });
    const record = (step: string, next: DesignDocument) => {
      state = JSON.stringify(next);
      history.record(step);
    };

    // The box made 35 high: 40 · 30 · 35 = 42000 mm³. Extrude 1 is untouched (same spec, reused): one body built.
    assert.deepEqual(editableFeature(doc, "feature-1"), { id: "feature-1", name: "Feature 1 (box)", shape: "box", sizes: { width: 40, depth: 30, height: 20 }, keys: ["width", "depth", "height"] });
    const a = await ok(doc, "feature-1", { height: 35 });
    assert.ok("next" in a);
    assert.equal(editStep(doc, "feature-1"), "Edit Feature 1 (box)");
    record(editStep(doc, "feature-1"), a.next);
    // Only the box's intent changed; every other item is the same object.
    a.next.timeline.features.forEach((f, i) => (f.id === "feature-1" ? assert.notEqual(f, doc.timeline.features[i]) : assert.equal(f, doc.timeline.features[i])));
    assert.deepEqual(a.next.timeline.features[0].intent.parameters, { width: 40, depth: 30, height: 35 });
    const second = await r.rebuild(a.next);
    assert.deepEqual(second.volumes, { "feature-1": 42000, "sketch-2": "built", [extrude]: 12000 });
    assert.equal(second.builds, 1, "only the box is built again");

    // Extrude 1 made 25: 40 · 30 · 25 = 30000 mm³; the box stays 42000.
    assert.deepEqual(editableFeature(a.next, extrude).sizes, { height: 10 });
    const b = await ok(a.next, extrude, { height: 25 });
    assert.ok("next" in b);
    assert.equal(editStep(a.next, extrude), "Edit Extrude 1");
    record(editStep(a.next, extrude), b.next);
    assert.equal(b.next.timeline.features[2].intent.summary, "Extrude Sketch 1 by 25 mm");
    const third = await r.rebuild(b.next);
    assert.deepEqual(third.volumes, { "feature-1": 42000, "sketch-2": "built", [extrude]: 30000 });
    assert.equal(third.builds, 1);

    // One Undo per edit, back to the start byte for byte; Redo forward again.
    history.undo();
    assert.equal(state, JSON.stringify(a.next));
    history.undo();
    assert.equal(state, JSON.stringify(doc));
    assert.deepEqual((await r.rebuild(JSON.parse(state))).volumes, first.volumes);
    history.redo();
    history.redo();
    assert.equal(state, JSON.stringify(b.next));

    // Typing the sizes it already has records nothing.
    const same = await ok(b.next, extrude, { height: 25 });
    assert.ok("next" in same && same.next === b.next);
  } finally {
    await r.close();
  }
  assert.equal(await kernel.call("body_count"), start, "every body freed");
});

test("the kernel's size limits, 1 µm to 1 km, at 0.9× and 1.1×: refused with the kernel's words naming the size, nothing recorded", async () => {
  const { doc, extrude } = part();
  // MIN_FEATURE = 1e-3 mm and MAX_SIZE = 1e6 mm (kernel/src/tolerance.rs).
  for (const [id, key, word] of [["feature-1", "height", "height"], [extrude, "height", "extrude distance"]] as const) {
    for (const [v, takes] of [[0.9e-3, false], [1.1e-3, true], [0.9e6, true], [1.1e6, false], [0, false], [-5, false]] as const) {
      const r = await ok(doc, id, { [key]: v });
      if (takes) assert.ok("next" in r && r.next !== doc, `${id} ${key} ${v} is taken`);
      else {
        assert.ok("refused" in r, `${id} ${key} ${v} is refused`);
        assert.match(r.refused, new RegExp(`^${word} must be between 0.001 and 1000000 mm, got ${v}`));
      }
    }
  }
  // Not a number at all never reaches the kernel: editFeature refuses it.
  assert.throws(() => editFeature(doc, "feature-1", { width: Number.NaN }), /Feature 1 \(box\): its width must be a number of mm, not NaN/);
  assert.throws(() => editFeature(doc, extrude, { height: Infinity }), /Extrude 1: its height must be a number of mm, not Infinity/);
  // A sketch has no sizes (25a3 reopens it); an unknown item is named.
  assert.throws(() => editableFeature(doc, "sketch-2"), /Sketch 1 is a sketch: it has no sizes to edit/);
  assert.throws(() => editFeature(doc, "feature-99", { height: 5 }), /there is no item feature-99 in the timeline/);
});

test("an extrude whose sketch is open (failed) takes a new distance, still failing for its sketch; a distance out of range is still refused", async () => {
  const p = part();
  // The rectangle's right side deleted: Sketch 1 is open and Extrude 1 fails.
  const open = deleteCurve(p.doc, p.sketch, p.lines[1]);
  const r = rebuilder();
  try {
    assert.equal((await r.rebuild(open)).volumes[p.extrude], "failed");
    const taken = await ok(open, p.extrude, { height: 25 });
    assert.ok("next" in taken && taken.next !== open);
    assert.equal((await r.rebuild(taken.next)).volumes[p.extrude], "failed");
    // Judged on the 10 mm stand-in square: 0 is refused by the distance's own check.
    const zero = await ok(open, p.extrude, { height: 0 });
    assert.ok("refused" in zero);
    assert.match(zero.refused, /^extrude distance must be between/);
  } finally {
    await r.close();
  }
});

test("an edit that breaks a body for a reason other than one size is refused when the body built before, taken when it already failed", async () => {
  // A slot preset w × d has half-circle ends of radius d/2: 40 × 10 builds; 6 × 10 (w < d) crosses itself, refused for its outline, not a size.
  const slot = insertPreset(partDocument("box", 40, 30, 20), "slot", 40, 10, 5);
  const broken = await ok(slot.doc, slot.id, { width: 6 });
  assert.ok("refused" in broken, "a slot narrower than it is deep");
  // The same slot, already broken in the data (a file written that way), takes an edit that leaves it broken.
  const already = insertPreset(partDocument("box", 40, 30, 20), "slot", 6, 10, 5);
  const still = await ok(already.doc, already.id, { height: 7 });
  assert.ok("next" in still && still.next !== already.doc);
  // And one that mends it builds.
  const mended = await ok(already.doc, already.id, { width: 40 });
  assert.ok("next" in mended);
});

/** A plain model: each solid item's kind and sizes, and the timeline's flags. */
type MItem = { id: string; kind: "box" | "cylinder" | "sphere" | "plate" | "extrude"; sizes: Required<PartSizes>; suppressed: boolean };
const volume = (i: MItem) => {
  const { width: w, depth: d, height: h } = i.sizes;
  if (i.kind === "box") return w * d * h;
  if (i.kind === "cylinder") return Math.PI * (w / 2) ** 2 * h;
  if (i.kind === "sphere") return (4 / 3) * Math.PI * (w / 2) ** 3;
  // A plate: the rectangle less its two holes of radius 0.15 · min(w, d) (profiles.ts).
  if (i.kind === "plate") return (w * d - 2 * Math.PI * (0.15 * Math.min(w, d)) ** 2) * h;
  // Extrude 1 of the 40 × 30 rectangle.
  return 40 * 30 * h;
};
const keysOf = (k: MItem["kind"]): ("width" | "depth" | "height")[] => (k === "sphere" ? ["width"] : k === "cylinder" ? ["width", "height"] : k === "extrude" ? ["height"] : ["width", "depth", "height"]);
/** The kernel's own range for every size (tolerance.rs); a random session keeps its valid sizes 1 to 500 mm, where nothing else can fail. */
const inRange = (v: number) => Number.isFinite(v) && v >= 1e-3 && v <= 1e6;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("seeded: 6 sessions × 60 steps of edits (some refused), suppress, the marker, undo and redo against a plain model of sizes and volumes", async () => {
  const start = await kernel.call("body_count");
  for (let seed = 1; seed <= 6; seed++) {
    const rand = rng(seed);
    const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
    // The box, Sketch 1 and Extrude 1, then a cylinder, a sphere and a plate.
    let doc = part().doc;
    let model: MItem[] = [
      { id: "feature-1", kind: "box", sizes: { width: 40, depth: 30, height: 20 }, suppressed: false },
      { id: "feature-11", kind: "extrude", sizes: { width: 0, depth: 0, height: 10 }, suppressed: false },
    ];
    for (const [kind, w, d, h] of [["cylinder", 20, 20, 30], ["sphere", 12, 12, 12], ["plate", 60, 20, 4]] as const) {
      const p = insertPreset(doc, kind, w, d, h);
      doc = p.doc;
      model.push({ id: p.id, kind, sizes: { width: w, depth: d, height: h }, suppressed: false });
    }
    let marker: string | null = null;
    const undo: [DesignDocument, MItem[], string | null][] = [];
    const redo: [DesignDocument, MItem[], string | null][] = [];
    const r = rebuilder();
    const where = (step: number) => `seed ${seed} step ${step}`;
    const builtIds = () => {
      const order = doc.timeline.features.map((f) => f.id);
      const end = marker === null ? order.length : marker === "start" ? 0 : order.indexOf(marker) + 1;
      return new Set(model.filter((i) => !i.suppressed && order.indexOf(i.id) < end).map((i) => i.id));
    };
    try {
      await r.rebuild(doc);
      let refusals = 0;
      let taken = 0;
      for (let step = 0; step < 60; step++) {
        const roll = rand();
        let builds: number | null = null;
        if (roll < 0.6) {
          const item = pick(model);
          const key = pick(keysOf(item.kind));
          const v = rand() < 0.25 ? pick([0, -3, 0.9e-3, 1.1e6, 2e6]) : Math.round(1 + rand() * 499);
          const now = editableFeature(doc, item.id);
          assert.deepEqual(now.keys, keysOf(item.kind), where(step));
          const got = await ok(doc, item.id, { [key]: v });
          const changes = item.sizes[key] !== v;
          // The kernel judges a round shape's radius (half the diameter typed), every other size as typed.
          if (!inRange(item.kind !== "box" && item.kind !== "plate" && item.kind !== "extrude" && key === "width" ? v / 2 : v)) {
            assert.ok("refused" in got, `${where(step)}: ${item.id} ${key} ${v} should be refused`);
            refusals++;
            continue;
          }
          assert.ok("next" in got, `${where(step)}: ${item.id} ${key} ${v} refused: ${"refused" in got ? got.refused : ""}`);
          if (!changes) {
            assert.equal(got.next, doc, `${where(step)}: an edit to the same size records nothing`);
            continue;
          }
          undo.push([doc, model, marker]);
          redo.length = 0;
          const sizes = { ...item.sizes, [key]: v };
          // The shape's own rule: a sphere's three sizes are its diameter, a cylinder's depth is its diameter.
          if (item.kind === "sphere") sizes.depth = sizes.height = v;
          if (item.kind === "cylinder" && key === "width") sizes.depth = v;
          const before = new Map(doc.timeline.features.map((f) => [f.id, f]));
          doc = got.next;
          model = model.map((i) => (i.id === item.id ? { ...i, sizes } : i));
          // Every other item is untouched, the same object.
          for (const f of doc.timeline.features) if (f.id !== item.id) assert.equal(f, before.get(f.id), `${where(step)}: editing ${item.id} changed ${f.id}`);
          // One body built when the item builds and no other built item has its spec; none otherwise.
          const spec = (i: MItem) => `${i.kind}:${keysOf(i.kind).map((k) => i.sizes[k]).join(",")}`;
          const shown = builtIds();
          const edited = model.find((i) => i.id === item.id)!;
          builds = shown.has(item.id) && !model.some((i) => i.id !== item.id && shown.has(i.id) && spec(i) === spec(edited)) ? 1 : 0;
          taken++;
        } else if (roll < 0.7) {
          const item = pick(model);
          undo.push([doc, model, marker]);
          redo.length = 0;
          doc = suppressItem(doc, item.id, !item.suppressed);
          model = model.map((i) => (i.id === item.id ? { ...i, suppressed: !i.suppressed } : i));
        } else if (roll < 0.8) {
          const to = pick([null, "start", ...doc.timeline.features.map((f) => f.id)]);
          if (to === marker || (to === doc.timeline.features.at(-1)?.id && marker === null)) continue;
          undo.push([doc, model, marker]);
          redo.length = 0;
          doc = moveMarker(doc, to);
          marker = doc.timeline.marker ?? null;
        } else {
          const [from, to] = roll < 0.9 ? [undo, redo] : [redo, undo];
          const back = from.pop();
          if (!back) continue;
          to.push([doc, model, marker]);
          [doc, model, marker] = back;
        }
        const { volumes, builds: made } = await r.rebuild(doc);
        if (builds !== null) assert.equal(made, builds, `${where(step)}: the edit built ${made} bodies`);
        const shown = builtIds();
        for (const i of model) {
          const got = volumes[i.id];
          if (!shown.has(i.id)) assert.equal(typeof got, "string", `${where(step)}: ${i.id} built though suppressed or rolled back`);
          else assert.ok(typeof got === "number" && Math.abs(got - volume(i)) <= 1e-9 * volume(i), `${where(step)}: ${i.id} volume ${got}, the model ${volume(i)}`);
        }
      }
      assert.ok(refusals > 0 && taken > 0, `seed ${seed}: ${refusals} refusals and ${taken} edits taken`);
    } finally {
      await r.close();
    }
  }
  assert.equal(await kernel.call("body_count"), start, "every body freed");
});
