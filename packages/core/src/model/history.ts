// Undo/redo across all workspaces (roadmap step 20): one history of
// whole-project snapshots, shared by every workspace like the selection.
// Snapshots for now; from steps 32–33 a step becomes "undo this timeline
// edit" behind the same interface.
//
// The history never reads the project itself: `capture` gives the project
// as text (the shell passes projectToJson) and `restore` puts a snapshot
// back (the shell opens it like a file and remounts). Recording the same
// text as the present is a no-op, so a restore that reports itself as a
// change records nothing, and neither does an edit back to the same value.

/** Undo/redo across all workspaces. */
export interface History {
  canUndo(): boolean;
  canRedo(): boolean;
  /** What Undo would take back ("Change size"), or null when there is nothing to undo. */
  undoLabel(): string | null;
  /** What Redo would do again, or null when there is nothing to redo. */
  redoLabel(): string | null;
  /**
   * Records the project as it is now as one step named `label`, after a
   * change. Returns false when there was nothing to record (the same text
   * as the present, or a call made while a snapshot is being restored).
   * A step with the same `mergeKey` as the step recorded just before it,
   * within the merge time and with no undo or redo between, is folded into
   * that step (typing 4 then 0 in one box is one step); folded back to the
   * state before that step, the step disappears. Recording drops every
   * step that could be redone.
   */
  record(label: string, mergeKey?: string): boolean;
  /** Puts back the state before the last step; returns that step's label, or null when there is nothing to undo. */
  undo(): string | null;
  /** Puts back the step last undone; returns its label, or null when there is nothing to redo. */
  redo(): string | null;
  /** Forgets every step: the project as it is now becomes the start (a project opened or started afresh). */
  reset(): void;
  /** Called once after every change to what can be undone or redone; returns an unsubscribe. */
  onChange(listener: () => void): () => void;
}

export interface HistoryOptions {
  /** The project as text, the same text for the same project. */
  capture(): string;
  /** Puts a snapshot back. If it throws, the history is left as it was and the error passes on. */
  restore(snapshot: string): void;
  /** Most undo steps kept; the oldest go first. Default UNDO_LIMIT. */
  limit?: number;
  /** Steps with one merge key closer together than this (ms) are one step. Default MERGE_MS. */
  mergeMs?: number;
  /** The clock, in ms (tests pass a fake one). */
  now?(): number;
}

/** Undo steps kept by default. A snapshot of today's project is a few kilobytes. */
export const UNDO_LIMIT = 100;
/** Edits of one thing closer together than this (ms) are one undo step. */
export const MERGE_MS = 1000;

interface Entry {
  snapshot: string;
  /** The step that led here ("" for the start). */
  label: string;
  mergeKey: string | undefined;
  at: number;
}

export function createHistory(options: HistoryOptions): History {
  const limit = options.limit ?? UNDO_LIMIT;
  const mergeMs = options.mergeMs ?? MERGE_MS;
  const now = options.now ?? (() => Date.now());
  if (!Number.isInteger(limit) || limit < 1) throw new Error(`undo limit must be a whole number of steps, at least 1 (got ${limit})`);
  if (!(mergeMs >= 0)) throw new Error(`merge time must be 0 ms or more (got ${mergeMs})`);

  // entries[0] is the oldest state kept; entries[index] is the present.
  let entries: Entry[] = [];
  let index = 0;
  // Merging is allowed only straight after a record.
  let lastWasRecord = false;
  let restoring = false;
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const l of [...listeners]) l();
  };
  const start = () => {
    entries = [{ snapshot: options.capture(), label: "", mergeKey: undefined, at: now() }];
    index = 0;
    lastWasRecord = false;
  };
  start();

  /** Restores entries[to] and moves there; on a failed restore nothing moves. */
  const go = (to: number) => {
    restoring = true;
    try {
      options.restore(entries[to].snapshot);
    } finally {
      restoring = false;
    }
    index = to;
    lastWasRecord = false;
    changed();
  };

  return {
    canUndo: () => index > 0,
    canRedo: () => index < entries.length - 1,
    undoLabel: () => (index > 0 ? entries[index].label : null),
    redoLabel: () => (index < entries.length - 1 ? entries[index + 1].label : null),
    record(label, mergeKey) {
      if (restoring) return false;
      const snapshot = options.capture();
      if (snapshot === entries[index].snapshot) return false;
      const t = now();
      const top = entries[index];
      entries.length = index + 1; // nothing to redo after a new step
      if (lastWasRecord && index > 0 && mergeKey !== undefined && top.mergeKey === mergeKey && t - top.at < mergeMs) {
        if (snapshot === entries[index - 1].snapshot) {
          // Folded back to where the step started: the step is gone.
          entries.pop();
          index--;
          lastWasRecord = false;
        } else {
          entries[index] = { snapshot, label, mergeKey, at: t };
        }
      } else {
        entries.push({ snapshot, label, mergeKey, at: t });
        index++;
        if (entries.length > limit + 1) {
          entries.shift();
          index--;
        }
        lastWasRecord = true;
      }
      changed();
      return true;
    },
    undo() {
      if (index === 0) return null;
      const label = entries[index].label;
      go(index - 1);
      return label;
    },
    redo() {
      if (index === entries.length - 1) return null;
      go(index + 1);
      return entries[index].label;
    },
    reset() {
      start();
      changed();
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
