import { test } from "node:test";
import assert from "node:assert/strict";
import { dataLeavesMachine, PROVIDERS } from "../src/index.ts";

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

test("specialist models are placeholders, one list covering the spec's tasks", async () => {
  const { loadSpecialist, SPECIALISTS, AI_FEATURES } = await import("../src/index.ts");
  assert.throws(() => loadSpecialist("upscaling"), /not implemented/);
  assert.deepEqual(SPECIALISTS.map((s) => s.task), ["background-removal", "segmentation", "upscaling", "inpainting", "tracing", "print-failure"]);
  // Every workspace and the suite has its planned AI features listed.
  assert.deepEqual(Object.keys(AI_FEATURES).sort(), ["circuit", "design", "image", "laser", "layout", "manufacture", "render", "simulate", "slice", "suite", "vector"]);
  assert.match(AI_FEATURES.manufacture.join(" "), /Never runs a machine/);
  assert.match(AI_FEATURES.circuit.join(" "), /AI draft — review required/);
});
