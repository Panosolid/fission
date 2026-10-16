import { test } from "node:test";
import assert from "node:assert/strict";
import { imageWorkspace } from "../src/index.ts";

test("Image's page is still a placeholder and says so, until opening a file works (G1b)", () => {
  assert.equal(imageWorkspace.status, "placeholder");
  assert.deepEqual(imageWorkspace.representations, { produces: [], accepts: [] });
});
