// @fission/storage: local-first project storage.
//
// Built: projects kept in this browser (store.ts, over the KeyValue in
// key-value.ts; IndexedDB in the browser through indexeddb.ts).
// Still a placeholder: autosave (step 19c), which throws "not implemented".

import type { DataReader, Project } from "@fission/core";
import { indexedDbKeyValue } from "./indexeddb.ts";
import { projectStore, type ProjectStore } from "./store.ts";

export { indexedDbKeyValue } from "./indexeddb.ts";
export { memoryKeyValue, type KeyValue } from "./key-value.ts";
export { projectStore, type ProjectStore, type ProjectSummary } from "./store.ts";

/** The store for this browser, kept in IndexedDB. `readers` are the workspace plugins. */
export function localStore(readers: readonly DataReader[]): ProjectStore {
  return projectStore(indexedDbKeyValue(), readers);
}

/** Saves the project a moment after each change. Not implemented yet (step 19c). */
export function startAutosave(_store: ProjectStore, _id: string, _project: () => Project): () => void {
  throw new Error("not implemented");
}
