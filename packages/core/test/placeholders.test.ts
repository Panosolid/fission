import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveReference } from "../src/model/references.ts";
import type { StableId } from "../src/model/references.ts";
import { historyNotBuilt } from "../src/model/session.ts";
import { emptyProject } from "../src/model/project.ts";

// Placeholders must say so, never pretend to work.
test("resolving a reference is not implemented yet", () => {
  assert.throws(() => resolveReference({ kind: "face", id: "f1" as StableId }), /not implemented/);
});

// The selection is built (step 17a, tested in selection.test.ts); undo/redo waits for step 20.
test("undo/redo is not built yet and says so", () => {
  assert.throws(() => historyNotBuilt.canUndo(), /not implemented/);
  assert.throws(() => historyNotBuilt.undo(), /not implemented/);
});

test("a new project is empty, in millimetres", () => {
  assert.deepEqual(emptyProject("Bracket"), { formatVersion: 2, name: "Bracket", units: { length: "mm" }, materials: [], links: [], workspaces: {} });
});

test("search, materials, machines, feedback and parameters are drafts and say so", async () => {
  const { searchProject } = await import("../src/model/search.ts");
  const { materialLibrary } = await import("../src/model/material.ts");
  const { machineLibrary } = await import("../src/model/machines.ts");
  const { reportFeedback } = await import("../src/model/feedback.ts");
  const { projectParameters } = await import("../src/model/parameters.ts");
  assert.throws(() => searchProject(emptyProject(), "M3"), /not implemented/);
  assert.throws(() => materialLibrary(), /not implemented/);
  assert.throws(() => machineLibrary(), /not implemented/);
  assert.throws(() => reportFeedback({ from: "slice", kind: "printability", summary: "", overlay: { id: "x", label: "", marks: [] }, computedFor: "feature-1" }), /not implemented/);
  assert.throws(() => projectParameters(), /not implemented/);
});
