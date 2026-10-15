// DRAFT: will change as the real workspaces are built.
//
// Shared by every workspace: one selection and one undo/redo history, so
// switching workspaces keeps both.

import type { GeometryReference } from "./references.ts";

export interface Selection {
  readonly items: readonly GeometryReference[];
  set(items: GeometryReference[]): void;
  onChange(listener: (items: readonly GeometryReference[]) => void): () => void;
}

/** Undo/redo across all workspaces (roadmap step 20; timeline edits from step 32). */
export interface History {
  canUndo(): boolean;
  canRedo(): boolean;
  undo(): void;
  redo(): void;
}

/** Selection until step 17: every call says it is not built yet. */
export const selectionNotBuilt: Selection = {
  get items(): readonly GeometryReference[] {
    throw new Error("not implemented");
  },
  set() {
    throw new Error("not implemented");
  },
  onChange() {
    throw new Error("not implemented");
  },
};

/** Undo/redo until step 20: every call says it is not built yet. */
export const historyNotBuilt: History = {
  canUndo() {
    throw new Error("not implemented");
  },
  canRedo() {
    throw new Error("not implemented");
  },
  undo() {
    throw new Error("not implemented");
  },
  redo() {
    throw new Error("not implemented");
  },
};
