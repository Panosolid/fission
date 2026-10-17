// What a click in the viewport does to the selection (step 17b). Pure, so
// the rules are unit-tested; workspace.ts applies the result.

import type { GeometryReference, ViewportPick } from "@fission/core";
import type { BodyNames } from "./naming.ts";
import { designReference } from "./references.ts";

/** The change a pick makes: replace with one face or edge, toggle one, clear, or leave as is. */
export type SelectionChange =
  | { change: "set"; item: GeometryReference }
  | { change: "toggle"; item: GeometryReference }
  | { change: "clear" }
  | { change: "keep" };

/**
 * A click on a face or edge selects only that; Shift adds it (or takes it
 * out again if already selected). An edge wins over a face. A click on empty space clears; with Shift it
 * keeps the selection, so a slip while adding loses nothing. `names` are
 * the names of the body on screen (null before one is built). A face or
 * edge with no name can't be referred to, so a click on one changes nothing.
 */
export function pickChange(pick: ViewportPick, names: BodyNames | null): SelectionChange {
  const hit = pick.edge != null ? ({ kind: "edge", index: pick.edge } as const) : pick.face !== null ? ({ kind: "face", index: pick.face } as const) : null;
  if (hit === null) return pick.shift ? { change: "keep" } : { change: "clear" };
  const item = names === null ? null : designReference(hit.kind, names, hit.index);
  if (item === null) return { change: "keep" };
  return pick.shift ? { change: "toggle", item } : { change: "set", item };
}
