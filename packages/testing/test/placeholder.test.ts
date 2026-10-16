import { test } from "node:test";
import assert from "node:assert/strict";
import { checkBaseline, seeded } from "../src/index.ts";

test("the shared harness is a placeholder and says so", () => {
  assert.throws(() => seeded(1n), /not implemented/);
  assert.throws(() => checkBaseline({}), /not implemented/);
});
