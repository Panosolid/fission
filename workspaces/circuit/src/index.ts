// @fission/circuit: the Circuit workspace. PLACEHOLDER: nothing here works yet.
//
// Electronics: schematic capture, board layout, component library, routing,
// design-rule checks, and Gerber and drill export. Its key job is designing
// the board and its enclosure together with Design: the board outline comes
// from a Design face or sketch, components sit in 3D inside the enclosure
// with live collision checks, and mounting holes are linked both ways (move
// one on the board and the screw post in the case moves, and the other way
// round). Work starts after CAD step 75 (full topological naming at 50,
// assemblies and joints at 74–75).

import type { FaceReference, WorkspacePlugin } from "@fission/core";
import { showPlaceholder } from "@fission/ui";

const summary =
  "Electronics: schematics, board layout, routing and design-rule checks, designed together with the enclosure in Design.";

/** DRAFT: a board. Its outline is a Design face by reference, never a copy. */
export interface Board {
  id: string;
  outline: FaceReference;
  layers: number;
  /** Mounting holes, each linked both ways to a screw post in Design. */
  mountingHoles: { id: string; diameter: number; post: FaceReference }[];
}

/** Writes Gerber and drill files for manufacturing a board. Not implemented yet. */
export function exportGerber(_board: Board): Record<string, string> {
  throw new Error("not implemented");
}

/** Checks a board against its design rules (clearances, widths). Not implemented yet. */
export function checkDesignRules(_board: Board): { message: string; at: [number, number] }[] {
  throw new Error("not implemented");
}

export const circuitWorkspace: WorkspacePlugin = {
  id: "circuit",
  title: "Circuit",
  summary,
  status: "placeholder",
  representations: { produces: [], accepts: [] },
  commands: [],
  mount(ctx) {
    showPlaceholder(ctx.properties, {
      title: "Circuit",
      summary,
      plans: [
        "Schematic capture with a shared component library",
        "Board layout and routing, with design-rule checks",
        "Board outline taken from a face or sketch in Design, by reference",
        "Components shown in 3D inside the enclosure, with live collision checks",
        "Mounting holes linked both ways to screw posts in the enclosure",
        "Gerber and drill export",
      ],
      startsAfter: "after CAD step 75 (full topological naming, then assemblies and joints)",
    });
    return () => ctx.properties.replaceChildren();
  },
};
