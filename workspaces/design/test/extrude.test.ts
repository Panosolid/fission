// Step 21d: extruding a sketch (docs/document-model.md, sections 3 and 6).
// The extrude is a new feature after its sketch, depending on it, and from
// step 24d1 a new body: it replaces nothing. Volumes on the real
// kernel are in packages/testing/journeys/extrude-sketch.journey.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ChangeNotes, DependencyGraph, emptyProject, projectFromJson, projectToJson, type KernelCalls, type Outline, type SketchLine } from "@fission/core";
import { lastFeature, partDocument, partOf, readDesignDocument, specOf, withPart, type DesignDocument } from "../src/document.ts";
import { addSketch, drawLine, movePoint } from "../src/sketch.ts";
import { extrudeSketch, extrudeStep, featureSpec, setExtrudeDistance } from "../src/extrude.ts";
import { PART_VIEW, syncGraph } from "../src/graph.ts";
import { parameterRows } from "../src/properties.ts";

const DESIGN = [{ id: "design" as const, readData: readDesignDocument }];

/** A box part, then Sketch 1: a 40 × 30 rectangle drawn as one closed chain from (0, 0). */
function rectangle(start: DesignDocument = partDocument("box", 10, 10, 10)) {
  const s = addSketch(start);
  let doc = drawLine(s.doc, s.id, [0, 0], [40, 0]).doc;
  const first = doc.sketches.at(-1)!.curves[0].start;
  for (const p of [[40, 30], [0, 30]] as const) doc = drawLine(doc, s.id, doc.sketches.at(-1)!.curves.at(-1)!.end, p).doc;
  doc = drawLine(doc, s.id, doc.sketches.at(-1)!.curves.at(-1)!.end, first).doc;
  return { doc, sketch: s.id };
}

/** A kernel that answers sketch_outline with `answer` and records the lines it was given. */
function fakeKernel(answer: { closed: Outline } | { open: string }) {
  const asked: SketchLine[][] = [];
  const kernel: KernelCalls = {
    call: (async (op: string, ...args: unknown[]) => {
      if (op !== "sketch_outline") throw new Error(`unexpected kernel call ${op}`);
      asked.push(args[0] as SketchLine[]);
      return answer;
    }) as KernelCalls["call"],
  };
  return { kernel, asked };
}

test("hand-worked: extruding Sketch 1 adds a new feature after the sketch and keeps the box", () => {
  // The box is feature-1, so the counter is at 2. Sketch 1 takes sketch-2.
  // The first line makes point-3, point-4 and line-5; each next line one new
  // point and the line (6 and 7, 8 and 9); the closing line ends on point-3
  // and takes only line-10. The counter is at 11, so the extrude is feature-11.
  const { doc, sketch } = rectangle();
  assert.equal(doc.nextId, 11);
  const made = extrudeSketch(doc, sketch, 10);
  assert.equal(made.id, "feature-11");
  assert.equal(made.doc.nextId, 12);
  // The box stays (every solid feature is its own body from 24d1); the extrude comes after its sketch.
  assert.deepEqual(made.doc.timeline.features.map((f) => f.id), ["feature-1", "sketch-2", "feature-11"]);
  assert.deepEqual(made.doc.timeline.features[0], doc.timeline.features[0]);
  assert.deepEqual(lastFeature(made.doc), {
    id: "feature-11",
    intent: { type: "extrude", parameters: { sketch: "sketch-2", distance: 10 }, summary: "Extrude Sketch 1 by 10 mm" },
    provenance: { self: { workspace: "design", id: "feature-11", label: "Extrude 1" }, from: [{ workspace: "design", id: "sketch-2", label: "Sketch 1" }] },
    dependsOn: ["sketch-2"],
    suppressed: false,
  });
  // The sketch is kept exactly as drawn.
  assert.deepEqual(made.doc.sketches, doc.sketches);
  assert.deepEqual(partOf(made.doc), { shape: "sketch-extrude", sizes: { height: 10 } });
  assert.equal(extrudeStep(doc, sketch), "Extrude Sketch 1");
  // A second extrude of the same sketch is Extrude 2, after the first: nothing is replaced.
  const again = extrudeSketch(made.doc, sketch, 4);
  assert.equal(again.id, "feature-12");
  assert.deepEqual(again.doc.timeline.features.map((f) => [f.id, f.provenance.self.label]), [["feature-1", "Feature 1 (box)"], ["sketch-2", "Sketch 1"], ["feature-11", "Extrude 1"], ["feature-12", "Extrude 2"]]);
  // The document it was given is unchanged.
  assert.equal(doc.timeline.features[0].id, "feature-1");
});

test("extruding after a ready-made profile part keeps the part and its profile", () => {
  const { doc, sketch } = rectangle(partDocument("plate", 40, 30, 5));
  assert.deepEqual(doc.profiles.map((p) => p.id), ["profile-1"]);
  const made = extrudeSketch(doc, sketch, 3).doc;
  assert.deepEqual(made.profiles, doc.profiles);
  assert.deepEqual(made.timeline.features.map((f) => f.id), ["feature-1", "sketch-2", "feature-11"]);
  assert.doesNotThrow(() => readDesignDocument(structuredClone(made)));
});

