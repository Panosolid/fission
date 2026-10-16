import { test } from "node:test";
import assert from "node:assert/strict";
import { RepresentationRegistry, type BodyView, type KernelCalls, type Timeline, XY_PLANE, describeProvenance } from "@fission/core";
import { lastFeature, partDocument, specOf } from "../src/document.ts";
import { designObjects, outlineProducer, registerDesign, type OutlineSource } from "../src/representations.ts";
import { outline } from "../src/profiles.ts";

test("a part is feature #1 of a one-step timeline, with its intent", () => {
  const doc = partDocument("box", 40, 30, 20);
  // The same Timeline type step 32 uses, not a special single-shape format.
  const timeline: Timeline = doc.timeline;
  assert.equal(timeline.features.length, 1);
  assert.deepEqual(timeline.features[0], {
    id: "feature-1",
    intent: { type: "box", parameters: { width: 40, depth: 30, height: 20 }, summary: "Box: 40 × 30 × 20 mm" },
    provenance: { self: { workspace: "design", id: "feature-1", label: "Feature 1 (box)" }, from: [] },
    dependsOn: [],
    suppressed: false,
  });
});

test("intent summaries for every shape", () => {
  const summary = (...a: Parameters<typeof partDocument>) => lastFeature(partDocument(...a)).intent.summary;
  assert.equal(summary("cylinder", 40, 30, 20), "Cylinder: ⌀40 × 20 mm");
  assert.equal(summary("sphere", 40, 30, 20), "Sphere: ⌀40 mm");
  assert.equal(summary("slot", 40, 30, 20), "Extrude: Slot with round ends profile 40 × 30 mm, by 20 mm");
});

test("an extrusion depends on its profile, and says it came from it", () => {
  const doc = partDocument("l-bracket", 40, 30, 20);
  const f = lastFeature(doc);
  assert.deepEqual(f.dependsOn, ["profile-1"]);
  assert.equal(describeProvenance(f.provenance), "Feature 1 (extrude) comes from L-bracket profile in Design.");
});

test("the body is built from the intent: changing a parameter changes the body", () => {
  const doc = partDocument("box", 40, 30, 20);
  const f = lastFeature(doc);
  f.intent.parameters.width = 55;
  assert.deepEqual(specOf(doc, f), { box: { width: 55, depth: 30, height: 20 } });
  f.intent.parameters.width = "wide";
  assert.throws(() => specOf(doc, f), /width must be a number/);
});

test("step 32 extends the list: a second feature needs no conversion of the first", () => {
  const doc = partDocument("plate", 40, 30, 20);
  const first = structuredClone(lastFeature(doc));
  doc.timeline.features.push({ ...structuredClone(first), id: "feature-2", dependsOn: ["profile-1", "feature-1"] });
  assert.deepEqual(doc.timeline.features[0], first);
  assert.deepEqual(specOf(doc, doc.timeline.features[0]), specOf(doc, doc.timeline.features[1]));
  // A saved document reads back unchanged: plain JSON, no special cases.
  assert.deepEqual(JSON.parse(JSON.stringify(doc)), doc);
});

/** Kernel stand-in for unit tests: a one-triangle mesh for whatever is asked. */
const fakeKernel: KernelCalls = {
  call: (async () =>
    ({ mesh: { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], normals: [], indices: [0, 1, 2], triangle_faces: [0], edge_lines: [], edge_line_edges: [] } }) as unknown as BodyView) as KernelCalls["call"],
};

test("Design produces exact Solids for its features and Outlines for its profiles", async () => {
  const registry = new RepresentationRegistry();
  registerDesign(registry, fakeKernel);
  const doc = partDocument("star", 40, 30, 20);
  const [profile, feature] = designObjects(doc);
  assert.deepEqual(await registry.deliver(feature, ["solid", "mesh"]), { representation: { kind: "solid", spec: specOf(doc, lastFeature(doc)) }, note: null });
  const asMesh = await registry.deliver(feature, ["mesh"]);
  assert.equal(asMesh.representation.kind, "mesh");
  assert.match(asMesh.note!, /can't take an exact solid/);
  assert.deepEqual(await registry.deliver(profile, ["outline"]), {
    representation: { kind: "outline", plane: XY_PLANE, outline: outline("star", 40, 30) },
    note: null,
  });
});

test("step 21: a sketch produces Outline through the same registry and producer, with no new path", async () => {
  // A stand-in for the step-21 sketch: any OutlineSource registered with
  // the existing generic producer. When the real sketch lands it must
  // pass this same check (see the roadmap note on step 21).
  const registry = new RepresentationRegistry();
  registerDesign(registry, fakeKernel);
  registry.registerProducer("design.sketch", "outline", outlineProducer);
  const triangle = { outer: { path: { corners: [0, 0, 10, 0, 0, 10], bulges: [] } }, holes: [] };
  const sketch: OutlineSource = { type: "design.sketch", id: "sketch-1", plane: XY_PLANE, outline: () => triangle };
  assert.deepEqual(await registry.deliver(sketch, ["outline", "mesh"]), { representation: { kind: "outline", plane: XY_PLANE, outline: triangle }, note: null });
});

test("Design's saved data reads back, and anything else is refused clearly", async () => {
  const { readDesignDocument } = await import("../src/document.ts");
  const doc = partDocument("slot", 40, 30, 20);
  assert.deepEqual(readDesignDocument(JSON.parse(JSON.stringify(doc))), doc);
  assert.throws(() => readDesignDocument(null), /Design data is missing/);
  assert.throws(() => readDesignDocument({ ...doc, version: 2 }), /version 2 is not one this Fission reads/);
  assert.throws(() => readDesignDocument({ ...doc, timeline: { features: [] } }), /no timeline/);
});
