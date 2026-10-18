// What Design shows for the selection (step 17d): what the viewport draws
// in the selection colour, and the properties panel's rows. Pure, so both
// are unit-tested; workspace.ts applies them on every selection change.

import type { GeometryReference, ViewportHighlight } from "@fission/core";
import { profileLabel, type ReadyProfile } from "./document.ts";
import { readDesignReference, readProfileReference, resolveReference } from "./references.ts";
import { bodyOf, resolveInScene, type Scene, type ShownBody } from "./scene.ts";

/**
 * The viewport highlight for these items on the bodies shown (`scene`,
 * scene.ts; null before any is built), in the joined mesh's numbering. A
 * selected body tints its faces; every shown body selected is the whole
 * highlight's `body`. Faces and edges no shown body has, bodies not shown,
 * and references not built by `designReference` (a profile among them: it
 * is not part of a body) draw nothing.
 */
export function highlightOf(items: readonly GeometryReference[], scene: Scene | null): ViewportHighlight {
  const highlight = { body: false, faces: [] as number[], edges: [] as number[] };
  if (scene === null) return highlight;
  const bodies = new Set<number>();
  for (const item of items) {
    const r = readDesignReference(item);
    if (r === null) continue;
    if (r.kind === "body") {
      const b = bodyOf(scene, item);
      if (b >= 0) bodies.add(b);
    } else {
      const i = resolveInScene(item, scene);
      if (i !== null) (r.kind === "face" ? highlight.faces : highlight.edges).push(i);
    }
  }
  if (bodies.size > 0 && bodies.size === scene.bodies.length) return { ...highlight, body: true };
  for (const b of [...bodies].sort((x, y) => x - y)) {
    for (let f = 0; f < scene.bodies[b].view.faces; f++) {
      const i = scene.faceStart[b] + f;
      if (!highlight.faces.includes(i)) highlight.faces.push(i);
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
 * One row per selected item, in selection order, from the bodies shown
 * (`scene`, null before the first build): a body is "Body n", its
 * browser row's number; a face or edge no shown body has, or a body not shown,
 * says so instead of a type. A profile is named from `profiles` (the
 * document's), as the browser names it, of type "outline"; one the
 * document no longer has says so.
 */
export function selectionRows(items: readonly GeometryReference[], scene: Scene | null, profiles: readonly ReadyProfile[] = []): SelectionRow[] {
  return items.map((item) => {
    if (item.kind === "outline") {
      const profile = profiles.find((p) => p.id === readProfileReference(item));
      return profile ? { name: profileLabel(profile), type: "outline", id: item.id } : { name: "Outline", type: NOT_IN_DESIGN, id: item.id };
    }
    const r = readDesignReference(item);
    if (!r) return { name: referenceLabel(item), type: NOT_ON_BODY, id: item.id };
    const b = scene === null ? -1 : bodyOf(scene, item);
    if (r.kind === "body") return b >= 0 ? { name: `Body ${scene!.bodies[b].place}`, type: "solid", id: item.id } : { name: "Body", type: scene ? NOT_ON_BODY : "…", id: item.id };
    const shown = b >= 0 ? scene!.bodies[b] : undefined;
    const i = shown ? resolveReference(item, shown.names) : null;
    const types = r.kind === "face" ? shown?.view.face_types : shown?.view.edge_types;
    const type = i !== null && types ? types[i] : undefined;
    return { name: referenceLabel(item), type: type ?? (scene ? NOT_ON_BODY : "…"), id: item.id };
  });
}

/**
 * The body the properties panel's Feature and Body sections describe: the
 * one the newest selected item is on (the body itself, or a face or edge
 * of it), else the last body shown, the part the Parameters edit; null
 * with no body shown. Items on no shown body (a profile, a body that did
 * not build) are passed over.
 */
export function panelBody(items: readonly GeometryReference[], scene: Scene | null): ShownBody | null {
  if (scene === null || scene.bodies.length === 0) return null;
  for (let i = items.length - 1; i >= 0; i--) {
    const b = bodyOf(scene, items[i]);
    if (b >= 0) return scene.bodies[b];
  }
  return scene.bodies[scene.bodies.length - 1];
}

/**
 * What survives a rebuild (17e, by name from step 24c): a face or edge of
 * a shown body is kept while that body has a face or edge of that name,
 * whatever the kernel now numbers it (a resize, a corner moved, the
 * outline walked from another line), and dropped when its face is gone
 * (its sketch curve deleted, a box turned into a cylinder, which has no
 * front). Body references stay; references this function cannot read, or
 * to a feature with no body shown, are left alone (not Design's to judge
 * here). A profile (an outline reference Design built) is kept while
 * `profileIds` has it: a change to a shape with no profile, a box, drops it.
 */
export function survivors(items: readonly GeometryReference[], scene: Scene, profileIds: readonly string[] = []): { kept: GeometryReference[]; dropped: GeometryReference[] } {
  const kept: GeometryReference[] = [];
  const dropped: GeometryReference[] = [];
  for (const item of items) {
    const r = readDesignReference(item);
    let keep = true;
    const profile = readProfileReference(item);
    if (profile !== null) keep = profileIds.includes(profile);
    else if (r && r.kind !== "body" && bodyOf(scene, item) >= 0) keep = resolveInScene(item, scene) !== null;
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
