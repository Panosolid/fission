// The keyboard shortcuts list (X7b): every key in the one shortcut table,
// grouped by where it works, the workspaces on screen first. Takes plain
// values so the UI kit doesn't depend on the document model (the shell
// builds them from core's ShortcutTable.help and chordLabel).

export interface ShortcutGroup {
  /** "Design", or "Everywhere" for the app's own keys. */
  title: string;
  /** On screen now: marked, so the keys that work right now stand out. */
  onScreen: boolean;
  rows: { keys: string; label: string }[];
}

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** HTML for the list: one section per group, each key in a <kbd>. */
export function shortcutList(groups: readonly ShortcutGroup[]): string {
  return groups
    .map(
      (g) =>
        `<section${g.onScreen ? ' data-on-screen=""' : ""}><h3>${escape(g.title)}${g.onScreen ? ' <span class="here">on screen</span>' : ""}</h3><dl>` +
        g.rows.map((r) => `<div><dt><kbd>${escape(r.keys)}</kbd></dt><dd>${escape(r.label)}</dd></div>`).join("") +
        `</dl></section>`,
    )
    .join("");
}
