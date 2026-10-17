// @fission/laser: the Laser workspace. PLACEHOLDER: nothing here works yet.
//
// 2D jobs for laser and vinyl cutters: cut, engrave and score layers, preview and machine control.
// It will refer to Design's geometry by stable IDs and never copy it, so a
// design change flows straight through. Work starts after CAD step 33 (when the sketcher is solid).

import type { FaceReference, WorkspacePlugin } from "@fission/core";
import { showPlaceholder } from "@fission/ui";

/** DRAFT: one laser job. Shapes come from design faces by reference. */
export interface LaserJob {
  id: string;
  layers: { mode: "cut" | "engrave" | "score"; power: number; speed: number; shapes: FaceReference[] }[];
}

/** Exports a job as SVG. Not implemented yet. */
export function exportSvg(_job: LaserJob): string {
  throw new Error("not implemented");
}

export const laserWorkspace: WorkspacePlugin = {
  id: "laser",
  title: "Laser",
  summary: "2D jobs for laser and vinyl cutters: cut, engrave and score layers, preview and machine control.",
  status: "placeholder",
  representations: { produces: [], accepts: [] },
  commands: [],
  mount(ctx) {
    showPlaceholder(ctx.properties, {
      title: "Laser",
      summary: "2D jobs for laser and vinyl cutters: cut, engrave and score layers, preview and machine control.",
      plans: ["Cut, engrave and score layers with power and speed settings", "Flat faces and sketches taken straight from Design, by reference (sheet-metal flat patterns later)", "Job preview with time estimate", "DXF and SVG import and export", "Machine control for common controllers"],
      startsAfter: "after CAD step 33 (when the sketcher is solid)",
    });
    return { unmount: () => ctx.properties.replaceChildren() };
  },
};
