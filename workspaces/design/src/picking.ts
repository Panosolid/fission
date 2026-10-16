// What a click in the viewport does to the selection (step 17b). Pure, so
// the rules are unit-tested; workspace.ts applies the result.

import type { GeometryReference, ViewportPick } from "@fission/core";
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
 * keeps the selection, so a slip while adding loses nothing. `featureId` is
 * the feature that built the body on screen.
 */
export function pickChange(pick: ViewportPick, featureId: string): SelectionChange {
  const item =
    pick.edge != null
      ? designReference("edge", featureId, pick.edge)
      : pick.face !== null
        ? designReference("face", featureId, pick.face)
        : null;
  if (item === null) return pick.shift ? { change: "keep" } : { change: "clear" };
  return pick.shift ? { change: "toggle", item } : { change: "set", item };
}
