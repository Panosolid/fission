import { test } from "node:test";
import assert from "node:assert/strict";
import { localStore } from "../src/index.ts";

test("storage is a placeholder and says so", () => {
  assert.throws(() => localStore(), /not implemented/);
});
