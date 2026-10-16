// Design's keys (X7b), in the one shortcut table (@fission/core shortcuts.ts).
// The shell runs them while Design is on screen; Design never listens to the
// keyboard itself.
import type { Selected, ShortcutSpec } from "@fission/core";

export const DESIGN_SHORTCUTS: readonly ShortcutSpec[] = [
  // Also in a size field: Escape there has nothing else to do.
  { id: "clear-selection", keys: "Escape", label: "Clear the selection", inText: true },
  // Copy (the keys or the browser's Edit menu) with one profile selected.
  { id: "copy-svg", keys: "Mod+C", label: "Copy the selected profile as SVG" },
];

/**
 * What Design does for shortcut `id` with `items` selected: "clear", "copy"
 * (Copy as SVG), or null to decline so the browser does what it would have
 * (copy with nothing, two things or a face selected copies as usual).
 */
export function designShortcut(id: string, items: readonly Selected[]): "clear" | "copy" | null {
  if (id === "clear-selection") return "clear";
  if (id === "copy-svg" && items.length === 1 && items[0].kind === "outline") return "copy";
  return null;
}
