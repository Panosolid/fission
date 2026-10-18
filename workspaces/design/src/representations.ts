// What Design hands to other workspaces, through the one representation
// registry in core: its features as exact Solids (and Meshes for targets
// that can't take solids), its profiles as exact Outlines.
//
// The Outline producer is generic: it takes any OutlineSource. Ready-made
// profiles are one kind; sketches (step 21b) register as another type with
// this same producer, so there is no sketch-only path.

import type { KernelCalls, Outline, Plane, Producible, Producer, RepresentationRegistry } from "@fission/core";
import { partFeature, type DesignDocument, type SketchPlane } from "./document.ts";
import { featureSpec } from "./extrude.ts";
import { outline } from "./profiles.ts";
import { planeOf, sketchItem, sketchOutline } from "./sketch.ts";
import { buildSpec } from "./spec.ts";

/** Anything in Design that is a closed 2D shape on a plane; a sketch's outline comes from the kernel, so it may be a promise. */
export interface OutlineSource extends Producible {
  plane: Plane;
  outline(): Outline | Promise<Outline>;
}

/** Outline of any OutlineSource: profiles and sketches. */
export const outlineProducer: Producer = async (object) => {
  const source = object as OutlineSource;
  return { kind: "outline", plane: source.plane, outline: await source.outline() };
};

/** A feature's result, handed over by id. */
export interface FeatureHandle extends Producible {
  type: "design.feature";
  document: DesignDocument;
}

/**
 * Design's objects that other workspaces can take: each profile, each
 * sketch (its outline found by `kernel` when asked for, never stored) and
 * the part's solid feature (none for a design with no body, 24f4).
 */
export function designObjects(document: DesignDocument, kernel: KernelCalls): (OutlineSource | FeatureHandle)[] {
  const profiles: OutlineSource[] = document.profiles.map((p) => ({
    type: "design.profile",
    id: p.id,
    plane: p.plane,
    outline: () => outline(p.kind, p.width, p.depth),
  }));
  const sketches: OutlineSource[] = document.sketches.map((s) => ({
    type: "design.sketch",
    id: s.id,
    plane: planeOf(sketchItem(document, s.id).intent.parameters.plane as SketchPlane),
    outline: () => sketchOutline(kernel, document, s.id),
  }));
  // A design with no body (24f4) offers no solid.
  const part = partFeature(document);
  const solid: FeatureHandle[] = part === null ? [] : [{ type: "design.feature", id: part.id, document }];
  return [...profiles, ...sketches, ...solid];
}

/** Says what Design produces. `kernel` builds meshes. */
export function registerDesign(registry: RepresentationRegistry, kernel: KernelCalls): void {
  registry.registerProducer("design.profile", "outline", outlineProducer);
  registry.registerProducer("design.sketch", "outline", outlineProducer);
  const spec = (o: Producible) => {
    const { document } = o as FeatureHandle;
    const feature = document.timeline.features.find((f) => f.id === o.id);
    if (!feature) throw new Error(`feature ${o.id} is not in the design`);
    // An extrude of a sketch asks the kernel for the outline, now.
    return featureSpec(kernel, document, feature);
  };
  registry.registerProducer("design.feature", "solid", async (o) => ({ kind: "solid", spec: await spec(o) }));
  registry.registerProducer("design.feature", "mesh", async (o) => {
    const view = await buildSpec(kernel, await spec(o));
    return { kind: "mesh", positions: view.mesh.positions, indices: view.mesh.indices };
  });
}
