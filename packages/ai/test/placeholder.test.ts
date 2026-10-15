import { test } from "node:test";
import assert from "node:assert/strict";
import { createProvider } from "../src/index.ts";

test("AI providers are a placeholder and say so", () => {
  assert.throws(() => createProvider({ kind: "ollama" }), /not implemented/);
});
