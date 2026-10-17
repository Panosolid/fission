// AI6: the panel picks a working local AI by itself, recognises whose API
// key was pasted, and lists the models that key (or Ollama) can use. No
// real provider is asked: fakeServer answers and records every request.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseModel, detectProviders, IN_BROWSER_MODEL, listModels, LOCAL_ORDER, memoryKeyStore, pickLocal, vendorFromKey, type Detected, type Fetch } from "../src/index.ts";
import { fakeServer, rng, SEED } from "./fakes.ts";

const ANT = "sk-ant-api03-abcdefghijklmnop";
const OAI = "sk-proj-abcdefghijklmnop";

// ---- whose key ----

test("vendorFromKey: only a start that one company uses names it; a bare sk- is never guessed", () => {
  assert.equal(vendorFromKey(ANT), "anthropic");
  assert.equal(vendorFromKey(`  ${ANT}\n`), "anthropic", "spaces around a paste are ignored");
  assert.equal(vendorFromKey(OAI), "openai");
  assert.equal(vendorFromKey("sk-svcacct-xyz"), "openai");
  // DeepSeek, Moonshot and old OpenAI keys all start "sk-": guessing would send one company's key to another.
  assert.equal(vendorFromKey("sk-0123456789abcdef0123456789abcdef"), null);
  assert.equal(vendorFromKey("sk-or-v1-abc"), null, "OpenRouter's key is not OpenAI's");
  assert.equal(vendorFromKey("gsk_abc"), null);
  assert.equal(vendorFromKey(""), null);
  // One letter off each prefix is not recognised (the check is the whole prefix).
  assert.equal(vendorFromKey("sk-an-abc"), null);
  assert.equal(vendorFromKey("sk-pro-abc"), null);
  assert.equal(vendorFromKey("xsk-ant-abc"), null, "the prefix must be at the start");
});

// ---- listing models ----

