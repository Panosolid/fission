// DRAFT: project-wide search (I14). One search box finds things in every
// workspace by what they ARE (their intent), not by name alone: "M3" finds
// every M3 hole in Design, M3 screws in an assembly and M3 mounting holes
// on a board in Circuit.

import type { Origin } from "./feature.ts";
import type { Project } from "./project.ts";

export interface SearchHit {
  /** Where it is, e.g. "Hole: 3.2 mm, through" in Design. */
  origin: Origin;
  /** Why it matched, e.g. "M3 clearance hole". */
  reason: string;
}

/** Searches every workspace's objects. Not implemented yet. */
export function searchProject(_project: Project, _query: string): SearchHit[] {
  throw new Error("not implemented");
}
