import { test } from "node:test";
import assert from "node:assert/strict";
import { slicePlate, sliceWorkspace } from "../src/index.ts";

test("Slice is a placeholder and says so", () => {
  assert.equal(sliceWorkspace.status, "placeholder");
  assert.throws(() => slicePlate({ id: "p", printer: "any", models: [] }), /not implemented/);
});
