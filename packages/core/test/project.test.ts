import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyProject, FORMAT_VERSION, readProject } from "../src/model/project.ts";

test("a saved project reads back unchanged", () => {
  const p = emptyProject("Bracket");
  assert.deepEqual(readProject(JSON.parse(JSON.stringify(p))), p);
});

test("a version 1 file (before live links) is upgraded, keeping everything else", () => {
  const v1 = { formatVersion: 1, name: "Old", units: { length: "in" }, materials: [], workspaces: { design: { version: 1 } } };
  assert.deepEqual(readProject(v1), { ...v1, formatVersion: 2, links: [] });
  assert.equal(FORMAT_VERSION, 2);
});

test("files from a newer Fission, and things that are not projects, are refused clearly", () => {
  assert.throws(() => readProject({ ...emptyProject(), formatVersion: 3 }), /saved by a newer Fission \(format 3; this one reads up to 2\)/);
  assert.throws(() => readProject([]), /expected an object/);
  assert.throws(() => readProject({ name: "x" }), /no format version/);
  assert.throws(() => readProject({ formatVersion: 1.5 }), /no format version/);
  const { units: _, ...noUnits } = emptyProject();
  assert.throws(() => readProject(noUnits), /"units" is missing/);
});
