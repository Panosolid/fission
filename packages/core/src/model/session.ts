// DRAFT: will change as the real workspaces are built.
//
// Shared by every workspace: one selection and one undo/redo history, so
// switching workspaces keeps both.

import type { GeometryReference } from "./references";

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
