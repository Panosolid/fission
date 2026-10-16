// @fission/simulate: the Simulate workspace. PLACEHOLDER: nothing here works yet.
//
// Finite element analysis on the kernel's exact geometry: static stress first, then thermal and modal.
// It will refer to Design's geometry by stable IDs and never copy it, so a
// design change flows straight through. Work starts after CAD step 50 (booleans and full topological naming), so loads stay on the right faces.

import type { BodyReference, FaceReference, WorkspacePlugin } from "@fission/core";
import { showPlaceholder } from "@fission/ui";

/** DRAFT: one simulation study. Loads and constraints point at design faces. */
export interface Study {
  id: string;
  kind: "static" | "thermal" | "modal";
  bodies: { body: BodyReference; material: string }[];
  loads: { face: FaceReference; force: [number, number, number] }[];
  constraints: { face: FaceReference; fixed: true }[];
}

/** Solves a study. Not implemented yet. */
export function solve(_study: Study): Promise<never> {
  throw new Error("not implemented");
}

export const simulateWorkspace: WorkspacePlugin = {
  id: "simulate",
  title: "Simulate",
  summary: "Finite element analysis on the kernel's exact geometry: static stress first, then thermal and modal.",
  status: "placeholder",
  mount(ctx) {
    showPlaceholder(ctx.panel, {
      title: "Simulate",
      summary: "Finite element analysis on the kernel's exact geometry: static stress first, then thermal and modal.",
      plans: ["Static stress, then thermal and modal studies", "Materials from the shared library (density, stiffness, strength)", "Loads and constraints placed on design faces by reference: they follow the face when the design changes", "Meshing from the exact geometry", "Results: stress, displacement and safety factor drawn in the shared viewport"],
      startsAfter: "after CAD step 50 (booleans and full topological naming), so loads stay on the right faces",
    });
    return () => {};
  },
};
