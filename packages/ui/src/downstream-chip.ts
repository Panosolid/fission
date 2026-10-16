// A downstream chip in Design's properties panel (docs/integration.md,
// principle 4): what another workspace makes from the design, in a few
// words ("Print: 2 h 14 m · 38 g"). Hover shows the preview; a click goes
// to that workspace (the panel wires it from data-target). A result that
// is out of date keeps its last value but says so, so a stale number is
// never shown unmarked. Takes plain values so the UI kit doesn't depend on
// the document model (core's DownstreamSummary has these fields).

export type ChipState = "fresh" | "updating" | "needs-rerun" | "missing";

export interface ChipInfo {
  id: string;
  label: string;
  value: string | undefined;
  state: ChipState;
  preview: string;
  /** The workspace a click goes to. */
  target: string;
  /** Its name, as the tooltip says it: "Slice". */
  targetName: string;
}

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** The mark after the value, and the tooltip line that explains it. */
const marks: Record<ChipState, { mark: string; why: (where: string) => string }> = {
  fresh: { mark: "", why: () => "Up to date." },
  updating: { mark: "updating…", why: () => "Out of date: being worked out again from the current design." },
  "needs-rerun": { mark: "out of date", why: (where) => `Out of date: rerun it in ${where}.` },
  missing: { mark: "missing", why: (where) => `Can't find what this was worked out from in ${where}.` },
};

/** HTML for one chip: a button, so it can be reached with the keyboard. */
export function downstreamChip(c: ChipInfo): string {
  const { mark, why } = marks[c.state];
  const value = c.state === "missing" || c.value === undefined ? "–" : c.value;
  const title = `${c.preview}\n${why(c.targetName)}\nClick to open ${c.targetName}.`;
  return (
    `<button type="button" class="downstream-chip ${c.state}" data-chip="${escape(c.id)}" data-target="${escape(c.target)}" data-state="${c.state}" title="${escape(title)}">` +
    `<span class="chip-label">${escape(c.label)}:</span> <span class="chip-value">${escape(value)}</span>` +
    (mark ? ` <span class="chip-mark">${mark}</span>` : "") +
    `</button>`
  );
}
