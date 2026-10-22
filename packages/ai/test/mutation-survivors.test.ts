// Tests written to kill the mutants StrykerJS found surviving in the AI
// assistant (2026-10-22; run it again with packages/testing/stryker/run.sh
// ai). Each test names the change to the code it catches. Mutants that
// change nothing a caller can see are listed, with the reason, in
// packages/testing/stryker/explained.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DependencyGraph, emptyProject, type Feature, type WorkspaceId } from "@fission/core";
import { askForCommands } from "../src/commands.ts";
import { buildContext } from "../src/context.ts";
import { requestJson, type Fetch } from "../src/http.ts";
import { browserKeyStore, memoryKeyStore } from "../src/keys.ts";
import { anthropicAnswer, anthropicBody, apiOrigin, hostedProvider, listHostedModels, openaiAnswer, otherEndpoint } from "../src/hosted.ts";
import { hasModel, isThisComputer, ollamaEndpoint, ollamaModels, ollamaProvider } from "../src/ollama.ts";
import { builtInProvider, gpuCanRun, inBrowserDownloadBytes, inBrowserProvider, type BuiltInModelLike, type GpuLike, type WebLLMLike } from "../src/local.ts";
import { systemPrompt } from "../src/prompt.ts";
import { SPECIALISTS } from "../src/specialists.ts";
import { AI_FEATURES } from "../src/features.ts";
import { chooseModel, createProvider, detectProviders, inBrowserDownloadSize, PROVIDERS } from "../src/providers.ts";
import type { AIProvider, AIRequest } from "../src/index.ts";
import { fakeServer } from "./fakes.ts";

// ---------- http.ts: every request the assistant sends ----------

test("requests carry no cookies and no referrer, so the provider learns nothing about the page", async () => {
  // Kills credentials "omit" => "" and referrerPolicy "no-referrer" => "" (security: a provider
  // must not get the user's cookies for its own site, nor the page's address).
  const seen: RequestInit[] = [];
  const fetch: Fetch = async (_url, init) => (seen.push(init), new Response("{}"));
  await requestJson({ fetch, url: "https://api.example/v1", body: { a: 1 }, timeoutMs: 1000, who: "Example" });
  await requestJson({ fetch, url: "https://api.example/v1", timeoutMs: 1000, who: "Example" });
  for (const init of seen) {
    assert.equal(init.credentials, "omit");
    assert.equal(init.referrerPolicy, "no-referrer");
  }
  assert.deepEqual(seen.map((i) => [i.method, i.body]), [["POST", '{"a":1}'], ["GET", undefined]]);
});

