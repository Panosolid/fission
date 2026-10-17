// The one place Design turns "this body / face / edge" into a reference.
//
// PLACEHOLDER IDS until topological naming (step 24): a face or edge is
// named by the feature that built the body and the kernel's index of that
// face or edge, e.g. "face:feature-1/3". Kernel indices are not stable: an
// edit that changes the topology can renumber them, so these ids may point
// at a different face after such an edit (17e checks and warns). Step 24
// replaces this function's body; nothing else builds ids.

import type { GeometryReference, OutlineReference, StableId } from "@fission/core";

/** Says what every id from `designReference` is, for tests and the properties panel. */
export const PLACEHOLDER_ID_NOTE = "Placeholder id (feature and kernel index) until topological naming, step 24";

/**
 * The reference for a body (`index` left out) or for the face or edge with
 * this kernel index on the body `featureId` built. Bad input throws: an
 * empty feature id, an index on a body, a missing or non-integer index.
 */
export function designReference(kind: Exclude<GeometryReference["kind"], "outline">, featureId: string, index?: number): GeometryReference {
  if (featureId.length === 0 || /[:/]/.test(featureId)) throw new Error(`invalid feature id ${JSON.stringify(featureId)}`);
  if (kind === "body") {
    if (index !== undefined) throw new Error("a body reference takes no index");
    return { kind, id: `body:${featureId}` as StableId };
  }
  if (index === undefined || !Number.isInteger(index) || index < 0) throw new Error(`a ${kind} reference needs a kernel index (a whole number ≥ 0), got ${index}`);
  return { kind, id: `${kind}:${featureId}/${index}` as StableId };
}

/**
 * What `designReference` built a reference from: its kind, feature id and
 * (for a face or edge) kernel index; null for an id it did not build.
 */
export function readDesignReference(ref: GeometryReference): { kind: GeometryReference["kind"]; featureId: string; index?: number } | null {
  const m = /^(body|face|edge):([^:/]+)(?:\/(0|[1-9]\d*))?$/.exec(ref.id);
  if (!m || m[1] !== ref.kind || (m[3] === undefined) !== (ref.kind === "body")) return null;
  return m[3] === undefined ? { kind: ref.kind, featureId: m[2] } : { kind: ref.kind, featureId: m[2], index: Number(m[3]) };
}

/**
 * The reference for one of the document's profiles, e.g.
 * "outline:profile-1". Profiles have ids of their own in the document, so
 * this one is stable today (sketch profiles at step 21 will be too).
 */
export function profileReference(profileId: string): OutlineReference {
  if (profileId.length === 0 || /[:/]/.test(profileId)) throw new Error(`invalid profile id ${JSON.stringify(profileId)}`);
  return { kind: "outline", id: `outline:${profileId}` as StableId };
}

/** The profile id `profileReference` built this reference from; null for any other reference. */
export function readProfileReference(ref: { kind: string; id: string }): string | null {
  const m = /^outline:([^:/]+)$/.exec(ref.id);
  return ref.kind === "outline" && m ? m[1] : null;
}
