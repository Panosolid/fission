// Models that run inside the browser: a small open model on the user's
// graphics card (WebGPU, through WebLLM), or the browser's own built-in
// model where it has one. Nothing leaves the machine; the in-browser model
// is downloaded once (WebLLM caches it), after its size has been shown.

import { CHECK_TIMEOUT_MS, requestJson, type Fetch } from "./http.ts";
import type { AIProvider, AIRequest } from "./providers.ts";

/** The default in-browser model until the A10 check picks one. */
export const IN_BROWSER_MODEL = "Qwen2.5-1.5B-Instruct-q4f16_1-MLC";

/** WebGPU's guaranteed minimum storage buffer (128 MiB): WebLLM's small ("low resource") models fit in it. */
export const LOW_RESOURCE_BUFFER = 128 * 1024 * 1024;
/** Larger models need 1 GiB buffers. */
export const FULL_BUFFER = 1024 * 1024 * 1024;

/** The parts of WebGPU the check reads. */
export interface GpuLike {
  requestAdapter(): Promise<{ features: { has(name: string): boolean }; limits: { maxStorageBufferBindingSize: number } } | null>;
}

/** What WebLLM says about a model it can run. */
export interface WebLLMModel {
  model_id: string;
  /** The model's files, e.g. https://huggingface.co/mlc-ai/<id>. */
  model: string;
  vram_required_MB?: number;
  low_resource_required?: boolean;
}

/** The parts of WebLLM used here (the real module is loaded only when the provider is used). */
export interface WebLLMLike {
  prebuiltAppConfig: { model_list: WebLLMModel[] };
  CreateMLCEngine(
    model: string,
    config?: { initProgressCallback?: (report: { progress: number; text: string }) => void },
  ): Promise<{ chat: { completions: { create(request: object): Promise<{ choices: { message: { content: string | null } }[] }> } } }>;
}

/**
 * Whether this graphics card can run `model`: WebGPU present, an adapter,
 * 16-bit float shaders for the q4f16 builds, and big enough buffers (a
 * low-resource model needs 128 MiB, others 1 GiB). A weak card gets a
 * suggestion, never a failure later.
 */
export async function gpuCanRun(gpu: GpuLike | undefined, model: WebLLMModel): Promise<{ ok: true } | { ok: false; reason: string; suggest: "ollama" }> {
  const no = (reason: string) => ({ ok: false as const, reason: `${reason}. Ollama on your computer, or an API key, will work instead.`, suggest: "ollama" as const });
  if (!gpu) return no("this browser has no WebGPU, which in-browser models need");
  let adapter: Awaited<ReturnType<GpuLike["requestAdapter"]>>;
  try {
    adapter = await gpu.requestAdapter();
  } catch {
    adapter = null;
  }
  if (!adapter) return no("the browser found no graphics card it can use for WebGPU");
  if (model.model_id.includes("f16") && !adapter.features.has("shader-f16")) return no(`your graphics card can't run 16-bit models such as ${model.model_id}`);
  const need = model.low_resource_required ? LOW_RESOURCE_BUFFER : FULL_BUFFER;
  if (!(adapter.limits.maxStorageBufferBindingSize >= need))
    return no(`your graphics card's largest buffer is ${mib(adapter.limits.maxStorageBufferBindingSize)} and ${model.model_id} needs ${mib(need)}`);
  return { ok: true };
}

const mib = (bytes: number) => `${Math.round(bytes / 2 ** 20)} MiB`;

/** The download size of a WebLLM model in bytes: the sum over its weight files, from the model's ndarray-cache.json. */
export async function inBrowserDownloadBytes(model: WebLLMModel, fetch: Fetch): Promise<number> {
  const reply = await requestJson({ fetch, url: `${model.model.replace(/\/+$/, "")}/resolve/main/ndarray-cache.json`, timeoutMs: CHECK_TIMEOUT_MS * 5, who: "the model's download site" });
  const records = (reply as { records?: { nbytes?: unknown }[] }).records;
  if (!Array.isArray(records) || records.length === 0) throw new Error("the model's file list is empty");
  let total = 0;
  for (const r of records) {
    if (typeof r.nbytes !== "number" || !Number.isFinite(r.nbytes) || r.nbytes < 0) throw new Error("the model's file list has a file with no size");
    total += r.nbytes;
  }
  return total;
}

