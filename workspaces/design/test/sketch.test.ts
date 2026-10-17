// Step 21b: sketches saved in the Design document (docs/document-model.md),
// the edits that change them, the version 1 → 2 migration and the checks
// a file with sketches must pass when it is opened.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ChangeNotes, DependencyGraph, emptyProject, projectFromJson, projectToJson, type Feature } from "@fission/core";
import { lastFeature, partDocument, partOf, readDesignDocument, withPart, type DesignDocument } from "../src/document.ts";
import { addSketch, deleteCurve, drawLine, movePoint, planeOf, sketchLines } from "../src/sketch.ts";
import { PART_VIEW, syncGraph } from "../src/graph.ts";

const DESIGN = [{ id: "design" as const, readData: readDesignDocument }];

/** A box, then Sketch 1 with an L of two lines sharing their corner. */
function lSketch() {
  const s = addSketch(partDocument("box", 40, 30, 20));
  const one = drawLine(s.doc, s.id, [0, 0], [40, 0]);
  const two = drawLine(one.doc, s.id, "point-4", [40, 30]);
  return { doc: two.doc, sketch: s.id, lines: [one.id, two.id] };
}

test("hand-worked: a sketch and two chained lines, every id from the one counter", () => {
  // A fresh part holds feature-1, so the counter is at 2. The sketch takes 2;
  // the first line's two new ends take 3 and 4 and the line 5; the second
  // line starts at point-4 (shared, no new point), its new end takes 6 and
  // the line 7. The counter ends at 8.
  const { doc } = lSketch();
  assert.equal(doc.nextId, 8);
  assert.deepEqual(doc.sketches, [
    {
      id: "sketch-2",
      points: [
        { id: "point-3", x: 0, y: 0 },
        { id: "point-4", x: 40, y: 0 },
        { id: "point-6", x: 40, y: 30 },
      ],
      curves: [
        { id: "line-5", kind: "line", start: "point-3", end: "point-4" },
        { id: "line-7", kind: "line", start: "point-4", end: "point-6" },
      ],
      constraints: [],
    },
  ]);
  const item: Feature = {
    id: "sketch-2",
    intent: { type: "sketch", parameters: { plane: "XY" }, summary: "Sketch 1 on the XY plane" },
    provenance: { self: { workspace: "design", id: "sketch-2", label: "Sketch 1" }, from: [] },
    dependsOn: [],
    suppressed: false,
  };
  assert.deepEqual(doc.timeline.features.map((f) => f.id), ["feature-1", "sketch-2"]);
  assert.deepEqual(doc.timeline.features[1], item);
  // The part is still the box: a sketch builds no solid.
  assert.equal(lastFeature(doc).id, "feature-1");
  assert.deepEqual(partOf(doc), { shape: "box", sizes: { width: 40, depth: 30, height: 20 } });
  // The kernel gets the lines rebuilt from point ids: (0,0)→(40,0), (40,0)→(40,30).
  assert.deepEqual(sketchLines(doc.sketches[0]), [
    { a: [0, 0], b: [40, 0] },
    { a: [40, 0], b: [40, 30] },
  ]);
});

test("ids are never reused: delete the newest line, draw another, and the new ids are new", () => {
  // The newest line (line-7) and its own end (point-6) go; point-4 stays,
  // since line-5 still ends there. "Largest id + 1" would now hand out 6
  // and 7 again; the counter hands out 8 and 9.
  const { doc, sketch } = lSketch();
  const gone = deleteCurve(doc, sketch, "line-7");
  assert.deepEqual(gone.sketches[0].points.map((p) => p.id), ["point-3", "point-4"]);
  assert.deepEqual(gone.sketches[0].curves.map((c) => c.id), ["line-5"]);
  assert.equal(gone.nextId, 8, "a delete never moves the counter back");
  const again = drawLine(gone, sketch, "point-4", [40, 30]);
  const newPoint = again.doc.sketches[0].points.at(-1)!.id;
  for (const old of ["line-7", "point-6"]) assert.notEqual(again.id, old), assert.notEqual(newPoint, old);
  assert.deepEqual([newPoint, again.id], ["point-8", "line-9"]);
  // Every id in the document is still unique, and the file reads back.
  assert.deepEqual(readDesignDocument(structuredClone(again.doc)), again.doc);
});

