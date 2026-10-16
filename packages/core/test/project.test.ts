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

// ---- Saving and opening a project file (19a) ----
import { projectFromJson, projectToJson, type Project } from "../src/model/project.ts";

test("a saved file has sorted keys and two-space indents (worked by hand)", () => {
  // emptyProject("A"): the keys sorted are formatVersion, links, materials,
  // name, units, workspaces; empty arrays and objects print as [] and {}.
  const expected = `{
  "formatVersion": 2,
  "links": [],
  "materials": [],
  "name": "A",
  "units": {
    "length": "mm"
  },
  "workspaces": {}
}
`;
  assert.equal(projectToJson(emptyProject("A")), expected);
});

test("the same project saves to the same bytes whatever order its keys were set in", () => {
  const a = { ...emptyProject("B"), workspaces: { design: { version: 1, b: 2, a: 1 } } };
  const b: Project = { workspaces: { design: { a: 1, version: 1, b: 2 } }, units: { length: "mm" }, name: "B", materials: [], links: [], formatVersion: 2 };
  assert.equal(projectToJson(a), projectToJson(b));
  // Arrays keep their order: it means something (the timeline is in build order).
  const c = { ...emptyProject(), workspaces: { design: { list: [3, 1, 2] } } };
  assert.match(projectToJson(c), /\[\s*3,\s*1,\s*2\s*\]/);
});

test("a number a file can't hold is refused when saving, naming where it is", () => {
  const p = { ...emptyProject(), workspaces: { design: { timeline: { features: [{ width: NaN }] } } } };
  assert.throws(() => projectToJson(p), /can't save: project\.workspaces\.design\.timeline\.features\[0\]\.width is NaN/);
  const q = { ...emptyProject(), workspaces: { design: { size: Infinity } } };
  assert.throws(() => projectToJson(q), /project\.workspaces\.design\.size is Infinity/);
  // A big but finite number is fine: 1 km in mm.
  assert.doesNotThrow(() => projectToJson({ ...emptyProject(), workspaces: { design: { size: 1e6 } } }));
});

/** A reader standing in for a workspace plugin: records what it was handed, and checks a version. */
function reader(id: "design" | "slice", seen: unknown[] = []) {
  return {
    id,
    readData(data: unknown) {
      seen.push(data);
      const d = data as { version?: number };
      if (d?.version !== 1) throw new Error(`${id} data version ${String(d?.version)} is not one this reads`);
      return { ...d, read: true };
    },
  };
}

test("opening hands each workspace only its own part, and keeps parts nobody here reads", () => {
  const seen: unknown[] = [];
  const text = JSON.stringify({ ...emptyProject("C"), workspaces: { design: { version: 1, x: 5 }, laser: { anything: [1] } } });
  const p = projectFromJson(text, [reader("design", seen), reader("slice")]);
  assert.deepEqual(seen, [{ version: 1, x: 5 }]);
  assert.deepEqual(p.workspaces, { design: { version: 1, x: 5, read: true }, laser: { anything: [1] } });
  assert.equal(p.name, "C");
});

test("a version 1 file opens: the outer layout is migrated, then the workspaces read", () => {
  const v1 = `{"formatVersion": 1, "name": "Old", "units": {"length": "mm"}, "materials": [], "workspaces": {"design": {"version": 1}}}`;
  const p = projectFromJson(v1, [reader("design")]);
  assert.equal(p.formatVersion, 2);
  assert.deepEqual(p.links, []);
  assert.deepEqual(p.workspaces.design, { version: 1, read: true });
});

test("bad files are each refused with their own message, never half-read", () => {
  const good = projectToJson({ ...emptyProject(), workspaces: { design: { version: 1 } } });
  const open = (text: string) => projectFromJson(text, [reader("design")]);
  // Truncated: cut the file in half.
  assert.throws(() => open(good.slice(0, good.length / 2)), /^Error: not a Fission project: the file is not valid JSON \(/);
  assert.throws(() => open(""), /not valid JSON/);
  assert.throws(() => open(good.replace('"formatVersion": 2', '"formatVersion": 3')), /saved by a newer Fission \(format 3; this one reads up to 2\)/);
  assert.throws(() => open(good.replace('"workspaces"', '"workspacez"')), /not a Fission project: "workspaces" is missing/);
  assert.throws(() => open(good.replace(/"workspaces": \{[^]*\}\n\}/, '"workspaces": []\n}')), /"workspaces" must be an object/);
  assert.throws(() => open(`"just a string"`), /expected an object/);
  // A workspace refusing its part refuses the whole file, saying which workspace.
  assert.throws(() => open(good.replace('"version": 1', '"version": 9')), /can't open the design workspace's data: design data version 9 is not one this reads/);
});

test("save then open gives an equal project (self-consistency)", () => {
  const p: Project = {
    ...emptyProject("Round trip"),
    units: { length: "in" },
    workspaces: { design: { version: 1, read: true, timeline: { features: [{ id: "feature-1", w: 0.1 + 0.2 }] } } },
  };
  // 0.1 + 0.2 = 0.30000000000000004: JSON keeps every digit a double needs.
  assert.deepEqual(projectFromJson(projectToJson(p), [reader("design")]), p);
});
