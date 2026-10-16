// Hosted models with the user's own API key. The key is read from the key
// store for the exact origin the request goes to, and goes in that one
// request's header: never in a URL, a log or an error message.
//
// - anthropic: the Messages API. A schema is enforced by offering one tool
//   whose input is the schema and requiring the model to use it.
// - openai: Chat Completions with response_format json_schema.
// - other: any OpenAI-compatible endpoint the user names (https only, or
//   http on this computer). Not every one supports schemas, so its answers
//   are validated and retried instead (structuredOutput false).

import { ANSWER_TIMEOUT_MS, requestJson, type Fetch } from "./http.ts";
import type { ApiKeyStore } from "./keys.ts";
import type { AIProvider, AIRequest, ApiVendor } from "./providers.ts";

export const VENDOR_ORIGINS: Record<Exclude<ApiVendor, "other">, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com",
};

/** A model each vendor offers, used when the user hasn't chosen one. */
export const DEFAULT_MODELS: Record<Exclude<ApiVendor, "other">, string> = {
  anthropic: "claude-haiku-5-5",
  openai: "gpt-5-mini",
};

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Where an "other" endpoint's requests go: its origin and the chat URL.
 * Only https, or http to this computer, so a key never crosses the network
 * unencrypted.
 */
export function otherEndpoint(endpoint: string | undefined): { origin: string; chatUrl: string } {
  if (!endpoint?.trim()) throw new Error("give the provider's address, such as https://example.com/v1");
  let url: URL;
  try {
    url = new URL(endpoint.trim());
  } catch {
    throw new Error(`"${endpoint}" isn't a web address`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname))) throw new Error("an API key is only sent over https (or to this computer), so the address must start with https://");
  if (url.username || url.password) throw new Error("the address can't contain a user name or password");
  return { origin: url.origin, chatUrl: `${url.href.replace(/\/+$/, "")}/chat/completions` };
}

/** The origin a vendor's requests (and so its key) go to. */
export function apiOrigin(vendor: ApiVendor, endpoint?: string): string {
  return vendor === "other" ? otherEndpoint(endpoint).origin : VENDOR_ORIGINS[vendor];
}

const TOOL = "answer";

export function anthropicBody(model: string, r: AIRequest): object {
  return {
    model,
    max_tokens: 2048,
    system: r.system,
    messages: r.messages,
    ...(r.jsonSchema ? { tools: [{ name: TOOL, description: "Give your answer.", input_schema: r.jsonSchema }], tool_choice: { type: "tool", name: TOOL } } : {}),
  };
}

export function openaiBody(model: string, r: AIRequest): object {
  return {
    model,
    messages: [{ role: "system", content: r.system }, ...r.messages],
    ...(r.jsonSchema ? { response_format: { type: "json_schema", json_schema: { name: TOOL, schema: r.jsonSchema } } } : {}),
  };
}

/** The answer text in an Anthropic reply: the tool's input as JSON when a schema was asked for, else the text. */
export function anthropicAnswer(reply: unknown): string {
  const content = (reply as { content?: { type?: string; text?: unknown; input?: unknown }[] }).content;
  if (!Array.isArray(content)) throw new Error("the reply has no content");
  const tool = content.find((b) => b.type === "tool_use");
  if (tool) return JSON.stringify(tool.input);
  const text = content.filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text).join("");
  if (text === "") throw new Error("the reply has no answer in it");
  return text;
}

export function openaiAnswer(reply: unknown): string {
  const content = (reply as { choices?: { message?: { content?: unknown } }[] }).choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("the reply has no answer in it");
  return content;
}

export function hostedProvider(o: { vendor?: ApiVendor; model?: string; endpoint?: string; keys: ApiKeyStore; fetch: Fetch; timeoutMs?: number }): AIProvider {
  const vendor = o.vendor ?? "anthropic";
  if (!["anthropic", "openai", "other"].includes(vendor)) throw new Error(`unknown API provider "${vendor}"`);
  const target = vendor === "other" ? otherEndpoint(o.endpoint) : { origin: VENDOR_ORIGINS[vendor], chatUrl: vendor === "anthropic" ? `${VENDOR_ORIGINS.anthropic}/v1/messages` : `${VENDOR_ORIGINS.openai}/v1/chat/completions` };
  const model = o.model?.trim() || (vendor === "other" ? "" : DEFAULT_MODELS[vendor]);
  const who = vendor === "anthropic" ? "Anthropic's API" : vendor === "openai" ? "OpenAI's API" : target.origin;
  const key = () => o.keys.get(target.origin);
  return {
    kind: "api-key",
    structuredOutput: vendor !== "other",
    async check() {
      if (!key()) return { ok: false, reason: `no API key is saved for ${who}` };
      if (model === "") return { ok: false, reason: "choose a model" };
      return { ok: true };
    },
    async complete(request) {
      const secret = key();
      if (!secret) throw new Error(`no API key is saved for ${who}`);
      if (model === "") throw new Error("no model is chosen");
      const headers: Record<string, string> =
        vendor === "anthropic"
          ? { "x-api-key": secret, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" }
          : { authorization: `Bearer ${secret}` };
      const body = vendor === "anthropic" ? anthropicBody(model, request) : openaiBody(model, vendor === "other" ? { ...request, jsonSchema: undefined } : request);
      const reply = await requestJson({ fetch: o.fetch, url: target.chatUrl, headers, body, timeoutMs: o.timeoutMs ?? ANSWER_TIMEOUT_MS, who, secret });
      try {
        return vendor === "anthropic" ? anthropicAnswer(reply) : openaiAnswer(reply);
      } catch (e) {
        throw new Error(`${who}: ${(e as Error).message}`);
      }
    },
  };
}
