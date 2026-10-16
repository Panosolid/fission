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
