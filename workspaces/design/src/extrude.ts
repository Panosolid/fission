// Extrude a sketch (step 21d, docs/document-model.md sections 3 and 6): a
// new extrude feature after the sketch, depending on it, whose intent is
// `{ sketch, distance }`. The outline is never stored: the kernel finds it
// from the sketch's lines every time the feature is built, so an edit to
// the sketch rebuilds the solid (a live link), and a sketch that no longer
// closes makes the build fail with the kernel's reason.
//
// Until the timeline (step 32) the part is one body, so extruding a sketch
// replaces the part's solid feature, as one undo step that says so.

import type { BodySpec, Feature, KernelCalls } from "@fission/core";
import { isSketchExtrude, isSketchItem, lastFeature, shown, specOf, type DesignDocument } from "./document.ts";
import { sketchItem, sketchOutline } from "./sketch.ts";

/** How far a new extrude goes until the user types another distance (mm). */
export const DEFAULT_DISTANCE = 10;

/** The undo step an extrude is recorded as: "Replace the part with Extrude of Sketch 1". */
export const extrudeStep = (doc: DesignDocument, sketchId: string) => `Replace the part with Extrude of ${sketchItem(doc, sketchId).provenance.self.label}`;

/** The undo step a typed distance is recorded as, merged per box like the other sizes. */
export const DISTANCE_STEP = "Change extrude distance";

const summary = (sketchLabel: string, distance: number) => `Extrude ${sketchLabel} by ${distance} mm`;

/**
 * The document with the part replaced by an extrude of this sketch by
 * `distance` mm: a new feature with the next id, appended to the timeline
 * (after the sketch, which is already in it), depending on the sketch.
 * Profiles no feature uses any more leave with the old part. The kernel
 * judges the distance and the outline when the feature is built.
 */
export function extrudeSketch(doc: DesignDocument, sketchId: string, distance: number): { doc: DesignDocument; id: string } {
  const sketch = sketchItem(doc, sketchId);
  if (!Number.isFinite(distance)) throw new Error(`an extrude needs its distance in mm, not ${shown(distance)}`);
  const id = `feature-${doc.nextId}`;
  const label = sketch.provenance.self.label;
  const feature: Feature = {
    id,
    intent: { type: "extrude", parameters: { sketch: sketchId, distance }, summary: summary(label, distance) },
    // "Extrude 1": the one solid feature until step 32 numbers them by position.
    provenance: { self: { workspace: "design", id, label: "Extrude 1" }, from: [{ workspace: "design", id: sketchId, label }] },
    dependsOn: [sketchId],
    suppressed: false,
  };
  const old = lastFeature(doc);
  const features = [...doc.timeline.features.filter((f) => f !== old), feature];
  const used = new Set(features.map((f) => f.intent.parameters.profile));
  return { id, doc: { ...doc, nextId: doc.nextId + 1, profiles: doc.profiles.filter((p) => used.has(p.id)), timeline: { ...doc.timeline, features } } };
}

/** The document with the part's extrude going `distance` mm instead; the part must be an extrude of a sketch. */
export function setExtrudeDistance(doc: DesignDocument, distance: number): DesignDocument {
  const old = lastFeature(doc);
  if (!isSketchExtrude(old)) throw new Error(`the part is ${old.intent.summary}, not an extrude of a sketch`);
  const sketchLabel = sketchItem(doc, old.intent.parameters.sketch as string).provenance.self.label;
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
  // The kernel extrudes along +Z: a sketch on XZ or YZ needs placing, which comes with sketches on other planes (step 24).
  if (item.intent.parameters.plane !== "XY")
    throw new Error(`${feature.intent.summary}: ${item.provenance.self.label} is on the ${shown(item.intent.parameters.plane)} plane, and only sketches on the XY plane can be extruded so far`);
  if (typeof distance !== "number") throw new Error(`${feature.intent.summary}: distance must be a number`);
  return { extrude: { profile: await sketchOutline(kernel, doc, sketch as string), distance } };
}
