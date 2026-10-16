import type { BodySpec, BodyView, KernelCalls } from "@fission/core";
import { lastFeature, partDocument, specOf } from "./document.ts";
import type { ShapeKind } from "./profiles.ts";

/**
 * The body for these inputs, as the kernel's BodySpec: boxes, cylinders and
 * spheres from the primitives (a cylinder's or sphere's width is its
 * diameter); the other shapes are outlines extruded by the height. Read
 * from the part's feature intent, the same way the viewer builds it.
 */
export function specFor(kind: ShapeKind, w: number, d: number, h: number): BodySpec {
  const document = partDocument(kind, w, d, h);
  return specOf(document, lastFeature(document));
}

/** Builds a BodySpec with the kernel. */
export function buildSpec(kernel: KernelCalls, spec: BodySpec): Promise<BodyView> {
  if ("box" in spec) return kernel.call("make_box", spec.box.width, spec.box.depth, spec.box.height);
  if ("cylinder" in spec) return kernel.call("make_cylinder", spec.cylinder.radius, spec.cylinder.height);
  if ("sphere" in spec) return kernel.call("make_sphere", spec.sphere.radius);
  return kernel.call("make_extrude", spec.extrude.profile, spec.extrude.distance);
}
