import { test } from "node:test";
import assert from "node:assert/strict";
import { solve, simulateWorkspace } from "../src/index.ts";

test("Simulate is a placeholder and says so", () => {
  assert.equal(simulateWorkspace.status, "placeholder");
  assert.throws(() => solve({ id: "s", kind: "static", bodies: [], loads: [], constraints: [] }), /not implemented/);
});
