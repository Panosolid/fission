// Extrude a sketch (step 21d, docs/document-model.md sections 3 and 6): a
// new extrude feature after the sketch, depending on it, whose intent is
// `{ sketch, distance }`. The outline is never stored: the kernel finds it
// from the sketch's lines every time the feature is built, so an edit to
// the sketch rebuilds the solid (a live link), and a sketch that no longer
// closes makes the build fail with the kernel's reason.
//
// Every extrude is a new body ("New body", step 24d1) until booleans join
// them: it is added to the timeline at the marker and replaces nothing.

import type { BodySpec, Feature, KernelCalls } from "@fission/core";
import { insertAt, insertItem, isSketchExtrude, isSketchItem, lastFeature, shown, specOf, type DesignDocument } from "./document.ts";
import { sketchItem, sketchOutline } from "./sketch.ts";

/** How far a new extrude goes until the user types another distance (mm). */
export const DEFAULT_DISTANCE = 10;

/** The undo step an extrude is recorded as: "Extrude Sketch 1". */
export const extrudeStep = (doc: DesignDocument, sketchId: string) => `Extrude ${sketchItem(doc, sketchId).provenance.self.label}`;

/** The undo step a typed distance is recorded as, merged per box like the other sizes. */
export const DISTANCE_STEP = "Change extrude distance";

const summary = (sketchLabel: string, distance: number) => `Extrude ${sketchLabel} by ${distance} mm`;

/**
 * The document with an extrude of this sketch by `distance` mm added: a
 * new feature with the next id, put in at the marker (insertItem), which
 * must be after the sketch, depending on the sketch; every feature already
 * there stays. It is named "Extrude n", n one more than the extrudes of
 * sketches there are, skipping a name in use. The kernel judges the
 * distance and the outline when the feature is built.
 */
export function extrudeSketch(doc: DesignDocument, sketchId: string, distance: number): { doc: DesignDocument; id: string } {
  const sketch = sketchItem(doc, sketchId);
  if (!Number.isFinite(distance)) throw new Error(`an extrude needs its distance in mm, not ${shown(distance)}`);
  if (doc.timeline.features.indexOf(sketch) >= insertAt(doc)) throw new Error(`${sketch.provenance.self.label} comes after the rollback marker, so an extrude put in at the marker can't use it`);
  const id = `feature-${doc.nextId}`;
  const label = sketch.provenance.self.label;
  const extrudes = doc.timeline.features.filter(isSketchExtrude);
  const names = new Set(extrudes.map((f) => f.provenance.self.label));
  let n = extrudes.length + 1;
  while (names.has(`Extrude ${n}`)) n++;
  const feature: Feature = {
    id,
    intent: { type: "extrude", parameters: { sketch: sketchId, distance }, summary: summary(label, distance) },
    provenance: { self: { workspace: "design", id, label: `Extrude ${n}` }, from: [{ workspace: "design", id: sketchId, label }] },
    dependsOn: [sketchId],
    suppressed: false,
  };
  return { id, doc: { ...doc, nextId: doc.nextId + 1, timeline: insertItem(doc, feature) } };
}

/** The document with an extrude of a sketch (the part, `lastFeature`, unless `id` names another) going `distance` mm instead. */
export function setExtrudeDistance(doc: DesignDocument, distance: number, id?: string): DesignDocument {
  const old = id === undefined ? lastFeature(doc) : doc.timeline.features.find((f) => f.id === id);
  if (!old) throw new Error(`there is no feature ${shown(id)} in the design`);
  if (!isSketchExtrude(old)) throw new Error(`${old.intent.summary} is not an extrude of a sketch`);
  // Its sketch may be gone (deleted: the extrude keeps its last shape, 24d2); its summary then names it as the extrude remembers it.
  const sketchId = old.intent.parameters.sketch as string;
  const there = doc.timeline.features.some((f) => f.id === sketchId);
  const sketchLabel = there ? sketchItem(doc, sketchId).provenance.self.label : (old.provenance.from.find((p) => p.id === sketchId)?.label ?? sketchId);
  const feature: Feature = { ...old, intent: { ...old.intent, parameters: { ...old.intent.parameters, distance }, summary: summary(sketchLabel, distance) } };
  return { ...doc, timeline: { ...doc.timeline, features: doc.timeline.features.map((f) => (f === old ? feature : f)) } };
}

/**
 * The body a feature builds, as the kernel's BodySpec. An extrude of a
 * sketch asks the kernel for the sketch's outline now (never stored);
 * every other feature is read from its intent alone (specOf).
 */
export async function featureSpec(kernel: KernelCalls, doc: DesignDocument, feature: Feature): Promise<BodySpec> {
  if (!isSketchExtrude(feature)) return specOf(doc, feature);
  const { sketch, distance } = feature.intent.parameters;
  const item = doc.timeline.features.find((f) => f.id === sketch && isSketchItem(f));
  if (!item) throw new Error(`${feature.intent.summary}: its sketch ${shown(sketch)} is missing`);
  // The kernel extrudes along +Z: a sketch on XZ or YZ needs placing, which comes with sketches on other planes (step 26).
  if (item.intent.parameters.plane !== "XY")
    throw new Error(`${feature.intent.summary}: ${item.provenance.self.label} is on the ${shown(item.intent.parameters.plane)} plane, and only sketches on the XY plane can be extruded so far`);
  if (typeof distance !== "number") throw new Error(`${feature.intent.summary}: distance must be a number`);
  return { extrude: { profile: await sketchOutline(kernel, doc, sketch as string), distance } };
}
