// DRAFT: design feedback from downstream workspaces (I17). Slice,
// Manufacture, Simulate and Circuit report problems back into Design
// through analysis overlays on the faces concerned and lines in the
// properties panel, while the user is still designing:
// - printability: overhangs, thin walls, estimated print time and weight
// - machinability: internal corners sharper than the smallest tool
// - stress: simulation results
// - clearance: board components colliding with the case

import type { AnalysisOverlay } from "./overlay.ts";
import type { WorkspaceId } from "./project.ts";

export type FeedbackKind = "printability" | "machinability" | "stress" | "clearance";

export interface DesignFeedback {
  from: WorkspaceId;
  kind: FeedbackKind;
  /** One line for the properties panel, e.g. "2 walls thinner than 0.8 mm". */
  summary: string;
  /** Painted on the design. */
  overlay: AnalysisOverlay;
  /** Feedback goes out of date with the design it was computed for (graph.ts). */
  computedFor: string;
}

/** Shows feedback in Design. Not implemented yet. */
export function reportFeedback(_feedback: DesignFeedback): void {
  throw new Error("not implemented");
}
