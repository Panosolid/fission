// Journey: deleting a sketch from the browser (step 24e4) on the real WASM
// kernel. `planDelete` gives the document a confirmed delete records (the
// item gone through `deleteItem`, kept shapes settled by `settleKept`) and
// the question asked first; each case is worked out by hand, then that
// document is rebuilt as the app rebuilds it, so what the box promised (a
// kept shape, or a failure) is what the rebuild shows. Planted bugs in the
// plan are each caught. Run with `npm run journeys` after the app build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { addSketch, BodyCache, deleteCurve, deleteItem, deleteWords, drawRectangle, extrudeSketch, partDocument, planDelete, rebuildTimeline, settleKept, type DesignDocument, type DeletePlan } from "@fission/design";
import { nodeKernel } from "../src/node-kernel.ts";

const kernel = nodeKernel();
const close = (got: number, want: number) => Math.abs(got - want) <= 1e-9 * Math.max(1, Math.abs(want));

/**
 * The starting box (feature-1, 40 × 30 × 20 = 24000 mm³), Sketch 1
 * (sketch-2: a 40 × 30 rectangle from (0, 0), lines bottom, right, top,
 * left) and Extrude 1 of it by 10 (feature-11: 40 · 30 · 10 = 12000 mm³).
 */
function part() {
  const s = addSketch(partDocument("box", 40, 30, 20));
  const rect = drawRectangle(s.doc, s.id, [0, 0], [40, 30]);
  const made = extrudeSketch(rect.doc, s.id, 10);
  return { doc: made.doc, sketch: s.id, extrude: made.id, lines: rect.ids };
}

/** Each item's status and, for a body, its volume and warning (cause, sketch), from a rebuild on a fresh cache that is freed after. */
async function rebuilt(doc: DesignDocument) {
  const cache = new BodyCache(kernel);
  try {
    const { order, results } = await rebuildTimeline(doc, cache, kernel);
    const out: Record<string, unknown> = {};
    for (const id of order) {
      const r = results[id];
      if (r.status === "built" && r.body !== undefined) out[id] = { volume: (await cache.view(r.body)).volume, warning: r.warning ? [r.warning.cause, r.warning.sketch] : null };
      else out[id] = r.status === "failed" ? { failed: r.cause, message: r.message } : r.status;
    }
    return out;
  } finally {
    await cache.clear();
  }
}

const volumeOf = (r: unknown) => (r as { volume: number }).volume;

test("a used sketch with a closed outline: asked first, then the extrude keeps the rectangle, 12000 mm³, warned as deleted; the box untouched", async () => {
  const start = await kernel.call("body_count");
  const { doc, sketch, extrude } = part();
  const plan = await planDelete(kernel, doc, sketch);
  assert.deepEqual(plan.ask, {
    heading: "Delete Sketch 1?",
    words: "Extrude 1 is built from Sketch 1. If you delete it, Extrude 1 keeps its last shape and shows a warning. Undo brings Sketch 1 back.",
  });
  // What is recorded: deleteItem's document with Sketch 1's points and curves kept for Extrude 1, nothing else.
  const s = doc.sketches[0];
  assert.deepEqual(plan.next, { ...deleteItem(doc, sketch), kept: { [extrude]: { points: s.points, curves: s.curves } } });
  const after = await rebuilt(plan.next);
  assert.deepEqual(Object.keys(after), ["feature-1", extrude]);
  assert.ok(close(volumeOf(after["feature-1"]), 24000), "the box: 40 · 30 · 20");
  assert.ok(close(volumeOf(after[extrude]), 12000), "the kept rectangle: 40 · 30 · 10");
  assert.deepEqual((after[extrude] as { warning: unknown }).warning, ["deleted-input", sketch]);
  assert.equal(await kernel.call("body_count"), start);
});

test("a used sketch already open and kept (a side deleted after extruding): still asked, the kept shape stays through the delete", async () => {
  const { doc: whole, sketch, extrude, lines } = part();
  // The right side deleted: the outline opens, settleKept keeps the rectangle for Extrude 1.
  const doc = await settleKept(kernel, whole, deleteCurve(whole, sketch, lines[1]));
  assert.ok(doc.kept?.[extrude], "kept before the delete");
  const plan = await planDelete(kernel, doc, sketch);
  assert.match(plan.ask!.words, /Extrude 1 keeps its last shape and shows a warning\./);
  assert.deepEqual(plan.next.kept, doc.kept, "the same kept shape, not the open sketch");
  const after = await rebuilt(plan.next);
  assert.ok(close(volumeOf(after[extrude]), 12000));
  assert.deepEqual((after[extrude] as { warning: unknown }).warning, ["deleted-input", sketch]);
});