test("Anthropic's model list: GET /v1/models with the key in its header, newest first as listed", async () => {
  const keys = memoryKeyStore();
  keys.set("https://api.anthropic.com", ANT);
  const { fetch, calls } = fakeServer(() => ({ json: { data: [{ id: "claude-opus-5-5", type: "model" }, { id: "claude-haiku-5-5", type: "model" }], has_more: false } }));
  assert.deepEqual(await listModels({ kind: "api-key", vendor: "anthropic" }, { fetch, keys }), ["claude-opus-5-5", "claude-haiku-5-5"]);
  // Worked from Anthropic's API reference: GET https://api.anthropic.com/v1/models,
  // the key as x-api-key, the version header, and the header that allows a browser page to call it.
  assert.deepEqual(calls, [
    {
      url: "https://api.anthropic.com/v1/models?limit=1000",
      method: "GET",
      headers: { "x-api-key": ANT, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
      body: undefined,
    },
  ]);
});

test("OpenAI's model list: bearer key, chat models only, sorted", async () => {
  const keys = memoryKeyStore();
  keys.set("https://api.openai.com", OAI);
  const ids = ["gpt-5-mini", "text-embedding-3-small", "whisper-1", "gpt-4.1", "dall-e-3", "tts-1", "omni-moderation-latest", "gpt-5", "gpt-image-1", "gpt-5-mini"];
  const { fetch, calls } = fakeServer(() => ({ json: { object: "list", data: ids.map((id) => ({ id, object: "model" })) } }));
  // By hand: drop embedding, whisper, dall-e, tts, moderation and image models and the repeated
  // gpt-5-mini, leaving gpt-5-mini, gpt-4.1, gpt-5; sorted by character code: "gpt-4.1" < "gpt-5" < "gpt-5-mini".
  assert.deepEqual(await listModels({ kind: "api-key", vendor: "openai" }, { fetch, keys }), ["gpt-4.1", "gpt-5", "gpt-5-mini"]);
  assert.equal(calls[0].url, "https://api.openai.com/v1/models");
  assert.deepEqual(calls[0].headers, { authorization: `Bearer ${OAI}` });
});

test("another provider's list comes from its own address's /models, and its key goes nowhere else", async () => {
  const keys = memoryKeyStore();
  keys.set("https://llm.example.com", "other-key-123");
  const { fetch, calls } = fakeServer(() => ({ json: { data: [{ id: "llama-3.3-70b" }, { id: 7 }, { id: "has space" }, null] } }));
  assert.deepEqual(await listModels({ kind: "api-key", vendor: "other", endpoint: "https://llm.example.com/v1/" }, { fetch, keys }), ["llama-3.3-70b"]);
  assert.equal(calls[0].url, "https://llm.example.com/v1/models");
  assert.equal(calls[0].headers.authorization, "Bearer other-key-123");
});

test("listing refuses in plain words: no key saved (nothing sent), the key refused (key blanked), an empty list", async () => {
  const empty = fakeServer(() => ({ json: { data: [] } }));
  await assert.rejects(listModels({ kind: "api-key", vendor: "anthropic" }, { fetch: empty.fetch, keys: memoryKeyStore() }), /no API key is saved for Anthropic's API/);
  assert.equal(empty.calls.length, 0, "without a key nothing is asked");

  const keys = memoryKeyStore();
  keys.set("https://api.anthropic.com", ANT);
  const refused = fakeServer(() => ({ status: 401, json: { error: { message: `invalid x-api-key ${ANT}` } } }));
  await assert.rejects(listModels({ kind: "api-key", vendor: "anthropic" }, { fetch: refused.fetch, keys }), (e: Error) => /refused the request \(HTTP 401\)/.test(e.message) && !e.message.includes(ANT));
  await assert.rejects(listModels({ kind: "api-key", vendor: "anthropic" }, { fetch: empty.fetch, keys }), /lists no models this key can use/);
  const noData = fakeServer(() => ({ json: { models: [] } }));
  await assert.rejects(listModels({ kind: "api-key", vendor: "anthropic" }, { fetch: noData.fetch, keys }), /no models in it/);
});

test("Ollama's list is what it has pulled; in the browser the one default; the built-in model none", async () => {
  const { fetch, calls } = fakeServer(() => ({ json: { models: [{ name: "qwen2.5:1.5b" }, { name: "llama3.2:latest" }, { size: 3 }] } }));
  assert.deepEqual(await listModels({ kind: "ollama" }, { fetch }), ["qwen2.5:1.5b", "llama3.2:latest"]);
  assert.equal(calls[0].url, "http://localhost:11434/api/tags");
  await listModels({ kind: "ollama", endpoint: "http://10.0.0.5:9999/" }, { fetch });
  assert.equal(calls[1].url, "http://10.0.0.5:9999/api/tags");
  assert.deepEqual(await listModels({ kind: "in-browser" }, { fetch }), [IN_BROWSER_MODEL]);
  assert.deepEqual(await listModels({ kind: "browser-built-in" }, { fetch }), []);
  assert.equal(calls.length, 2, "neither in-browser nor built-in asks anything");
});

// ---- choosing ----

test("chooseModel: the chosen one if listed, else the suggested one, else the first", () => {
  const list = ["claude-opus-5-5", "claude-haiku-5-5"];
  assert.equal(chooseModel({ kind: "api-key", vendor: "anthropic", model: "claude-opus-5-5" }, list), "claude-opus-5-5");
  assert.equal(chooseModel({ kind: "api-key", vendor: "anthropic" }, list), "claude-haiku-5-5", "Anthropic's suggested model");
  assert.equal(chooseModel({ kind: "api-key", vendor: "anthropic", model: "gone-model" }, list), "claude-haiku-5-5");
  assert.equal(chooseModel({ kind: "api-key", vendor: "anthropic" }, ["claude-x"]), "claude-x");
  assert.equal(chooseModel({ kind: "api-key", vendor: "other" }, ["a", "b"]), "a");
  assert.equal(chooseModel({ kind: "ollama" }, ["llama3.2:latest", "qwen2.5:1.5b"]), "qwen2.5:1.5b");
  assert.equal(chooseModel({ kind: "ollama", model: "llama3.2" }, ["qwen2.5:1.5b", "llama3.2:latest"]), "llama3.2:latest", "llama3.2 is llama3.2:latest");
  assert.equal(chooseModel({ kind: "ollama" }, []), null);
});

const d = (ok: Record<string, boolean>): Detected[] => (["in-browser", "ollama", "api-key", "browser-built-in"] as const).map((kind) => ({ kind, ok: ok[kind] ?? false }));

test("pickLocal: built-in first, then a running Ollama, then the in-browser download; never an API key", () => {
  assert.equal(pickLocal(d({ "browser-built-in": true, ollama: true, "in-browser": true, "api-key": true })), "browser-built-in");
  assert.equal(pickLocal(d({ ollama: true, "in-browser": true, "api-key": true })), "ollama");
  assert.equal(pickLocal(d({ "in-browser": true, "api-key": true })), "in-browser");
  assert.equal(pickLocal(d({ "api-key": true })), null, "an API key costs money, so it is never picked for the user");
  assert.equal(pickLocal([]), null);
});

test("pickLocal against a simple model: seeded random availabilities", () => {
  const r = rng(SEED);
  for (let i = 0; i < 500; i++) {
    const ok = { "in-browser": r.next() < 0.5, ollama: r.next() < 0.5, "api-key": r.next() < 0.5, "browser-built-in": r.next() < 0.5 };
    const found = d(ok);
    // The model: walk the fixed order by hand.
    const expected = ok["browser-built-in"] ? "browser-built-in" : ok.ollama ? "ollama" : ok["in-browser"] ? "in-browser" : null;
    assert.equal(pickLocal(found), expected, `seed ${SEED}, case ${i}: ${JSON.stringify(ok)}`);
    assert.equal(LOCAL_ORDER.includes("api-key"), false);
  }
});

test("detectProviders runs the checks together: a slow Ollama doesn't hold up the rest", async () => {
  let release!: () => void;
  const waiting = new Promise<void>((r) => (release = r));
  let started = 0;
  const slowOllama: Fetch = async () => {
    started++;
    await waiting;
    throw new TypeError("Failed to fetch");
  };
  let builtInAsked = false;
  const builtIn = {
    availability: async () => {
      builtInAsked = true;
      return "available" as const;
    },
    create: async () => ({}) as never,
  };
  const pending = detectProviders({ fetch: slowOllama, gpu: undefined, builtIn, loadWebLLM: async () => ({ prebuiltAppConfig: { model_list: [] }, CreateMLCEngine: async () => ({}) as never }) });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(started, 1);
  assert.equal(builtInAsked, true, "the built-in check ran while Ollama was still being asked");
  release();
  const found = await pending;
  assert.deepEqual(found.map((x) => [x.kind, x.ok]), [["in-browser", false], ["ollama", false], ["api-key", true], ["browser-built-in", true]]);
  assert.equal(pickLocal(found), "browser-built-in");
});

test("detectProviders asks Ollama nothing when it is left out (the panel's first look)", async () => {
  const { fetch, calls } = fakeServer(() => ({ json: { models: [] } }));
  const builtIn = { availability: async () => "available" as const, create: async () => ({}) as never };
  const found = await detectProviders({ fetch, gpu: undefined, builtIn, loadWebLLM: async () => ({ prebuiltAppConfig: { model_list: [] }, CreateMLCEngine: async () => ({}) as never }) }, ["in-browser", "api-key", "browser-built-in"]);
  assert.deepEqual(found.map((x) => x.kind), ["in-browser", "api-key", "browser-built-in"]);
  assert.equal(calls.length, 0, "no request to an address on this computer");
  assert.deepEqual((await detectProviders({ fetch, gpu: undefined, builtIn: undefined }, ["ollama"])).map((x) => [x.kind, x.ok]), [["ollama", true]]);
  assert.equal(calls.length, 1);
});
