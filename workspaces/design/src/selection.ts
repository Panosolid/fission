// What Design shows for the selection (step 17d): what the viewport draws
// in the selection colour, and the properties panel's rows. Pure, so both
// are unit-tested; workspace.ts applies them on every selection change.

import type { BodyView, GeometryReference, ViewportHighlight } from "@fission/core";
import { readDesignReference } from "./references.ts";

/**
 * The viewport highlight for these items on the body `featureId` built.
 * References to other bodies, or not built by `designReference`, draw nothing.
 */
export function highlightOf(items: readonly GeometryReference[], featureId: string): ViewportHighlight {
  const highlight = { body: false, faces: [] as number[], edges: [] as number[] };
  for (const item of items) {
    const r = readDesignReference(item);
    if (r?.featureId !== featureId) continue;
    if (r.kind === "body") highlight.body = true;
    else (r.kind === "face" ? highlight.faces : highlight.edges).push(r.index!);
  }
  return highlight;
}

export interface SelectionRow {
  /** "Body 1", "Face 3", "Edge 4": the kind and kernel index, numbered from 0 like the ids. */
  name: string;
  /** The body's kind, or the face's surface or the edge's curve type, from the last built body. */
  type: string;
  /** The placeholder id, shown so the user sees what is stored. */
  id: string;
}

/** Said in place of a type the last built body cannot give. */
export const NOT_ON_BODY = "not on the current body";

/**
 * One row per selected item, in selection order. `view` is the last built
 * body (null before the first build): a face or edge index it does not
 * have, or a reference to another feature's body, says so instead of a type.
 */
export function selectionRows(items: readonly GeometryReference[], featureId: string, view: BodyView | null): SelectionRow[] {
  return items.map((item) => {
    const r = readDesignReference(item);
    const kind = item.kind[0].toUpperCase() + item.kind.slice(1);
    if (!r) return { name: kind, type: NOT_ON_BODY, id: item.id };
    if (r.kind === "body") return { name: "Body 1", type: r.featureId === featureId ? "solid" : NOT_ON_BODY, id: item.id };
    const types = r.kind === "face" ? view?.face_types : view?.edge_types;
    const type = r.featureId === featureId && types ? types[r.index!] : undefined;
    return { name: `${kind} ${r.index}`, type: type ?? (view ? NOT_ON_BODY : "…"), id: item.id };
  });
}

/**
 * What survives a rebuild (17e). Until topological naming (step 32) a face
 * or edge is only its kernel index, so it is kept when the rebuilt body
 * still has that index with the same surface or curve type, on a body with
 * the same numbers of vertices, edges and faces as `before` (a resize keeps
 * them; a change of shape renumbers everything). `before` is null when no
 * earlier body is known (first build, or back from another workspace):
 * then the index and nothing else is checked. Body references to `featureId`
 * stay; references this function cannot read, or to another feature, are
 * left alone (not Design's to judge here).
 */
export function survivors(items: readonly GeometryReference[], featureId: string, before: BodyView | null, after: BodyView): { kept: GeometryReference[]; dropped: GeometryReference[] } {
  const sameTopology = before === null || (before.vertices === after.vertices && before.edges === after.edges && before.faces === after.faces);
  const kept: GeometryReference[] = [];
  const dropped: GeometryReference[] = [];
  for (const item of items) {
    const r = readDesignReference(item);
    let keep = true;
    if (r && r.featureId === featureId && r.kind !== "body") {
      const types = (v: BodyView) => (r.kind === "face" ? v.face_types : v.edge_types);
      const now = types(after)[r.index!];
      keep = now !== undefined && sameTopology && (before === null || types(before)[r.index!] === now);
    }
    (keep ? kept : dropped).push(item);
  }
  return { kept, dropped };
}

/** The visible note for references a rebuild dropped ("" when none were). */
export function droppedNote(dropped: readonly GeometryReference[]): string {
  if (dropped.length === 0) return "";
  const names = dropped.map((d) => {
    const r = readDesignReference(d);
    return r ? `${d.kind[0].toUpperCase()}${d.kind.slice(1)} ${r.index}` : d.id;
  });
  return `Taken out of the selection: ${names.join(", ")}. The edit renumbered the body's faces and edges, so these could not be followed.`;
}
