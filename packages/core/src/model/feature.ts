// Features that know what they are, and objects that know where they came from.
//
// A timeline feature stores its INTENT (type, parameters, purpose), not
// just the geometry it made, so other workspaces can use it directly: CAM
// drills holes, Laser tells cuts from engraves, Slice treats holes
// specially. Every object also carries its PROVENANCE ("where did I come
// from?") and the ids it depends on, which feed the dependency graph
// (graph.ts).
//
// This is the structure the full timeline (step 32) uses. Today Design's
// one part is feature #1 of a one-step timeline; step 32 appends to the
// list instead of converting an old format.

import type { WorkspaceId } from "./project.ts";

export type ParameterValue = number | string | boolean;

/** What a feature is for, in words and numbers. */
export interface Intent {
  /** e.g. "box", "extrude", later "hole", "pocket", "engrave". */
  type: string;
  /** Lengths in mm, angles in degrees. */
  parameters: Record<string, ParameterValue>;
  /** One line for people, e.g. "Box: 40 × 30 × 20 mm". */
  summary: string;
  /** Optional: why it is there, e.g. "mounting hole for an M3 screw". */
  purpose?: string;
}

/** One object something came from, e.g. "Logo v3" in Vector. */
export interface Origin {
  workspace: WorkspaceId;
  id: string;
  label: string;
}

/** Where an object came from. */
export interface Provenance {
  /** The object itself. */
  self: Origin;
  /** What it was made from or applied to, in order. */
  from: Origin[];
}

/** One step of a timeline (Design today; CAM setups and print plates later use the same shape). */
export interface Feature {
  id: string;
  intent: Intent;
  provenance: Provenance;
  /** Ids of the objects this feature reads (profiles, sketches, earlier features). */
  dependsOn: string[];
  /** Turned off in the timeline: kept, but not built. */
  suppressed: boolean;
}

/** Features in build order. */
export interface Timeline {
  features: Feature[];
}

const workspaceNames: Record<WorkspaceId, string> = {
  design: "Design",
  render: "Render",
  simulate: "Simulate",
  manufacture: "Manufacture",
  laser: "Laser",
  slice: "Slice",
  circuit: "Circuit",
  vector: "Vector",
  image: "Image",
  layout: "Layout",
};

/** A workspace's name as people read it, e.g. "Design". */
export const workspaceName = (id: WorkspaceId): string => workspaceNames[id];

const where = (o: Origin) => `${o.label} in ${workspaceNames[o.workspace]}`;

/**
 * "Where did I come from?" in one sentence for the properties panel, e.g.
 * "This engraving comes from Logo v3 in Vector, applied to Body 2 in Design."
 */
export function describeProvenance(p: Provenance): string {
  if (p.from.length === 0) return `${p.self.label} was made in ${workspaceNames[p.self.workspace]}.`;
  const [first, ...rest] = p.from;
  const applied = rest.length ? `, applied to ${rest.map(where).join(", then ")}` : "";
  return `${p.self.label} comes from ${where(first)}${applied}.`;
}
