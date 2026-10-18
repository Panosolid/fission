// Step 24d2: an extrude's kept shape in Design's data (the owner's rule:
// an extrude whose sketch is lost keeps its last shape). Each refusal breaks
// a valid file in one way and gets its exact message; the rebuild itself is
// checked on the real kernel in packages/testing/journeys/timeline.journey.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyProject, projectFromJson, projectToJson } from "@fission/core";
import { builds, keptOf, lastFeature, readDesignDocument, partDocument, type DesignDocument } from "../src/document.ts";
import { addSketch, deleteCurve, drawRectangle } from "../src/sketch.ts";
import { extrudeSketch, setExtrudeDistance } from "../src/extrude.ts";

const DESIGN = [{ id: "design" as const, readData: readDesignDocument }];
const save = (d: DesignDocument) => projectToJson({ ...emptyProject("Kept"), workspaces: { design: d } });

/**
 * A box (feature-1), Sketch 1 (sketch-2: a 40 × 30 rectangle, points 3, 4,
 * 6, 8 and lines 5, 7, 9, 10, ids in the order the rectangle tool takes
 * them) and its extrude (feature-11); then the bottom
 * line deleted, with the rectangle kept for the extrude, as settleKept
 * leaves it.
 */
function keptDoc(): DesignDocument {
  const s = addSketch(partDocument("box", 40, 30, 20));
  const rect = drawRectangle(s.doc, s.id, [0, 0], [40, 30]);
  const e = extrudeSketch(rect.doc, s.id, 10);
  const whole = e.doc.sketches[0];
  const open = deleteCurve(e.doc, s.id, rect.ids[0]);
  return { ...open, kept: { [e.id]: { points: whole.points, curves: whole.curves } } };
}

const json = (d: DesignDocument) => JSON.parse(JSON.stringify(d));
const refused = (d: unknown, message: string) => assert.throws(() => readDesignDocument(d), { message });

test("a kept shape is saved and opens byte-identical; its ids are the sketch's, the counter above them", () => {
  const doc = keptDoc();
  assert.deepEqual(Object.keys(doc.kept!), ["feature-11"]);
  assert.deepEqual(doc.kept!["feature-11"].curves.map((c) => c.id), ["line-5", "line-7", "line-9", "line-10"]);
  const text = save(doc);
  const opened = projectFromJson(text, DESIGN).workspaces.design as DesignDocument;
  assert.equal(save(opened), text);
  assert.deepEqual(keptOf(opened, opened.timeline.features[2]), doc.kept!["feature-11"]);
  // A distance typed while lost keeps it.
  assert.ok(setExtrudeDistance(doc, 20, "feature-11").kept);
});

test("an extrude whose sketch is deleted opens; it builds with a kept shape and not without one", () => {
  const doc = keptDoc();
  const gone: DesignDocument = { ...doc, sketches: [], timeline: { features: doc.timeline.features.filter((f) => f.id !== "sketch-2") } };
  const opened = readDesignDocument(json(gone));
  const extrude = opened.timeline.features[1];
  assert.equal(builds(opened, extrude), true);
  assert.equal(lastFeature(opened).id, "feature-11");
  // Without the kept shape it doesn't build, so the part is the box.
  const { kept: _, ...bare } = gone;
  assert.equal(builds(bare, bare.timeline.features[1]), false);
  assert.equal(lastFeature(readDesignDocument(json(bare))).id, "feature-1");
  // Its distance can still be typed; the summary names the sketch as the extrude remembers it.
  assert.equal(setExtrudeDistance(gone, 15, "feature-11").timeline.features[1].intent.summary, "Extrude Sketch 1 by 15 mm");
});

test("every way a kept shape can break is refused with its own message", () => {
  const ok = json(keptDoc());
  assert.doesNotThrow(() => readDesignDocument(json(ok)));
  const broken = (change: (d: { kept: Record<string, { points: Record<string, unknown>[]; curves: Record<string, unknown>[] }>; nextId: number; timeline: { features: { id: string }[] } }) => void) => {
    const d = json(ok);
    change(d);
    return d;
  };
  refused(broken((d) => ((d as { kept: unknown }).kept = [])), "Design data's kept shapes are not an object of extrude ids");
  refused(broken((d) => (d.kept["feature-1"] = d.kept["feature-11"])), "Design data keeps a shape for feature-1, which is not an extrude of a sketch in the timeline");
  refused(broken((d) => (d.kept["feature-99"] = d.kept["feature-11"])), "Design data keeps a shape for feature-99, which is not an extrude of a sketch in the timeline");
  refused(broken((d) => ((d.kept["feature-11"] as { points?: unknown }).points = undefined)), "Design feature feature-11's kept shape needs points and curves lists");
  refused(broken((d) => delete d.kept["feature-11"].points[0].x), "Design feature feature-11's kept shape: point point-3 needs x and y in mm");
  refused(broken((d) => (d.kept["feature-11"].curves[0].end = "point-99")), "Design feature feature-11's kept shape: line line-5 ends at point-99, which is not one of the sketch's points");
  refused(broken((d) => (d.kept["feature-11"].curves[3].id = "point-3")), "Design feature feature-11's kept shape uses the id point-3 twice");
  // Kept ids hold the counter up: one at or above nextId is refused.
  refused(broken((d) => (d.kept["feature-11"].curves[3].id = `line-${d.nextId}`)), `Design data's nextId ${ok.nextId} is not above line-${ok.nextId}, so a new id could repeat it`);
  // An extrude may lose its sketch, but never point at a later item or one that isn't a sketch.
  refused(broken((d) => ((d.timeline.features[2] as { intent: { parameters: { sketch: string } } }).intent.parameters.sketch = "feature-1")), "Design feature feature-11 extrudes feature-1, which is not a sketch before it in the timeline");
});
