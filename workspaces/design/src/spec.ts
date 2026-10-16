import type { BodySpec } from "@fission/core";
import { outline, type ShapeKind } from "./profiles.ts";

/**
 * The body for these inputs, as the kernel's BodySpec: boxes, cylinders and
 * spheres from the primitives (a cylinder's or sphere's width is its
 * diameter); the other shapes are outlines extruded by the height.
 */
export function specFor(kind: ShapeKind, w: number, d: number, h: number): BodySpec {
  if (kind === "box") return { box: { width: w, depth: d, height: h } };
  if (kind === "cylinder") return { cylinder: { radius: w / 2, height: h } };
  if (kind === "sphere") return { sphere: { radius: w / 2 } };
  return { extrude: { profile: outline(kind, w, d), distance: h } };
}
