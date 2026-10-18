// Split view (X3): which workspaces can go in the second pane.

export interface SplitEntry {
  id: string;
  title: string;
  /** A workspace not built yet: its pane says "Coming soon" and draws no 3D view. */
  placeholder?: boolean;
}

/**
 * The workspaces offered for the second pane, in switcher order: every one
 * but the workspace already shown in the first pane (a workspace is on
 * screen once). `shown` is null when the first pane shows a page that is
 * not a workspace (Community): then all of them.
 */
export function splitChoices<T extends SplitEntry>(entries: readonly T[], shown: string | null): T[] {
  return entries.filter((e) => e.id !== shown);
}

/** The second pane's workspace when Split is opened: the first working one offered, or the first one when only placeholders are left. */
export function defaultSplit<T extends SplitEntry>(entries: readonly T[], shown: string | null): T | undefined {
  const choices = splitChoices(entries, shown);
  return choices.find((e) => !e.placeholder) ?? choices[0];
}

/** The narrowest window that offers Split (theme.css hides it below this): two viewports beside two 240 px panel columns. */
export const SPLIT_MIN_WIDTH_PX = 900;
