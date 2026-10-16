// What Design hands to other workspaces, through the one representation
// registry in core: its features as exact Solids (and Meshes for targets
// that can't take solids), its profiles as exact Outlines.
//
// The Outline producer is generic: it takes any OutlineSource. Ready-made
// profiles are one kind today; at step 21 sketches register as another
// type with this same producer, so there is no sketch-only path.

import type { KernelCalls, Outline, Plane, Producible, Producer, RepresentationRegistry } from "@fission/core";
import { lastFeature, specOf, type DesignDocument } from "./document.ts";
import { outline } from "./profiles.ts";
import { buildSpec } from "./spec.ts";

/** Anything in Design that is a closed 2D shape on a plane. */
export interface OutlineSource extends Producible {
  plane: Plane;
  outline(): Outline;
}

/** Outline of any OutlineSource: profiles now, sketches from step 21. */
export const outlineProducer: Producer = (object) => {
  const source = object as OutlineSource;
  return { kind: "outline", plane: source.plane, outline: source.outline() };
};

/** A feature's result, handed over by id. */
export interface FeatureHandle extends Producible {
  type: "design.feature";
  document: DesignDocument;
}

/** Design's objects that other workspaces can take: each profile and the part's last feature. */
export function designObjects(document: DesignDocument): (OutlineSource | FeatureHandle)[] {
  const profiles: OutlineSource[] = document.profiles.map((p) => ({
    type: "design.profile",
    id: p.id,
    plane: p.plane,
    outline: () => outline(p.kind, p.width, p.depth),
  }));
  return [...profiles, { type: "design.feature", id: lastFeature(document).id, document }];
}

/** Says what Design produces. `kernel` builds meshes. */
export function registerDesign(registry: RepresentationRegistry, kernel: KernelCalls): void {
  registry.registerProducer("design.profile", "outline", outlineProducer);
  const spec = (o: Producible) => {
    const { document } = o as FeatureHandle;
    const feature = document.timeline.features.find((f) => f.id === o.id);
    if (!feature) throw new Error(`feature ${o.id} is not in the design`);
    return specOf(document, feature);
  };
  registry.registerProducer("design.feature", "solid", (o) => ({ kind: "solid", spec: spec(o) }));
  registry.registerProducer("design.feature", "mesh", async (o) => {
    const view = await buildSpec(kernel, spec(o));
    return { kind: "mesh", positions: view.mesh.positions, indices: view.mesh.indices };
  });
}
