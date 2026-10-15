import { test } from "node:test";
import assert from "node:assert/strict";
import { communityLibrary } from "../src/index.ts";

test("the community library is a placeholder and says so", () => {
  assert.throws(() => communityLibrary(), /not implemented/);
});
