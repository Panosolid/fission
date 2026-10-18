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

/** Rows next to each other with the same label as one row of their keys (the sketch's typed-size keys 0 to 9, point and minus are one row, SF4). */
function mergeRows(rows: readonly { keys: string; label: string }[]): { keys: string[]; label: string }[] {
  const out: { keys: string[]; label: string }[] = [];
  for (const r of rows) {
    const last = out.at(-1);
    if (last && last.label === r.label) last.keys.push(r.keys);
    else out.push({ keys: [r.keys], label: r.label });
  }
  return out;
}

/** HTML for the list: one section per group, each key in a <kbd>, rows with one label merged. */
export function shortcutList(groups: readonly ShortcutGroup[]): string {
  return groups
    .map(
      (g) =>
        `<section${g.onScreen ? ' data-on-screen=""' : ""}><h3>${escape(g.title)}${g.onScreen ? ' <span class="here">on screen</span>' : ""}</h3><dl>` +
        mergeRows(g.rows).map((r) => `<div><dt>${r.keys.map((k) => `<kbd>${escape(k)}</kbd>`).join(" ")}</dt><dd>${escape(r.label)}</dd></div>`).join("") +
        `</dl></section>`,
    )
    .join("");
}
