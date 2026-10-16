import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveReference } from "../src/model/references.ts";
import type { StableId } from "../src/model/references.ts";
import { historyNotBuilt, selectionNotBuilt } from "../src/model/session.ts";
import { emptyProject } from "../src/model/project.ts";

// Placeholders must say so, never pretend to work.
test("resolving a reference is not implemented yet", () => {
  assert.throws(() => resolveReference({ kind: "face", id: "f1" as StableId }), /not implemented/);
});

test("selection and undo/redo are not built yet and say so", () => {
  assert.throws(() => selectionNotBuilt.items, /not implemented/);
  assert.throws(() => selectionNotBuilt.set([]), /not implemented/);
  assert.throws(() => historyNotBuilt.canUndo(), /not implemented/);
  assert.throws(() => historyNotBuilt.undo(), /not implemented/);
});

test("a new project is empty, in millimetres", () => {
  assert.deepEqual(emptyProject("Bracket"), { formatVersion: 2, name: "Bracket", units: { length: "mm" }, materials: [], links: [], workspaces: {} });
});
