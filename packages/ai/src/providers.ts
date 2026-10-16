// One interface to whichever model the user chooses. PLACEHOLDERS: the
// provider descriptions below are real (they drive the settings page and
// the privacy indicator); talking to a model is not built yet.
//
// AI is always optional: every feature in Fission works without it, and
// no provider is active until the user picks one. It costs the project
// nothing to run: models run on the user's machine, or on a provider the
// user pays with their own API key.
//
// The rest of the app talks to `AIProvider` only and never knows which
// one is active.

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

/** A provider for these settings. Not implemented yet. */
export function createProvider(_settings: ProviderSettings): AIProvider {
  throw new Error("not implemented");
}

/** Which providers this browser could run (WebGPU and its power, a built-in model). Not implemented yet. */
export function detectProviders(): Promise<{ kind: AIProviderKind; ok: boolean; reason?: string }[]> {
  throw new Error("not implemented");
}