test("deleting a line keeps points other lines share, and deleting them all empties the sketch", () => {
  const { doc, sketch } = lSketch();
  const first = deleteCurve(doc, sketch, "line-5");
  // point-3 was only line-5's; point-4 is line-7's start too.
  assert.deepEqual(first.sketches[0].points.map((p) => p.id), ["point-4", "point-6"]);
  const none = deleteCurve(first, sketch, "line-7");
  assert.deepEqual(none.sketches[0], { id: sketch, points: [], curves: [], constraints: [] });
  // The sketch itself stays in the timeline, empty, as in a sketch with nothing drawn yet.
  assert.deepEqual(none.timeline.features.map((f) => f.id), ["feature-1", "sketch-2"]);
});

test("moving a shared point moves the end of both lines that meet there", () => {
  const { doc, sketch } = lSketch();
  const moved = movePoint(doc, sketch, "point-4", 50, -5);
  assert.deepEqual(sketchLines(moved.sketches[0]), [
    { a: [0, 0], b: [50, -5] },
    { a: [50, -5], b: [40, 30] },
  ]);
  assert.equal(moved.nextId, doc.nextId);
});

test("sketch edits never change the document they are given", () => {
  const { doc, sketch } = lSketch();
  const before = JSON.stringify(doc);
  addSketch(doc);
  drawLine(doc, sketch, "point-6", [0, 30]);
  deleteCurve(doc, sketch, "line-5");
  movePoint(doc, sketch, "point-3", 1, 1);
  assert.equal(JSON.stringify(doc), before);
});