/** The request as the OpenAI-style messages WebLLM takes, with the schema as WebLLM's json_object constraint. */
export function webllmRequest(r: AIRequest): object {
  return {
    messages: [{ role: "system", content: r.system }, ...r.messages],
    temperature: 0,
    ...(r.jsonSchema ? { response_format: { type: "json_object", schema: JSON.stringify(r.jsonSchema) } } : {}),
  };
}

export function inBrowserProvider(o: {
  model?: string;
  gpu: GpuLike | undefined;
  loadWebLLM: () => Promise<WebLLMLike>;
  onProgress?: (fraction: number, text: string) => void;
}): AIProvider {
  const id = o.model?.trim() || IN_BROWSER_MODEL;
  let engine: ReturnType<WebLLMLike["CreateMLCEngine"]> | undefined;
  const info = async () => {
    const webllm = await o.loadWebLLM();
    const model = webllm.prebuiltAppConfig.model_list.find((m) => m.model_id === id);
    if (!model) throw new Error(`${id} isn't a model the in-browser runner knows`);
    return { webllm, model };
  };
  return {
    kind: "in-browser",
    structuredOutput: true,
    async check() {
      try {
        return await gpuCanRun(o.gpu, (await info()).model);
      } catch (e) {
        return { ok: false, reason: (e as Error).message, suggest: "ollama" };
      }
    },
    async complete(request) {
      if (!engine) {
        const { webllm, model } = await info();
        const can = await gpuCanRun(o.gpu, model);
        if (!can.ok) throw new Error(can.reason);
        engine = webllm.CreateMLCEngine(id, { initProgressCallback: (p) => o.onProgress?.(p.progress, p.text) });
        engine.catch(() => (engine = undefined)); // a failed load is tried again next time
      }
      const reply = await (await engine).chat.completions.create(webllmRequest(request));
      const content = reply.choices[0]?.message.content;
      if (typeof content !== "string") throw new Error("the in-browser model gave no answer");
      return content;
    },
  };
}

/** The parts of the browser's built-in model API used here (a global `LanguageModel` where the browser has one). */
export interface BuiltInModelLike {
  availability(): Promise<"unavailable" | "downloadable" | "downloading" | "available">;
  create(options: { initialPrompts: { role: "system" | "user" | "assistant"; content: string }[] }): Promise<{
    prompt(input: string, options?: { responseConstraint?: object }): Promise<string>;
    destroy(): void;
  }>;
}

export function builtInProvider(o: { api: BuiltInModelLike | undefined }): AIProvider {
  return {
    kind: "browser-built-in",
    structuredOutput: true,
    async check() {
      if (!o.api) return { ok: false, reason: "this browser has no built-in model", suggest: "in-browser" };
      const a = await o.api.availability().catch(() => "unavailable" as const);
      if (a === "available") return { ok: true };
      if (a === "unavailable") return { ok: false, reason: "this browser's built-in model can't run on this computer", suggest: "in-browser" };
      // The browser has the API but not the model ("downloadable", or
      // "downloading" once something asked for it): a session made now would
      // start or wait on a download of a few gigabytes and answer nothing
      // until it ends. Found by CI's Chrome 156 (#238), which says
      // "downloadable" on a machine with no model: the panel chose it and
      // every question hung. Offering the download with the user's consent is
      // a later item; until then only a model that is there counts.
      return {
        ok: false,
        reason: a === "downloading" ? "this browser is still downloading its built-in model; it can be chosen once that has finished" : "this browser hasn't downloaded its built-in model yet",
        suggest: "in-browser",
      };
    },
    async complete(r) {
      if (!o.api) throw new Error("this browser has no built-in model");
      const last = r.messages.at(-1);
      if (!last || last.role !== "user") throw new Error("a request must end with the user's message");
      const session = await o.api.create({ initialPrompts: [{ role: "system", content: r.system }, ...r.messages.slice(0, -1)] });
      try {
        return await session.prompt(last.content, r.jsonSchema ? { responseConstraint: r.jsonSchema } : undefined);
      } finally {
        session.destroy();
      }
    },
  };
}
