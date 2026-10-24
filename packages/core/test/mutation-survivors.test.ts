// Tests written to kill the mutants StrykerJS found surviving in the
// document model, file reading and undo (testing hunt 3a, 2026-10-17;
// run it again with packages/testing/stryker/run.sh core). Each test names
// the change to the code it catches. Mutants that change nothing a caller
// can see are listed, with the reason, in packages/testing/stryker/explained.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHistory, MERGE_MS, type HistoryOptions } from "../src/model/history.ts";
import { emptyProject, projectFromJson, projectToJson, readProject } from "../src/model/project.ts";
import { describeProvenance, workspaceName } from "../src/model/feature.ts";

/** A history over one width, as in history.test.ts, with an optional fake clock. */
function rig(extra: Partial<HistoryOptions> = {}) {
  const doc = { w: 40 };
  const h = createHistory({ capture: () => JSON.stringify(doc), restore: (s) => (doc.w = JSON.parse(s).w), ...extra });
  const edit = (w: number, label = `Width ${w}`, key?: string) => {
    doc.w = w;
    return h.record(label, key);
  };
  return { h, doc, edit };
}

// ---- history.ts ----

test("without a clock given, the real clock merges two quick edits of one box", () => {
  // Catches the default clock returning nothing: then every gap is NaN, never
  // under the merge time, and the two keys would be two steps. The two
  // records run microseconds apart, far under MERGE_MS = 1000 ms.
  const { h, doc, edit } = rig();
  edit(4, "Width", "width");
  edit(45, "Width", "width");
  assert.equal(h.undo(), "Width");
  assert.equal(doc.w, 40);
  assert.equal(h.canUndo(), false);
});

test("an undo limit of 1 is allowed and keeps exactly one step", () => {
  // Catches `limit < 1` becoming `limit <= 1`. Limit 1: 40 → 41 → 42 keeps
  // only 41 → 42, so one undo reaches 41 and the next does nothing.
  const { h, doc, edit } = rig({ limit: 1 });
  edit(41);
  edit(42);
  assert.equal(h.undo(), "Width 42");
  assert.equal(doc.w, 41);
  assert.equal(h.undo(), null);
});

test("a merge time of 0 ms is allowed and merges nothing, not even edits at the same instant", () => {
  // Catches `mergeMs >= 0` becoming `> 0`. With 0 ms, a gap of 0 is not
  // under the merge time (0 < 0 is false), so each edit is its own step.
  const { h, doc, edit } = rig({ mergeMs: 0, now: () => 5 });
  edit(4, "Width", "width");
  edit(45, "Width", "width");
  assert.equal(h.undo(), "Width");
  assert.equal(doc.w, 4);
});

test("edits exactly the merge time apart are two steps (the boundary between 0.9× and 1.1×)", () => {
  // Catches `<` becoming `<=`: a gap of exactly 1000 ms is not under 1000 ms.
  let t = 0;
  const { h, doc, edit } = rig({ now: () => t });
  edit(4, "Width", "width");
  t += MERGE_MS;
  edit(45, "Width", "width");
  h.undo();
  assert.equal(doc.w, 4);
});

test("after typing back to where a step started, the same box starts a new step at once", () => {
  // Catches the fold-back leaving "the last change was a record" set: the
  // next key would then merge into the step before (Width 41), which was
  // made with the same key and only just now.
  const { h, doc, edit } = rig({ now: () => 0 });
  edit(41, "Width", "width"); // step 1: 40 → 41
  h.undo();
  h.redo(); // an undo and redo in between: the next key is a step of its own
  edit(50, "Width", "width"); // step 2: 41 → 50
  edit(41, "Width", "width"); // typed back to 41: step 2 is gone
  assert.equal(h.undoLabel(), "Width");
  edit(42, "Width", "width"); // a new step 41 → 42, not merged into step 1
  h.undo();
  assert.equal(doc.w, 41);
  h.undo();
  assert.equal(doc.w, 40);
});

test("while a failed step puts the project back, restoring() says so", () => {
  // Catches the failed step's put-back not marking itself as a restore: a
  // workspace remounting then would take it for a user's change.
  const doc = { w: 40 };
  const seen: boolean[] = [];
  const h = createHistory({
    capture: () => JSON.stringify(doc),
    restore: (s) => {
      doc.w = JSON.parse(s).w;
      seen.push(h.restoring());
    },
  });
  assert.throws(() => h.step("Bad", () => { doc.w = 99; throw new Error("no"); }), /no/);
  assert.deepEqual(seen, [true]);
  assert.equal(h.restoring(), false);
  assert.equal(doc.w, 40);
});

