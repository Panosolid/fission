// Design's commands, as data (the command API in core). The panel and the
// AI assistant do the same thing through these: the AI gets schemas
// generated from them and can't do anything a user couldn't. There are
// two: set the part (change it, or add a body at the marker), and export
// every body shown.

import type { Command, CommandSpec } from "@fission/core";
import { withPart, type DesignDocument } from "./document.ts";
import type { ShapeKind } from "./profiles.ts";

export const SHAPES: readonly ShapeKind[] = ["box", "cylinder", "sphere", "l-bracket", "plate", "slot", "star"];

export const DESIGN_COMMANDS: readonly CommandSpec[] = [
  {
    op: "set_part",
    summary: "Make the part a shape of these sizes. The part is the last body the timeline builds: set_part changes it in place when it is one of these shapes, and otherwise (an extruded sketch, or no body) adds a new body at the timeline marker. Cylinders and spheres use width as the diameter; other shapes extrude a ready-made profile by the height.",
    params: {
      shape: { type: "choice", values: SHAPES, description: "which shape" },
      width: { type: "length", description: "width, or diameter for a cylinder or sphere" },
      // Optional (AI4): a left-out size keeps the part's current one, and cylinders and spheres need
      // no depth. Required, small models filled the sizes a shape ignores with 0, which is refused.
      depth: { type: "length", optional: true, description: "depth; leave it out for a cylinder or sphere, or to keep the current depth" },
      height: { type: "length", optional: true, description: "height, or how far a profile is extruded; leave it out for a sphere, or to keep the current height" },
    },
  },
  {
    op: "export_stl",
    summary: "Download every body shown as one binary STL file, for printing or another program. Warns when a body is too big for STL's single-precision numbers.",
    params: {},
  },
];

/** The sizes each shape is built from; the others it ignores. */
const NEEDS: Record<ShapeKind, readonly ("depth" | "height")[]> = { box: ["depth", "height"], cylinder: ["height"], sphere: [], "l-bracket": ["depth", "height"], plate: ["depth", "height"], slot: ["depth", "height"], star: ["depth", "height"] };

/**
 * The document a parsed Design command makes from `current` (none: a fresh
 * part); set_part keeps its sketches. With no part to keep sizes from (the
 * panel's own command always names all three), a size the shape needs but
 * the command leaves out is an error; one it ignores is never read.
 */
export function documentFor(command: Command, current?: DesignDocument | null): DesignDocument {
  // export_stl makes no document: it saves the one there is.
  if (command.op !== "set_part") throw new Error(`Design has no command ${command.op}`);
  const { shape, width, depth, height } = command as unknown as { shape: ShapeKind; width: number; depth?: number; height?: number };
  for (const key of NEEDS[shape]) if (command[key] === undefined) throw new Error(`set_part: a ${shape} needs its ${key}`);
  return withPart(current, shape, width, depth ?? width, height ?? width);
}
