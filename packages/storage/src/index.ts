// @fission/storage: local-first project storage. PLACEHOLDER.
//
// Will keep projects on the user's own machine (the browser's file system
// access API where available, IndexedDB otherwise), autosave as you work,
// and import/export project files and meshes. Nothing here works yet.
//
// DRAFT interfaces: will change when storage is built (roadmap step 19).

import type { Project } from "@fission/core";

export interface ProjectSummary {
  id: string;
  name: string;
  modified: Date;
}

export interface ProjectStore {
  list(): Promise<ProjectSummary[]>;
  open(id: string): Promise<Project>;
  save(id: string, project: Project): Promise<void>;
  remove(id: string): Promise<void>;
}

/** The store for this browser. Not implemented yet. */
export function localStore(): ProjectStore {
  throw new Error("not implemented");
}

/** Saves the project a moment after each change. Not implemented yet. */
export function startAutosave(_store: ProjectStore, _id: string, _project: () => Project): () => void {
  throw new Error("not implemented");
}
