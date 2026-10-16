import { test } from "node:test";
import assert from "node:assert/strict";
import { browserKeyStore, createProvider, dataLeavesMachine, detectProviders, PROVIDERS } from "../src/index.ts";

test("AI providers are a placeholder and say so", () => {
  assert.throws(() => createProvider({ kind: "ollama" }), /not implemented/);
  assert.throws(() => detectProviders(), /not implemented/);
  assert.throws(() => browserKeyStore(), /not implemented/);
});

test("four providers; only the API-key one sends anything off the machine", () => {
  assert.deepEqual(PROVIDERS.map((p) => p.kind), ["in-browser", "ollama", "api-key", "browser-built-in"]);
  assert.deepEqual(PROVIDERS.filter((p) => dataLeavesMachine(p.kind)).map((p) => p.kind), ["api-key"]);
});

test("the settings text covers what the spec asks for", () => {
  const notes = (k: string) => PROVIDERS.find((p) => p.kind === k)!.notes.join(" ");
  assert.match(notes("ollama"), /OLLAMA_ORIGINS/);
  assert.match(notes("api-key"), /Consumer chat subscriptions can't be used/);
  assert.match(notes("api-key"), /stored only in this browser/);
  assert.match(notes("api-key"), /shows exactly what will be sent/);
  assert.match(notes("in-browser"), /size is shown before the download/);
  assert.match(notes("in-browser"), /too weak, Fission suggests/);
});