test("the panel shows an extrude of a sketch as its distance alone", () => {
  // Width and depth come from the sketch; the height box is the distance.
  assert.deepEqual(parameterRows("sketch-extrude"), [
    { key: "width", label: "Width", shown: false },
    { key: "depth", label: "Depth", shown: false },
    { key: "height", label: "Extrude by", shown: true },
  ]);
});

test("a typed distance changes the extrude and its summary, nothing else", () => {
  const { doc, sketch } = rectangle();
  const made = extrudeSketch(doc, sketch, 10).doc;
  const longer = setExtrudeDistance(made, 25.5);
  assert.deepEqual(lastFeature(longer).intent, { type: "extrude", parameters: { sketch: "sketch-2", distance: 25.5 }, summary: "Extrude Sketch 1 by 25.5 mm" });
  assert.equal(longer.nextId, made.nextId);
  assert.deepEqual(longer.sketches, made.sketches);
  assert.equal(lastFeature(made).intent.parameters.distance, 10);
  // Only an extrude of a sketch has a distance to set this way.
  assert.throws(() => setExtrudeDistance(doc, 5), /^Error: Box: 10 × 10 × 10 mm is not an extrude of a sketch$/);
  // Another extrude than the part, by id: only that one changes.
  const two = extrudeSketch(made, sketch, 4).doc;
  const first = setExtrudeDistance(two, 7, "feature-11");
  assert.deepEqual(first.timeline.features.map((f) => f.intent.parameters.distance), [undefined, undefined, 7, 4]);
  assert.throws(() => setExtrudeDistance(two, 7, "feature-99"), /^Error: there is no feature feature-99 in the design$/);
});

test("ids are never reused: extrude, back to a box, extrude again, every feature id new", () => {
  // feature-11 is the first extrude. Back to a box from the panel: a new
  // preset after it (nothing is replaced), so it takes feature-12 from the
  // counter (a plate would take a profile id too). The next extrude is feature-13.
  const { doc, sketch } = rectangle();
  const one = extrudeSketch(doc, sketch, 10).doc;
  const box = withPart(one, "box", 20, 20, 20);
  assert.deepEqual(box.timeline.features.map((f) => f.id), ["feature-1", "sketch-2", "feature-11", "feature-12"]);
  assert.equal(box.timeline.features[3].provenance.self.id, "feature-12");
  assert.equal(box.timeline.features[3].provenance.self.label, "Feature 12 (box)");
  assert.equal(box.nextId, 13);
  assert.deepEqual(partOf(box), { shape: "box", sizes: { width: 20, depth: 20, height: 20 } });
  // Editing that box keeps its id (the same feature, changed), as for any preset.
  assert.equal(lastFeature(withPart(box, "cylinder", 5, 5, 5)).id, "feature-12");
  const plate = withPart(one, "plate", 40, 30, 5);
  assert.deepEqual(plate.profiles.map((p) => p.id), ["profile-13"]);
  assert.deepEqual(lastFeature(plate).dependsOn, ["profile-13"]);
  assert.deepEqual(lastFeature(plate).provenance.from.map((r) => r.id), ["profile-13"]);
  assert.ok("extrude" in specOf(plate, lastFeature(plate))); // its profile is found under the new id
  assert.doesNotThrow(() => readDesignDocument(structuredClone(plate)));
  assert.equal(extrudeSketch(box, sketch, 5).id, "feature-13");
});

test("featureSpec asks the kernel for the sketch's outline each time, with the lines as drawn", async () => {
  const { doc, sketch } = rectangle();
  const made = extrudeSketch(doc, sketch, 10).doc;
  const outline: Outline = { outer: { path: { corners: [0, 0, 40, 0, 40, 30, 0, 30], bulges: [0, 0, 0, 0] } }, holes: [] };
  const { kernel, asked } = fakeKernel({ closed: outline });
  assert.deepEqual(await featureSpec(kernel, made, lastFeature(made)), { extrude: { profile: outline, distance: 10 } });
  assert.deepEqual(asked, [
    [
      { a: [0, 0], b: [40, 0] },
      { a: [40, 0], b: [40, 30] },
      { a: [40, 30], b: [0, 30] },
      { a: [0, 30], b: [0, 0] },
    ],
  ]);
  // Moved, the sketch is asked again with the moved point: nothing was kept.
  await featureSpec(kernel, movePoint(made, sketch, "point-6", 40, 50), lastFeature(made));
  assert.deepEqual(asked[1][1], { a: [40, 0], b: [40, 50] });
  // A preset needs no kernel call to say what it builds.
  assert.deepEqual(await featureSpec(kernel, doc, lastFeature(doc)), { box: { width: 10, depth: 10, height: 10 } });
  assert.equal(asked.length, 2);
});

