// A change note (docs/integration.md, principle 9): one line naming why
// something updated ("Print plate updated: you changed wall thickness in
// Design"), a "Why?" that opens the dependency chain from the cause to the
// result, and a dismiss button (the shell wires it from data-dismiss).
// Takes plain values so the UI kit doesn't depend on the document model
// (core's ChangeNote has these fields).

export type NoteState = "updating" | "needs-rerun" | "updated";

export interface ChangeNoteInfo {
  id: string;
  state: NoteState;
  text: string;
  /** From the cause to the result, one line each. */
  chain: string[];
}

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** HTML for one note. role="status" so screen readers announce it without taking focus. */
export function changeNote(n: ChangeNoteInfo): string {
  const id = escape(n.id);
  const chain = n.chain.map((c) => `<li>${escape(c)}</li>`).join("");
  return (
    `<div class="change-note ${n.state}" role="status" data-note="${id}" data-state="${n.state}">` +
    `<div class="note-body"><span class="note-text">${escape(n.text)}</span>` +
    `<details><summary>Why?</summary><ol>${chain}</ol></details></div>` +
    `<button type="button" class="note-dismiss" data-dismiss="${id}" aria-label="Dismiss this note" title="Dismiss">×</button>` +
    `</div>`
  );
}
