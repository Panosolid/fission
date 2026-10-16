// Split view (X3): which workspaces can go in the second pane.

export interface SplitEntry {
  id: string;
  title: string;
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

/** The second pane's workspace when Split is opened: the first one offered. */
export function defaultSplit<T extends SplitEntry>(entries: readonly T[], shown: string | null): T | undefined {
  return splitChoices(entries, shown)[0];
}

/** The narrowest window that offers Split (theme.css hides it below this): two viewports beside two 240 px panel columns. */
export const SPLIT_MIN_WIDTH_PX = 900;
