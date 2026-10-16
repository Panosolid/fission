// Change notes (docs/integration.md, principle 9): when something updates
// because of something else, a short dismissible note names the cause
// ("Print plate updated: you changed wall thickness in Design"), with one
// click to the chain of dependencies that links the two. Nothing updates
// silently in a way the user would find surprising.
//
// A note is made for each result the dependency graph marks out of date in
// a workspace other than the one where the change was made: a change in
// Design updating Design's own results is what the user just did, so it
// gets no note. Each result has at most one note, naming its latest cause.
// Like the downstream chips, a note's state comes from the graph when it is
// read, never from the workspace: "updating" while a cheap result is being
// rebuilt, "needs-rerun" while an expensive one waits for the user,
// "updated" once the graph marks it fresh. A note about a result that is no
// longer in the project is dropped.

import type { Cost, DependencyGraph, Staleness } from "./graph.ts";
import type { WorkspaceId } from "./project.ts";
import { workspaceName, type Origin } from "./feature.ts";

/** What the user did, as the note names it. */
export interface ChangeCause {
  /** The graph node that changed (or was removed). */
  node: string;
  /** Its label and workspace, kept with the note so they survive the node being removed. */
  label: string;
  workspace: WorkspaceId;
  /** What happened, as the note says it after the colon: "you changed wall thickness". */
  change: string;
}

export type ChangeNoteState = "updating" | "needs-rerun" | "updated";

/** One note, as the UI shows it: plain values. */
export interface ChangeNote {
  /** Unique for the session; a newer cause for the same result gets a new id, so dismissing the old note never hides the new one. */
  id: string;
  /** The result that was updated (a graph node). */
  node: string;
  /** Where that result lives, so the shell can show the note in the right place. */
  workspace: WorkspaceId;
  cost: Cost;
  state: ChangeNoteState;
  /** The one-line note: "Print plate updated: you changed wall thickness in Design." */
  text: string;
  /** The dependency chain from the cause to the result, one line each: "Wall thickness in Design", …, "Print plate in Slice". */
  chain: string[];
}

interface Recorded {
  id: string;
  node: string;
  cause: ChangeCause;
  chain: Origin[];
}

const where = (o: { label: string; workspace: WorkspaceId }) => `${o.label} in ${workspaceName(o.workspace)}`;

export class ChangeNotes {
  /** Affected node → its note; one per result. */
  private byNode = new Map<string, Recorded>();
  private seq = 0;
  private listeners = new Set<() => void>();

  /** Calls `listener` after a note is made or dismissed (a note's state changes come from the graph: see DependencyGraph.onChange). Returns a function that stops it. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  /**
   * Notes what `staleness` (the result of graph.changed or graph.remove for
   * `cause.node`) set off. Returns the ids of the notes made. A cause with
   * no words is refused, and so is a staleness list naming something the
   * graph doesn't hold: it must come from this graph, just now.
   */
  record(cause: ChangeCause, staleness: Staleness, graph: DependencyGraph): string[] {
    if (cause.change.trim() === "") throw new Error(`a change note for ${cause.label} needs to say what changed`);
    if (cause.label.trim() === "") throw new Error(`a change note's cause ${cause.node} needs a label`);
    const made: string[] = [];
    for (const id of [...staleness.updateNow, ...staleness.awaitingRerun]) {
      const node = graph.node(id);
      if (!node) throw new Error(`change note: ${id} is not in the project; record what graph.changed just returned`);
      if (node.workspace === cause.workspace) continue;
      const ids = graph.path(cause.node, id);
      if (!ids) throw new Error(`change note: ${node.label} does not read ${cause.label}`);
      const chain = ids.map((x): Origin => {
        const n = graph.node(x);
        return n ? { id: x, label: n.label, workspace: n.workspace } : { id: x, label: cause.label, workspace: cause.workspace };
      });
      const note: Recorded = { id: `note-${++this.seq}`, node: id, cause: { ...cause }, chain };
      this.byNode.set(id, note);
      made.push(note.id);
    }
    if (made.length > 0) for (const l of [...this.listeners]) l();
    return made;
  }

  /** Hides a note. False when there is no such note (already dismissed, replaced, or never made). */
  dismiss(id: string): boolean {
    for (const [node, n] of this.byNode)
      if (n.id === id) {
        this.byNode.delete(node);
        for (const l of [...this.listeners]) l();
        return true;
      }
    return false;
  }

  /**
   * The notes to show, oldest first, each with its state read from the
   * graph now. Notes about results no longer in the project are dropped
   * for good.
   */
  current(graph: DependencyGraph): ChangeNote[] {
    const out: ChangeNote[] = [];
    for (const [nodeId, n] of this.byNode) {
      const node = graph.node(nodeId);
      if (!node) {
        this.byNode.delete(nodeId);
        continue;
      }
      const state: ChangeNoteState = !graph.isStale(nodeId) ? "updated" : node.cost === "cheap" ? "updating" : "needs-rerun";
      out.push({ id: n.id, node: nodeId, workspace: node.workspace, cost: node.cost, state, text: noteText(node, n.cause, state), chain: n.chain.map(where) });
    }
    return out.sort((a, b) => Number(a.id.slice(5)) - Number(b.id.slice(5)));
  }
}

/** The note's one line, worked out from the result, the cause and the state. */
export function noteText(result: { label: string; workspace: WorkspaceId }, cause: ChangeCause, state: ChangeNoteState): string {
  const why = `${cause.change} in ${workspaceName(cause.workspace)}.`;
  if (state === "updated") return `${result.label} updated: ${why}`;
  if (state === "updating") return `${result.label} updating: ${why}`;
  return `${result.label} out of date: ${why} Rerun it in ${workspaceName(result.workspace)}.`;
}
