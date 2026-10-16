// API keys: stored ONLY in the user's own browser storage, never in the
// project file, never logged, and sent only to the provider they belong
// to. DRAFT.

import type { ApiVendor } from "./providers.ts";

export interface ApiKeyStore {
  /** The key for a vendor, or null. Never pass it anywhere but that vendor's requests. */
  get(vendor: ApiVendor): string | null;
  set(vendor: ApiVendor, key: string): void;
  remove(vendor: ApiVendor): void;
}

/** The key store in this browser's storage. Not implemented yet. */
export function browserKeyStore(): ApiKeyStore {
  throw new Error("not implemented");
}
