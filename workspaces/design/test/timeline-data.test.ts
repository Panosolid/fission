// Step 24d1: the timeline's data (docs/progress/cad.md, its test plan).
// Every solid feature is its own body, presets take ids from the counter,
// the rollback marker is saved, and version 2 files open as version 3.
// The seeded sessions against the timeline model are in packages/testing
// (src/timeline-data.ts, test/timeline-data.test.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { emptyProject, projectFromJson, projectToJson, type Feature } from "@fission/core";
import {
  builds,
  changePreset,
  insertAt,
  insertPreset,
  lastFeature,
  migrateDesignV2,
  partDocument,
  partOf,
  readDesignDocument,
  withPart,
  type DesignDocument,
} from "../src/document.ts";
import { addSketch, drawRectangle } from "../src/sketch.ts";
import { extrudeSketch } from "../src/extrude.ts";

const DESIGN = [{ id: "design" as const, readData: readDesignDocument }];
const REAL_V2 = readFileSync(new URL("./files/v2-plate.fission.json", import.meta.url), "utf8");

const ids = (d: DesignDocument) => d.timeline.features.map((f) => f.id);

/**
 * The checks the saved version 2 file must pass when opened through
 * `read`; returns the first that fails, so the planted migrations below
 * can show each one fails.
 */
function fixtureProblem(read: (data: unknown) => DesignDocument): string | null {
  const v2 = JSON.parse(REAL_V2).workspaces.design;
  let doc: DesignDocument;
  try {
    doc = projectFromJson(REAL_V2, [{ id: "design", readData: read }]).workspaces.design as DesignDocument;
  } catch (e) {
    return `refused: ${e}`;
  }
  // v2-plate.fission.json was saved by main before 24d1 (made by the
  // script in its commit): a 40 × 30 × 20 box (feature-1, counter 2);
  // Sketch 1 is sketch-2, its rectangle's four corners point-3, 4, 6, 8 and
  // lines 5, 7, 9, 10 (counter 11); the extrude by 10 is feature-11, and
  // in version 2 it replaced the box; Sketch 2 is sketch-12 with a line
  // (points 13, 14, line-15) and a half disc arc round point-16 (arc-17),
  // so the counter is at 18. Version 3 keeps every one of these.
  if (doc.version !== 3) return `version ${doc.version}`;
  if (JSON.stringify(ids(doc)) !== JSON.stringify(["sketch-2", "feature-11", "sketch-12"])) return `items ${ids(doc)}`;
  if (doc.nextId !== 18) return `nextId ${doc.nextId}`;
  if (Object.hasOwn(doc.timeline, "marker")) return "a marker appeared";
  // Its one solid feature stays unsuppressed and is the part.
  if (doc.timeline.features.some((f) => f.suppressed)) return "something was suppressed";
  if (lastFeature(doc).id !== "feature-11") return `part ${lastFeature(doc).id}`;
  if (JSON.stringify({ ...doc, version: 2 }) !== JSON.stringify(v2)) return "something else changed";
  const saved = projectToJson(projectFromJson(REAL_V2, DESIGN));
  if (projectToJson(projectFromJson(saved, DESIGN)) !== saved) return "save and reopen changed the text";
  return null;
}

test("the real version 2 file (saved by main before 24d1) opens as version 3 with every id kept, and reopens byte-identical", () => {
  assert.equal(JSON.parse(REAL_V2).workspaces.design.version, 2);
  assert.equal(fixtureProblem(readDesignDocument), null);
  const doc = projectFromJson(REAL_V2, DESIGN).workspaces.design as DesignDocument;
  assert.deepEqual(partOf(doc), { shape: "sketch-extrude", sizes: { height: 10 } });
  // Saved, it is version 3.
  assert.equal(JSON.parse(projectToJson(projectFromJson(REAL_V2, DESIGN))).workspaces.design.version, 3);
});

