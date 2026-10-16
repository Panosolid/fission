import { test } from "node:test";
import assert from "node:assert/strict";
import { imageWorkspace, importImage } from "../src/index.ts";

test("Image is a placeholder and says so", () => {
  assert.equal(imageWorkspace.status, "placeholder");
  assert.throws(() => importImage(new Uint8Array(), 0.1), /not implemented/);
});
