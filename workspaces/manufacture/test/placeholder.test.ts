import { test } from "node:test";
import assert from "node:assert/strict";
import { postProcess, manufactureWorkspace } from "../src/index.ts";

test("Manufacture is a placeholder and says so", () => {
  assert.equal(manufactureWorkspace.status, "placeholder");
  assert.throws(() => postProcess([], "mill"), /not implemented/);
});
