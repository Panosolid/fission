// API keys: stored ONLY in the user's own browser storage, never in the
// project file, never logged, and sent only to the provider they belong
// to. A key is filed under the address it is sent to (its origin, such as
// https://api.anthropic.com), so a key can only ever be read for the one
// host it was entered for: changing an "other" endpoint finds no key.

export interface ApiKeyStore {
  /** The key for requests to `origin`, or null. Never pass it anywhere but that origin. */
  get(origin: string): string | null;
  /** Stores a checked key (`checkApiKey`); throws a clear error for a bad one. */
  set(origin: string, key: string): void;
  remove(origin: string): void;
}

/** The part of the Web Storage API the store uses (localStorage, or a stand-in in tests). */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const PREFIX = "fission.ai.key:";
/** Real keys are around 50 to 200 characters; anything far longer is a paste gone wrong. */
export const MAX_KEY_LENGTH = 512;

/**
 * The key as typed, trimmed, or a reason it can't be one. A key goes into
 * an HTTP header, so only printable ASCII without spaces is accepted: a
 * newline in it could add a header of its own.
 */
export function checkApiKey(key: string): { ok: true; key: string } | { ok: false; reason: string } {
  const k = key.trim();
  if (k === "") return { ok: false, reason: "the API key is empty" };
  if (k.length > MAX_KEY_LENGTH) return { ok: false, reason: `that is ${k.length} characters, longer than any API key (${MAX_KEY_LENGTH} at most)` };
  if (!/^[\x21-\x7e]+$/.test(k)) return { ok: false, reason: "an API key has no spaces, line breaks or special characters; check it was copied whole" };
  return { ok: true, key: k };
}

/** Origins are compared exactly, so "https://api.openai.com/" and "https://api.openai.com" are one. */
function originOf(origin: string): string {
  const url = new URL(origin);
  return url.origin;
}

/** The key store in this browser's storage (localStorage unless another is given). */
export function browserKeyStore(storage: KeyValueStorage = globalThis.localStorage): ApiKeyStore {
  if (!storage) throw new Error("this browser has no local storage, so an API key can't be kept");
  return {
    get: (origin) => storage.getItem(PREFIX + originOf(origin)),
    set(origin, key) {
      const checked = checkApiKey(key);
      if (!checked.ok) throw new Error(checked.reason);
      storage.setItem(PREFIX + originOf(origin), checked.key);
    },
    remove: (origin) => storage.removeItem(PREFIX + originOf(origin)),
  };
}

/** A store that forgets everything when the page closes (tests, or a browser without storage). */
export function memoryKeyStore(): ApiKeyStore {
  const map = new Map<string, string>();
  return browserKeyStore({ getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), removeItem: (k) => void map.delete(k) });
}
