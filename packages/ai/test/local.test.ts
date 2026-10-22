import { test } from "node:test";
import assert from "node:assert/strict";
import { createProvider, gpuCanRun, IN_BROWSER_MODEL, inBrowserDownloadBytes, pickLocal, type BuiltInModelLike, type WebLLMLike, type WebLLMModel } from "../src/index.ts";
import { LOW_RESOURCE_BUFFER, FULL_BUFFER } from "../src/local.ts";
import { fakeServer } from "./fakes.ts";

const small: WebLLMModel = { model_id: "Small-q4f16_1-MLC", model: "https://models.test/Small", low_resource_required: true };
const big: WebLLMModel = { model_id: "Big-q4f32_1-MLC", model: "https://models.test/Big", low_resource_required: false };
const gpu = (buffer: number, f16 = true) => ({ requestAdapter: async () => ({ features: new Set(f16 ? ["shader-f16"] : []), limits: { maxStorageBufferBindingSize: buffer } }) });

test("graphics card check: no WebGPU, no adapter, no 16-bit shaders, each with a suggestion", async () => {
  for (const [g, why] of [
    [undefined, /no WebGPU/],
    [{ requestAdapter: async () => null }, /no graphics card it can use/],
    [{ requestAdapter: async () => Promise.reject(new Error("lost")) }, /no graphics card it can use/],
    [gpu(2 ** 31, false), /can't run 16-bit models such as Small-q4f16_1-MLC/],
  ] as const) {
    const r = await gpuCanRun(g, small);
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, why);
    assert.match((r as { reason: string }).reason, /Ollama on your computer, or an API key, will work instead/);
    assert.equal((r as { suggest: string }).suggest, "ollama");
  }
});

test("graphics card buffer: a small model needs 128 MiB (0.9x refused, 1x and 1.1x run); a big one 1 GiB", async () => {
  // A minimum, not a tolerance: below it can't run, at or above it can.
  assert.equal((await gpuCanRun(gpu(Math.floor(0.9 * LOW_RESOURCE_BUFFER)), small)).ok, false);
  assert.equal((await gpuCanRun(gpu(LOW_RESOURCE_BUFFER), small)).ok, true);
  assert.equal((await gpuCanRun(gpu(Math.ceil(1.1 * LOW_RESOURCE_BUFFER)), small)).ok, true);
  const weak = await gpuCanRun(gpu(Math.floor(0.9 * FULL_BUFFER)), big);
  // 0.9 x 1024 MiB = 921.6 MiB, shown rounded: 922 MiB.
  assert.match((weak as { reason: string }).reason, /largest buffer is 922 MiB and Big-q4f32_1-MLC needs 1024 MiB/);
  assert.equal((await gpuCanRun(gpu(Math.ceil(1.1 * FULL_BUFFER)), big)).ok, true);
  assert.equal((await gpuCanRun(gpu(NaN), small)).ok, false, "a missing limit is not a pass");
});

test("download size is the sum of the model's weight files, read before anything is downloaded", async () => {
  // Worked by hand: 32 MiB + 32 MiB + 1.5 MiB = 65.5 MiB = 65.5 x 1048576 = 68681728 bytes.
  const { fetch, calls } = fakeServer(() => ({ json: { records: [{ nbytes: 33554432 }, { nbytes: 33554432 }, { nbytes: 1572864 }] } }));
  assert.equal(await inBrowserDownloadBytes({ ...small, model: "https://models.test/Small/" }, fetch), 68681728);
  assert.equal(calls[0].url, "https://models.test/Small/resolve/main/ndarray-cache.json");
  const bad = fakeServer(() => ({ json: { records: [{ nbytes: 1 }, { size: 2 }] } }));
  await assert.rejects(inBrowserDownloadBytes(small, bad.fetch), /a file with no size/);
  const empty = fakeServer(() => ({ json: { records: [] } }));
  await assert.rejects(inBrowserDownloadBytes(small, empty.fetch), /empty/);
});

function fakeWebLLM(models: WebLLMModel[], answer = '{"commands":[]}') {
  const created: string[] = [];
  const requests: object[] = [];
  const webllm: WebLLMLike = {
    prebuiltAppConfig: { model_list: models },
    async CreateMLCEngine(model, config) {
      created.push(model);
      config?.initProgressCallback?.({ progress: 1, text: "loaded" });
      return { chat: { completions: { create: async (r: object) => (requests.push(r), { choices: [{ message: { content: answer } }] }) } } };
    },
  };
  return { webllm, created, requests };
}

test("in the browser: the model loads once, reports progress, and is held to the schema", async () => {
  const f = fakeWebLLM([small]);
  const progress: number[] = [];
  const p = createProvider({ kind: "in-browser", model: small.model_id }, { gpu: gpu(2 ** 30), loadWebLLM: async () => f.webllm, onProgress: (x) => progress.push(x) });
  assert.deepEqual(await p.check(), { ok: true });
  await p.complete({ system: "S", messages: [{ role: "user", content: "hi" }], jsonSchema: { type: "object" } });
  await p.complete({ system: "S", messages: [{ role: "user", content: "again" }] });
  assert.deepEqual(f.created, [small.model_id], "loaded once");
  assert.deepEqual(progress, [1]);
  assert.deepEqual(f.requests[0], {
    messages: [{ role: "system", content: "S" }, { role: "user", content: "hi" }],
    temperature: 0,
    response_format: { type: "json_object", schema: '{"type":"object"}' },
  });
  assert.equal("response_format" in f.requests[1], false);
});

