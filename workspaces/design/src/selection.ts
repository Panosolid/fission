// What Design shows for the selection (step 17d): what the viewport draws
// in the selection colour, and the properties panel's rows. Pure, so both
// are unit-tested; workspace.ts applies them on every selection change.

import type { Feature, GeometryReference, ViewportHighlight } from "@fission/core";
import { partFeature, profileLabel, type DesignDocument, type ReadyProfile } from "./document.ts";
import { readDesignReference, readProfileReference, resolveReference, sharedBy } from "./references.ts";
import { bodyOf, findInScene, resolveInScene, type Scene, type ShownBody } from "./scene.ts";

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
/** Said in place of a type when the edit gave the item's name to more than one face or edge (step 25a4). */
export const NAME_SHARED = "matches more than one";
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
    if (type === undefined && sharedBy(item, shown?.names ?? null) > 1) return { name: referenceLabel(item), type: NAME_SHARED, id: item.id };
    return { name: referenceLabel(item), type: type ?? (scene ? NOT_ON_BODY : "…"), id: item.id };
  });
}

/** What the properties panel's Feature and Body sections describe: a feature, and its body when one is shown. */
export interface PanelFocus {
  feature: Feature;
  /** Its body in the scene; null when none is shown (the feature failed, or no rebuild has drawn it yet). */
  body: ShownBody | null;
}

/**
 * What the Feature and Body sections describe: the feature of the newest
 * selected item that names one in `doc` (a body, or a face or edge of it),
 * with its body when shown; else the part the Parameters edit
 * (`partFeature`), with its body when shown; null with no part. A selected
 * body that did not build is described as having none, never by another
 * body's numbers (bug hunt 2026-10-19, finding 5). Items that name no
 * feature of `doc` (a profile, a deleted feature) are passed over.
 */
export function panelFocus(items: readonly GeometryReference[], scene: Scene | null, doc: DesignDocument): PanelFocus | null {
  const focus = (feature: Feature): PanelFocus => ({ feature, body: scene?.bodies.find((b) => b.feature === feature.id) ?? null });
  for (let i = items.length - 1; i >= 0; i--) {
    const r = readDesignReference(items[i]);
    const feature = r && doc.timeline.features.find((f) => f.id === r.featureId);
    if (feature) return focus(feature);
  }
  const part = partFeature(doc);
  return part === null ? null : focus(part);
}

/**
 * What survives a rebuild (17e, by name from step 24c): a face or edge of
 * a shown body is kept while that body has a face or edge of that name,
 * whatever the kernel now numbers it (a resize, a corner moved, the
 * outline walked from another line), and dropped when its face is gone
 * (its sketch curve deleted, a box turned into a cylinder, which has no
 * front). One whose name the edit gave to two or more faces or edges is
 * dropped too and listed in `shared` (step 25a4): it is never moved to one
 * of them. Body references stay; references this function cannot read, or
 * to a feature with no body shown, are left alone (not Design's to judge
 * here). A profile (an outline reference Design built) is kept while
 * `profileIds` has it: a change to a shape with no profile, a box, drops it.
 */
export function survivors(
  items: readonly GeometryReference[],
  scene: Scene,
  profileIds: readonly string[] = [],
): { kept: GeometryReference[]; dropped: GeometryReference[]; shared: GeometryReference[] } {
  const kept: GeometryReference[] = [];
  const dropped: GeometryReference[] = [];
  const shared: GeometryReference[] = [];
  for (const item of items) {
    const r = readDesignReference(item);
    let keep = true;
    const profile = readProfileReference(item);
    if (profile !== null) keep = profileIds.includes(profile);
    else if (r && r.kind !== "body" && bodyOf(scene, item) >= 0) {
      const found = findInScene(item, scene);
      keep = found.status === "found";
      if (found.status === "shared") shared.push(item);
    }
    (keep ? kept : dropped).push(item);
  }
  return { kept, dropped, shared };
}

/** "A", "A and B", "A, B and C". */
function listed(names: readonly string[]): string {
  return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The visible note for references a rebuild dropped ("" when none were);
 * `shared`, the ones among them whose name the edit gave to more than one
 * face or edge, are said apart, so the user knows to pick again.
 */
export function droppedNote(dropped: readonly GeometryReference[], shared: readonly GeometryReference[] = []): string {
  if (dropped.length === 0) return "";
  const isShared = (d: GeometryReference) => shared.some((s) => s.kind === d.kind && s.id === d.id);
  const names = dropped.map((d) => (readProfileReference(d) !== null ? "the profile" : referenceLabel(d)));
  const gone = dropped.filter((d) => d.kind !== "outline" && !isShared(d));
  const twice = dropped.filter(isShared);
  const one = (n: number, it: string, they: string) => (n === 1 ? it : they);
  const why = [
    ...(gone.length > 0 && twice.length === 0 ? ["The edit took them off the body, so they could not be followed."] : []),
    ...(gone.length > 0 && twice.length > 0 ? [`The edit took ${listed(gone.map(referenceLabel))} off the body, so ${one(gone.length, "it", "they")} could not be followed.`] : []),
    ...(twice.length > 0
      ? [
          `${listed(twice.map(referenceLabel))} now ${one(twice.length, "matches", "match")} more than one ${twice.every((d) => d.kind === "face") ? "face" : twice.every((d) => d.kind === "edge") ? "edge" : "face or edge"}, so ${one(twice.length, "it was", "they were")} not moved to any of them: pick again.`,
        ]
      : []),
    ...(dropped.some((d) => d.kind === "outline") ? ["The part has no profile now."] : []),
  ];
  return `Taken out of the selection: ${names.join(", ")}. ${why.join(" ")}`;
}
