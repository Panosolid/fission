// The one place Design turns "this body / face / edge" into a reference.
//
// Stable names (step 24c, naming.ts): a body is named by the feature that
// built it, "body:feature-1"; a face by that feature, its role and, for an
// extrude's side, its sketch curve, "face:feature-7/side:line-4"; an edge by
// the two faces it joins, "edge:feature-7/side:line-4+start". An edit that
// renumbers the kernel's faces leaves these names alone, so a reference
// follows its face through it, and one whose face is gone resolves to
// nothing, never to another face. Nothing else builds ids.

import type { GeometryReference, OutlineReference, StableId } from "@fission/core";
import { indexOf, type BodyNames } from "./naming.ts";

/** Says what every face and edge id is, for the properties panel. */
export const NAME_NOTE = "Stable name: the feature, the face's role in it and its sketch curve (an edge: the two faces it joins)";

/** The reference for the body `featureId` built. Bad input throws: an empty feature id, or one with ":" or "/". */
export function bodyReference(featureId: string): GeometryReference {
  if (featureId.length === 0 || /[:/]/.test(featureId)) throw new Error(`invalid feature id ${JSON.stringify(featureId)}`);
  return { kind: "body", id: `body:${featureId}` as StableId };
}

/**
 * The reference for the face or edge with this kernel index on the body
 * `names` names; null when that index has no name (never a reference that
 * could point at another face later). Bad input throws: an index that is
 * not a whole number ≥ 0.
 */
export function designReference(kind: "face" | "edge", names: BodyNames, index: number): GeometryReference | null {
  if (!Number.isInteger(index) || index < 0) throw new Error(`a ${kind} reference needs a kernel index (a whole number ≥ 0), got ${index}`);
  const part = (kind === "face" ? names.faces : names.edges)[index] ?? null;
  return part === null ? null : { kind, id: `${kind}:${names.feature}/${part}` as StableId };
}

// A face's part: a role, then for a side ":" and its curve id (escaped, so
// it holds none of ": / + >"). An edge's: two faces' parts joined by "+"
// (a set) or ">" (in order).
const FACE = "[a-z]+(?::[^:/+>]+)?";
const PART = { face: new RegExp(`^${FACE}$`), edge: new RegExp(`^${FACE}[+>]${FACE}$`) };

/**
 * What `bodyReference` or `designReference` built a reference from: its
 * kind, feature id and (for a face or edge) the name after the feature;
 * null for an id they did not build.
 */
export function readDesignReference(ref: GeometryReference): { kind: GeometryReference["kind"]; featureId: string; part?: string } | null {
  const m = /^(body|face|edge):([^:/]+)(?:\/(.+))?$/.exec(ref.id);
  if (!m || m[1] !== ref.kind) return null;
  if (m[1] === "body") return m[3] === undefined ? { kind: "body", featureId: m[2] } : null;
  if (m[3] === undefined || !PART[m[1] as "face" | "edge"].test(m[3])) return null;
  return { kind: ref.kind, featureId: m[2], part: m[3] };
}

/** The kernel index of the face or edge a reference names, on the body `names` names; null when it isn't on that body. */
export function resolveReference(ref: GeometryReference, names: BodyNames | null): number | null {
  const r = readDesignReference(ref);
  if (names === null || r === null || r.kind === "body" || r.kind === "outline" || r.featureId !== names.feature) return null;
  const i = indexOf(names, r.kind, r.part!);
  return i < 0 ? null : i;
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
