import { test, mock } from "node:test";
import assert from "node:assert/strict";
import type { CommandSpec } from "@fission/core";
import { askForCommands, ANSWER_TIMEOUT_MS, createProvider, detectProviders, memoryKeyStore, type AIRequest, type Fetch } from "../src/index.ts";
import { fakeServer, rng, SEED, type Call } from "./fakes.ts";

const specs: CommandSpec[] = [{ op: "set_part", summary: "s", params: { width: { type: "length", description: "w" } } }];
const request: AIRequest = { system: "S", messages: [{ role: "user", content: "make it 40 wide" }], jsonSchema: { type: "object" } };
const good = JSON.stringify({ commands: [{ op: "set_part", width: 40 }] });

// ---- Ollama ----

test("Ollama: the request is exactly the chat call its API documents", async () => {
  const { fetch, calls } = fakeServer(() => ({ json: { message: { role: "assistant", content: "hello" } } }));
  const p = createProvider({ kind: "ollama", model: "qwen2.5:1.5b" }, { fetch });
  assert.equal(p.structuredOutput, true);
  assert.equal(await p.complete(request), "hello");
  // Worked from Ollama's API: POST {endpoint}/api/chat; the system text as the first
  // message; stream false for one JSON reply; the schema as `format`; temperature 0.
  assert.deepEqual(calls, [
    {
      url: "http://localhost:11434/api/chat",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: { model: "qwen2.5:1.5b", messages: [{ role: "system", content: "S" }, { role: "user", content: "make it 40 wide" }], stream: false, format: { type: "object" }, options: { temperature: 0 } },
    },
  ]);
});

test("Ollama: no schema, no format; another endpoint is used as given", async () => {
  const { fetch, calls } = fakeServer(() => ({ json: { message: { content: "x" } } }));
  await createProvider({ kind: "ollama", model: "m", endpoint: "http://10.0.0.5:9999/" }, { fetch }).complete({ ...request, jsonSchema: undefined });
  assert.equal(calls[0].url, "http://10.0.0.5:9999/api/chat");
  assert.equal("format" in (calls[0].body as object), false);
});

test("Ollama: check finds the model (a bare name means :latest), or says how to get it", async () => {
  const { fetch } = fakeServer(() => ({ json: { models: [{ name: "llama3.2:latest" }, { name: "qwen2.5:1.5b" }] } }));
  const check = (model: string) => createProvider({ kind: "ollama", model }, { fetch }).check();
  assert.deepEqual(await check("llama3.2"), { ok: true });
  assert.deepEqual(await check("qwen2.5:1.5b"), { ok: true });
  assert.deepEqual(await check("llama3.2:1b"), { ok: false, reason: "Ollama doesn't have llama3.2:1b yet: run `ollama pull llama3.2:1b`" });
  assert.deepEqual(await check(""), { ok: false, reason: "choose a model: Ollama has llama3.2:latest, qwen2.5:1.5b" });
});

test("Ollama: unreachable says why it may be, and suggests another provider", async () => {
  const fetch: Fetch = async () => {
    throw new TypeError("Failed to fetch");
  };
  const r = await createProvider({ kind: "ollama", model: "m" }, { fetch }).check();
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /couldn't reach Ollama at http:\/\/localhost:11434: Failed to fetch\. Is Ollama running, and does OLLAMA_ORIGINS allow this page/);
  assert.equal((r as { suggest?: string }).suggest, "api-key");
});

