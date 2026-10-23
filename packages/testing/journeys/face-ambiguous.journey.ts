// Ambiguous face names in Design's rebuild (26g's mutation testing found
// no test reached them: today only booleans, from step 34 on, can give two
// faces one name). On the real kernel, with its views read through a
// stand-in that renames a 40 × 30 × 20 box's back face "front", so two
// faces are "front" and the top's front and back edges are both
// "front+top":
//   - a sketch on the front: its plane is ambiguous, so it is held where
//     it was drawn (never put on either face) with the ambiguous words,
//     and its extrude says its source's plane is ambiguous;
//   - a sketch on the top (still one face, so found) with one circle
//     centred on the front edge's middle (now two edges' name:
//     "point-ambiguous") and one on the back right corner (its name is
//     gone: "point-lost"): both held, counted together, lost first, both
//     sentences in the warning;
//   - a settled design settled again is the same object;
//   - a body the kernel refuses fails with its words.
// Run with `npm run journeys`.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { BodyView, KernelCalls } from "@fission/core";
import { addFaceSketch, BodyCache, drawCircle, drawnFrame, extrudeSketch, facePlane, partDocument, pinNewPoints, rebuildTimeline, settleKept, type DesignDocument } from "@fission/design";
import { kernel } from "./design-app.ts";

/** The real kernel, its body views with every face whose role is "back" read as "front". */
const twoFronts: KernelCalls = {
  call: (async (op: string, ...args: unknown[]) => {
    const r = await (kernel.call as (op: string, ...args: unknown[]) => Promise<unknown>)(op, ...args);
    if (op !== "body_view") return r;
    const view = r as BodyView;
    return { ...view, face_roles: view.face_roles.map((f) => (f?.role === "back" ? { ...f, role: "front" } : f)) };
  }) as KernelCalls["call"],
};

const CORNER = "back+right&back+top&right+top";

test("hand-worked: a sketch whose face's name is now two faces' is held where it was drawn, its plane ambiguous, and its extrude says so", async () => {
  // The front, y = 0, outward (0, −1, 0): XZ's frame (sketch x = X, y = Z), its origin where the world's origin meets y = 0, (0, 0, 0).
  const box = partDocument("box", 40, 30, 20);
  const made = addFaceSketch(box, { plane: facePlane("feature-1", "front"), feature: "feature-1" }, drawnFrame([0, -1, 0], [20, 0, 10]));
  const doc = extrudeSketch(drawCircle(made.doc, made.id, [20, 10], 3).doc, made.id, 5).doc;
  const extrude = doc.timeline.features.at(-1)!.id;
  // A cache each: a cache asks the kernel for a body's view once.
  const cache = new BodyCache(kernel);
  const renamed = new BodyCache(twoFronts);
  try {
    // The real names: found, no warning.
    const real = await rebuildTimeline(doc, cache, kernel);
    assert.equal((real.results[made.id] as { plane?: unknown }).plane, undefined);
    // Two fronts: neither is picked. Held at the frame as drawn, the ambiguous words, and the extrude's source warning.
    const two = await rebuildTimeline(doc, renamed, twoFronts);
    const r = two.results[made.id] as { status: string; placement: { plane: { origin: number[]; normal: number[] } }; plane?: { cause: string; message: string } };
    assert.equal(r.status, "built");
    assert.deepEqual(r.plane, { cause: "plane-ambiguous", face: facePlane("feature-1", "front"), message: "Sketch 1's face is now more than one face, so its plane is ambiguous: it stays where it was rather than guess" });
    assert.deepEqual([r.placement.plane.origin, r.placement.plane.normal], [[0, 0, 0], [0, -1, 0]]);
    const e = two.results[extrude] as { status: string; source?: { cause: string; message: string } };
    assert.equal(e.status, "built");
    assert.equal(e.source?.cause, "plane-ambiguous");
    assert.equal(e.source?.message, "Extrude 1's source is lost: Sketch 1's plane is ambiguous, so it stays where it was");
  } finally {
    await cache.clear();
    await renamed.clear();
  }
});

