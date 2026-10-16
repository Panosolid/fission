// Design's commands, as data (the command API in core). The panel and the
// AI assistant do the same thing through these: the AI gets schemas
// generated from them and can't do anything a user couldn't. Until the
// timeline (step 32) there is one: set the part.

import type { Command, CommandSpec } from "@fission/core";
import { partDocument, type DesignDocument } from "./document.ts";
import type { ShapeKind } from "./profiles.ts";

export const SHAPES: readonly ShapeKind[] = ["box", "cylinder", "sphere", "l-bracket", "plate", "slot", "star"];

export const DESIGN_COMMANDS: readonly CommandSpec[] = [
  {
    op: "set_part",
    summary: "Make the part a shape of these sizes: feature 1 of the timeline. Cylinders and spheres use width as the diameter; other shapes extrude a ready-made profile by the height.",
    params: {
      shape: { type: "choice", values: SHAPES, description: "which shape" },
      width: { type: "length", description: "width, or diameter for a cylinder or sphere" },
      depth: { type: "length", description: "depth (ignored by cylinders and spheres)" },
      height: { type: "length", description: "height, or how far a profile is extruded (ignored by spheres)" },
    },
  },
];

/** The document a parsed Design command makes. */
export function documentFor(command: Command): DesignDocument {
  if (command.op !== "set_part") throw new Error(`Design has no command ${command.op}`);
  const { shape, width, depth, height } = command as unknown as { shape: ShapeKind; width: number; depth: number; height: number };
  return partDocument(shape, width, depth, height);
}
