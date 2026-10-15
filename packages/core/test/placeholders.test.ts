import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveReference } from "../src/model/references.ts";
import type { StableId } from "../src/model/references.ts";

// Placeholders must say so, never pretend to work.
test("resolving a reference is not implemented yet", () => {
  assert.throws(() => resolveReference({ kind: "face", id: "f1" as StableId }), /not implemented/);
});
