// @fission/slice: the Slice workspace. PLACEHOLDER: nothing here works yet.
//
// A 3D printing slicer for any printer, fed directly by the design.
// It will refer to Design's geometry by stable IDs and never copy it, so a
// design change flows straight through. Work starts after CAD step 73 (STL and 3MF export).

import type { BodyReference, WorkspacePlugin } from "@fission/core";
import { showPlaceholder } from "@fission/ui";

/** DRAFT: one build plate. Models are design bodies by reference. */
export interface Plate {
  id: string;
  printer: string;
  models: { body: BodyReference; position: [number, number]; rotation: number }[];
}

/** Slices a plate to G-code. Not implemented yet. */
export function slicePlate(_plate: Plate): string {
  throw new Error("not implemented");
}

export const sliceWorkspace: WorkspacePlugin = {
  id: "slice",
  title: "Slice",
  summary: "A 3D printing slicer for any printer, fed directly by the design.",
  status: "placeholder",
  representations: { produces: [], accepts: [] },
  mount(ctx) {
    showPlaceholder(ctx.panel, {
      title: "Slice",
      summary: "A 3D printing slicer for any printer, fed directly by the design.",
      plans: ["Printer profiles for any printer, not tied to one brand", "Supports, infill and walls", "Several plates per project; a plate updates when the design changes", "Layer preview and G-code export"],
      startsAfter: "after CAD step 73 (STL and 3MF export)",
    });
    return () => {};
  },
};
