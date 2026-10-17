import { test } from "node:test";
import assert from "node:assert/strict";
import { browserKeyStore, checkApiKey, MAX_KEY_LENGTH, memoryKeyStore, type KeyValueStorage } from "../src/index.ts";
import { rng, SEED } from "./fakes.ts";

function storage(): KeyValueStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), removeItem: (k) => void map.delete(k) };
}

test("a key is filed under the origin it is sent to, and only that origin finds it", () => {
  const s = storage();
  const keys = browserKeyStore(s);
  keys.set("https://api.anthropic.com", "  sk-ant-123  ");
  // Worked by hand: the origin of "https://api.anthropic.com/v1/messages" is scheme + host,
  // "https://api.anthropic.com", so the same key; a trailing slash changes nothing.
  assert.equal(keys.get("https://api.anthropic.com/v1/messages"), "sk-ant-123", "trimmed as stored");
  assert.equal(keys.get("https://api.anthropic.com/"), "sk-ant-123");
  // Another host, or the same host over http or another port, is another origin: no key.
  assert.equal(keys.get("https://api.openai.com"), null);
  assert.equal(keys.get("http://api.anthropic.com"), null);
  assert.equal(keys.get("https://api.anthropic.com:8443"), null);
  assert.deepEqual([...s.map.keys()], ["fission.ai.key:https://api.anthropic.com"]);
  keys.remove("https://api.anthropic.com/");
  assert.equal(keys.get("https://api.anthropic.com"), null);
  assert.equal(s.map.size, 0);
});

test("only something that can be a key is stored: no line breaks, spaces or control characters", () => {
  const keys = memoryKeyStore();
  assert.throws(() => keys.set("https://a.test", "   "), /empty/);
  assert.throws(() => keys.set("https://a.test", "sk-1\r\nx-evil: 1"), /no spaces, line breaks/, "a newline could add a header of its own");
  assert.throws(() => keys.set("https://a.test", "sk 1"), /no spaces/);
  assert.throws(() => keys.set("https://a.test", "sk-é"), /special characters/);
  assert.equal(keys.get("https://a.test"), null, "nothing stored after a refusal");
});

test("key length: 0.9x of the limit is accepted, 1.1x is refused, the limit itself is the last accepted", () => {
  const key = (n: number) => "k".repeat(n);
  assert.equal(checkApiKey(key(Math.floor(0.9 * MAX_KEY_LENGTH))).ok, true);
  assert.equal(checkApiKey(key(MAX_KEY_LENGTH)).ok, true);
  assert.equal(checkApiKey(key(MAX_KEY_LENGTH + 1)).ok, false);
  const r = checkApiKey(key(Math.ceil(1.1 * MAX_KEY_LENGTH)));
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /longer than any API key/);
});

test("seeded random: the store behaves like a map from origin to key", () => {
  const r = rng(SEED);
  const origins = ["https://api.anthropic.com", "https://api.openai.com", "https://example.test", "http://localhost:8080"];
  const spellings = (o: string) => [o, `${o}/`, `${o}/v1/chat/completions`];
  for (let run = 0; run < 50; run++) {
    const keys = memoryKeyStore();
    const model = new Map<string, string>();
    for (let i = 0; i < 40; i++) {
      const o = r.pick(origins);
      const as = r.pick(spellings(o));
      const what = r.int(3);
      if (what === 0) {
        const k = `sk-${r.int(1e6)}`;
        keys.set(as, k);
        model.set(o, k);
      } else if (what === 1) {
        keys.remove(as);
        model.delete(o);
      }
      for (const x of origins) assert.equal(keys.get(x), model.get(x) ?? null, `seed ${SEED}, run ${run}, op ${i}: ${x}`);
    }
  }
});