test("a reply body that stops part way through the time allowed says it timed out, in seconds", async () => {
  // Kills the body-read catch => {}, `timedOut` => true / false there, its message => "" and
  // `timeoutMs / 1000` => `* 1000`. The headers arrive, then the body read fails after the clock
  // ran out: 2,500 ms rounds to 3 s.
  const realSetTimeout = globalThis.setTimeout;
  let fire: (() => void) | null = null;
  globalThis.setTimeout = ((fn: () => void) => ((fire = fn), 0)) as unknown as typeof setTimeout;
  try {
    const fetch: Fetch = async () =>
      ({
        ok: true,
        status: 200,
        text: async () => {
          fire!();
          throw new Error("the body stream was aborted");
        },
      }) as unknown as Response;
    await assert.rejects(requestJson({ fetch, url: "https://x", timeoutMs: 2500, who: "Slow" }), { message: "Slow didn't answer within 3 s" });
    // Not timed out: the body's own error comes through as it is.
    const broken: Fetch = async () => ({ ok: true, status: 200, text: async () => Promise.reject(new Error("bad gzip")) }) as unknown as Response;
    await assert.rejects(requestJson({ fetch: broken, url: "https://x", timeoutMs: 2500, who: "Slow" }), { message: "bad gzip" });
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});

test("a reply that isn't JSON shows its first 80 characters", async () => {
  // Kills `text.slice(0, 80)` => `text`.
  const { fetch } = fakeServer(() => ({ text: "x".repeat(100) }));
  await assert.rejects(requestJson({ fetch, url: "https://x", timeoutMs: 1000, who: "P" }), { message: `P sent a reply that isn't JSON: ${"x".repeat(80)}` });
});

test("a refusal shows the provider's message, else the first 200 characters, else 'no details given'", async () => {
  // Kills every mutant of errorText's `e && typeof e.message === "string"` and of
  // `body.slice(0, 200) || "no details given"`.
  const refusal = async (text: string) => {
    const { fetch } = fakeServer(() => ({ status: 400, text }));
    try {
      await requestJson({ fetch, url: "https://x", timeoutMs: 1000, who: "P" });
    } catch (e) {
      return (e as Error).message.replace("P refused the request (HTTP 400): ", "");
    }
    return "accepted";
  };
  assert.equal(await refusal('{"error":{"message":"bad key"}}'), "bad key");
  assert.equal(await refusal('{"error":"rate limited"}'), "rate limited");
  assert.equal(await refusal('{"error":{"message":5}}'), '{"error":{"message":5}}');
  assert.equal(await refusal('{"error":null}'), '{"error":null}');
  assert.equal(await refusal("y".repeat(300)), "y".repeat(200));
  assert.equal(await refusal(""), "no details given");
});

// ---------- ollama.ts ----------

test("Ollama addresses: http and https only, every trailing slash gone, spaces trimmed", () => {
  // Kills `url.protocol !== "https:"` => true and "https:" => "", /\/+$/ => /\/$/.
  assert.equal(ollamaEndpoint("https://ollama.example:443/"), "https://ollama.example");
  assert.equal(ollamaEndpoint("http://localhost:11434///"), "http://localhost:11434");
  assert.throws(() => ollamaEndpoint("ftp://localhost:11434"), /not ftp:/);
});

test("a name that merely ends like a loopback address is not this computer (security audit S3)", () => {
  // Not a killer: the regex's ^ is explained (the URL parser refuses any host whose last label
  // is a number but which isn't an IPv4 address, so "a.127.0.0.1" never reaches it). This pins
  // the parser's half of that, and that the address is trimmed before it is read.
  assert.equal(isThisComputer("http://a.127.0.0.1:11434"), false);
  assert.equal(isThisComputer("http://127.0.0.1:11434"), true);
  assert.equal(isThisComputer("  http://127.0.0.1:11434  "), true);
});

test("Ollama's model list: an exact name, a missing tag, and entries that are not models", async () => {
  // Kills `n === model` => false (a name with its own tag must match itself), `?? []` =>
  // ["Stryker was here"] and `m?.name` => `m.name` (a null entry must not throw).
  const { fetch } = fakeServer(() => ({ json: { models: [{ name: "qwen2.5:1.5b" }, null, { name: 7 }] } }));
  assert.deepEqual(await ollamaModels({ fetch }), ["qwen2.5:1.5b"]);
  const none = fakeServer(() => ({ json: {} }));
  assert.deepEqual(await ollamaModels({ fetch: none.fetch }), []);
  assert.deepEqual(await ollamaProvider({ model: "qwen2.5:1.5b", fetch }).check(), { ok: true });
});

test("Ollama names itself by its address in errors, and needs a chosen model, spaces trimmed", async () => {
  // Kills `Ollama at ${endpoint}` => "", `o.model?.trim()` => `o.model`, and complete()'s
  // `model === ""` => false and its message => "" (and "" => "Stryker was here!").
  const { fetch, calls } = fakeServer(() => ({ status: 500, text: "boom" }));
  const p = ollamaProvider({ model: "  ", fetch, endpoint: "http://localhost:9" });
  await assert.rejects(p.complete({ system: "", messages: [] }), { message: "no Ollama model is chosen" });
  assert.equal(calls.length, 0, "nothing sent without a model");
  const q = ollamaProvider({ model: " llama3.2 ", fetch, endpoint: "http://localhost:9" });
  await assert.rejects(q.complete({ system: "", messages: [] }), { message: "Ollama at http://localhost:9 refused the request (HTTP 500): boom" });
  assert.equal((calls[0].body as { model: string }).model, "llama3.2");
  const unnamed = ollamaProvider({ fetch, endpoint: "http://localhost:9" });
  await assert.rejects(unnamed.complete({ system: "", messages: [] }), { message: "no Ollama model is chosen" });
});

// ---------- keys.ts ----------

test("with no local storage, keeping a key is refused with the reason", () => {
  // Kills `!storage` => false and its message => "".
  assert.throws(() => browserKeyStore(undefined as never), { message: "this browser has no local storage, so an API key can't be kept" });
});

// ---------- context.ts ----------

const feature = (n: number): Feature => ({
  id: `feature-${n}`,
  intent: { type: "box", parameters: { width: n }, summary: `Box ${n}` },
  provenance: { self: { workspace: "design", id: `feature-${n}`, label: `F${n}` }, from: [] },
  dependsOn: [],
  suppressed: false,
});

test("large context: the newest 500 features and the first 20 errors", () => {
  // Kills LIMITS.large => {} (slice(-undefined) keeps everything, slice(0, undefined) too).
  const project = emptyProject();
  project.workspaces.design = { version: 1, profiles: [], timeline: { features: Array.from({ length: 501 }, (_, i) => feature(i + 1)) } };
  const c = buildContext(project, { workspace: "design", graph: new DependencyGraph(), detail: "large", errors: Array.from({ length: 21 }, (_, i) => `e${i}`) });
  assert.equal(c.features.length, 500);
  assert.equal(c.features[0].id, "feature-2");
  assert.equal(c.errors.length, 20);
  assert.equal(c.errors.at(-1), "e19");
});

test("a workspace with no timeline adds no features; no errors is an empty list; materials by name", () => {
  // Kills `?.timeline` => `.timeline` (an undefined workspace entry), `timeline?.features` =>
  // `.features`, errors' `?? []` => ["Stryker was here"] and the materials' `(m) => m.name`.
  const project = emptyProject();
  project.workspaces.image = { version: 1 };
  project.workspaces.render = undefined as never;
  project.materials = [{ id: "m1", name: "Oak", appearance: { colour: "#a0522d", roughness: 0.8, metalness: 0 } }];
  const c = buildContext(project, { workspace: "design", graph: new DependencyGraph() });
  assert.deepEqual([c.features, c.errors, c.materials], [[], [], ["Oak"]]);
});

// ---------- commands.ts, prompt.ts ----------

test("a retry shows the model its own bad answer, then says why it can't be used", async () => {
  // Kills the retry's { role: "assistant", content } => {} and its role strings => "", and the
  // first error's "" => "Stryker was here!" (two bad answers report the second's problem).
  const seen: AIRequest[] = [];
  const provider: AIProvider = { kind: "ollama", structuredOutput: true, check: async () => ({ ok: true }), complete: async (r) => (seen.push(structuredClone(r)), "not json") };
  const spec = { op: "go", summary: "Go.", params: {} };
  const r = await askForCommands(provider, { system: "s", messages: [{ role: "user", content: "hi" }] }, [spec]);
  assert.deepEqual(r, { ok: false, error: "The AI's answer couldn't be used, even after one retry: the answer is not JSON. Nothing was changed." });
  assert.deepEqual(seen[1].messages, [
    { role: "user", content: "hi" },
    { role: "assistant", content: "not json" },
    { role: "user", content: "That answer can't be used: the answer is not JSON. Answer again with valid JSON only." },
  ]);
});

test("the system prompt opens with what the model does, and describes only lengths and choices", () => {
  // Kills its first two lines => "", `p.type === "choice"` => true and the kind's "" =>
  // "Stryker was here!" (a text parameter has no kind note).
  const spec = { op: "name", summary: "Name it.", params: { label: { type: "text" as const, maxLength: 20, description: "the name" }, side: { type: "choice" as const, values: ["a", "b"], description: "which side", optional: true } } };
  const lines = systemPrompt([], [spec]).split("\n");
  assert.deepEqual(lines.slice(0, 5), ["You edit a CAD part in Panosolid by answering with commands.", "The commands you can use:", "- name: Name it.", "  label: the name", "  side: which side (one of: a, b; optional)"]);
});

// ---------- local.ts ----------

const gpu = (buffer: number, f16 = true, throws = false): GpuLike => ({
  requestAdapter: async () => {
    if (throws) throw new Error("GPU process crashed");
    return { features: { has: (n: string) => f16 && n === "shader-f16" }, limits: { maxStorageBufferBindingSize: buffer } };
  },
});

test("a graphics card whose adapter request throws counts as none; an f32 model needs no f16 shaders", async () => {
  // Kills the catch's `adapter = null` => {} and "f16" => "" (every model id includes "").
  assert.deepEqual(await gpuCanRun(gpu(2 ** 31, true, true), { model_id: "M-q4f16_1", model: "" }), {
    ok: false,
    reason: "the browser found no graphics card it can use for WebGPU. Ollama on your computer, or an API key, will work instead.",
    suggest: "ollama",
  });
  assert.deepEqual(await gpuCanRun(gpu(2 ** 31, false), { model_id: "M-q4f32_1", model: "" }), { ok: true });
});

test("the download size: from the model's file list, any number of trailing slashes, every size a number of at least 0", async () => {
  // Kills /\/+$/ => /\/$/,
  // "the model's download site" => "", and the nbytes checks' mutants (`||` => `&&`, each half =>
  // false, `< 0` => `<= 0`: an empty file is 0 bytes and fine).
  const { fetch, calls } = fakeServer(() => ({ json: { records: [{ nbytes: 10 }, { nbytes: 0 }, { nbytes: 5 }] } }));
  assert.equal(await inBrowserDownloadBytes({ model_id: "M", model: "https://hf.example/m//" }, fetch), 15);
  assert.equal(calls[0].url, "https://hf.example/m/resolve/main/ndarray-cache.json");
  for (const bad of ["10", -1, Infinity, null]) {
    const s = fakeServer(() => ({ json: { records: [{ nbytes: bad }] } }));
    await assert.rejects(inBrowserDownloadBytes({ model_id: "M", model: "https://hf.example/m" }, s.fetch), { message: "the model's file list has a file with no size" }, String(bad));
  }
  const down = fakeServer(() => ({ status: 503, text: "" }));
  await assert.rejects(inBrowserDownloadBytes({ model_id: "M", model: "https://hf.example/m" }, down.fetch), { message: "the model's download site refused the request (HTTP 503): no details given" });
});

test("the download check waits 15 s before giving up (worked by hand: 5 × the 3 s check)", async () => {
  // Kills CHECK_TIMEOUT_MS * 5 => / 5: the message says the rounded seconds.
  const realSetTimeout = globalThis.setTimeout;
  let waited = -1;
  globalThis.setTimeout = ((fn: () => void, ms: number) => ((waited = ms), realSetTimeout(fn, 0))) as unknown as typeof setTimeout;
  try {
    const never: Fetch = (_url, init) => new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted"))));
    await assert.rejects(inBrowserDownloadBytes({ model_id: "M", model: "https://hf.example/m" }, never), { message: "the model's download site didn't answer within 15 s" });
    assert.equal(waited, 15_000);
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});

function webllm(content: string | null | undefined, ids = ["Qwen2.5-1.5B-Instruct-q4f16_1-MLC", "Small"]): WebLLMLike {
  return {
    prebuiltAppConfig: { model_list: ids.map((model_id) => ({ model_id, model: "", low_resource_required: true })) },
    CreateMLCEngine: async (_id, config) => {
      config?.initProgressCallback?.({ progress: 1, text: "ready" });
      return { chat: { completions: { create: async () => ({ choices: content === undefined ? [] : [{ message: { content } }] }) } } };
    },
  };
}

test("the in-browser model: a chosen id trimmed, no progress handler needed, and no answer is an error", async () => {
  // Kills `o.model?.trim()` => `o.model`, `o.onProgress?.(…)` => `o.onProgress(…)`,
  // `choices[0]?.message` => `.message` (no choices must not throw a TypeError), and
  // `typeof content !== "string"` => false and its message => "".
  const p = inBrowserProvider({ model: " Small ", gpu: gpu(2 ** 31), loadWebLLM: async () => webllm('{"commands":[]}') });
  assert.equal(await p.complete({ system: "", messages: [] }), '{"commands":[]}');
  for (const content of [null, undefined]) {
    const q = inBrowserProvider({ gpu: gpu(2 ** 31), loadWebLLM: async () => webllm(content) });
    await assert.rejects(q.complete({ system: "", messages: [] }), { message: "the in-browser model gave no answer" });
  }
});

test("the browser's built-in model: structured, refused when absent or unable, and only after a user's message", async () => {
  // Kills structuredOutput true => false, the availability catch's "unavailable" => undefined,
  // `a === "unavailable"` => false and its strings => "", complete()'s `!o.api` => false and its
  // message => "", and the last-message check's mutants.
  const none = builtInProvider({ api: undefined });
  assert.equal(none.structuredOutput, true);
  await assert.rejects(none.complete({ system: "", messages: [{ role: "user", content: "hi" }] }), { message: "this browser has no built-in model" });
  const broken = builtInProvider({ api: { availability: () => Promise.reject(new Error("no")), create: async () => assert.fail("not created") } });
  assert.deepEqual(await broken.check(), { ok: false, reason: "this browser's built-in model can't run on this computer", suggest: "in-browser" });
  const api: BuiltInModelLike = { availability: async () => "available", create: async () => ({ prompt: async () => "ok", destroy: () => {} }) };
  const p = builtInProvider({ api });
  for (const messages of [[], [{ role: "assistant" as const, content: "x" }]])
    await assert.rejects(p.complete({ system: "", messages }), { message: "a request must end with the user's message" });
  assert.equal(await p.complete({ system: "", messages: [{ role: "user", content: "hi" }] }), "ok");
});

// ---------- specialists.ts ----------

test("the planned specialist models, as the provider list names them", () => {
  // Kills each title and workspace => "" or [].
  assert.deepEqual(
    SPECIALISTS.map((s) => [s.task, s.title, s.workspaces.join(" "), s.later ?? ""]),
    [
      ["background-removal", "Background removal", "image", ""],
      ["segmentation", "Smart selection (segmentation)", "image", ""],
      ["upscaling", "Upscaling", "image", ""],
      ["inpainting", "Inpainting (fill a selection)", "image", ""],
      ["tracing", "Image tracing to paths", "vector laser", ""],
      ["print-failure", "Print-failure classification from photos", "slice", "after Slice is real"],
    ],
  );
});

// ---------- features.ts ----------

test("every workspace and the suite promise at least one AI feature, each a real line, and Manufacture's says it never runs a machine", () => {
  // Kills each list => [] and each line => "". The machine line is the project's rule (the
  // assistant never controls a machine), shown where a user would look for it.
  const all: (WorkspaceId | "suite")[] = ["design", "render", "simulate", "manufacture", "laser", "slice", "circuit", "vector", "image", "layout", "suite"];
  assert.deepEqual(Object.keys(AI_FEATURES).sort(), [...all].sort());
  for (const w of all) {
    const lines = AI_FEATURES[w];
    assert.ok(lines.length > 0, `${w} has no AI features`);
    for (const line of lines) assert.ok(line.trim().length >= 5, `${w}: ${JSON.stringify(line)}`);
    assert.equal(new Set(lines).size, lines.length, `${w} names one twice`);
  }
  assert.ok(AI_FEATURES.manufacture.includes("Never runs a machine"));
  assert.ok(AI_FEATURES.circuit.some((l) => l.includes("review required")), "AI-drafted schematics are marked for review");
});

// ---------- hosted.ts: where an API key may go ----------

test("an 'other' address may be http only to this computer by name, 127.0.0.1 or [::1]; anything else needs https", () => {
  // Kills LOCAL_HOSTS' "127.0.0.1" and "[::1]" => "", `url.protocol === "http:"` => true (ftp to
  // this computer would pass), and the trims and bad-address error's block and message.
  for (const ok of ["http://localhost:8080/v1", "http://127.0.0.1:8080/v1", "http://[::1]:8080/v1", "https://llm.example/v1"]) assert.ok(otherEndpoint(ok).chatUrl.endsWith("/v1/chat/completions"), ok);
  assert.equal(otherEndpoint("  https://llm.example/v1  ").origin, "https://llm.example");
  for (const bad of ["ftp://localhost/v1", "http://192.168.1.5/v1", "ws://127.0.0.1/v1"]) assert.throws(() => otherEndpoint(bad), /only sent over https/, bad);
  assert.throws(() => otherEndpoint("not an address"), { message: '"not an address" isn\'t a web address' });
});

test("an 'other' address with only a user name, or only a password, is refused; trailing slashes go", () => {
  // Kills `url.username || url.password` => `&&` and /\/+$/ => /\/$/.
  assert.throws(() => otherEndpoint("https://me@llm.example/v1"), /user name or password/);
  assert.throws(() => otherEndpoint("https://:secret@llm.example/v1"), /user name or password/);
  assert.equal(otherEndpoint("https://llm.example/v1///").modelsUrl, "https://llm.example/v1/models");
});

test("each vendor's key goes to its own origin", () => {
  // Kills apiOrigin's body => {} and `vendor === "other"` => true / `!==`.
  assert.equal(apiOrigin("anthropic"), "https://api.anthropic.com");
  assert.equal(apiOrigin("openai"), "https://api.openai.com");
  assert.equal(apiOrigin("other", "https://llm.example/v1"), "https://llm.example");
});

const keysFor = (origin: string, key = "sk-test-123456") => {
  const k = memoryKeyStore();
  k.set(origin, key);
  return k;
};

test("listing models: OpenAI's own wording, an unknown vendor refused, and 15 s to answer", async () => {
  // Kills `vendor === "openai"` => false / `!==` / "openai" / "OpenAI's API" => "" in `who`,
  // `vendor === "anthropic"` => true there, the unknown-vendor check, and `?? CHECK_TIMEOUT_MS * 5`
  // => `&&` / `/ 5`.
  const { fetch } = fakeServer(() => ({ status: 401, text: '{"error":{"message":"bad key"}}' }));
  await assert.rejects(listHostedModels({ vendor: "openai", keys: keysFor("https://api.openai.com"), fetch }), { message: "OpenAI's API refused the request (HTTP 401): bad key" });
  await assert.rejects(listHostedModels({ vendor: "nope" as never, keys: memoryKeyStore(), fetch }), { message: 'unknown API provider "nope"' });
  const realSetTimeout = globalThis.setTimeout;
  const waits: number[] = [];
  globalThis.setTimeout = ((fn: () => void, ms: number) => (waits.push(ms), realSetTimeout(fn, 1e9))) as unknown as typeof setTimeout;
  try {
    const ok = fakeServer(() => ({ json: { data: [{ id: "m" }] } }));
    await listHostedModels({ vendor: "anthropic", keys: keysFor("https://api.anthropic.com"), fetch: ok.fetch });
    await listHostedModels({ vendor: "anthropic", keys: keysFor("https://api.anthropic.com"), fetch: ok.fetch, timeoutMs: 7 });
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  assert.deepEqual(waits, [15_000, 7]);
});

test("Anthropic's answer: only text blocks count, and a reply with no text is an error", () => {
  // Kills the content-is-an-array check and its message, the text filter (=> content, => true,
  // `||`, each half => true) and `text === ""` => false.
  assert.throws(() => anthropicAnswer({ content: "hi" }), { message: "the reply has no content" });
  assert.equal(anthropicAnswer({ content: [{ type: "thinking", text: "hmm " }, { type: "text", text: "yes" }, { type: "text", text: 5 }, { type: "text" }] }), "yes");
  assert.throws(() => anthropicAnswer({ content: [{ type: "thinking", text: "hmm" }] }), { message: "the reply has no answer in it" });
});

test("OpenAI's answer: a reply with no choices, no message or no text is an error, not a crash", () => {
  // Kills each `?.` in `choices?.[0]?.message?.content` => `.`, the type check => false and its
  // message => "".
  for (const reply of [{}, { choices: [] }, { choices: [{}] }, { choices: [{ message: {} }] }, { choices: [{ message: { content: 5 } }] }])
    assert.throws(() => openaiAnswer(reply), { message: "the reply has no answer in it" }, JSON.stringify(reply));
});

test("a hosted provider: Anthropic's name, a trimmed model, 'choose a model' for an 'other' with none, and its answer errors named", async () => {
  // Kills `vendor === "anthropic"` => false and "Anthropic's API" => "" in `who`, "other" /
  // "anthropic" defaults, `o.model?.trim()` => `o.model`, check()'s { ok: false, "choose a model" }
  // mutants, complete()'s model check and message, and the answer catch's block and message.
  const noKey = hostedProvider({ keys: memoryKeyStore(), fetch: fakeServer(() => ({})).fetch });
  assert.deepEqual(await noKey.check(), { ok: false, reason: "no API key is saved for Anthropic's API" });
  const other = hostedProvider({ vendor: "other", endpoint: "https://llm.example/v1", keys: keysFor("https://llm.example"), fetch: fakeServer(() => ({})).fetch });
  assert.deepEqual(await other.check(), { ok: false, reason: "choose a model" });
  await assert.rejects(other.complete({ system: "", messages: [] }), { message: "no model is chosen" });
  const { fetch, calls } = fakeServer(() => ({ json: { content: [] } }));
  const p = hostedProvider({ vendor: "anthropic", model: " claude-x ", keys: keysFor("https://api.anthropic.com", "sk-ant-abc123456"), fetch });
  await assert.rejects(p.complete({ system: "", messages: [{ role: "user", content: "hi" }] }), { message: "Anthropic's API: the reply has no answer in it" });
  assert.equal((calls[0].body as { model: string }).model, "claude-x");
  assert.equal(calls[0].url, "https://api.anthropic.com/v1/messages");
});

test("Anthropic's structured answer asks for the one tool, described", () => {
  // Kills the tool's description "Give your answer." => "".
  const body = anthropicBody("m", { system: "s", messages: [], jsonSchema: { type: "object" } }) as { tools: { description: string }[] };
  assert.equal(body.tools[0].description, "Give your answer.");
});

test("a hosted answer waits as long as asked, else 180 s", async () => {
  // Kills `o.timeoutMs ?? ANSWER_TIMEOUT_MS` => `&&` (7 would become 180,000).
  const realSetTimeout = globalThis.setTimeout;
  const waits: number[] = [];
  globalThis.setTimeout = ((fn: () => void, ms: number) => (waits.push(ms), realSetTimeout(fn, 1e9))) as unknown as typeof setTimeout;
  try {
    const { fetch } = fakeServer(() => ({ json: { content: [{ type: "text", text: "ok" }] } }));
    for (const timeoutMs of [7, undefined]) await hostedProvider({ keys: keysFor("https://api.anthropic.com"), fetch, timeoutMs }).complete({ system: "", messages: [] });
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  assert.deepEqual(waits, [7, 180_000]);
});

// ---------- providers.ts ----------

test("the provider list: each has a title, a description and notes, and only the API key sends data away", () => {
  // Kills each title, description and note => "" and the built-in model's notes => []. The two
  // local ones promise that nothing leaves the machine, in those words.
  for (const p of PROVIDERS) {
    assert.ok(p.title.length >= 5 && p.description.length >= 20, p.kind);
    assert.ok(p.notes.length > 0 && p.notes.every((n) => n.length >= 20), p.kind);
  }
  assert.deepEqual(PROVIDERS.map((p) => [p.kind, p.remote]), [["in-browser", false], ["ollama", false], ["api-key", true], ["browser-built-in", false]]);
  for (const kind of ["in-browser", "ollama"]) assert.match(PROVIDERS.find((p) => p.kind === kind)!.description, /nothing leaves your machine/i, kind);
  assert.deepEqual(PROVIDERS.map((p) => p.title), ["In your browser", "Ollama on your computer", "Your own API key", "Your browser's built-in AI"]);
});

test("with no stand-ins given, providers use the browser's own fetch, graphics card and built-in model", async () => {
  // Kills browserFetch, browserGpu and browserBuiltIn => () => undefined, and browserGpu's
  // `navigator?.gpu` => `navigator.gpu`.
  const realFetch = globalThis.fetch;
  const nav = Object.getOwnPropertyDescriptor(globalThis, "navigator")!;
  const urls: string[] = [];
  globalThis.fetch = (async (url: string) => (urls.push(url), new Response('{"message":{"content":"hi"}}'))) as typeof fetch;
  (globalThis as { LanguageModel?: unknown }).LanguageModel = { availability: async () => "available" };
  Object.defineProperty(globalThis, "navigator", { value: { gpu: { requestAdapter: async () => null } }, configurable: true });
  try {
    assert.equal(await createProvider({ kind: "ollama", model: "m" }).complete({ system: "", messages: [] }), "hi");
    assert.deepEqual(urls, ["http://localhost:11434/api/chat"]);
    assert.deepEqual(await createProvider({ kind: "browser-built-in" }).check(), { ok: true });
    const gpu = await createProvider({ kind: "in-browser" }, { loadWebLLM: async () => webllm("x") }).check();
    assert.equal(gpu.ok === false && gpu.reason.startsWith("the browser found no graphics card"), true, JSON.stringify(gpu));
    Object.defineProperty(globalThis, "navigator", { value: undefined, configurable: true });
    const none = await createProvider({ kind: "in-browser" }, { loadWebLLM: async () => webllm("x") }).check();
    assert.equal(none.ok === false && none.reason.startsWith("this browser has no WebGPU"), true, JSON.stringify(none));
  } finally {
    globalThis.fetch = realFetch;
    delete (globalThis as { LanguageModel?: unknown }).LanguageModel;
    Object.defineProperty(globalThis, "navigator", nav);
  }
});

test("an in-browser model's download size is read for the model named, through the stand-ins given", async () => {
  // Kills the body => {}, `deps.loadWebLLM ?? loadWebLLM` and `deps.fetch ?? browserFetch` => `&&`,
  // the model match's mutants, and the unknown model's check and message.
  const { fetch, calls } = fakeServer((c) => ({ json: { records: [{ nbytes: c.url.includes("/b/") ? 7 : 1 }] } }));
  const runner: WebLLMLike = { ...webllm("x"), prebuiltAppConfig: { model_list: [{ model_id: "A", model: "https://hf.example/a" }, { model_id: "B", model: "https://hf.example/b" }] } };
  assert.equal(await inBrowserDownloadSize("B", { fetch, loadWebLLM: async () => runner }), 7);
  assert.deepEqual(calls.map((c) => c.url), ["https://hf.example/b/resolve/main/ndarray-cache.json"]);
  await assert.rejects(inBrowserDownloadSize("C", { fetch, loadWebLLM: async () => runner }), { message: "C isn't a model the in-browser runner knows" });
});

test("detecting providers: a check that throws gives its message; Ollama refusing with a body that mentions models is not found", async () => {
  // Kills the catch's ({ ok: false, reason }) => {} / () => undefined, and the ^ of
  // /^(choose a model|Ollama has no models yet)/ (a refusal's text can contain those words).
  const builtIn = {
    availability(): never {
      throw new Error("the built-in model API is switched off");
    },
  } as unknown as BuiltInModelLike;
  assert.deepEqual(await detectProviders({ builtIn }, ["browser-built-in"]), [{ kind: "browser-built-in", ok: false, reason: "the built-in model API is switched off" }]);
  const { fetch } = fakeServer(() => ({ status: 403, text: "choose a model" }));
  const [ollama] = await detectProviders({ fetch }, ["ollama"]);
  assert.equal(ollama.ok, false);
});

test("choosing a model: each kind's suggestion beats the first listed", () => {
  // Kills every mutant of the `suggested` chain: Ollama's qwen, the vendor's default (Anthropic's
  // when none is named, OpenAI's), the in-browser default, and none for an 'other' API.
  const list = (...extra: string[]) => ["first", ...extra];
  assert.equal(chooseModel({ kind: "ollama" }, list("qwen2.5:1.5b")), "qwen2.5:1.5b");
  assert.equal(chooseModel({ kind: "api-key" }, list("claude-haiku-5-5", "gpt-5-mini")), "claude-haiku-5-5");
  assert.equal(chooseModel({ kind: "api-key", vendor: "openai" }, list("claude-haiku-5-5", "gpt-5-mini")), "gpt-5-mini");
  assert.equal(chooseModel({ kind: "api-key", vendor: "other" }, list("claude-haiku-5-5", "gpt-5-mini")), "first");
  assert.equal(chooseModel({ kind: "in-browser" }, list("Qwen2.5-1.5B-Instruct-q4f16_1-MLC")), "Qwen2.5-1.5B-Instruct-q4f16_1-MLC");
  assert.equal(chooseModel({ kind: "browser-built-in" }, list("qwen2.5:1.5b", "claude-haiku-5-5", "Qwen2.5-1.5B-Instruct-q4f16_1-MLC")), "first");
});

test("leftovers from the second run: blank addresses, default vendors, names in errors, and Ollama-only tag matching", async () => {
  // Kills hosted's `endpoint?.trim()` => `endpoint` (spaces only is no address), listing's
  // default vendor "anthropic" => "", `vendor === "openai"` => true in a provider's name for an
  // 'other' address, hostedProvider's unknown-vendor check and message, the in-browser
  // provider's structuredOutput, buildContext's selection `?? []`, and chooseModel's
  // `settings.kind === "ollama"` => true (only Ollama reads "x" as "x:latest").
  assert.throws(() => otherEndpoint("   "), /give the provider's address/);
  const { fetch } = fakeServer(() => ({ json: { data: [{ id: "claude-x" }] } }));
  assert.deepEqual(await listHostedModels({ keys: keysFor("https://api.anthropic.com"), fetch }), ["claude-x"]);
  const other = hostedProvider({ vendor: "other", endpoint: "https://llm.example/v1", model: "m", keys: memoryKeyStore(), fetch });
  assert.deepEqual(await other.check(), { ok: false, reason: "no API key is saved for https://llm.example" });
  assert.throws(() => hostedProvider({ vendor: "nope" as never, keys: memoryKeyStore(), fetch }), { message: 'unknown API provider "nope"' });
  assert.equal(inBrowserProvider({ gpu: undefined, loadWebLLM: async () => webllm("x") }).structuredOutput, true);
  const c = buildContext(emptyProject(), { workspace: "design", graph: new DependencyGraph() });
  assert.deepEqual([c.selection, c.graph.dependsOnSelection], [[], []]);
  assert.equal(chooseModel({ kind: "api-key", vendor: "openai", model: "x" }, ["first", "x:latest"]), "first");
  assert.equal(chooseModel({ kind: "ollama", model: "x" }, ["first", "x:latest"]), "x:latest");
});

// ---------- leftovers from the third run ----------

test("a marker of \"start\" means nothing is built, even when an item happens to be called start", () => {
  // Kills `timeline.marker === "start"` => false and "start" => "": both fall back to finding
  // the item named by the marker, which here exists (the first of two), so they would count
  // one item as built. Worked by hand: marker "start" puts the end at 0, so both items are
  // after the marker.
  const project = emptyProject();
  project.workspaces.design = { version: 1, profiles: [], timeline: { features: [{ ...feature(1), id: "start" }, feature(2)], marker: "start" } };
  const c = buildContext(project, { workspace: "design", graph: new DependencyGraph() });
  assert.deepEqual(c.features.map((f) => [f.id, f.afterMarker]), [["start", true], ["feature-2", true]]);
});

test("a selected id the graph doesn't have adds nothing to what depends on the selection", () => {
  // Kills `o.graph.has(id) ? [...] : []` => `["Stryker was here"]`: an id that is not in the
  // graph has no downstream at all.
  const g = new DependencyGraph();
  g.set({ id: "a", label: "a", workspace: "design", cost: "cheap" });
  g.set({ id: "b", label: "b", workspace: "design", cost: "cheap" }, ["a"]);
  const c = buildContext(emptyProject(), { workspace: "design", graph: g, selection: ["gone", "a"] });
  assert.deepEqual(c.graph.dependsOnSelection, ["b"]);
});

test("Ollama: a name listed without a tag matches a model asked for without one", () => {
  // Kills `n === model` => false: "llama3.2" asked for becomes want "llama3.2:latest", so only
  // the exact compare finds a list entry written "llama3.2".
  assert.equal(hasModel(["llama3.2"], "llama3.2"), true);
  assert.equal(hasModel(["llama3.2:1b"], "llama3.2"), false);
});

test("listing models at another provider with no key names that provider's address", async () => {
  // Kills `vendor === "openai"` => true in listHostedModels' `who`: an 'other' address would be
  // called OpenAI's API in the error.
  const { fetch, calls } = fakeServer(() => ({ json: { data: [] } }));
  await assert.rejects(listHostedModels({ vendor: "other", endpoint: "https://llm.example/v1", keys: memoryKeyStore(), fetch }), { message: "no API key is saved for https://llm.example" });
  assert.equal(calls.length, 0);
});