test("featureSpec refuses an open sketch with the kernel's reason, and places a sketch on XZ or YZ in its plane's frame (26c)", async () => {
  const { doc, sketch } = rectangle();
  const made = extrudeSketch(doc, sketch, 10).doc;
  const { kernel } = fakeKernel({ open: "the line end at (0, 0) is not joined to another line" });
  await assert.rejects(featureSpec(kernel, made, lastFeature(made)), /^Error: Sketch 1 has no closed outline: the line end at \(0, 0\) is not joined to another line$/);
  const outline: Outline = { outer: { path: { corners: [0, 0, 40, 0, 40, 30, 0, 30], bulges: [0, 0, 0, 0] } }, holes: [] };
  // Until 26c a sketch on XZ was refused; now it is built upright in XZ's frame (x along X, normal −Y, so y = −Y × X = Z), never flat.
  const closed = fakeKernel({ closed: outline }).kernel;
  for (const [plane, frame] of [
    ["XZ", { origin: [0, 0, 0], x: [1, 0, 0], normal: [0, -1, 0] }],
    ["YZ", { origin: [0, 0, 0], x: [0, 1, 0], normal: [1, 0, 0] }],
  ] as const) {
    const upright = structuredClone(made);
    upright.timeline.features[1].intent.parameters.plane = plane;
    assert.deepEqual(await featureSpec(closed, upright, lastFeature(upright)), { extrude: { profile: outline, distance: 10, frame } });
  }
  // On XY, as before 26c: no frame at all, so every body built before is built bit for bit the same.
  assert.deepEqual(await featureSpec(closed, made, lastFeature(made)), { extrude: { profile: outline, distance: 10 } });
  // specOf alone can't build it: the outline needs the kernel.
  assert.throws(() => specOf(made, lastFeature(made)), /built through featureSpec/);
});

test("extrudeSketch refuses a sketch that isn't there and a distance that isn't a number", () => {
  const { doc, sketch } = rectangle();
  assert.throws(() => extrudeSketch(doc, "sketch-99", 10), /^Error: there is no sketch sketch-99 in the timeline$/);
  assert.throws(() => extrudeSketch(doc, sketch, Number.NaN), /^Error: an extrude needs its distance in mm, not NaN$/);
  // The part's own feature is not a sketch.
  assert.throws(() => extrudeSketch(doc, "feature-1", 10), /no sketch feature-1/);
});

test("the extrude reads its sketch in the graph: a line drawn makes the part out of date", () => {
  const { doc, sketch } = rectangle();
  const made = extrudeSketch(doc, sketch, 10).doc;
  const g = new DependencyGraph();
  syncGraph(g, made, null, new ChangeNotes());
  for (const id of g.stale()) g.markFresh(id);
  syncGraph(g, movePoint(made, sketch, "point-6", 40, 50), made, new ChangeNotes());
  assert.deepEqual(g.stale().sort(), [PART_VIEW, "feature-11"]);
});

// ---- Saving and opening ----

test("a project with an extruded sketch saves and opens byte-identical", () => {
  const { doc, sketch } = rectangle();
  const made = extrudeSketch(doc, sketch, 12.5).doc;
  const text = projectToJson({ ...emptyProject("Extruded"), workspaces: { design: made } });
  const opened = projectFromJson(text, DESIGN);
  assert.deepEqual(opened.workspaces.design, made);
  assert.equal(projectToJson(opened), text);
});

test("a file whose extrude breaks a rule is refused when it is opened, each with its message", () => {
  const broken = (edit: (d: DesignDocument) => void) => {
    const { doc, sketch } = rectangle();
    const d = structuredClone(extrudeSketch(doc, sketch, 10).doc);
    edit(d);
    return () => readDesignDocument(d);
  };
  assert.doesNotThrow(broken(() => {}));
  const extrude = (d: DesignDocument) => d.timeline.features[2];
  const cases: [(d: DesignDocument) => void, RegExp][] = [
    // Built in order, the sketch must come first.
    [(d) => d.timeline.features.reverse(), /^Error: Design feature feature-11 extrudes sketch-2, which is not a sketch before it in the timeline$/],
    // A sketch that is gone is allowed from 24d2 (deleted: the extrude keeps its last shape, test/kept.test.ts), but the extrude must still depend on it.
    [(d) => (extrude(d).intent.parameters.sketch = "sketch-99"), /^Error: Design feature feature-11 extrudes sketch-99 but does not depend on it$/],
    [(d) => (extrude(d).intent.parameters.sketch = "feature-1"), /extrudes feature-1, which is not a sketch before it/],
    [(d) => (extrude(d).intent.parameters.sketch = 2), /extrudes 2, which is not a sketch before it/],
    [(d) => (extrude(d).dependsOn = []), /^Error: Design feature feature-11 extrudes sketch-2 but does not depend on it$/],
    [(d) => (extrude(d).intent.parameters.distance = "10"), /^Error: Design feature feature-11: distance 10 is not a number of mm$/],
    [(d) => (extrude(d).intent.parameters.distance = null), /distance null is not a number of mm/],
    [(d) => (extrude(d).intent.parameters.profile = "profile-1"), /^Error: Design feature feature-11 extrudes both a sketch and a profile$/],
    [(d) => (d.nextId = 11), /nextId 11 is not above feature-11/],
  ];
  for (const [edit, message] of cases) assert.throws(broken(edit), message);
});
