// @fission/manufacture: the Manufacture workspace. PLACEHOLDER: nothing here works yet.
//
// CNC toolpaths from the design: setups, stock, tools, strategies, simulation and G-code.
// It will refer to Design's geometry by stable IDs and never copy it, so a
// design change flows straight through. Work starts after CAD step 50 (booleans and full topological naming), so a toolpath stays on the right pocket.

import type { EdgeReference, FaceReference, WorkspacePlugin } from "@fission/core";
import { showPlaceholder } from "@fission/ui";

/** DRAFT: one machining operation on referenced geometry. */
export interface Operation {
  id: string;
  strategy: "facing" | "pocket" | "contour" | "drill" | "adaptive";
  tool: string;
  geometry: (FaceReference | EdgeReference)[];
}

/** Turns operations into G-code for a machine. Not implemented yet. */
export function postProcess(_ops: Operation[], _machine: string): string {
  throw new Error("not implemented");
}

export const manufactureWorkspace: WorkspacePlugin = {
  id: "manufacture",
  title: "Manufacture",
  summary: "CNC toolpaths from the design: setups, stock, tools, strategies, simulation and G-code.",
  status: "placeholder",
  representations: { produces: [], accepts: [] },
  mount(ctx) {
    showPlaceholder(ctx.panel, {
      title: "Manufacture",
      summary: "CNC toolpaths from the design: setups, stock, tools, strategies, simulation and G-code.",
      plans: ["Setups with stock and work coordinates", "A tool library shared across projects", "2D, 2.5D and 3D strategies on design faces and edges, by reference", "Toolpath simulation in the shared viewport", "G-code through post-processors for different machines"],
      startsAfter: "after CAD step 50 (booleans and full topological naming), so a toolpath stays on the right pocket",
    });
    return () => {};
  },
};
