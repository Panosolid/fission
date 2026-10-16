import { test } from "node:test";
import assert from "node:assert/strict";
import { describeProvenance } from "../src/model/feature.ts";

test("provenance of an object made from scratch", () => {
  assert.equal(describeProvenance({ self: { workspace: "design", id: "f1", label: "Box 1" }, from: [] }), "Box 1 was made in Design.");
});

test("provenance across workspaces reads as one sentence", () => {
  // The example from the integration spec, word for word.
  const p = {
    self: { workspace: "laser" as const, id: "e1", label: "This engraving" },
    from: [
      { workspace: "vector" as const, id: "logo", label: "Logo v3" },
      { workspace: "design" as const, id: "b2", label: "Body 2" },
    ],
  };
  assert.equal(describeProvenance(p), "This engraving comes from Logo v3 in Vector, applied to Body 2 in Design.");
});