test("a used sketch that never closed (extruded open, nothing kept): the box says the extrude fails, and it does", async () => {
  const { doc: whole, sketch, extrude, lines } = part();
  // The side deleted before anything was kept (written straight into the data, as an opened file can hold it): no kept shape.
  const doc = deleteCurve(whole, sketch, lines[1]);
  assert.equal(doc.kept, undefined);
  const before = await rebuilt(doc);
  assert.equal((before[extrude] as { failed: string }).failed, "open-outline", "failing already, with nothing kept");
  const plan = await planDelete(kernel, doc, sketch);
  assert.equal(plan.ask!.words, "Extrude 1 is built from Sketch 1. If you delete it, Extrude 1 has no shape to keep and fails. Undo brings Sketch 1 back.");
  assert.equal(plan.next.kept, undefined);
  const after = await rebuilt(plan.next);
  assert.deepEqual(after[extrude], { failed: "deleted-input", message: "Sketch 1 was deleted" });
});

test("a sketch nothing is built from: no question, the delete is only the sketch going", async () => {
  const { doc } = part();
  const s2 = addSketch(doc);
  const drawn = drawRectangle(s2.doc, s2.id, [50, 0], [60, 10]).doc;
  const plan = await planDelete(kernel, drawn, s2.id);
  assert.equal(plan.ask, null);
  assert.deepEqual(plan.next, deleteItem(drawn, s2.id));
  assert.deepEqual(plan.next, { ...doc, nextId: drawn.nextId }, "back to the part as it was, the counter moved on (ids never reused)");
});

test("two extrudes of one closed sketch: both keep the rectangle, 12000 and 6000 mm³, both warned", async () => {
  const { doc: one, sketch, extrude } = part();
  const two = extrudeSketch(one, sketch, 5);
  const plan = await planDelete(kernel, two.doc, sketch);
  assert.match(plan.ask!.words, /^Extrude 1 and Extrude 2 are built from Sketch 1\. If you delete it, Extrude 1 and Extrude 2 keep their last shapes and show a warning\./);
  const after = await rebuilt(plan.next);
  // 40 · 30 · 10 = 12000 and 40 · 30 · 5 = 6000.
  assert.ok(close(volumeOf(after[extrude]), 12000) && close(volumeOf(after[two.id]), 6000));
});

/** Plans that each break one rule, as a bug in planDelete would. */
const PLANTED: Record<string, (doc: DesignDocument, id: string) => Promise<DeletePlan>> = {
  // The kept shapes never settled: the extrude has nothing to build from, though the box said it keeps its shape.
  "unsettled": async (doc, id) => {
    const next = deleteItem(doc, id);
    const settled = await settleKept(kernel, doc, next);
    return { next, ask: deleteWords(doc, settled, id) };
  },
  // The words read from the document before the delete: no kept entry yet, so they say "fails" for a closed sketch.
  "words-from-before": async (doc, id) => {
    const next = await settleKept(kernel, doc, deleteItem(doc, id));
    return { next, ask: deleteWords(doc, doc, id) };
  },
  // Never asks.
  "never-asks": async (doc, id) => ({ next: await settleKept(kernel, doc, deleteItem(doc, id)), ask: null }),
};

test("each planted bug in the plan is caught: the box's promise and the rebuild disagree, or nothing is asked", async () => {
  const { doc, sketch, extrude } = part();
  /** The check the tests above make: asked, and the box's "keeps" or "fails" matches the rebuild. */
  const honest = async (plan: DeletePlan) => {
    if (plan.ask === null) return "not asked";
    const after = (await rebuilt(plan.next))[extrude];
    const keeps = plan.ask.words.includes("Extrude 1 keeps its last shape");
    const built = typeof after === "object" && after !== null && "volume" in after;
    return keeps === built ? "ok" : `the box says ${keeps ? "kept" : "fails"}, the rebuild ${built ? "built it" : "failed it"}`;
  };
  assert.equal(await honest(await planDelete(kernel, doc, sketch)), "ok");
  const caught = Object.fromEntries(await Promise.all(Object.entries(PLANTED).map(async ([name, plan]) => [name, await honest(await plan(doc, sketch))])));
  assert.deepEqual(caught, {
    "unsettled": "the box says kept, the rebuild failed it",
    "words-from-before": "the box says fails, the rebuild built it",
    "never-asks": "not asked",
  });
});
