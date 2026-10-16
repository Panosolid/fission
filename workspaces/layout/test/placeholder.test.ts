import { test } from "node:test";
import assert from "node:assert/strict";
import { exportPdf, exportPng, layoutWorkspace } from "../src/index.ts";

test("Layout is a placeholder and says so", () => {
  assert.equal(layoutWorkspace.status, "placeholder");
  const doc = { id: "poster", unit: "mm" as const, pages: [{ width: 297, height: 420, items: [] }] };
  assert.throws(() => exportPdf(doc), /not implemented/);
  assert.throws(() => exportPng(doc, 0, 10), /not implemented/);
});
