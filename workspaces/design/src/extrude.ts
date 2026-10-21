// Extrude a sketch (step 21d, docs/document-model.md sections 3 and 6): a
// new extrude feature after the sketch, depending on it, whose intent is
// `{ sketch, distance }`. The outline is never stored: the kernel finds it
// from the sketch's lines every time the feature is built, so an edit to
// the sketch rebuilds the solid (a live link). A sketch that no longer
// closes leaves the extrude its last shape with a warning (the owner's
// rule, step 24d2, rebuild.ts), or fails it with the kernel's reason when
// it never closed.
//
// Every extrude is a new body ("New body", step 24d1) until booleans join
// them: it is added to the timeline at the marker and replaces nothing.

import type { BodySpec, Feature, KernelCalls } from "@fission/core";
import { insertAt, insertItem, isSketchExtrude, partFeature, shown, specOf, type DesignDocument } from "./document.ts";
import { extrudeSpec, type CurveIds } from "./rebuild.ts";
import { sketchItem } from "./sketch.ts";

/** How far a new extrude goes until the user types another distance (mm). */
export const DEFAULT_DISTANCE = 10;

/** What the Extrude panel says when every sketch is after the rollback marker or suppressed, so none is offered. */
export const NO_USABLE_SKETCH = "No sketch can be extruded here: each comes after the rollback marker or is suppressed. Move the marker past one, or unsuppress it.";

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

/** The document with an extrude of a sketch (the part, `partFeature`, unless `id` names another) going `distance` mm instead. */
export function setExtrudeDistance(doc: DesignDocument, distance: number, id?: string): DesignDocument {
  const old = id === undefined ? partFeature(doc) : doc.timeline.features.find((f) => f.id === id);
  if (!old) throw new Error(id === undefined ? "the design has no body to change the distance of" : `there is no feature ${shown(id)} in the design`);
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
 * sketch asks the kernel for the sketch's outline now (never stored), or
 * uses its kept shape (`extrudeSpec`); every other feature is read from
 * its intent alone (specOf).
 */
export async function featureSpec(kernel: KernelCalls, doc: DesignDocument, feature: Feature): Promise<BodySpec> {
  return (await featureBuild(kernel, doc, feature)).spec;
}

/** `featureSpec` with, for an extrude of a sketch, the ids of the curves its outline came from (the kept shape's while its sketch is lost), as `featureNames` takes them. */
export async function featureBuild(kernel: KernelCalls, doc: DesignDocument, feature: Feature): Promise<{ spec: BodySpec; curves?: CurveIds }> {
  if (!isSketchExtrude(feature)) return { spec: specOf(doc, feature) };
  // The owner's rule (rebuild.ts): a lost sketch's extrude is built from its kept shape.
  const made = await extrudeSpec(kernel, doc, feature);
  if ("status" in made) throw new Error(made.message);
  return { spec: made.spec, curves: made.curves };
}
