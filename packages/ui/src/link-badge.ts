// The small icon on an item that came from another workspace: linked
// (follows its source), frozen (a copy that no longer follows), or a
// warning when the source can't be found. Takes plain values so the UI kit
// doesn't depend on the document model.

export type LinkBadgeState = "live" | "frozen" | "unresolved";

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const looks: Record<LinkBadgeState, { icon: string; text: string }> = {
  live: { icon: "🔗", text: "Linked" },
  frozen: { icon: "❄", text: "Frozen copy" },
  unresolved: { icon: "⚠", text: "Link broken" },
};

/** HTML for the badge. `detail` is the tooltip: the source's name, or the warning. */
export function linkBadge(state: LinkBadgeState, detail: string): string {
  const { icon, text } = looks[state];
  return `<span class="link-badge ${state}" title="${escape(detail)}" data-link="${state}"><span aria-hidden="true">${icon}</span> ${text}</span>`;
}
