// Ollama on the user's own computer: its chat endpoint, held to the JSON
// schema with Ollama's `format` (constrained output), temperature 0 so the
// same question gives the same answer. Nothing leaves the machine.

import { ANSWER_TIMEOUT_MS, CHECK_TIMEOUT_MS, requestJson, type Fetch } from "./http.ts";
import type { AIProvider, AIRequest } from "./providers.ts";

export const OLLAMA_ENDPOINT = "http://localhost:11434";

/** The endpoint without a trailing slash, or a thrown error for one that isn't an http(s) address. */
export function ollamaEndpoint(endpoint = OLLAMA_ENDPOINT): string {
  let url: URL;
  try {
    url = new URL(endpoint.trim());
  } catch {
    throw new Error(`"${endpoint}" isn't a web address; Ollama usually listens at ${OLLAMA_ENDPOINT}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`Ollama is reached over http or https, not ${url.protocol}`);
  return url.href.replace(/\/+$/, "");
}

/** The body Ollama's /api/chat takes for this request. */
export function ollamaBody(model: string, r: AIRequest): object {
  return {
    model,
    messages: [{ role: "system", content: r.system }, ...r.messages],
    stream: false,
    ...(r.jsonSchema ? { format: r.jsonSchema } : {}),
    options: { temperature: 0 },
  };
}

/** Whether Ollama's model list has `model` ("llama3.2" is "llama3.2:latest"). */
export function hasModel(names: readonly string[], model: string): boolean {
  const want = model.includes(":") ? model : `${model}:latest`;
  return names.some((n) => n === model || n === want);
}

/** The models Ollama has pulled (its /api/tags), or a thrown error when it can't be reached. */
export async function ollamaModels(o: { endpoint?: string; fetch: Fetch }): Promise<string[]> {
  const endpoint = ollamaEndpoint(o.endpoint);
  const reply = await requestJson({ fetch: o.fetch, url: `${endpoint}/api/tags`, timeoutMs: CHECK_TIMEOUT_MS, who: `Ollama at ${endpoint}` });
  return ((reply as { models?: { name?: unknown }[] }).models ?? []).map((m) => m?.name).filter((n): n is string => typeof n === "string");
}

const UNREACHABLE = "Is Ollama running, and does OLLAMA_ORIGINS allow this page? (see the Ollama notes in the provider list)";

export function ollamaProvider(o: { model?: string; endpoint?: string; fetch: Fetch; timeoutMs?: number }): AIProvider {
  const endpoint = ollamaEndpoint(o.endpoint);
  const who = `Ollama at ${endpoint}`;
  const model = o.model?.trim() ?? "";
  return {
    kind: "ollama",
    structuredOutput: true,
    async check() {
      let names: string[];
      try {
        names = await ollamaModels({ endpoint, fetch: o.fetch });
      } catch (e) {
        return { ok: false, reason: `${(e as Error).message}. ${UNREACHABLE}`, suggest: "api-key" };
      }
      if (model === "") return { ok: false, reason: names.length ? `choose a model: Ollama has ${names.join(", ")}` : "Ollama has no models yet: run `ollama pull qwen2.5:1.5b` first" };
      if (!hasModel(names, model)) return { ok: false, reason: `Ollama doesn't have ${model} yet: run \`ollama pull ${model}\`` };
      return { ok: true };
    },
    async complete(request) {
      if (model === "") throw new Error("no Ollama model is chosen");
      const reply = await requestJson({ fetch: o.fetch, url: `${endpoint}/api/chat`, body: ollamaBody(model, request), timeoutMs: o.timeoutMs ?? ANSWER_TIMEOUT_MS, who });
      const content = (reply as { message?: { content?: unknown } }).message?.content;
      if (typeof content !== "string") throw new Error(`${who} sent a reply with no message in it`);
      return content;
    },
  };
}
