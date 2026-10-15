// DRAFT: will change as the real workspaces are built.
//
// One project file holds everything: the design timeline, render scenes,
// simulation studies, CAM setups, laser jobs and print plates. Each
// workspace stores its own data under its id and refers to design geometry
// only through references (references.ts).

import type { Material } from "./material";

export type WorkspaceId = "design" | "render" | "simulate" | "manufacture" | "laser" | "slice";

/** One units system for every workspace. The kernel always works in mm. */
export type LengthUnit = "mm" | "cm" | "m" | "in";

export interface Project {
  formatVersion: 1;
  name: string;
  units: { length: LengthUnit };
  materials: Material[];
  /** Each workspace's own saved data (its WorkspacePlugin's save/load). */
  workspaces: Partial<Record<WorkspaceId, unknown>>;
}
