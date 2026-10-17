import { test } from "node:test";
import assert from "node:assert/strict";
import { RepresentationRegistry, type BodyView, type KernelCalls, type Timeline, XY_PLANE, describeProvenance } from "@fission/core";
import { lastFeature, partDocument, specOf } from "../src/document.ts";
import { designObjects, outlineProducer, registerDesign, type OutlineSource } from "../src/representations.ts";
import { addSketch, drawLine } from "../src/sketch.ts";
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
  const [profile, feature] = designObjects(doc, fakeKernel);
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
  // Any OutlineSource registered with the existing generic producer gives its outline.
  const stand = new RepresentationRegistry();
  stand.registerProducer("design.thing", "outline", outlineProducer);
  const triangle = { outer: { path: { corners: [0, 0, 10, 0, 0, 10], bulges: [] } }, holes: [] };
  const thing: OutlineSource = { type: "design.thing", id: "thing-1", plane: XY_PLANE, outline: () => triangle };
  assert.deepEqual(await stand.deliver(thing, ["outline", "mesh"]), { representation: { kind: "outline", plane: XY_PLANE, outline: triangle }, note: null });

  // The real sketch (21b): registered by registerDesign as design.sketch with
  // that same producer, its outline found by the kernel from the lines rebuilt
  // from point ids. A right triangle (0,0), (10,0), (0,10) drawn as a chain.
  const s = addSketch(partDocument("box", 40, 30, 20));
  let d = s.doc;
  const a = drawLine(d, s.id, [0, 0], [10, 0]);
  const b = drawLine(a.doc, s.id, a.doc.sketches[0].curves[0].end, [0, 10]);
  d = drawLine(b.doc, s.id, b.doc.sketches[0].curves[1].end, a.doc.sketches[0].curves[0].start).doc;
  const asked: unknown[] = [];
  const kernel: KernelCalls = {
    call: (async (op: string, lines: unknown, circles: unknown) => {
      asked.push([op, lines, circles]);
      return { closed: triangle };
    }) as KernelCalls["call"],
  };
  const registry = new RepresentationRegistry();
  registerDesign(registry, kernel);
  const sketch = designObjects(d, kernel).find((o) => o.type === "design.sketch")!;
  assert.equal(sketch.id, s.id);
  assert.deepEqual(await registry.deliver(sketch, ["outline", "mesh"]), { representation: { kind: "outline", plane: XY_PLANE, outline: triangle }, note: null });
  // The kernel was given the three lines in drawing order, each end at its point's place, and no circles.
  assert.deepEqual(asked, [["sketch_outline", [{ a: [0, 0], b: [10, 0] }, { a: [10, 0], b: [0, 10] }, { a: [0, 10], b: [0, 0] }], []]]);
  // A sketch that makes no closed outline is refused with the kernel's reason, named.
  const open: KernelCalls = { call: (async () => ({ open: "a line ends loose at (0, 10)" })) as unknown as KernelCalls["call"] };
  const r2 = new RepresentationRegistry();
  registerDesign(r2, open);
  await assert.rejects(r2.deliver(designObjects(d, open).find((o) => o.type === "design.sketch")!, ["outline"]), /Sketch 1 has no closed outline: a line ends loose at \(0, 10\)/);
});

test("Design's saved data reads back, and anything else is refused clearly", async () => {
  const { readDesignDocument } = await import("../src/document.ts");
  const doc = partDocument("slot", 40, 30, 20);
  assert.deepEqual(readDesignDocument(JSON.parse(JSON.stringify(doc))), doc);
  assert.throws(() => readDesignDocument(null), /Design data is missing/);
  assert.throws(() => readDesignDocument({ ...doc, version: 3 }), /version 3 is not one this Fission reads \(1 or 2\)/);
  assert.throws(() => readDesignDocument({ ...doc, timeline: { features: [] } }), /no timeline/);
});

// ---- Opening a saved project (19a) ----
import { projectFromJson, projectToJson, emptyProject } from "@fission/core";
import { partOf, readDesignDocument, type DesignDocument } from "../src/document.ts";

const DESIGN = [{ id: "design" as const, readData: readDesignDocument }];

/** A version-2 file written by hand, as docs/project-format.md describes it: a 50 × 30 × 20 box. */
const HAND_WRITTEN = `{
  "formatVersion": 2,
  "name": "Block",
  "units": { "length": "mm" },
  "materials": [],
  "links": [],
  "workspaces": {
    "design": {
      "version": 1,
      "profiles": [],
      "timeline": { "features": [{
        "id": "feature-1",
        "intent": { "type": "box", "parameters": { "width": 50, "depth": 30, "height": 20 }, "summary": "Box: 50 × 30 × 20 mm" },
        "provenance": { "self": { "workspace": "design", "id": "feature-1", "label": "Feature 1 (box)" }, "from": [] },
        "dependsOn": [],
        "suppressed": false
      }] }
    }
  }
}`;