test("Ollama: its own error message is passed on; a reply without a message is an error, not an empty answer", async () => {
  const missing = fakeServer(() => ({ status: 404, json: { error: "model 'm' not found" } }));
  await assert.rejects(createProvider({ kind: "ollama", model: "m" }, { fetch: missing.fetch }).complete(request), /refused the request \(HTTP 404\): model 'm' not found/);
  const empty = fakeServer(() => ({ json: { done: true } }));
  await assert.rejects(createProvider({ kind: "ollama", model: "m" }, { fetch: empty.fetch }).complete(request), /no message in it/);
  const html = fakeServer(() => ({ text: "<html>proxy</html>" }));
  await assert.rejects(createProvider({ kind: "ollama", model: "m" }, { fetch: html.fetch }).complete(request), /isn't JSON/);
});

test("Ollama: addresses that can't work are refused when the provider is made", () => {
  assert.throws(() => createProvider({ kind: "ollama", endpoint: "localhost:11434" }), /http or https/);
  assert.throws(() => createProvider({ kind: "ollama", endpoint: "not a url" }), /isn't a web address/);
});

test("Ollama end to end: a bad answer, the retry with the problem explained, then a good one", async () => {
  const answers = ['{"commands":[{"op":"set_part","width":-1}]}', good];
  const { fetch, calls } = fakeServer(() => ({ json: { message: { content: answers.shift() } } }));
  const r = await askForCommands(createProvider({ kind: "ollama", model: "m" }, { fetch }), { system: "S", messages: request.messages }, specs);
  assert.deepEqual(r, { ok: true, commands: [{ op: "set_part", width: 40 }], attempts: 2 });
  const second = (calls[1].body as { messages: { role: string; content: string }[]; format: unknown }).messages;
  assert.equal(second.length, 4, "system, question, the bad answer, and the retry note");
  assert.match(second[3].content, /can't be used/);
  assert.ok((calls[1].body as { format: unknown }).format, "still held to the schema");
});

test("answer timeout: a reply at 0.9x of the limit is used, one at 1.1x gives a clear error", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const slow = (ms: number): Fetch => (_url, init) =>
      new Promise((resolve, reject) => {
        const t = setTimeout(() => resolve(new Response(JSON.stringify({ message: { content: "ok" } }))), ms);
        init.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    const ask = (ms: number) => createProvider({ kind: "ollama", model: "m" }, { fetch: slow(ms) }).complete(request);
    const fast = ask(0.9 * ANSWER_TIMEOUT_MS);
    mock.timers.tick(0.9 * ANSWER_TIMEOUT_MS);
    assert.equal(await fast, "ok");
    const late = ask(1.1 * ANSWER_TIMEOUT_MS);
    mock.timers.tick(ANSWER_TIMEOUT_MS);
    await assert.rejects(late, /didn't answer within 180 s/);
  } finally {
    mock.timers.reset();
  }
});

// ---- Your own API key ----

const KEY = "sk-test-0123456789";

test("Anthropic: key in its header only; the schema is enforced as the one tool the model must use", async () => {
  const keys = memoryKeyStore();
  keys.set("https://api.anthropic.com", KEY);
  const { fetch, calls } = fakeServer(() => ({ json: { content: [{ type: "tool_use", name: "answer", input: { commands: [{ op: "set_part", width: 40 }] } }] } }));
  const p = createProvider({ kind: "api-key", vendor: "anthropic", model: "claude-haiku-5-5" }, { fetch, keys });
  assert.deepEqual(await p.check(), { ok: true });
  const r = await askForCommands(p, { system: "S", messages: request.messages }, specs);
  assert.deepEqual(r, { ok: true, commands: [{ op: "set_part", width: 40 }], attempts: 1 });
  const c = calls[0];
  assert.equal(c.url, "https://api.anthropic.com/v1/messages");
  assert.equal(c.headers["x-api-key"], KEY);
  assert.equal(c.headers["anthropic-version"], "2023-06-01");
  const body = c.body as { model: string; system: string; tools: { name: string; input_schema: { required: string[] } }[]; tool_choice: unknown };
  assert.equal(body.model, "claude-haiku-5-5");
  assert.equal(body.system, "S");
  assert.deepEqual(body.tool_choice, { type: "tool", name: "answer" });
  assert.deepEqual(body.tools[0].input_schema.required, ["commands"], "the generated command-list schema");
});

test("Anthropic: a text answer (no schema asked) is returned as text", async () => {
  const keys = memoryKeyStore();
  keys.set("https://api.anthropic.com", KEY);
  const { fetch, calls } = fakeServer(() => ({ json: { content: [{ type: "text", text: "Hi " }, { type: "text", text: "there" }] } }));
  assert.equal(await createProvider({ kind: "api-key", vendor: "anthropic" }, { fetch, keys }).complete({ ...request, jsonSchema: undefined }), "Hi there");
  assert.equal("tools" in (calls[0].body as object), false);
  assert.equal((calls[0].body as { model: string }).model, "claude-haiku-5-5", "the default when none is chosen");
});

test("OpenAI: bearer key, response_format json_schema, the first choice's text", async () => {
  const keys = memoryKeyStore();
  keys.set("https://api.openai.com", KEY);
  const { fetch, calls } = fakeServer(() => ({ json: { choices: [{ message: { content: good } }] } }));
  const p = createProvider({ kind: "api-key", vendor: "openai", model: "m1" }, { fetch, keys });
  assert.equal(await p.complete(request), good);
  assert.equal(calls[0].url, "https://api.openai.com/v1/chat/completions");
  assert.equal(calls[0].headers.authorization, `Bearer ${KEY}`);
  assert.deepEqual(calls[0].body, {
    model: "m1",
    messages: [{ role: "system", content: "S" }, { role: "user", content: "make it 40 wide" }],
    response_format: { type: "json_schema", json_schema: { name: "answer", schema: { type: "object" } } },
  });
});

test("another OpenAI-compatible provider: https only (or this computer), no response_format, answers validated instead", async () => {
  const keys = memoryKeyStore();
  keys.set("https://models.example.test", KEY);
  const { fetch, calls } = fakeServer(() => ({ json: { choices: [{ message: { content: good } }] } }));
  const p = createProvider({ kind: "api-key", vendor: "other", endpoint: "https://models.example.test/api/v1/", model: "m" }, { fetch, keys });
  assert.equal(p.structuredOutput, false);
  await p.complete(request);
  assert.equal(calls[0].url, "https://models.example.test/api/v1/chat/completions");
  assert.equal("response_format" in (calls[0].body as object), false);
  assert.throws(() => createProvider({ kind: "api-key", vendor: "other", endpoint: "http://models.example.test/v1" }, { keys }), /only sent over https/);
  assert.throws(() => createProvider({ kind: "api-key", vendor: "other", endpoint: "https://me:pw@models.example.test/v1" }, { keys }), /user name or password/);
  assert.throws(() => createProvider({ kind: "api-key", vendor: "other" }, { keys }), /give the provider's address/);
  assert.doesNotThrow(() => createProvider({ kind: "api-key", vendor: "other", endpoint: "http://localhost:8080/v1" }, { keys }));
});

test("no key saved: the check says so, and nothing is sent", async () => {
  const { fetch, calls } = fakeServer(() => ({ json: {} }));
  const p = createProvider({ kind: "api-key", vendor: "openai" }, { fetch, keys: memoryKeyStore() });
  assert.deepEqual(await p.check(), { ok: false, reason: "no API key is saved for OpenAI's API" });
  await assert.rejects(p.complete(request), /no API key is saved/);
  assert.equal(calls.length, 0);
});

test("a provider that echoes the key in an error never puts it in our message", async () => {
  const keys = memoryKeyStore();
  keys.set("https://api.openai.com", KEY);
  const { fetch } = fakeServer((c) => ({ status: 401, json: { error: { message: `Incorrect API key provided: ${c.headers.authorization}` } } }));
  const err = await createProvider({ kind: "api-key", vendor: "openai" }, { fetch, keys }).complete(request).catch((e: Error) => e);
  assert.ok(err instanceof Error);
  assert.match(err.message, /HTTP 401.*Incorrect API key provided: Bearer \[your key\]/);
  assert.equal(err.message.includes(KEY), false);
});

test("seeded random: every key goes only to its own origin, only in a header, never in a URL or body", async () => {
  const r = rng(SEED);
  const endpoints = ["https://models.example.test/v1", "https://other.example.test/api", "http://localhost:8080/v1"];
  for (let run = 0; run < 200; run++) {
    const keys = memoryKeyStore();
    const stored = new Map<string, string>();
    for (const origin of ["https://api.anthropic.com", "https://api.openai.com", ...endpoints.map((e) => new URL(e).origin)]) {
      if (r.next() < 0.6) {
        const k = `sk-${origin.length}-${r.int(1e9)}`;
        keys.set(origin, k);
        stored.set(origin, k);
      }
    }
    const vendor = r.pick(["anthropic", "openai", "other"] as const);
    const endpoint = r.pick(endpoints);
    const { fetch, calls } = fakeServer(() => ({ json: { content: [{ type: "text", text: "a" }], choices: [{ message: { content: "a" } }] } }));
    const p = createProvider({ kind: "api-key", vendor, endpoint, model: "m" }, { fetch, keys });
    await p.complete({ ...request, jsonSchema: r.next() < 0.5 ? { type: "object" } : undefined }).catch(() => undefined);
    for (const c of calls as Call[]) {
      const origin = new URL(c.url).origin;
      for (const [keyOrigin, k] of stored) {
        const where = `seed ${SEED}, run ${run}: key for ${keyOrigin} in a request to ${c.url}`;
        assert.equal(c.url.includes(k), false, where);
        assert.equal(JSON.stringify(c.body).includes(k), false, where);
        if (keyOrigin !== origin) assert.equal(Object.values(c.headers).some((v) => v.includes(k)), false, where);
      }
      assert.ok(stored.has(origin), `seed ${SEED}, run ${run}: a request went out with no key for ${origin}`);
    }
    assert.equal(calls.length, stored.has(vendor === "other" ? new URL(endpoint).origin : vendor === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com") ? 1 : 0, `seed ${SEED}, run ${run}`);
  }
});

// ---- Choosing and detecting ----

test("createProvider gives each kind its provider and refuses an unknown one", () => {
  const deps = { fetch: fakeServer(() => ({})).fetch, keys: memoryKeyStore(), gpu: undefined, builtIn: undefined, loadWebLLM: async () => ({ prebuiltAppConfig: { model_list: [] }, CreateMLCEngine: async () => ({}) as never }) };
  for (const kind of ["in-browser", "ollama", "api-key", "browser-built-in"] as const) assert.equal(createProvider({ kind }, deps).kind, kind);
  assert.throws(() => createProvider({ kind: "cloud" as never }, deps), /unknown AI provider "cloud"/);
});

test("detectProviders: says which can run here and why the others can't", async () => {
  const noOllama: Fetch = async () => {
    throw new TypeError("Failed to fetch");
  };
  const loadWebLLM = async () => ({ prebuiltAppConfig: { model_list: [{ model_id: "Qwen2.5-1.5B-Instruct-q4f16_1-MLC", model: "https://m.test/q", low_resource_required: true }] }, CreateMLCEngine: async () => ({}) as never });
  const none = await detectProviders({ fetch: noOllama, gpu: undefined, builtIn: undefined, loadWebLLM });
  assert.deepEqual(
    none.map((d) => [d.kind, d.ok]),
    [["in-browser", false], ["ollama", false], ["api-key", true], ["browser-built-in", false]],
  );
  assert.match(none[0].reason!, /no WebGPU/);
  assert.match(none[1].reason!, /OLLAMA_ORIGINS/);

  const gpu = { requestAdapter: async () => ({ features: new Set(["shader-f16"]), limits: { maxStorageBufferBindingSize: 2 ** 30 } }) };
  const ollama = fakeServer(() => ({ json: { models: [] } }));
  const builtIn = { availability: async () => "downloadable" as const, create: async () => ({}) as never };
  const all = await detectProviders({ fetch: ollama.fetch, gpu, builtIn, loadWebLLM });
  assert.deepEqual(all.map((d) => d.ok), [true, true, true, true]);
  assert.equal(ollama.calls[0].url, "http://localhost:11434/api/tags", "only Ollama's usual address on this computer is asked");
});
