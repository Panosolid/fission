import { test } from "node:test";
import assert from "node:assert/strict";
import { exportSvg, importSvg, vectorWorkspace } from "../src/index.ts";

test("Vector is a placeholder and says so", () => {
  assert.equal(vectorWorkspace.status, "placeholder");
  assert.throws(() => importSvg("<svg/>"), /not implemented/);
  assert.throws(() => exportSvg({ id: "d", layers: [] }), /not implemented/);
});