test("sketch edits refuse what makes no sense, each with its own message", () => {
  const { doc, sketch } = lSketch();
  assert.throws(() => drawLine(doc, "sketch-99", [0, 0], [1, 0]), /^Error: there is no sketch sketch-99 in the design$/);
  assert.throws(() => drawLine(doc, sketch, "point-99", [1, 0]), /^Error: sketch sketch-2 has no point point-99$/);
  assert.throws(() => drawLine(doc, sketch, "point-4", "point-4"), /^Error: a line can't start and end at the same point point-4$/);
  for (const bad of [NaN, Infinity, -Infinity])
    assert.throws(() => drawLine(doc, sketch, [bad, 0], [1, 0]), /a sketch point needs x and y in mm/);
  assert.throws(() => deleteCurve(doc, sketch, "line-99"), /^Error: sketch sketch-2 has no curve line-99$/);
  assert.throws(() => movePoint(doc, sketch, "point-99", 0, 0), /^Error: sketch sketch-2 has no point point-99$/);
  assert.throws(() => movePoint(doc, sketch, "point-3", 0, NaN), /a sketch point needs x and y in mm/);
  assert.throws(() => addSketch(doc, "AB" as never), /AB is not a plane a sketch can be on/);
});

test("a second sketch is Sketch 2, numbered past a name already in use", () => {
  const one = addSketch(partDocument("box", 40, 30, 20));
  assert.equal(addSketch(one.doc).doc.timeline.features[2].intent.summary, "Sketch 2 on the XY plane");
  // A file whose only sketch is called Sketch 2 (Sketch 1 was deleted elsewhere): the next is Sketch 3.
  const renamed = structuredClone(one.doc);
  renamed.timeline.features[1].intent.summary = "Sketch 2 on the XY plane";
  assert.equal(addSketch(renamed).doc.timeline.features[2].intent.summary, "Sketch 3 on the XY plane");
});

test("hand-worked: each origin plane's frame is right-handed (y = normal × x)", () => {
  // y = n × x. XY: Z × X = Y. XZ: (−Y) × X = −(Y × X) = −(−Z) = Z, so a
  // sketch's y points up. YZ: X × Y = Z, again up.
  const cross = ([a, b, c]: number[], [d, e, f]: number[]) => [b * f - c * e, c * d - a * f, a * e - b * d];
  const y = (p: ReturnType<typeof planeOf>) => cross(p.normal, p.xAxis).map((v) => v + 0); // + 0 turns −0 into 0
  assert.deepEqual(y(planeOf("XY")), [0, 1, 0]);
  assert.deepEqual(y(planeOf("XZ")), [0, 0, 1]);
  assert.deepEqual(y(planeOf("YZ")), [0, 0, 1]);
  assert.deepEqual([planeOf("XZ").xAxis, planeOf("YZ").xAxis], [[1, 0, 0], [0, 1, 0]]);
});

test("changing the part keeps the sketches where they are, and the counter never goes back", () => {
  const { doc } = lSketch();
  const bracket = withPart(doc, "l-bracket", 50, 30, 10);
  assert.deepEqual(bracket.timeline.features.map((f) => f.id), ["feature-1", "sketch-2"]);
  assert.deepEqual(bracket.sketches, doc.sketches);
  assert.equal(bracket.nextId, 8);
  assert.deepEqual(partOf(bracket), { shape: "l-bracket", sizes: { width: 50, depth: 30, height: 10 } });
  assert.deepEqual(bracket.profiles.map((p) => p.id), ["profile-1"]);
  // With no document before it, the same as a fresh part.
  assert.deepEqual(withPart(null, "box", 1, 2, 3), partDocument("box", 1, 2, 3));
});

test("drawing a line changes the sketch in the graph, not the part", () => {
  // A result reading the sketch (as an extrude will at 21d, or a cut path in Laser).
  const g = new DependencyGraph();
  const s = addSketch(partDocument("box", 40, 30, 20));
  syncGraph(g, s.doc, null, new ChangeNotes());
  g.set({ id: "laser.cut", label: "Cut path", workspace: "laser", cost: "cheap" }, [s.id]);
  for (const id of g.stale()) g.markFresh(id);
  // The same sketch again (a copy): nothing is out of date.
  syncGraph(g, structuredClone(s.doc), s.doc, new ChangeNotes());
  assert.deepEqual(g.stale(), []);
  // A line drawn: the sketch's item is unchanged but its content is not.
  const notes = new ChangeNotes();
  syncGraph(g, drawLine(s.doc, s.id, [0, 0], [1, 0]).doc, s.doc, notes);
  assert.deepEqual(g.stale(), ["laser.cut"]);
  assert.equal(g.isStale(PART_VIEW), false);
  assert.match(notes.current(g)[0].text, /you changed the sketch/);
});

// ---- Saving and opening (docs/project-format.md, Design's data version 2) ----

const REAL_V1 = readFileSync(new URL("./files/v1-bracket.fission.json", import.meta.url), "utf8");

test("a real version 1 file (saved by the Fission before 21b) opens as version 2, and saves and reopens unchanged", () => {
  // v1-bracket.fission.json was saved by main before this step: an
  // L-bracket 40 × 30 extruded 20. Its ids are profile-1 and feature-1, so
  // the counter starts at 2; there are no sketches; nothing else changes.
  const v1 = JSON.parse(REAL_V1).workspaces.design;
  assert.equal(v1.version, 1);
  const p = projectFromJson(REAL_V1, DESIGN);
  const doc = p.workspaces.design as DesignDocument;
  assert.deepEqual(doc, { ...v1, version: 2, nextId: 2, sketches: [] });
  assert.deepEqual(partOf(doc), { shape: "l-bracket", sizes: { width: 40, depth: 30, height: 20 } });
  // Saved, it is version 2; opened and saved again, byte-identical.
  const saved = projectToJson(p);
  assert.equal(JSON.parse(saved).workspaces.design.version, 2);
  assert.equal(projectToJson(projectFromJson(saved, DESIGN)), saved);
});

test("a project with sketches saves and opens byte-identical", () => {
  const { doc, sketch } = lSketch();
  const two = addSketch(movePoint(doc, sketch, "point-3", -0.1, 1e-6)).doc;
  const text = projectToJson({ ...emptyProject("Sketched"), workspaces: { design: two } });
  const opened = projectFromJson(text, DESIGN);
  assert.deepEqual(opened.workspaces.design, two);
  assert.equal(projectToJson(opened), text);
});

test("a file with sketches that breaks a rule is refused when it is opened, each with its message", () => {
  // Each case breaks the valid L sketch in exactly one way.
  const broken = (edit: (d: DesignDocument & Record<string, unknown>) => void) => {
    const d = structuredClone(lSketch().doc) as DesignDocument & Record<string, unknown>;
    edit(d);
    return () => readDesignDocument(d);
  };
  assert.doesNotThrow(broken(() => {}));
  const cases: [(d: DesignDocument & Record<string, unknown>) => void, RegExp][] = [
    [(d) => delete d.sketches, /^Error: Design data has no sketches list$/],
    [(d) => (d.nextId = 2.5), /nextId 2.5 is not a counting number/],
    [(d) => (d.nextId = 0), /nextId 0 is not a counting number/],
    // The counter must be above every id: at 7, line-7 could be handed out again.
    [(d) => (d.nextId = 7), /^Error: Design data's nextId 7 is not above line-7, so a new id could repeat it$/],
    [(d) => ((d.sketches[0] as { id: unknown }).id = 3), /^Error: Design sketch 1 has no id$/],
    [(d) => delete (d.sketches[0] as Partial<DesignDocument["sketches"][0]>).curves, /sketch-2 needs points, curves and constraints lists/],
    [(d) => ((d.sketches[0].constraints as unknown[]) = [{ kind: "horizontal" }]), /sketch-2 has constraints, which this Fission can't read yet/],
    [(d) => ((d.sketches[0].points[0] as { x: unknown }).x = "0"), /^Error: Design sketch sketch-2: point point-3 needs x and y in mm$/],
    [(d) => ((d.sketches[0].points[1] as { id: unknown }).id = null), /^Error: Design sketch sketch-2: point 2 has no id$/],
    [(d) => ((d.sketches[0].curves[0] as { kind: string }).kind = "arc"), /curve line-5 is a arc, which this Fission can't read yet \(only lines\)/],
    [(d) => (d.sketches[0].curves[1].end = "point-99"), /line line-7 ends at point-99, which is not one of the sketch's points/],
    [(d) => (d.sketches[0].curves[1].end = "point-4"), /line line-7 starts and ends at the same point/],
    [(d) => ((d.sketches[0].curves[0] as { id: unknown }).id = undefined), /^Error: Design sketch sketch-2: curve 1 has no id$/],
    [(d) => d.timeline.features.pop(), /^Error: Design sketch sketch-2 has no place in the timeline$/],
    [(d) => (d.sketches = []), /^Error: Design timeline item sketch-2 is a sketch with no content in the sketches list$/],
    [(d) => (d.timeline.features[1].intent.parameters.plane = "AB"), /sketch-2 is on AB, not a plane this Fission knows \(XY, XZ or YZ\)/],
    [(d) => d.sketches[0].points.push({ id: "point-3", x: 1, y: 1 }), /^Error: Design id point-3 is used twice$/],
    [(d) => (d.sketches[0].curves[0].id = "feature-1"), /^Error: Design id feature-1 is used twice$/],
    // Every item a sketch: there is no part to show.
    [(d) => d.timeline.features.shift(), /Design data has no part: every timeline item is a sketch/],
  ];
  for (const [edit, message] of cases) assert.throws(broken(edit), message);
});

test("version 1 data holding version 2's fields is refused, not half-migrated", () => {
  const v1 = JSON.parse(REAL_V1).workspaces.design;
  assert.doesNotThrow(() => readDesignDocument(structuredClone(v1)));
  assert.throws(() => readDesignDocument({ ...v1, nextId: 5 }), /^Error: Design data says version 1 but has a nextId or sketches, which version 1 never had$/);
  assert.throws(() => readDesignDocument({ ...v1, sketches: [] }), /says version 1 but has a nextId or sketches/);
});

test("version 1 data with a counter-looking id gets a counter above it", () => {
  // A v1 file whose feature is "feature-7": the counter starts at 8, so the
  // first sketch is sketch-8 and never collides with it.
  const v1 = JSON.parse(REAL_V1).workspaces.design;
  v1.timeline.features[0].id = "feature-7";
  const doc = readDesignDocument(v1);
  assert.equal(doc.nextId, 8);
  assert.equal(addSketch(doc).id, "sketch-8");
});

test("a file value whose own toString is broken is named by its kind, not run (found by fuzzing)", () => {
  // Before: String({ toString: 8 }) threw "Cannot convert object to primitive
  // value" and the file was refused with an engine message, not Design's.
  const evil = { toString: 8 };
  const doc = structuredClone(lSketch().doc);
  (doc.sketches[0].curves[1] as { end: unknown }).end = evil;
  assert.throws(() => readDesignDocument(doc), /^Error: Design sketch sketch-2: line line-7 ends at an object, which is not one of the sketch's points$/);
  assert.throws(() => readDesignDocument({ ...lSketch().doc, version: evil }), /^Error: Design data version an object is not one this Fission reads/);
  assert.throws(() => readDesignDocument({ ...lSketch().doc, nextId: [evil] }), /^Error: Design data's nextId a list is not a counting number$/);
  const slot = partDocument("slot", 40, 30, 20);
  slot.timeline.features[0].intent.parameters.profile = evil as never;
  assert.throws(() => readDesignDocument(slot), /its profile an object is missing$/);
});
