// The one place Design turns "this body / face / edge" into a reference.
//
// PLACEHOLDER IDS until topological naming (step 32): a face or edge is
// named by the feature that built the body and the kernel's index of that
// face or edge, e.g. "face:feature-1/3". Kernel indices are not stable: an
// edit that changes the topology can renumber them, so these ids may point
// at a different face after such an edit (17e checks and warns). Step 32
// replaces this function's body; nothing else builds ids.

import type { GeometryReference, StableId } from "@fission/core";

/** Says what every id from `designReference` is, for tests and the properties panel. */
export const PLACEHOLDER_ID_NOTE = "Placeholder id (feature and kernel index) until topological naming, step 32";

/**
 * The reference for a body (`index` left out) or for the face or edge with
 * this kernel index on the body `featureId` built. Bad input throws: an
 * empty feature id, an index on a body, a missing or non-integer index.
 */
export function designReference(kind: GeometryReference["kind"], featureId: string, index?: number): GeometryReference {
  if (featureId.length === 0 || /[:/]/.test(featureId)) throw new Error(`invalid feature id ${JSON.stringify(featureId)}`);
  if (kind === "body") {
    if (index !== undefined) throw new Error("a body reference takes no index");
    return { kind, id: `body:${featureId}` as StableId };
  }
  if (index === undefined || !Number.isInteger(index) || index < 0) throw new Error(`a ${kind} reference needs a kernel index (a whole number ≥ 0), got ${index}`);
  return { kind, id: `${kind}:${featureId}/${index}` as StableId };
}
