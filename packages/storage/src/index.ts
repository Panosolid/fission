// @fission/storage: local-first project storage.
//
// Projects kept in this browser (store.ts, over the KeyValue in
// key-value.ts; IndexedDB in the browser through indexeddb.ts), and
// autosave on top of them (autosave.ts).

import type { DataReader } from "@fission/core";
import { indexedDbKeyValue } from "./indexeddb.ts";
import { projectStore, type ProjectStore } from "./store.ts";

export { indexedDbKeyValue } from "./indexeddb.ts";
export { memoryKeyValue, type KeyValue } from "./key-value.ts";
export { startAutosave, QUIET_MS, type Autosave, type AutosaveOptions, type AutosaveStatus, type Timers } from "./autosave.ts";
export { projectStore, type ProjectStore, type ProjectSummary } from "./store.ts";

/** The store for this browser, kept in IndexedDB. `readers` are the workspace plugins. */
export function localStore(readers: readonly DataReader[]): ProjectStore {
  return projectStore(indexedDbKeyValue(), readers);
}
