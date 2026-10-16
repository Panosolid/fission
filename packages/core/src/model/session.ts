// Shared by every workspace: one selection and one undo/redo history, so
// switching workspaces keeps both. The selection is built (step 17a); the
// history is built in history.ts (step 20a) and the shell creates it (20b).
// historyNotBuilt stands in for it in tests of workspaces that never undo.

import type { History } from "./history.ts";
import type { GeometryReference } from "./references.ts";

export type { History } from "./history.ts";

export interface Selection {
  readonly items: readonly GeometryReference[];
  /** Replaces the selection; repeats in `items` are kept once, first place wins. */
  set(items: readonly GeometryReference[]): void;
  /** Adds the reference if it is not selected, removes it if it is (Shift-click). */
  toggle(item: GeometryReference): void;
  clear(): void;
  /** Called once after every change that alters the items, never for a no-op; returns an unsubscribe. */
  onChange(listener: (items: readonly GeometryReference[]) => void): () => void;
}

/** Two references name the same thing when kind and id match. */
const sameRef = (a: GeometryReference, b: GeometryReference) => a.kind === b.kind && a.id === b.id;

/** The one selection the shell creates and hands every workspace in its context. */
export function createSelection(): Selection {
  let items: readonly GeometryReference[] = [];
  const listeners = new Set<(items: readonly GeometryReference[]) => void>();
  const replace = (next: GeometryReference[]) => {
    const unchanged = next.length === items.length && next.every((r, i) => sameRef(r, items[i]));
    if (unchanged) return;
    items = Object.freeze(next.map((r) => ({ ...r })));
    for (const l of [...listeners]) l(items);
  };
  return {
    get items() {
      return items;
    },
    set(next) {
      const kept: GeometryReference[] = [];
      for (const r of next) if (!kept.some((k) => sameRef(k, r))) kept.push(r);
      replace(kept);
    },
    toggle(item) {
      replace(items.some((r) => sameRef(r, item)) ? items.filter((r) => !sameRef(r, item)) : [...items, item]);
    },
    clear() {
      replace([]);
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** A history for tests that must not touch one: every call says it is not built. */
const notBuilt = (): never => {
  throw new Error("not implemented");
};
export const historyNotBuilt: History = {
  canUndo: notBuilt,
  canRedo: notBuilt,
  undoLabel: notBuilt,
  redoLabel: notBuilt,
  record: notBuilt,
  undo: notBuilt,
  redo: notBuilt,
  reset: notBuilt,
  amend: notBuilt,
  onChange: notBuilt,
};
