// One interface to whichever model the user chooses. The descriptions
// below drive the settings page and the privacy indicator; the providers
// themselves are in ollama.ts, hosted.ts and local.ts.
//
// AI is always optional: every feature in Fission works without it, and
// no provider is active until the user picks one. It costs the project
// nothing to run: models run on the user's machine, or on a provider the
// user pays with their own API key.
//
// The rest of the app talks to `AIProvider` only and never knows which
// one is active.

import type { Fetch } from "./http.ts";
import { browserKeyStore, type ApiKeyStore } from "./keys.ts";
import { builtInProvider, inBrowserProvider, type BuiltInModelLike, type GpuLike, type WebLLMLike } from "./local.ts";
import { hostedProvider } from "./hosted.ts";
import { ollamaProvider } from "./ollama.ts";

export type AIProviderKind = "in-browser" | "ollama" | "api-key" | "browser-built-in";

/** Hosted providers reachable with the user's own API key. */
export type ApiVendor = "anthropic" | "openai" | "other";

export interface ProviderSettings {
  kind: AIProviderKind;
  /** in-browser and ollama: which model. */
  model?: string;
  /** ollama: where the user's local server listens (default http://localhost:11434). */
  endpoint?: string;
  /** api-key: whose API. The key itself lives only in browser storage (keys.ts), never here. */
  vendor?: ApiVendor;
}

/** What providers reach the outside world through; tests pass stand-ins. Each defaults to the browser's own. */
export interface ProviderDeps {
  fetch?: Fetch;
  keys?: ApiKeyStore;
  gpu?: GpuLike;
  loadWebLLM?: () => Promise<WebLLMLike>;
  builtIn?: BuiltInModelLike;
  /** In-browser model download progress, 0–1. */
  onProgress?: (fraction: number, text: string) => void;
  /** How long an answer may take (ANSWER_TIMEOUT_MS). */
  timeoutMs?: number;
}

/** A request in the shape every provider takes. */
export interface AIRequest {
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
  /** When set, the answer must be JSON matching this schema (constrained output where the provider supports it). */
  jsonSchema?: object;
}

export interface AIProvider {
  readonly kind: AIProviderKind;
  /** Whether it can run here, and if not, what to try instead. */
  check(): Promise<{ ok: true } | { ok: false; reason: string; suggest?: AIProviderKind }>;
  complete(request: AIRequest): Promise<string>;
  /** Whether this provider can be held to a JSON schema; otherwise answers are validated and retried once (commands.ts). */
  readonly structuredOutput: boolean;
}

/** What the settings page and the privacy indicator say about each provider. */
export interface ProviderInfo {
  kind: AIProviderKind;
  title: string;
  /** True when requests leave the user's machine. */
  remote: boolean;
  description: string;
  /** Shown before the user enables it. */
  notes: string[];
}

export const PROVIDERS: readonly ProviderInfo[] = [
  {
    kind: "in-browser",
    title: "In your browser",
    remote: false,
    description: "A small open model running on your graphics card through WebGPU. The default local option: nothing leaves your machine.",
    notes: [
      "The model is downloaded once, and its size is shown before the download starts.",
      "Needs a reasonably capable graphics card. If yours is too weak, Fission suggests Ollama or an API key instead of failing.",
    ],
  },
  {
    kind: "ollama",
    title: "Ollama on your computer",
    remote: false,
    description: "Connects to Ollama running on your own computer. Nothing leaves your machine.",
    notes: [
      "Install Ollama and pull a model, e.g. `ollama pull llama3.2`.",
      "Browsers may only talk to Ollama if it allows this page: start it with OLLAMA_ORIGINS set to this site's address (for example OLLAMA_ORIGINS=https://your-fission-address), then restart Ollama.",
    ],
  },
  {
    kind: "api-key",
    title: "Your own API key",
    remote: true,
    description: "Uses a hosted model (Anthropic, OpenAI or another provider) with an API key you paste in. You pay the provider for your own usage.",
    notes: [
      "Consumer chat subscriptions can't be used here: the providers only allow programs to connect with an API key.",
      "Your key is stored only in this browser and sent only to the provider it belongs to.",
      "Before the first request, Fission shows exactly what will be sent.",
    ],
  },
  {
    kind: "browser-built-in",
    title: "Your browser's built-in AI",
    remote: false,
    description: "If your browser has a model built in, Fission can use it. Offered only when the browser reports one.",
    notes: ["Availability depends on your browser and its version."],
  },
];

/** Whether requests to this provider leave the user's machine (the indicator next to the assistant). */
export function dataLeavesMachine(kind: AIProviderKind): boolean {
  return PROVIDERS.find((p) => p.kind === kind)!.remote;
}

const browserFetch: Fetch = (url, init) => globalThis.fetch(url, init);
const browserGpu = () => (globalThis.navigator as { gpu?: GpuLike } | undefined)?.gpu;
const browserBuiltIn = () => (globalThis as { LanguageModel?: BuiltInModelLike }).LanguageModel;
const loadWebLLM = () => import("@mlc-ai/web-llm") as unknown as Promise<WebLLMLike>;

/** A provider for these settings. Throws a clear error for settings that can't work (a bad address, an unknown kind). */
export function createProvider(settings: ProviderSettings, deps: ProviderDeps = {}): AIProvider {
  const fetch = deps.fetch ?? browserFetch;
  switch (settings.kind) {
    case "ollama":
      return ollamaProvider({ model: settings.model, endpoint: settings.endpoint, fetch, timeoutMs: deps.timeoutMs });
    case "api-key":
      return hostedProvider({ vendor: settings.vendor, model: settings.model, endpoint: settings.endpoint, keys: deps.keys ?? browserKeyStore(), fetch, timeoutMs: deps.timeoutMs });
    case "in-browser":
      return inBrowserProvider({ model: settings.model, gpu: "gpu" in deps ? deps.gpu : browserGpu(), loadWebLLM: deps.loadWebLLM ?? loadWebLLM, onProgress: deps.onProgress });
    case "browser-built-in":
      return builtInProvider({ api: "builtIn" in deps ? deps.builtIn : browserBuiltIn() });
    default:
      throw new Error(`unknown AI provider "${String((settings as { kind: unknown }).kind)}"`);
  }
}

/**
 * Which providers could run here, each with the reason when one can't:
 * WebGPU and its power for the default in-browser model, Ollama at its
 * usual address, the browser's built-in model. An API key always can (the
 * key is asked for when it is chosen).
 */
export async function detectProviders(deps: ProviderDeps = {}): Promise<{ kind: AIProviderKind; ok: boolean; reason?: string }[]> {
  const out: { kind: AIProviderKind; ok: boolean; reason?: string }[] = [];
  for (const p of PROVIDERS) {
    if (p.kind === "api-key") {
      out.push({ kind: p.kind, ok: true });
      continue;
    }
    const r =
      p.kind === "ollama"
        ? await ollamaAnswers(deps.fetch ?? browserFetch)
        : await createProvider({ kind: p.kind }, deps).check().catch((e: Error) => ({ ok: false as const, reason: e.message }));
    out.push(r.ok ? { kind: p.kind, ok: true } : { kind: p.kind, ok: false, reason: r.reason });
  }
  return out;
}

async function ollamaAnswers(fetch: Fetch): Promise<{ ok: true } | { ok: false; reason: string }> {
  // With no model chosen a reachable Ollama always asks for one; anything else means it can't be reached.
  const r = await ollamaProvider({ model: "", fetch }).check();
  return r.ok || /^(choose a model|Ollama has no models yet)/.test(r.reason) ? { ok: true } : r;
}
