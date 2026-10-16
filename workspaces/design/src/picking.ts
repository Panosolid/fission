// What a click in the viewport does to the selection (step 17b). Pure, so
// the rules are unit-tested; workspace.ts applies the result.

import type { GeometryReference, ViewportPick } from "@fission/core";
import { designReference } from "./references.ts";

/** The change a pick makes: replace with one face, toggle one face, clear, or leave as is. */
export type SelectionChange =
  | { change: "set"; item: GeometryReference }
  | { change: "toggle"; item: GeometryReference }
  | { change: "clear" }
  | { change: "keep" };

/**
 * A click on a face selects only that face; Shift adds it (or takes it out
 * again if already selected). A click on empty space clears; with Shift it
 * keeps the selection, so a slip while adding loses nothing. `featureId` is
 * the feature that built the body on screen.
 */
export function pickChange(pick: ViewportPick, featureId: string): SelectionChange {
  if (pick.face === null) return pick.shift ? { change: "keep" } : { change: "clear" };
  const item = designReference("face", featureId, pick.face);
  return pick.shift ? { change: "toggle", item } : { change: "set", item };
}
