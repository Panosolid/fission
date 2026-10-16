import { test } from "node:test";
import assert from "node:assert/strict";
import type { FaceReference, StableId } from "@fission/core";
import { checkDesignRules, circuitWorkspace, exportGerber } from "../src/index.ts";

test("Circuit is a placeholder and says so", () => {
  assert.equal(circuitWorkspace.status, "placeholder");
  const face: FaceReference = { kind: "face", id: "f" as StableId };
  const board = { id: "b", outline: face, layers: 2, mountingHoles: [] };
  assert.throws(() => exportGerber(board), /not implemented/);
  assert.throws(() => checkDesignRules(board), /not implemented/);
});