test("the fixture test fails for a migration broken on purpose, each way", () => {
  // Version 2 relabelled as 3 with nothing else done would pass this file,
  // which has one solid feature; these two break what it does check.
  const plantMarker = (data: unknown) => {
    const d = structuredClone(data) as Record<string, unknown> & { timeline: Record<string, unknown> };
    if (d.version === 2) d.timeline.marker = "sketch-12";
    return readDesignDocument(migrated(d));
  };
  const suppressAll = (data: unknown) => {
    const d = migrateDesignV2(data as Record<string, unknown>) as unknown as DesignDocument;
    return readDesignDocument({ ...d, timeline: { ...d.timeline, features: d.timeline.features.map((f) => ({ ...f, suppressed: !(f.intent.type === "sketch") })) } });
  };
  const dropCounter = (data: unknown) => readDesignDocument({ ...migrateDesignV2(data as Record<string, unknown>), nextId: 17 });
  assert.match(fixtureProblem(plantMarker) ?? "", /a marker appeared/);
  assert.match(fixtureProblem(suppressAll) ?? "", /refused: .*builds no body/);
  assert.match(fixtureProblem(dropCounter) ?? "", /refused: .*nextId 17 is not above arc-17/);
});

/** Version 2 data as version 3, the marker kept (the planted migration above). */
const migrated = (d: Record<string, unknown>) => ({ ...d, version: 3 });

/** A version 2 document with a box, then a sketch with a 20 × 10 rectangle, then a cylinder: two solid features (only hand-made; version 2's app always kept one). */
function twoSolids(): Record<string, unknown> {
  let doc = partDocument("box", 40, 30, 20);
  const s = addSketch(doc);
  doc = drawRectangle(s.doc, s.id, [0, 0], [20, 10]).doc;
  doc = insertPreset(doc, "cylinder", 10, 10, 5).doc;
  return { ...structuredClone(doc), version: 2 };
}

test("a version 2 file with two solid features opens with the earlier one suppressed, so it looks as it did", () => {
  // Version 2 showed only the last solid feature (the cylinder, feature-11);
  // in version 3 the box would be a body of its own, so it is suppressed:
  // the same one body is shown and the box is kept, not lost.
  const v2 = twoSolids();
  const doc = readDesignDocument(structuredClone(v2));
  assert.deepEqual(ids(doc), ["feature-1", "sketch-2", "feature-11"]);
  assert.deepEqual(doc.timeline.features.map((f) => f.suppressed), [true, false, false]);
  assert.equal(lastFeature(doc).id, "feature-11");
  assert.deepEqual(partOf(doc), { shape: "cylinder", sizes: { width: 10, height: 5 } });
  // Everything else is as it was.
  const back = { ...doc, version: 2, timeline: { features: doc.timeline.features.map((f, i) => (i === 0 ? { ...f, suppressed: false } : f)) } };
  assert.deepEqual(back, v2);
  // Version 2 data with a marker is refused, never half-migrated.
  const marked = structuredClone(v2) as { timeline: Record<string, unknown> };
  marked.timeline.marker = "feature-1";
  assert.throws(() => readDesignDocument(marked), /^Error: Design data says version 2 but has a timeline marker, which version 2 never had$/);
});

test("hand-worked: extruding after a box keeps the box, two solid features, and the panel adds a preset after an extrude", () => {
  // Box feature-1 (counter 2); Sketch 1 sketch-2; its rectangle points 3,
  // 4, 6, 8 and lines 5, 7, 9, 10 (counter 11); the extrude is feature-11.
  const s = addSketch(partDocument("box", 40, 30, 20));
  const drawn = drawRectangle(s.doc, s.id, [0, 0], [20, 10]).doc;
  assert.equal(drawn.nextId, 11);
  const made = extrudeSketch(drawn, s.id, 10).doc;
  assert.deepEqual(ids(made), ["feature-1", "sketch-2", "feature-11"]);
  assert.equal(made.nextId, 12);
  assert.equal(lastFeature(made).id, "feature-11");
  // The panel asking for a sphere: the part is an extrude, so a new preset
  // goes in after it with the next id; the extrude stays.
  const sphere = withPart(made, "sphere", 8, 8, 8);
  assert.deepEqual(ids(sphere), ["feature-1", "sketch-2", "feature-11", "feature-12"]);
  assert.equal(sphere.nextId, 13);
  // Then the panel edits that preset in place: same id, same place, counter unchanged.
  const bigger = withPart(sphere, "sphere", 9, 9, 9);
  assert.deepEqual(ids(bigger), ids(sphere));
  assert.equal(bigger.nextId, 13);
  assert.deepEqual(partOf(bigger), { shape: "sphere", sizes: { width: 9 } });
  // A preset of a profile shape takes two ids: feature-13 and profile-14.
  const plate = insertPreset(bigger, "plate", 40, 30, 5);
  assert.equal(plate.id, "feature-13");
  assert.deepEqual(plate.doc.profiles.map((p) => p.id), ["profile-14"]);
  assert.equal(plate.doc.nextId, 15);
  assert.doesNotThrow(() => readDesignDocument(structuredClone(plate.doc)));
});

