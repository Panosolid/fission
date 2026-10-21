// What Design hands to other workspaces, through the one representation
// registry in core: its features as exact Solids (and Meshes for targets
// that can't take solids), its profiles as exact Outlines.
//
// The Outline producer is generic: it takes any OutlineSource. Ready-made
// profiles are one kind; sketches (step 21b) register as another type with
// this same producer, so there is no sketch-only path.

import type { KernelCalls, Outline, Plane, Producible, Producer, RepresentationRegistry, SourceLookup } from "@fission/core";
import { bodyFeatures } from "./browser.ts";
import type { DesignDocument } from "./document.ts";
import { featureSpec } from "./extrude.ts";
import { outline } from "./profiles.ts";
import { readDesignReference, readProfileReference } from "./references.ts";
import { bodyOf, findInScene, type Scene } from "./scene.ts";
import { sketchOutline, sketchPlane } from "./sketch.ts";
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
 * every solid feature that builds, in build order (25c1; none for a design
 * with no body, 24f4).
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
    plane: sketchPlane(document, s.id),
    outline: () => sketchOutline(kernel, document, s.id),
  }));
  // Every body shown, not only the part's (25c1); a design with no body (24f4) offers no solid.
  const solids: FeatureHandle[] = bodyFeatures(document).map((f) => ({ type: "design.feature", id: f.id, document }));
  return [...profiles, ...sketches, ...solids];
}

/**
 * How a link another workspace holds finds what it points at in Design
 * (step 25a4), after every rebuild: an object by its id (a profile, a
 * sketch, a body that builds), and a body, face or edge by its stable name on the
 * bodies shown (`scene`, null before the first build), never by the
 * kernel's index. A face or edge found delivers the solid of the body it
 * is on (its feature's), the link keeping the name of which face; one the
 * edit took off its body, or a body not shown, is gone (null, so the link
 * warns); one whose name the edit gave to two or more faces or edges says
 * so and is never moved to one of them. Sources from other workspaces are
 * not Design's to find (null).
 */
export function designLookup(document: DesignDocument, scene: Scene | null, kernel: KernelCalls): SourceLookup {
  const solidOf = (featureId: string): FeatureHandle => ({ type: "design.feature", id: featureId, document });
  return (source) => {
    if (source.origin.workspace !== "design") return null;
    if (source.kind === "object") {
      const object = designObjects(document, kernel).find((o) => o.id === source.origin.id) ?? null;
      // A body the last rebuild failed is not shown, so a link to it is gone until it builds again.
      return object?.type === "design.feature" && scene !== null && !scene.bodies.some((b) => b.feature === object.id) ? null : object;
    }
    const { ref } = source;
    const profile = readProfileReference(ref);
    if (profile !== null) return designObjects(document, kernel).find((o) => o.type === "design.profile" && o.id === profile) ?? null;
    if (scene === null || readDesignReference(ref) === null) return null;
    const b = bodyOf(scene, ref);
    if (b < 0) return null;
    if (ref.kind === "body") return solidOf(scene.bodies[b].feature);
    const found = findInScene(ref, scene);
    if (found.status === "shared") return { unresolved: `now matches more than one ${ref.kind} after the last edit, so it was not moved to any of them` };
    return found.status === "found" ? solidOf(scene.bodies[b].feature) : null;
  };
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
