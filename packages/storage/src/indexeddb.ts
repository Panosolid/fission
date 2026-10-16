// The browser's KeyValue: one IndexedDB database with one object store of
// string keys and string values. Kept thin on purpose; everything worth
// testing lives in store.ts, which the unit tests run on memoryKeyValue.

import type { KeyValue } from "./key-value.ts";

const STORE = "kv";

/** Turns an IndexedDB failure into an Error with a message a person can read. */
function failure(e: DOMException | null, doing: string): Error {
  if (e?.name === "QuotaExceededError") return new Error(`browser storage is full: can't ${doing}`);
  return new Error(`browser storage failed: can't ${doing}${e ? ` (${e.name}: ${e.message})` : ""}`);
}

function request<T>(r: IDBRequest<T>, doing: string): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(failure(r.error, doing));
  });
}

/** The KeyValue kept in this browser's IndexedDB database `name`. */
export function indexedDbKeyValue(name = "fission", factory: IDBFactory = indexedDB): KeyValue {
  let db: Promise<IDBDatabase> | undefined;
  const open = () =>
    (db ??= new Promise((resolve, reject) => {
      const r = factory.open(name, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => {
        db = undefined; // let the next call try again
        reject(failure(r.error, "open the project database"));
      };
      r.onblocked = () => reject(new Error("browser storage is busy: close other Fission tabs and try again"));
    }));
  /** Runs one request in its own transaction; a write resolves only once it is committed. */
  const run = async <T>(mode: IDBTransactionMode, doing: string, make: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const tx = (await open()).transaction(STORE, mode);
    const result = request(make(tx.objectStore(STORE)), doing);
    const done = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(failure(tx.error, doing));
      tx.onabort = () => reject(failure(tx.error, doing));
    });
    const [value] = await Promise.all([result, done]);
    return value;
  };
  return {
    get: async (key) => {
      const v = await run("readonly", `read "${key}"`, (s) => s.get(key));
      return typeof v === "string" ? v : undefined;
    },
    set: (key, value) => run("readwrite", `save "${key}"`, (s) => s.put(value, key)).then(() => undefined),
    delete: (key) => run("readwrite", `remove "${key}"`, (s) => s.delete(key)).then(() => undefined),
    keys: async (prefix) => {
      // Every string starting with prefix sorts between prefix and prefix + U+FFFF.
      const keys = await run("readonly", "list projects", (s) => s.getAllKeys(IDBKeyRange.bound(prefix, prefix + "￿")));
      return keys.filter((k): k is string => typeof k === "string" && k.startsWith(prefix));
    },
  };
}