test("changePreset changes one preset by id, and refuses what is not a preset", () => {
  const two = insertPreset(partDocument("box", 1, 2, 3), "cylinder", 4, 4, 6).doc;
  const changed = changePreset(two, "feature-1", "box", 7, 8, 9);
  assert.deepEqual(changed.timeline.features[0].intent.parameters, { width: 7, depth: 8, height: 9 });
  assert.deepEqual(changed.timeline.features[1], two.timeline.features[1]);
  // A suppressed preset stays suppressed when its sizes change.
  const off = { ...two, timeline: { features: two.timeline.features.map((f, i) => (i === 0 ? { ...f, suppressed: true } : f)) } };
  assert.equal(changePreset(off, "feature-1", "sphere", 3, 3, 3).timeline.features[0].suppressed, true);
  const s = addSketch(two);
  assert.throws(() => changePreset(s.doc, s.id, "box", 1, 1, 1), /^Error: there is no preset sketch-3 in the design$/);
  assert.throws(() => changePreset(two, "feature-9", "box", 1, 1, 1), /^Error: there is no preset feature-9 in the design$/);
});

test("with the marker on an item, a new sketch, extrude or preset goes in just after it and the marker moves onto it", () => {
  // Box feature-1, Sketch 1 (sketch-2, rectangle to counter 11), cylinder feature-11.
  const s = addSketch(partDocument("box", 40, 30, 20));
  const three = insertPreset(drawRectangle(s.doc, s.id, [0, 0], [20, 10]).doc, "cylinder", 10, 10, 5).doc;
  const at = (marker: string): DesignDocument => ({ ...three, timeline: { ...three.timeline, marker } });
  assert.equal(insertAt(three), 3);
  assert.equal(insertAt(at("start")), 0);
  assert.equal(insertAt(at("sketch-2")), 2);
  // An extrude of Sketch 1 with the marker on it: between the sketch and the cylinder.
  const e = extrudeSketch(at("sketch-2"), s.id, 5);
  assert.deepEqual(ids(e.doc), ["feature-1", "sketch-2", "feature-12", "feature-11"]);
  assert.equal(e.doc.timeline.marker, "feature-12");
  // The part is the last solid feature that builds: the new extrude, not the rolled-back cylinder.
  assert.equal(lastFeature(e.doc).id, "feature-12");
  // A preset with the marker on the box: second; a sketch with the marker at the start: first.
  const p = insertPreset(at("feature-1"), "sphere", 3, 3, 3);
  assert.deepEqual(ids(p.doc), ["feature-1", "feature-12", "sketch-2", "feature-11"]);
  assert.equal(p.doc.timeline.marker, "feature-12");
  const first = addSketch(at("start"));
  assert.deepEqual(ids(first.doc), ["sketch-12", "feature-1", "sketch-2", "feature-11"]);
  assert.equal(first.doc.timeline.marker, "sketch-12");
  // With no marker everything goes last and no marker appears.
  assert.equal(Object.hasOwn(insertPreset(three, "box", 1, 1, 1).doc.timeline, "marker"), false);
  // An extrude can't go in before its own sketch.
  assert.throws(() => extrudeSketch(at("feature-1"), s.id, 5), /^Error: Sketch 1 comes after the rollback marker, so an extrude put in at the marker can't use it$/);
  // Each document with a marker saves and opens byte-identical.
  // (first.doc builds no body, refused until 24d3 can show one.)
  for (const d of [e.doc, p.doc]) {
    const text = projectToJson({ ...emptyProject(), workspaces: { design: d } });
    assert.equal(projectToJson(projectFromJson(text, DESIGN)), text);
  }
});

test("the part is the last solid feature that builds: suppressed, rolled back, or extruding a suppressed sketch, it doesn't", () => {
  const s = addSketch(partDocument("box", 40, 30, 20));
  const made = extrudeSketch(drawRectangle(s.doc, s.id, [0, 0], [20, 10]).doc, s.id, 10).doc;
  const edit = (f: (x: Feature) => Partial<Feature>, marker?: string): DesignDocument => ({
    ...made,
    timeline: { features: made.timeline.features.map((x) => ({ ...x, ...f(x) })), ...(marker === undefined ? {} : { marker }) },
  });
  assert.equal(lastFeature(made).id, "feature-11");
  assert.equal(lastFeature(edit((x) => ({ suppressed: x.id === "feature-11" }))).id, "feature-1");
  assert.equal(lastFeature(edit((x) => ({ suppressed: x.id === "sketch-2" }))).id, "feature-1");
  assert.equal(builds(edit((x) => ({ suppressed: x.id === "sketch-2" })), made.timeline.features[2]), false);
  assert.equal(lastFeature(edit(() => ({}), "sketch-2")).id, "feature-1");
  assert.equal(lastFeature(edit(() => ({}), "feature-11")).id, "feature-11");
  // Nothing builds: refused, with the reason.
  const none = /^Error: Design data builds no body: every solid feature is suppressed or after the rollback marker, and this Panoshape can't show a design with no body yet$/;
  assert.throws(() => lastFeature(edit(() => ({}), "start")), none);
  assert.throws(() => lastFeature(edit((x) => ({ suppressed: x.id !== "sketch-2" }))), none);
  assert.throws(() => readDesignDocument(structuredClone(edit(() => ({}), "start"))), none);
});

test("a version 3 file that breaks a timeline rule is refused when it is opened, each with its message", () => {
  const s = addSketch(partDocument("box", 40, 30, 20));
  const valid = extrudeSketch(drawRectangle(s.doc, s.id, [0, 0], [20, 10]).doc, s.id, 10).doc;
  const broken = (edit: (d: DesignDocument & { timeline: Record<string, unknown> }) => void) => {
    const d = structuredClone(valid) as DesignDocument & { timeline: Record<string, unknown> };
    edit(d);
    return () => readDesignDocument(d);
  };
  assert.doesNotThrow(broken(() => {}));
  assert.doesNotThrow(broken((d) => (d.timeline.marker = "sketch-2")));
  assert.doesNotThrow(broken((d) => (d.timeline.marker = "feature-1")));
  const cases: [(d: DesignDocument & { timeline: Record<string, unknown> }) => void, RegExp][] = [
    [(d) => (d.timeline.marker = "feature-99"), /^Error: Design timeline marker feature-99 is not "start" or the id of an item in the timeline$/],
    [(d) => (d.timeline.marker = 3), /^Error: Design timeline marker 3 is not "start" or the id of an item in the timeline$/],
    [(d) => (d.timeline.marker = null), /^Error: Design timeline marker null is not "start" or the id of an item in the timeline$/],
    [(d) => (d.timeline.marker = "line-4"), /marker line-4 is not "start" or the id of an item/],
    [(d) => (d.timeline.marker = "start"), /builds no body/],
    [(d) => ((d.timeline.features as Feature[])[2].suppressed = "no" as unknown as boolean), /^Error: Design feature feature-11: suppressed must be true or false, not no$/],
  ];
  for (const [edit, message] of cases) assert.throws(broken(edit), message);
});