test("a step that brings the history exactly to the undo limit drops nothing", () => {
  // Catches the step's trim starting one step early (`>=`, or `limit - 1`).
  // Limit 2 from 40: Width 41, then step S (42). Two steps, both kept.
  const { h, doc, edit } = rig({ limit: 2 });
  edit(41);
  h.step("S", () => edit(42));
  assert.equal(h.undo(), "S");
  assert.equal(h.undo(), "Width 41");
  assert.equal(doc.w, 40);
});

test("a step past the undo limit drops the oldest step", () => {
  // Catches the step's own trim being skipped or moving the wrong way.
  // Limit 2 from 40: Width 41, Width 42, then step S (43). Three steps, so
  // the oldest (40 → 41) goes: undo reaches 42, then 41, then stops.
  const { h, doc, edit } = rig({ limit: 2 });
  edit(41);
  edit(42);
  h.step("S", () => edit(43));
  assert.equal(h.undo(), "S");
  assert.equal(h.undo(), "Width 42");
  assert.equal(doc.w, 41);
  assert.equal(h.undo(), null);
  assert.equal(h.redo(), "Width 42");
  assert.equal(h.redo(), "S");
  assert.equal(doc.w, 43);
});

// ---- project.ts ----

test('a new project with no name given is called "Untitled"', () => {
  assert.equal(emptyProject().name, "Untitled");
});

test("null, version 0 and negative versions are refused with their own messages", () => {
  // Catches `data === null` and `v < 1` dropped: null would fail reading a
  // property of null, version 0 would look for a migration from 0.
  assert.throws(() => readProject(null), /^Error: not a SpindleLabs project: expected an object$/);
  for (const v of [0, -1]) assert.throws(() => readProject({ ...emptyProject(), formatVersion: v }), /^Error: not a SpindleLabs project: no format version$/);
});

test("a bad unit's message lists every unit, comma separated", () => {
  assert.throws(
    () => readProject({ ...emptyProject(), units: { length: "furlong" } }),
    (e: Error) => e.message === 'not a SpindleLabs project: "units" must give a length unit (mm, cm, m, in)',
  );
});

test("a null anywhere inside a workspace's data opens", () => {
  // Catches the file check walking into null as if it were an object.
  const text = JSON.stringify({ ...emptyProject(), workspaces: { render: { scene: null, lights: [null, 1] } } });
  assert.deepEqual(projectFromJson(text, []).workspaces, { render: { scene: null, lights: [null, 1] } });
});

test("an opened workspace's data is saved again and can be replaced or dropped", () => {
  // Catches the opened part being defined hidden (not enumerable: saving
  // would drop it), read-only (a workspace could not store its new data) or
  // fixed (it could not be dropped).
  const text = JSON.stringify({ ...emptyProject("W"), workspaces: { render: { a: 1 } } });
  const p = projectFromJson(text, []);
  assert.deepEqual(JSON.parse(projectToJson(p)).workspaces, { render: { a: 1 } });
  p.workspaces.render = { a: 2 };
  assert.deepEqual(p.workspaces.render, { a: 2 });
  // ...and dropped (not defined fixed in place, which would throw here).
  delete p.workspaces.render;
  assert.deepEqual(p.workspaces, {});
});

// ---- feature.ts ----

test("every workspace's name as people read it", () => {
  const ids = ["design", "render", "simulate", "manufacture", "laser", "slice", "circuit", "vector", "image", "layout"] as const;
  assert.deepEqual(ids.map(workspaceName), ["Design", "Render", "Simulate", "Manufacture", "Laser", "Slice", "Circuit", "Vector", "Image", "Layout"]);
});

test("provenance from one origin has no 'applied to'; from three, the later two are joined by ', then '", () => {
  const self = { workspace: "slice" as const, id: "p", label: "Plate 1" };
  const o = (workspace: "vector" | "design" | "image", label: string) => ({ workspace, id: label, label });
  assert.equal(describeProvenance({ self, from: [o("design", "Body 2")] }), "Plate 1 comes from Body 2 in Design.");
  assert.equal(
    describeProvenance({ self, from: [o("image", "Photo"), o("vector", "Trace"), o("design", "Relief")] }),
    "Plate 1 comes from Photo in Image, applied to Trace in Vector, then Relief in Design.",
  );
});
