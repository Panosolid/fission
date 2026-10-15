// @fission/ai: one interface to whichever AI model the user chooses. PLACEHOLDER.
//
// Will offer three kinds of provider: a hosted model with the user's own
// API key, a local model served by Ollama, or a small model running in the
// browser (WebLLM). Nothing here works yet, and nothing is sent anywhere.
//
// DRAFT interfaces: will change when the first AI feature is built.

export type AiProviderKind = "api-key" | "ollama" | "in-browser";

export interface AiProviderSettings {
  kind: AiProviderKind;
  /** For "api-key": the user's key, stored only on their machine. */
  apiKey?: string;
  /** For "ollama": where the local server listens. */
  endpoint?: string;
  model?: string;
}

export interface AiProvider {
  readonly kind: AiProviderKind;
  complete(prompt: string): Promise<string>;
}

/** A provider for these settings. Not implemented yet. */
export function createProvider(_settings: AiProviderSettings): AiProvider {
  throw new Error("not implemented");
}
