// Insert ▾ (U0d, the owner's ask): the ready-made shapes, hidden in a menu
// until wanted, each always added as a whole new body at the timeline
// marker at the panel's default sizes (40 × 30 × 20 mm; a round shape's
// diameter is the width), never changing a body already there. A second
// section is where models downloaded from Community will go: off, saying
// so, until Community exists. `inserted` is the document change, a pure
// function; `insertSections` the menu's items (packages/ui menu-button.ts).

import type { MenuSection } from "@fission/ui";
import { SHAPES } from "./commands.ts";
import { insertPreset, type DesignDocument } from "./document.ts";
import type { ShapeKind } from "./profiles.ts";
import { DEFAULT_SIZES } from "./properties.ts";
import { SHAPE_LABELS } from "./toolbar.ts";

export const INSERT_TITLE = "Add a ready-made shape as a new body, at 40 × 30 × 20 mm: change its sizes in the properties.";
/** Why the Community item is off (placeholders never pretend to work). */
export const COMMUNITY_OFF = "Models shared on Community will be added from here. Community isn't built yet.";

/** The undo step an insert is recorded as: "Insert Box". */
export const insertStep = (kind: ShapeKind) => `Insert ${SHAPE_LABELS[kind]}`;

/** The sizes every preset is inserted at: the panel's defaults, width 40, depth 30, height 20 mm. */
export const INSERT_SIZES = { width: Number(DEFAULT_SIZES.width), depth: Number(DEFAULT_SIZES.depth), height: Number(DEFAULT_SIZES.height) };

/** The design with a new `kind` body put in at the marker (`insertPreset`), and the new feature's id. */
export function inserted(doc: DesignDocument, kind: ShapeKind): { doc: DesignDocument; id: string } {
  return insertPreset(doc, kind, INSERT_SIZES.width, INSERT_SIZES.depth, INSERT_SIZES.height);
}

/** "a box", "an L-bracket": the shape as a tooltip says it. */
const aShape = (kind: ShapeKind) => (kind === "l-bracket" ? "an L-bracket" : `a ${SHAPE_LABELS[kind].toLowerCase()}`);

/** The menu's sections: every preset (item ids `insert-box`…, `data-shape` read by the e2e tests), then From Community, off. */
export function insertSections(onInsert: (kind: ShapeKind) => void): MenuSection[] {
  return [
    {
      heading: "Presets",
      items: SHAPES.map((kind) => ({ id: `insert-${kind}`, label: SHAPE_LABELS[kind], title: `Add ${aShape(kind)} as a new body`, data: { shape: kind }, run: () => onInsert(kind) })),
    },
    { heading: "From Community", items: [{ id: "insert-community", label: "Community models", off: COMMUNITY_OFF, run: () => {} }] },
  ];
}