test("hand-worked: one pinned point ambiguous and one lost: both held, counted as two, lost first, both sentences", async () => {
  // The top, z = 20: XY's frame, so sketch (x, y) is the world's. Circles of radius 3 round the front edge's middle (20, 0) and the
  // back right corner (40, 30), each centre pinned there.
  const box = partDocument("box", 40, 30, 20);
  const made = addFaceSketch(box, { plane: facePlane("feature-1", "top"), feature: "feature-1" }, drawnFrame([0, 0, 1], [20, 15, 20]));
  const targets = [
    { at: [20, 0] as [number, number], kind: "midpoint" as const, name: "front+top" },
    { at: [40, 30] as [number, number], kind: "endpoint" as const, name: CORNER },
  ];
  const one = drawCircle(made.doc, made.id, [20, 0], 3).doc;
  const two = drawCircle(one, made.id, [40, 30], 3).doc;
  const doc: DesignDocument = pinNewPoints(made.doc, two, made.id, targets);
  assert.equal(doc.sketches.find((s) => s.id === made.id)!.pins!.length, 2);
  const cache = new BodyCache(kernel);
  const renamed = new BodyCache(twoFronts);
  try {
    const real = await rebuildTimeline(doc, cache, kernel);
    assert.equal((real.results[made.id] as { points?: unknown }).points, undefined, "both found on the real box");
    // Two fronts: "front+top" is two edges' name (ambiguous); the corner, now named by "front" edges, has no "back" in it (lost).
    const r = (await rebuildTimeline(doc, renamed, twoFronts)).results[made.id] as { plane?: unknown; pinned?: unknown[]; points?: { cause: string; points: number; message: string } };
    assert.equal(r.plane, undefined, "the top is still one face");
    assert.deepEqual(r.pinned, []);
    assert.deepEqual(r.points, {
      cause: "point-lost",
      points: 2,
      message:
        "Sketch 1: a point snapped to an edge has lost that edge, so it stays where it was. " +
        "Sketch 1: a point snapped to an edge is on an edge that is now more than one edge, so it stays where it was rather than guess",
    });
    // Only the ambiguous one pinned: one point, ambiguous, its one sentence.
    const sketch = doc.sketches.find((s) => s.id === made.id)!;
    const onlyMiddle: DesignDocument = { ...doc, sketches: doc.sketches.map((s) => (s === sketch ? { ...s, pins: s.pins!.filter((p) => p.name === "front+top") } : s)) };
    const m = (await rebuildTimeline(onlyMiddle, renamed, twoFronts)).results[made.id] as { points?: unknown };
    assert.deepEqual(m.points, { cause: "point-ambiguous", points: 1, message: "Sketch 1: a point snapped to an edge is on an edge that is now more than one edge, so it stays where it was rather than guess" });
  } finally {
    await cache.clear();
    await renamed.clear();
  }
});

test("a design settled once is settled: settling it again gives the same object, with a face sketch held, pinned and found", async () => {
  // A sketch on the box's right face (YZ's frame: sketch x = Y, y = Z) with a circle centred on the corner (30, 20), the right face's
  // back top corner (40, 30, 20), pinned there. Settled once, then again from itself: nothing changes, so the same object comes back.
  const box = partDocument("box", 40, 30, 20);
  const made = addFaceSketch(box, { plane: facePlane("feature-1", "right"), feature: "feature-1" }, drawnFrame([1, 0, 0], [40, 15, 10]));
  const pinned = pinNewPoints(made.doc, drawCircle(made.doc, made.id, [30, 20], 3).doc, made.id, [{ at: [30, 20], kind: "endpoint", name: CORNER }]);
  const settled = await settleKept(kernel, pinned, pinned);
  assert.equal(await settleKept(kernel, settled, settled), settled);
  // The box made a cylinder: the right face goes, so the sketch is held where it was.
  const cylinder = { ...settled, timeline: { ...settled.timeline, features: settled.timeline.features.map((f, i) => (i === 0 ? { ...f, intent: { ...f.intent, type: "cylinder", parameters: { radius: 20, height: 20 } } } : f)) } } as DesignDocument;
  const lost = await settleKept(kernel, settled, cylinder);
  assert.notEqual(lost, cylinder, "the held placement taken in");
  assert.ok(lost.sketches.find((s) => s.id === made.id)!.face!.held, "held");
  assert.equal(await settleKept(kernel, lost, lost), lost);
});

test("hand-worked: a body the kernel refuses fails with the kernel's own words, as an error", async () => {
  // A box 2 km wide: past MAX_SIZE (1 km), so the kernel refuses it, naming the width and the limits.
  const cache = new BodyCache(kernel);
  try {
    const b = await rebuildTimeline(partDocument("box", 2e6, 30, 20), cache, kernel);
    assert.deepEqual(Object.values(b.results), [{ status: "failed", cause: "error", message: "width must be between 0.001 and 1000000 mm, got 2000000" }]);
  } finally {
    await cache.clear();
  }
});