test("in the browser: a weak card is refused before anything downloads; an unknown model is named", async () => {
  const f = fakeWebLLM([small]);
  const weak = createProvider({ kind: "in-browser", model: small.model_id }, { gpu: gpu(1024), loadWebLLM: async () => f.webllm });
  await assert.rejects(weak.complete({ system: "S", messages: [{ role: "user", content: "hi" }] }), /largest buffer is 0 MiB/);
  assert.deepEqual(f.created, [], "nothing loaded");
  const unknown = createProvider({ kind: "in-browser", model: "Nope" }, { gpu: gpu(2 ** 30), loadWebLLM: async () => f.webllm });
  assert.deepEqual(await unknown.check(), { ok: false, reason: "Nope isn't a model the in-browser runner knows", suggest: "ollama" });
  const byDefault = createProvider({ kind: "in-browser" }, { gpu: gpu(2 ** 30), loadWebLLM: async () => fakeWebLLM([{ ...small, model_id: IN_BROWSER_MODEL }]).webllm });
  assert.deepEqual(await byDefault.check(), { ok: true }, "the default model is the one the runner lists");
});

test("in the browser: a failed load is tried again next time", async () => {
  let tries = 0;
  const webllm: WebLLMLike = {
    prebuiltAppConfig: { model_list: [small] },
    async CreateMLCEngine() {
      if (++tries === 1) throw new Error("download interrupted");
      return { chat: { completions: { create: async () => ({ choices: [{ message: { content: "ok" } }] }) } } };
    },
  };
  const p = createProvider({ kind: "in-browser", model: small.model_id }, { gpu: gpu(2 ** 30), loadWebLLM: async () => webllm });
  const ask = () => p.complete({ system: "S", messages: [{ role: "user", content: "hi" }] });
  await assert.rejects(ask(), /download interrupted/);
  assert.equal(await ask(), "ok");
});

test("the browser's built-in model: earlier turns as its opening prompts, the schema as its constraint, the session closed even on failure", async () => {
  const seen: unknown[] = [];
  let destroyed = 0;
  const api = (fail: boolean): BuiltInModelLike => ({
    availability: async () => "available",
    create: async (o) => {
      seen.push(o);
      return {
        prompt: async (input, options) => {
          seen.push([input, options]);
          if (fail) throw new Error("model busy");
          return "answer";
        },
        destroy: () => void destroyed++,
      };
    },
  });
  const r = { system: "S", messages: [{ role: "user" as const, content: "a" }, { role: "assistant" as const, content: "b" }, { role: "user" as const, content: "c" }], jsonSchema: { type: "object" } };
  assert.equal(await createProvider({ kind: "browser-built-in" }, { builtIn: api(false) }).complete(r), "answer");
  assert.deepEqual(seen, [{ initialPrompts: [{ role: "system", content: "S" }, { role: "user", content: "a" }, { role: "assistant", content: "b" }] }, ["c", { responseConstraint: { type: "object" } }]]);
  await assert.rejects(createProvider({ kind: "browser-built-in" }, { builtIn: api(true) }).complete(r), /model busy/);
  assert.equal(destroyed, 2);
});

test("the browser's built-in model: absent or unavailable says so", async () => {
  assert.deepEqual(await createProvider({ kind: "browser-built-in" }, { builtIn: undefined }).check(), { ok: false, reason: "this browser has no built-in model", suggest: "in-browser" });
  const off: BuiltInModelLike = { availability: async () => "unavailable", create: async () => ({}) as never };
  assert.equal((await createProvider({ kind: "browser-built-in" }, { builtIn: off }).check()).ok, false);
});

test("the browser's built-in model: only one that is there counts; one still to download, or downloading, says so and is never created", async () => {
  // Each answer the API can give (the Prompt API's Availability values), and whether a session may be made of it.
  let created = 0;
  const api = (availability: Awaited<ReturnType<BuiltInModelLike["availability"]>>): BuiltInModelLike => ({
    availability: async () => availability,
    create: async () => (created++, {}) as never,
  });
  assert.deepEqual(await createProvider({ kind: "browser-built-in" }, { builtIn: api("available") }).check(), { ok: true });
  assert.deepEqual(await createProvider({ kind: "browser-built-in" }, { builtIn: api("downloadable") }).check(), { ok: false, reason: "this browser hasn't downloaded its built-in model yet", suggest: "in-browser" });
  assert.deepEqual(await createProvider({ kind: "browser-built-in" }, { builtIn: api("downloading") }).check(), { ok: false, reason: "this browser is still downloading its built-in model; it can be chosen once that has finished", suggest: "in-browser" });
  // An API that fails to answer counts as unavailable, not as there.
  const broken: BuiltInModelLike = { availability: async () => { throw new Error("gone"); }, create: async () => (created++, {}) as never };
  assert.equal((await createProvider({ kind: "browser-built-in" }, { builtIn: broken }).check()).ok, false);
  assert.equal(created, 0, "check() never makes a session, so it never starts a download");
  // A model that is only downloadable is not picked for the user, whatever else is found.
  assert.equal(pickLocal([{ kind: "browser-built-in", ...(await createProvider({ kind: "browser-built-in" }, { builtIn: api("downloadable") }).check()) }]), null);
});
