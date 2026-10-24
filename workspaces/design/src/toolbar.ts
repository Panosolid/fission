// Design's toolbar, read from its commands (commands.ts): one button per
// export under "Export". The toolbar and the AI assistant issue the same
// commands. The shapes set_part offers are named here (SHAPE_LABELS) for
// Insert ▾ (insert.ts) and the panel's Shape choice (properties.ts); the
// toolbar's own shape buttons went with U0d (the owner's ask: presets
// hidden away until wanted).

import type { Command, CommandSpec } from "@fission/core";
import { DESIGN_COMMANDS } from "./commands.ts";
import type { ShapeKind } from "./profiles.ts";

export interface ToolButton {
  label: string;
  /** The tooltip: the command's own summary. */
  title: string;
  /** What the button issues. */
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
  const exports: ToolButton[] = [];
  for (const spec of specs) if (spec.op in EXPORT_LABELS) exports.push({ label: EXPORT_LABELS[spec.op], title: spec.summary, command: { op: spec.op } });
  return [{ name: "Export", buttons: exports }].filter((g) => g.buttons.length > 0);
}
