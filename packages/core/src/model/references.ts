// DRAFT: will change as the real workspaces are built.
//
// Downstream workspaces never copy geometry. They point at Design's bodies,
// faces and edges by stable IDs from topological naming (scheme chosen at
// roadmap step 24, full naming at step 50), and re-resolve those IDs every
// time the design changes.

/** A topological-naming ID, e.g. "face created by feature X, from profile edge Y, side Z". */
export type StableId = string & { readonly __stableId: unique symbol };

export interface BodyReference {
  kind: "body";
  id: StableId;
}

export interface FaceReference {
  kind: "face";
  id: StableId;
}

export interface EdgeReference {
  kind: "edge";
  id: StableId;
}

/** A closed 2D shape: a Design profile now, sketch profiles from step 21, Vector paths from V1. */
export interface OutlineReference {
  kind: "outline";
  id: StableId;
}

export type GeometryReference = BodyReference | FaceReference | EdgeReference | OutlineReference;

/**
 * What a reference points at after the latest design rebuild. An unresolved
 * reference is shown as a warning on the item that holds it (like a failed
 * timeline step), never dropped silently.
 */
export type Resolution = { status: "resolved" } | { status: "unresolved"; reason: string };

/** Re-resolves a reference against the current design. Not implemented until step 24. */
export function resolveReference(_ref: GeometryReference): Resolution {
  throw new Error("not implemented");
}
