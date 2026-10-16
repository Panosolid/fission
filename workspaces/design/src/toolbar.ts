// Design's toolbar, read from its commands (commands.ts): one button per
// shape of set_part under "Create", one per export under "Export". The
// toolbar and the AI assistant issue the same commands, so a shape added
// to the command list gets its button here without touching the UI.

import type { Command, CommandSpec } from "@fission/core";
import { DESIGN_COMMANDS } from "./commands.ts";
import type { ShapeKind } from "./profiles.ts";

export interface ToolButton {
  label: string;
  /** The tooltip: the command's own summary. */
  title: string;
  /** What the button issues; set_part buttons name only the shape, the sizes come from the properties. */
  command: Command;
}

export interface ToolGroup {
  name: string;
  buttons: ToolButton[];
}

export const SHAPE_LABELS: Record<ShapeKind, string> = {
  box: "Box",
  cylinder: "Cylinder",
  sphere: "Sphere",
  "l-bracket": "L-bracket",
  plate: "Plate",
  slot: "Slot",
  star: "Star",
};

const EXPORT_LABELS: Record<string, string> = { export_stl: "STL" };

/** The toolbar's groups for these commands; a command it doesn't know gets no button. */
export function toolbarGroups(specs: readonly CommandSpec[] = DESIGN_COMMANDS): ToolGroup[] {
  const create: ToolButton[] = [];
  const exports: ToolButton[] = [];
  for (const spec of specs) {
    const shape = spec.params.shape;
    if (spec.op === "set_part" && shape?.type === "choice")
      for (const kind of shape.values)
        create.push({
          label: SHAPE_LABELS[kind as ShapeKind] ?? kind,
          title: spec.summary,
          command: { op: spec.op, shape: kind },
        });
    else if (spec.op in EXPORT_LABELS) exports.push({ label: EXPORT_LABELS[spec.op], title: spec.summary, command: { op: spec.op } });
  }
  return [
    { name: "Create", buttons: create },
    { name: "Export", buttons: exports },
  ].filter((g) => g.buttons.length > 0);
}