test("a hand-written version-2 file opens to its 50 × 30 × 20 box", () => {
  const p = projectFromJson(HAND_WRITTEN, DESIGN);
  const doc = p.workspaces.design as DesignDocument;
  assert.deepEqual(partOf(doc), { shape: "box", sizes: { width: 50, depth: 30, height: 20 } });
  const spec = specOf(doc, lastFeature(doc));
  assert.deepEqual(spec, { box: { width: 50, depth: 30, height: 20 } });
  // V = 50 · 30 · 20 = 30000 mm³ (the real kernel measures it in the open-a-file journey).
  assert.equal(spec.box!.width * spec.box!.depth * spec.box!.height, 30000);
  assert.equal(p.name, "Block");
});

test("a version-1 file with a Design part opens (outer migration, then Design's own: a counter above its ids, no sketches)", () => {
  const v1 = JSON.parse(HAND_WRITTEN);
  v1.formatVersion = 1;
  delete v1.links;
  const p = projectFromJson(JSON.stringify(v1), DESIGN);
  assert.deepEqual(p.links, []);
  // Its ids are feature-1 only, so the counter starts at 2.
  assert.deepEqual(p.workspaces.design, { ...JSON.parse(HAND_WRITTEN).workspaces.design, version: 2, nextId: 2, sketches: [] });
});

test("partOf undoes partDocument for every shape (self-consistency)", () => {
  for (const kind of ["box", "cylinder", "sphere", "l-bracket", "plate", "slot", "star"] as const) {
    const { shape, sizes } = partOf(partDocument(kind, 41, 31, 21));
    assert.equal(shape, kind);
    const full = { width: 41, depth: kind === "cylinder" || kind === "sphere" ? undefined : 31, height: kind === "sphere" ? undefined : 21 };
    assert.deepEqual(sizes, Object.fromEntries(Object.entries(full).filter(([, v]) => v !== undefined)));
    // And the document it describes is the one it came from.
    const doc = partDocument(kind, 41, 31, 21);
    assert.deepEqual(partDocument(shape, sizes.width!, sizes.depth ?? 31, sizes.height ?? 21), doc);
  }
});

test("Design data the panel can't show is refused when the file is opened, each with its message", () => {
  const broken = (edit: (d: any) => void) => {
    const f = JSON.parse(HAND_WRITTEN);
    edit(f.workspaces.design);
    return () => projectFromJson(JSON.stringify(f), DESIGN);
  };
  assert.throws(broken((d) => (d.timeline.features[0].intent.type = "loft")), /can't open the design workspace's data: unknown feature type loft/);
  assert.throws(broken((d) => (d.timeline.features[0].intent.parameters.width = "50")), /Box: 50 × 30 × 20 mm: width must be a number/);
  assert.throws(broken((d) => delete d.timeline.features[0].intent), /Design feature 1 has no id or intent/);
  assert.throws(broken((d) => (d.timeline.features = [])), /Design data has no timeline/);
  assert.throws(broken((d) => ((d as { version: number }).version = 3)), /Design data version 3 is not one this Fission reads \(1 or 2\)/);
  const extrude = (edit: (d: DesignDocument) => void) => {
    const doc = partDocument("slot", 40, 30, 20);
    edit(doc);
    return () => projectFromJson(projectToJson({ ...emptyProject(), workspaces: { design: doc } }), DESIGN);
  };
  assert.doesNotThrow(extrude(() => {}));
  assert.throws(extrude((d) => (d.profiles = [])), /its profile profile-1 is missing/);
  assert.throws(extrude((d) => ((d.profiles[0] as { kind: string }).kind = "hexagon")), /profile profile-1 has an unknown kind hexagon/);
  assert.throws(extrude((d) => ((d.profiles[0] as { width: unknown }).width = null)), /profile profile-1: width and depth must be numbers/);
});

test("a profile that is not an object is refused with Design's own message (found by fuzzing)", () => {
  // Before: profiles [null] reached `x.id` and the file was refused with
  // "Cannot read properties of null (reading 'id')".
  const doc = partDocument("slot", 40, 30, 20) as unknown as { profiles: unknown[] };
  for (const bad of [null, 3, "profile-1", []])
    assert.throws(() => readDesignDocument({ ...doc, profiles: [bad, ...doc.profiles] }), /^Error: Design profile 1 is not an object$/);
  assert.throws(() => readDesignDocument({ ...doc, profiles: [...doc.profiles, null] }), /^Error: Design profile 2 is not an object$/);
});
