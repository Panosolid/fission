// Security re-check N1: a feature id of "__proto__" broke the rebuild. The
// rebuild kept its results in a plain object, where results["__proto__"] = r
// sets the object's prototype instead of adding an entry, so the body was
// freed as unused and the part failed with "body 2 is not in this cache".
// Now the reader refuses ids not shaped as Design makes them (a lower-case
// word and the counter's number, sketch-3, or the word alone, as a version 1
// file's "base"), and the rebuild keeps results with no prototype, so even
// an id that got past the reader is an entry.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { BodyHandle, KernelCalls } from "@fission/core";
import { readDesignDocument, type DesignDocument } from "../src/document.ts";
import { BodyCache, rebuildTimeline } from "../src/rebuild.ts";

/** A one-box design whose box has this id, and a sketch beside it, as a file holds them. */
function design(boxId: string, sketchId = "sketch-1"): DesignDocument {
  const item = (id: string, type: string, parameters: Record<string, unknown>) => ({ id, intent: { type, parameters, summary: type }, provenance: { self: { workspace: "design" as const, id, label: type }, from: [] }, dependsOn: [], suppressed: false });
  return {
    version: 3,
    nextId: 10,
    profiles: [],
    sketches: [{ id: sketchId, points: [], curves: [], constraints: [] }],
    timeline: { features: [item(sketchId, "sketch", { plane: "XY" }), item(boxId, "box", { width: 1, depth: 2, height: 3 })] },
  };
}

const read = (d: DesignDocument) => readDesignDocument(JSON.parse(JSON.stringify(d)));

test("ids as Design makes them open: a word, a dash and the counter's number, or the word alone", () => {
  // "constructor" is a word too: as a plain object's key it is only an own entry (no setter, unlike __proto__).
  for (const id of ["feature-2", "box-3", "feature-9", "base", "constructor"]) assert.equal(read(design(id)).timeline.features[1].id, id);
  assert.equal(read(design("feature-2", "sketch-3")).sketches[0].id, "sketch-3");
});

test("an id not shaped like Design's is refused by name, __proto__ first", () => {
  // JSON.parse makes "__proto__" an own key and an own id, as a file would bring it.
  const message = (id: string) => `Design id ${JSON.stringify(id)} is not shaped like Design's ids: a lower-case word and its number, like sketch-3`;
  for (const id of ["__proto__", "toString", "hasOwnProperty", "feature-", "-2", "feature-2x", "feature 2", "Feature-2", "feature-2-", "fea_ture-2", "feature-2\n", ""])
    assert.throws(() => read(design(id)), { message: message(id) }, JSON.stringify(id));
  assert.throws(() => read(design("feature-2", "__proto__")), { message: message("__proto__") });
});

/** The kernel calls a box's rebuild makes, answered without a kernel: handles count up, frees are recorded. */
function fakeKernel() {
  let next = 1;
  const freed: BodyHandle[] = [];
  const kernel = {
    call: async (op: string, ...args: unknown[]) => {
      if (op === "body_build") return next++;
      if (op === "body_free") return void freed.push(args[0] as BodyHandle);
      throw new Error(`the fake kernel doesn't do ${op}`);
    },
  } as unknown as KernelCalls;
  return { kernel, freed };
}

test("an id that got past the reader is still an entry in the rebuild's results, and its body is kept", async () => {
  // Built straight from data (not read), as the old reader let it through.
  const { kernel, freed } = fakeKernel();
  const cache = new BodyCache(kernel);
  const build = await rebuildTimeline(design("__proto__"), cache, kernel);
  assert.deepEqual(build.order, ["sketch-1", "__proto__"]);
  assert.ok(Object.hasOwn(build.results, "__proto__"), "an own entry, not the prototype");
  assert.deepEqual(build.results["__proto__"], { status: "built", body: 1, spec: { box: { width: 1, depth: 2, height: 3 } } });
  assert.deepEqual(Object.keys(build.results), ["sketch-1", "__proto__"]);
  assert.deepEqual(freed, [], "the box's body is kept, not freed as unused");
  assert.equal(cache.size, 1);
});
