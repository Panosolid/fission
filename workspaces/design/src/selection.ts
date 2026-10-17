// What Design shows for the selection (step 17d): what the viewport draws
// in the selection colour, and the properties panel's rows. Pure, so both
// are unit-tested; workspace.ts applies them on every selection change.

import type { BodyView, GeometryReference, ViewportHighlight } from "@fission/core";
import { profileLabel, type ReadyProfile } from "./document.ts";
import type { BodyNames } from "./naming.ts";
import { readDesignReference, readProfileReference, resolveReference } from "./references.ts";

/**
 * The viewport highlight for these items on the body `featureId` built,
 * whose faces and edges `names` names (null before one is built). Faces
 * and edges not on it, other bodies, and references not built by
 * `designReference` (a profile among them: it is not part of the body),
 * draw nothing.
 */
export function highlightOf(items: readonly GeometryReference[], featureId: string, names: BodyNames | null): ViewportHighlight {
  const highlight = { body: false, faces: [] as number[], edges: [] as number[] };
  for (const item of items) {
    const r = readDesignReference(item);
    if (r === null) continue;
    if (r.kind === "body") highlight.body ||= r.featureId === featureId;
    else {
      const i = resolveReference(item, names);
      if (i !== null) (r.kind === "face" ? highlight.faces : highlight.edges).push(i);
    }
  }
  return highlight;
}

export interface SelectionRow {
  /** "Body 1", "Top face", "Side face of line-4", "Edge of Top and Front": the kind and its name; a profile's name. */
  name: string;
  /** The body's kind, or the face's surface or the edge's curve type, from the last built body. */
  type: string;
  /** The stable name, shown so the user sees what is stored. */
  id: string;
}

/** Said in place of a type the last built body cannot give. */
export const NOT_ON_BODY = "not on the current body";
/** Said for a selected outline that is not one of the document's profiles. */
export const NOT_IN_DESIGN = "not in the design";

/** A face's name part in words: "top" → "Top", "side:line-4" → "Side of line-4". */
function faceWords(part: string): string {
  const [role, curve] = part.split(":");
  const word = role[0].toUpperCase() + role.slice(1);
  return curve === undefined ? word : `${word} of ${decodeURIComponent(curve)}`;
}

/** What a face or edge reference is called in the selection list and the note: "Top face", "Edge of Side of line-4 and Start". */
export function referenceLabel(ref: GeometryReference): string {
  const r = readDesignReference(ref);
  if (r === null || r.part === undefined) return ref.kind[0].toUpperCase() + ref.kind.slice(1);
  if (r.kind === "face") return `${faceWords(r.part)} face`;
  const [a, b] = r.part.split(/[+>]/);
  return `Edge of ${faceWords(a)} and ${faceWords(b)}`;
}

/**
 * One row per selected item, in selection order. `view` and `names` are
 * the last built body's (null before the first build): a face or edge it
 * does not have, or a reference to another feature's body, says so instead
 * of a type. A profile is named from `profiles` (the document's), as the
 * browser names it, of type "outline"; one the document no longer has says so.
 */
export function selectionRows(items: readonly GeometryReference[], featureId: string, view: BodyView | null, names: BodyNames | null, profiles: readonly ReadyProfile[] = []): SelectionRow[] {
  return items.map((item) => {
    if (item.kind === "outline") {
      const profile = profiles.find((p) => p.id === readProfileReference(item));
      return profile ? { name: profileLabel(profile), type: "outline", id: item.id } : { name: "Outline", type: NOT_IN_DESIGN, id: item.id };
    }
    const r = readDesignReference(item);
    if (!r) return { name: referenceLabel(item), type: NOT_ON_BODY, id: item.id };
    if (r.kind === "body") return { name: "Body 1", type: r.featureId === featureId ? "solid" : NOT_ON_BODY, id: item.id };
    const i = resolveReference(item, names);
    const types = r.kind === "face" ? view?.face_types : view?.edge_types;
    const type = i !== null && types ? types[i] : undefined;
    return { name: referenceLabel(item), type: type ?? (view ? NOT_ON_BODY : "…"), id: item.id };
  });
}

/**
 * What survives a rebuild (17e, by name from step 24c): a face or edge of
 * the rebuilt body's feature is kept while the new body has a face or
 * edge of that name, whatever the kernel now numbers it (a resize, a corner
 * moved, the outline walked from another line), and dropped when its face
 * is gone (its sketch curve deleted, a box turned into a cylinder, which
 * has no front). Body references stay; references this function cannot
 * read, or to another feature, are left alone (not Design's to judge here).
 * A profile (an outline reference Design built) is kept while `profileIds`
 * has it: a change to a shape with no profile, a box, drops it.
 */
export function survivors(items: readonly GeometryReference[], names: BodyNames, profileIds: readonly string[] = []): { kept: GeometryReference[]; dropped: GeometryReference[] } {
  const kept: GeometryReference[] = [];
  const dropped: GeometryReference[] = [];
  for (const item of items) {
    const r = readDesignReference(item);
    let keep = true;
    const profile = readProfileReference(item);
    if (profile !== null) keep = profileIds.includes(profile);
    else if (r && r.featureId === names.feature && r.kind !== "body") keep = resolveReference(item, names) !== null;
    (keep ? kept : dropped).push(item);
  }
  return { kept, dropped };
}

/** The visible note for references a rebuild dropped ("" when none were). */
export function droppedNote(dropped: readonly GeometryReference[]): string {
  if (dropped.length === 0) return "";
  const names = dropped.map((d) => (readProfileReference(d) !== null ? "the profile" : referenceLabel(d)));
  const why = [
    ...(dropped.some((d) => d.kind !== "outline") ? ["The edit took them off the body, so they could not be followed."] : []),
    ...(dropped.some((d) => d.kind === "outline") ? ["The part has no profile now."] : []),
  ];
  return `Taken out of the selection: ${names.join(", ")}. ${why.join(" ")}`;
}
