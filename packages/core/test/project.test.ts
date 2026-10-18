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

test("files from a newer Panoshape, and things that are not projects, are refused clearly", () => {
  assert.throws(() => readProject({ ...emptyProject(), formatVersion: 3 }), /saved by a newer Panoshape \(format 3; this one reads up to 2\)/);
  assert.throws(() => readProject([]), /expected an object/);
  assert.throws(() => readProject({ name: "x" }), /no format version/);
  assert.throws(() => readProject({ formatVersion: 1.5 }), /no format version/);
  const { units: _, ...noUnits } = emptyProject();
  assert.throws(() => readProject(noUnits), /"units" is missing/);
});

// ---- Saving and opening a project file (19a) ----
import { MAX_NESTING, MAX_PROJECT_BYTES, megabytes, projectFromJson, projectToJson, type Project } from "../src/model/project.ts";

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
  assert.throws(() => open(good.slice(0, good.length / 2)), /^Error: not a Panoshape project: the file is not valid JSON \(/);
  assert.throws(() => open(""), /not valid JSON/);
  assert.throws(() => open(good.replace('"formatVersion": 2', '"formatVersion": 3')), /saved by a newer Panoshape \(format 3; this one reads up to 2\)/);
  assert.throws(() => open(good.replace('"workspaces"', '"workspacez"')), /not a Panoshape project: "workspaces" is missing/);
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

// ---- Found by fuzzing the loader (packages/testing/src/project-fuzz.ts) ----

test("an outer field of the wrong type is refused, not opened half-broken", () => {
  const p = emptyProject() as unknown as Record<string, unknown>;
  assert.throws(() => readProject({ ...p, name: 5 }), /not a Panoshape project: "name" must be text/);
  assert.throws(() => readProject({ ...p, units: {} }), /"units" must give a length unit/);
  assert.throws(() => readProject({ ...p, units: { length: "furlong" } }), /"units" must give a length unit/);
  assert.throws(() => readProject({ ...p, units: null }), /"units" must give a length unit/);
  assert.throws(() => readProject({ ...p, materials: "" }), /"materials" must be a list/);
  assert.throws(() => readProject({ ...p, links: true }), /"links" must be a list/);
  // Every unit the format lists opens.
  for (const length of ["mm", "cm", "m", "in"]) assert.equal(readProject({ ...p, units: { length } }).units.length, length);
});

test('a "__proto__" key in a file is kept when the project is saved again', () => {
  // JSON.parse keeps "__proto__" as an ordinary key; assigning it to a new
  // object would set the object's prototype instead, losing the key.
  const text = `{"formatVersion": 2, "links": [], "materials": [], "name": "P", "units": {"length": "mm"}, "workspaces": {"render": {"__proto__": {"a": 1}, "b": 2}}}`;
  const saved = projectToJson(projectFromJson(text, []));
  assert.deepEqual(Object.keys(JSON.parse(saved).workspaces.render), ["__proto__", "b"]);
  assert.equal(JSON.parse(saved).workspaces.render["__proto__"].a, 1);
  assert.equal(({} as Record<string, unknown>).a, undefined); // and nothing else changed
  // The same as a workspace's id, which projectFromJson hands out itself.
  const asId = `{"formatVersion": 2, "links": [], "materials": [], "name": "P", "units": {"length": "mm"}, "workspaces": {"__proto__": {"a": 1}}}`;
  assert.deepEqual(Object.keys(JSON.parse(projectToJson(projectFromJson(asId, []))).workspaces), ["__proto__"]);
});

test("a file nested deeper than MAX_NESTING is refused when opened, since it could not be saved again", () => {
  // The outer object is level 1 and "workspaces" level 2; each "[" is one
  // more, so "[" × b reaches level 2 + b: b = MAX_NESTING − 2 is exactly
  // the most, one more is refused, at the 257th level: render then 254 × [0].
  const at = (brackets: number) => `{"formatVersion": 2, "links": [], "materials": [], "name": "P", "units": {"length": "mm"}, "workspaces": {"render": ${"[".repeat(brackets)}${"]".repeat(brackets)}}}`;
  assert.equal(MAX_NESTING, 256);
  assert.doesNotThrow(() => projectToJson(projectFromJson(at(MAX_NESTING - 2), [])));
  assert.throws(() => projectFromJson(at(MAX_NESTING - 1), []), /not a Panoshape project: project\.workspaces\.render(\[0\]){254} is nested more than 256 deep/);
  // 10,000 deep is past what saving (JSON.stringify) can reach.
  assert.throws(() => projectFromJson(at(10_000), []), /nested more than 256 deep/);
});

test("a number too big for a double (read as Infinity) is refused with where it is", () => {
  // 1e400 > Number.MAX_VALUE ≈ 1.8e308, so JSON.parse gives Infinity, which
  // no file can hold: opening it would make a project that can't be saved.
  const text = (n: string) => `{"formatVersion": 2, "links": [], "materials": [], "name": "P", "units": {"length": "mm"}, "workspaces": {"render": {"w": ${n}}}}`;
  assert.throws(() => projectFromJson(text("1e400"), []), /not a Panoshape project: project\.workspaces\.render\.w is too big a number/);
  assert.throws(() => projectFromJson(text("-1e400"), []), /project\.workspaces\.render\.w is too big a number/);
  assert.equal((projectFromJson(text("1e308"), []).workspaces.render as { w: number }).w, 1e308);
});

test("a project of MAX_PROJECT_BYTES opens; one more is refused before it is parsed (audit S2)", () => {
  // 64 × 1024 × 1024 = 67,108,864 bytes. A saved empty project padded with
  // spaces (still valid JSON) to exactly that opens; one space more doesn't.
  assert.equal(MAX_PROJECT_BYTES, 67_108_864);
  const json = projectToJson(emptyProject("P"));
  const padded = (n: number) => json + " ".repeat(n - json.length);
  assert.equal(projectFromJson(padded(MAX_PROJECT_BYTES), []).name, "P");
  // 67,108,865 / 1,048,576 = 64.000001, rounded up to a tenth: 64.1, so it never reads as the limit.
  assert.throws(() => projectFromJson(padded(MAX_PROJECT_BYTES + 1), []), { message: "can't open this project: it is 64.1 MB, and a Panoshape project may be at most 64 MB" });
  // Refused by its size before JSON.parse: text that isn't JSON at all gets the size message, not "not valid JSON".
  assert.throws(() => projectFromJson("x".repeat(MAX_PROJECT_BYTES + 1), []), /^Error: can't open this project: it is 64\.1 MB/);
  // 0.9 × 64 MB = 57.6 MB opens; 1.1 × is 73,819,750 bytes = 70.39999… MB, up to 70.4.
  assert.equal(projectFromJson(padded(Math.floor(0.9 * MAX_PROJECT_BYTES)), []).name, "P");
  assert.throws(() => projectFromJson(padded(Math.floor(1.1 * MAX_PROJECT_BYTES)), []), /it is 70\.4 MB/);
});

test("megabytes, worked by hand", () => {
  assert.equal(megabytes(1024 * 1024), "1 MB");
  assert.equal(megabytes(1.25 * 1024 * 1024), "1.3 MB"); // 1.25 up to a tenth
  assert.equal(megabytes(1), "0.1 MB"); // a single byte is still more than nothing
  assert.equal(megabytes(0), "0 MB");
});
