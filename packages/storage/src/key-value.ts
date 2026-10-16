// The small key-value interface the project store is written over. The
// browser uses IndexedDB through a thin adapter (indexeddb.ts); unit tests
// use the in-memory one below, so the store's logic is tested without a
// browser.

export interface KeyValue {
  /** The value under `key`, or undefined when there is none. */
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  /** Removes `key`; removing a key that is not there does nothing. */
  delete(key: string): Promise<void>;
  /** Every key that starts with `prefix`, in no particular order. */
  keys(prefix: string): Promise<string[]>;
}

/** A key-value store held in memory: for tests, and gone when the page closes. */
export function memoryKeyValue(): KeyValue & { readonly entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    get: async (key) => entries.get(key),
    set: async (key, value) => void entries.set(key, value),
    delete: async (key) => void entries.delete(key),
    keys: async (prefix) => [...entries.keys()].filter((k) => k.startsWith(prefix)),
  };
}
