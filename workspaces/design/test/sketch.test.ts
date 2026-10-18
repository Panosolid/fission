// Step 21b: sketches saved in the Design document (docs/document-model.md),
// the edits that change them, the version 1 → 2 migration and the checks
// a file with sketches must pass when it is opened. Circles from step 22b,
// arcs from 23a.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ChangeNotes, DependencyGraph, emptyProject, projectFromJson, projectToJson, type Feature, type KernelCalls } from "@fission/core";
import { lastFeature, partDocument, partOf, readDesignDocument, withPart, type DesignDocument } from "../src/document.ts";
import { addSketch, deleteCurve, drawArc, drawCircle, drawLine, movePoint, planeOf, SKETCH_STEPS, sketchCurves, sketchLines, sketchOutline } from "../src/sketch.ts";
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
  // The box (feature-1) changed in place keeps its id; the profile it now
  // needs is new, so it takes the counter's 8 (presets take counter ids
  // like any feature from step 24d1), and the counter moves to 9.
  assert.equal(doc.nextId, 8);
  assert.equal(bracket.nextId, 9);
  assert.deepEqual(partOf(bracket), { shape: "l-bracket", sizes: { width: 50, depth: 30, height: 10 } });
  assert.deepEqual(bracket.profiles.map((p) => p.id), ["profile-8"]);
  // Changed again, it keeps that profile's id; back to a box, the profile goes with nothing using it.
  assert.deepEqual(withPart(bracket, "plate", 50, 30, 10).profiles.map((p) => p.id), ["profile-8"]);
  assert.deepEqual(withPart(bracket, "box", 5, 5, 5).profiles, []);
  assert.equal(withPart(withPart(bracket, "box", 5, 5, 5), "star", 5, 5, 5).profiles[0].id, "profile-9");
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

test("a real version 1 file (saved by the Panoshape before 21b) opens as version 3, and saves and reopens unchanged", () => {
  // v1-bracket.fission.json was saved by main before this step: an
  // L-bracket 40 × 30 extruded 20. Its ids are profile-1 and feature-1, so
  // the counter starts at 2; there are no sketches; its one solid feature
  // is not suppressed by the step to version 3; nothing else changes.
  const v1 = JSON.parse(REAL_V1).workspaces.design;
  assert.equal(v1.version, 1);
  const p = projectFromJson(REAL_V1, DESIGN);
  const doc = p.workspaces.design as DesignDocument;
  assert.deepEqual(doc, { ...v1, version: 3, nextId: 2, sketches: [] });
  assert.deepEqual(partOf(doc), { shape: "l-bracket", sizes: { width: 40, depth: 30, height: 20 } });
  // Saved, it is version 3; opened and saved again, byte-identical.
  const saved = projectToJson(p);
  assert.equal(JSON.parse(saved).workspaces.design.version, 3);
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
    [(d) => ((d.sketches[0].constraints as unknown[]) = [{ kind: "horizontal" }]), /sketch-2 has constraints, which this Panoshape can't read yet/],
    [(d) => ((d.sketches[0].points[0] as { x: unknown }).x = "0"), /^Error: Design sketch sketch-2: point point-3 needs x and y in mm$/],
    [(d) => ((d.sketches[0].points[1] as { id: unknown }).id = null), /^Error: Design sketch sketch-2: point 2 has no id$/],
    [(d) => ((d.sketches[0].curves[0] as { kind: string }).kind = "spline"), /curve line-5 is a spline, which this Panoshape can't read yet \(only lines, circles and arcs\)/],
    [(d) => (d.sketches[0].curves[1].end = "point-99"), /line line-7 ends at point-99, which is not one of the sketch's points/],
    [(d) => (d.sketches[0].curves[1].end = "point-4"), /line line-7 starts and ends at the same point/],
    [(d) => ((d.sketches[0].curves[0] as { id: unknown }).id = undefined), /^Error: Design sketch sketch-2: curve 1 has no id$/],
    [(d) => d.timeline.features.pop(), /^Error: Design sketch sketch-2 has no place in the timeline$/],
    [(d) => (d.sketches = []), /^Error: Design timeline item sketch-2 is a sketch with no content in the sketches list$/],
    [(d) => (d.timeline.features[1].intent.parameters.plane = "AB"), /sketch-2 is on AB, not a plane this Panoshape knows \(XY, XZ or YZ\)/],
    [(d) => d.sketches[0].points.push({ id: "point-3", x: 1, y: 1 }), /^Error: Design id point-3 is used twice$/],
    [(d) => (d.sketches[0].curves[0].id = "feature-1"), /^Error: Design id feature-1 is used twice$/],
  ];
  for (const [edit, message] of cases) assert.throws(broken(edit), message);
  // Every item a sketch is no longer refused (24f4): a design with no body, opened as one.
  const sketchesOnly = broken((d) => d.timeline.features.shift())();
  assert.deepEqual(sketchesOnly.timeline.features.map((f) => f.id), ["sketch-2"]);
  assert.equal(partOf(sketchesOnly), null);
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

/** lSketch with a circle round a new point (10, 5), radius 3, and one round the L's corner point-4, radius 2.5. */
function circled() {
  const { doc, sketch } = lSketch();
  const one = drawCircle(doc, sketch, [10, 5], 3);
  const two = drawCircle(one.doc, sketch, "point-4", 2.5);
  return { doc: two.doc, sketch, circles: [one.id, two.id] };
}

test("hand-worked: circles round a new point and round a shared corner, ids from the one counter (22b)", () => {
  // lSketch leaves the counter at 8. The first circle's new centre takes 8,
  // the circle 9; the second is round point-4 (shared, no new point) and
  // takes 10. The counter ends at 11.
  const { doc, circles } = circled();
  assert.deepEqual(circles, ["circle-9", "circle-10"]);
  assert.equal(doc.nextId, 11);
  const s = doc.sketches[0];
  assert.deepEqual(s.points.map((p) => [p.id, p.x, p.y]), [["point-3", 0, 0], ["point-4", 40, 0], ["point-6", 40, 30], ["point-8", 10, 5]]);
  assert.deepEqual(s.curves.slice(2), [
    { id: "circle-9", kind: "circle", centre: "point-8", radius: 3 },
    { id: "circle-10", kind: "circle", centre: "point-4", radius: 2.5 },
  ]);
  // The kernel gets the lines and the circles apart, each in drawing order,
  // rebuilt from the point ids: point-8 is (10, 5), point-4 is (40, 0).
  assert.deepEqual(sketchCurves(s), {
    lines: [{ a: [0, 0], b: [40, 0] }, { a: [40, 0], b: [40, 30] }],
    circles: [{ centre: [10, 5], radius: 3 }, { centre: [40, 0], radius: 2.5 }],
    arcs: [],
  });
  assert.deepEqual(sketchLines(s), sketchCurves(s).lines);
  assert.equal(SKETCH_STEPS.circle, "Draw circle");
});

test("sketchOutline hands the kernel the lines and the circles, and names the sketch when it is open (22b)", async () => {
  const s = addSketch(partDocument("box", 10, 10, 10));
  const doc = drawCircle(s.doc, s.id, [1, 2], 4).doc;
  const asked: unknown[][] = [];
  const kernel = { call: (async (...args: unknown[]) => (asked.push(args), { closed: { outer: { circle: { center: [1, 2], radius: 4 } }, holes: [] } })) } as unknown as KernelCalls;
  assert.deepEqual(await sketchOutline(kernel, doc, s.id), { outer: { circle: { center: [1, 2], radius: 4 } }, holes: [] });
  assert.deepEqual(asked, [["sketch_outline", [], [{ centre: [1, 2], radius: 4 }], []]]);
  const open = { call: (async () => ({ open: "the sketch makes 2 separate loops; for now a sketch makes one outline" })) } as unknown as KernelCalls;
  await assert.rejects(sketchOutline(open, doc, s.id), /^Error: Sketch 1 has no closed outline: the sketch makes 2 separate loops/);
});

test("a circle's centre follows its point, and deleting a circle drops a centre only it used (22b)", () => {
  const { doc, sketch } = circled();
  // Moving the L's corner moves both lines' ends and the second circle's centre.
  const moved = movePoint(doc, sketch, "point-4", 41, -1);
  assert.deepEqual(sketchCurves(moved.sketches[0]).circles, [{ centre: [10, 5], radius: 3 }, { centre: [41, -1], radius: 2.5 }]);
  assert.deepEqual(sketchCurves(moved.sketches[0]).lines, [{ a: [0, 0], b: [41, -1] }, { a: [41, -1], b: [40, 30] }]);
  // circle-9 was alone round point-8: both go. The counter stays at 11.
  const one = deleteCurve(doc, sketch, "circle-9");
  assert.deepEqual(one.sketches[0].points.map((p) => p.id), ["point-3", "point-4", "point-6"]);
  assert.equal(one.nextId, 11);
  // Both lines gone: point-4 stays while circle-10 is round it; point-3 and point-6 go.
  const noLines = deleteCurve(deleteCurve(one, sketch, "line-5"), sketch, "line-7");
  assert.deepEqual(noLines.sketches[0].points.map((p) => p.id), ["point-4"]);
  assert.deepEqual(noLines.sketches[0].curves.map((c) => c.id), ["circle-10"]);
  assert.deepEqual(deleteCurve(noLines, sketch, "circle-10").sketches[0], { id: sketch, points: [], curves: [], constraints: [] });
  // A new circle after the deletes takes a new id, never circle-9 again.
  assert.equal(drawCircle(noLines, sketch, [0, 0], 1).id, "circle-12");
});

test("drawCircle refuses what makes no sense, each with its own message, and never changes its input (22b)", () => {
  const { doc, sketch } = lSketch();
  const before = structuredClone(doc);
  for (const bad of [0, -0, -2, Number.NaN, Infinity, -Infinity])
    assert.throws(() => drawCircle(doc, sketch, [0, 0], bad), new RegExp(`^Error: a circle needs a radius in mm above 0, not ${String(bad).replace("-0", "0")}$`));
  assert.throws(() => drawCircle(doc, sketch, "point-99", 1), /^Error: sketch sketch-2 has no point point-99$/);
  assert.throws(() => drawCircle(doc, sketch, [Number.NaN, 0], 1), /^Error: a sketch point needs x and y in mm, not NaN, 0$/);
  assert.throws(() => drawCircle(doc, "sketch-9", [0, 0], 1), /^Error: there is no sketch sketch-9 in the design$/);
  // The smallest positive radius is the kernel's to refuse (MIN_FEATURE), not the data's.
  assert.equal(drawCircle(doc, sketch, [0, 0], Number.MIN_VALUE).doc.sketches[0].curves.at(-1)!.kind, "circle");
  drawCircle(doc, sketch, "point-4", 5);
  assert.deepEqual(doc, before);
});

test("a project with circles saves and opens byte-identical, and a broken circle is refused with its message (22b)", () => {
  const { doc } = circled();
  const text = projectToJson({ ...emptyProject("Circled"), workspaces: { design: doc } });
  const opened = projectFromJson(text, DESIGN);
  assert.deepEqual(opened.workspaces.design, doc);
  assert.equal(projectToJson(opened), text);
  // Each case breaks one circle in exactly one way.
  type Loose = { centre?: unknown; radius?: unknown };
  const broken = (edit: (c: Loose, d: DesignDocument) => void) => {
    const d = structuredClone(doc);
    edit(d.sketches[0].curves[3] as Loose, d);
    return () => readDesignDocument(d);
  };
  assert.doesNotThrow(broken(() => {}));
  const cases: [(c: Loose, d: DesignDocument) => void, RegExp][] = [
    [(c) => (c.centre = "point-99"), /^Error: Design sketch sketch-2: circle circle-10 is round point-99, which is not one of the sketch's points$/],
    [(c) => delete c.centre, /circle circle-10 is round undefined, which is not one of the sketch's points$/],
    [(c) => (c.centre = { toString: 8 }), /circle circle-10 is round an object, which is not one of the sketch's points$/],
    [(c) => (c.radius = 0), /^Error: Design sketch sketch-2: circle circle-10 needs a radius in mm above 0, not 0$/],
    [(c) => (c.radius = -2.5), /circle circle-10 needs a radius in mm above 0, not -2.5$/],
    [(c) => (c.radius = "2.5"), /circle circle-10 needs a radius in mm above 0, not 2.5$/],
    [(c) => (c.radius = Infinity), /circle circle-10 needs a radius in mm above 0, not Infinity$/],
    [(c) => delete c.radius, /circle circle-10 needs a radius in mm above 0, not undefined$/],
    // The centre point gone from the points list: circle-9 names a point the sketch hasn't got.
    [(_, d) => (d.sketches[0].points = d.sketches[0].points.filter((p) => p.id !== "point-8")), /^Error: Design sketch sketch-2: circle circle-9 is round point-8, which is not one of the sketch's points$/],
    [(_, d) => (d.sketches[0].curves[2].id = "circle-10"), /^Error: Design id circle-10 is used twice$/],
    [(_, d) => (d.nextId = 10), /^Error: Design data's nextId 10 is not above circle-10, so a new id could repeat it$/],
  ];
  for (const [edit, message] of cases) assert.throws(broken(edit), message);
  // A circle round a point of another sketch is refused like a line ending there.
  const other = addSketch(doc);
  const elsewhere = drawCircle(other.doc, other.id, [1, 1], 1).doc;
  (elsewhere.sketches[1].curves[0] as Loose).centre = "point-8";
  assert.throws(() => readDesignDocument(elsewhere), /circle circle-13 is round point-8, which is not one of the sketch's points$/);
});

test("a file value whose own toString is broken is named by its kind, not run (found by fuzzing)", () => {
  // Before: String({ toString: 8 }) threw "Cannot convert object to primitive
  // value" and the file was refused with an engine message, not Design's.
  const evil = { toString: 8 };
  const doc = structuredClone(lSketch().doc);
  (doc.sketches[0].curves[1] as { end: unknown }).end = evil;
  assert.throws(() => readDesignDocument(doc), /^Error: Design sketch sketch-2: line line-7 ends at an object, which is not one of the sketch's points$/);
  assert.throws(() => readDesignDocument({ ...lSketch().doc, version: evil }), /^Error: Design data version an object is not one this Panoshape reads/);
  assert.throws(() => readDesignDocument({ ...lSketch().doc, nextId: [evil] }), /^Error: Design data's nextId a list is not a counting number$/);
  const slot = partDocument("slot", 40, 30, 20);
  slot.timeline.features[0].intent.parameters.profile = evil as never;
  assert.throws(() => readDesignDocument(slot), /its profile an object is missing$/);
});

/**
 * lSketch with a quarter arc from the L's corner point-4 (40, 0) to a new
 * point (0, 40) round the L's start point-3 (0, 0), and a line from there
 * back to point-3: with the first line, a pie slice.
 */
function pie() {
  const { doc, sketch } = lSketch();
  const doc2 = deleteCurve(doc, sketch, "line-7");
  const a = drawArc(doc2, sketch, "point-4", [0, 40], "point-3");
  const back = drawLine(a.doc, sketch, "point-8", "point-3");
  return { doc: back.doc, sketch, arc: a.id, line: back.id };
}

test("hand-worked: an arc sharing a line's end and a centre point, ids from the one counter (23a)", () => {
  // lSketch leaves the counter at 8; deleting line-7 drops point-6 (only it
  // used it) but never moves the counter back. The arc starts at point-4
  // and is round point-3 (both shared, no new ids); its new end (0, 40)
  // takes 8 and the arc 9. The closing line from point-8 to point-3 is
  // line-10, and the counter ends at 11.
  const { doc: l, sketch } = lSketch();
  const a = drawArc(deleteCurve(l, sketch, "line-7"), sketch, "point-4", [0, 40], "point-3");
  assert.equal(a.id, "arc-9");
  const back = drawLine(a.doc, sketch, "point-8", "point-3");
  assert.equal(back.id, "line-10");
  assert.equal(back.doc.nextId, 11);
  const s = back.doc.sketches[0];
  assert.deepEqual(s.points.map((p) => [p.id, p.x, p.y]), [["point-3", 0, 0], ["point-4", 40, 0], ["point-8", 0, 40]]);
  assert.deepEqual(s.curves, [
    { id: "line-5", kind: "line", start: "point-3", end: "point-4" },
    { id: "arc-9", kind: "arc", start: "point-4", end: "point-8", centre: "point-3" },
    { id: "line-10", kind: "line", start: "point-8", end: "point-3" },
  ]);
  // The kernel gets lines, circles and arcs apart, rebuilt from point ids.
  assert.deepEqual(sketchCurves(s), {
    lines: [{ a: [0, 0], b: [40, 0] }, { a: [0, 40], b: [0, 0] }],
    circles: [],
    arcs: [{ start: [40, 0], end: [0, 40], centre: [0, 0] }],
  });
  assert.equal(SKETCH_STEPS.arc, "Draw arc");
  // Every point new: ids in the order start, end, centre, then the arc.
  const fresh = addSketch(partDocument("box", 10, 10, 10));
  const b = drawArc(fresh.doc, fresh.id, [5, 0], [-5, 0], [0, 0]);
  assert.deepEqual(b.doc.sketches[0].points.map((p) => p.id), ["point-3", "point-4", "point-5"]);
  assert.deepEqual(b.doc.sketches[0].curves, [{ id: "arc-6", kind: "arc", start: "point-3", end: "point-4", centre: "point-5" }]);
});

test("deleting an arc keeps the points lines share and drops the ones only it used (23a)", () => {
  const { doc, sketch, arc } = pie();
  // The arc's start point-4 and centre point-3 are line ends; its end
  // point-8 is the closing line's start. All three stay.
  const gone = deleteCurve(doc, sketch, arc).sketches[0];
  assert.deepEqual(gone.points.map((p) => p.id), ["point-3", "point-4", "point-8"]);
  // On a sketch of the arc alone, all three of its points go with it.
  const fresh = addSketch(partDocument("box", 10, 10, 10));
  const b = drawArc(fresh.doc, fresh.id, [5, 0], [-5, 0], [0, 0]);
  assert.deepEqual(deleteCurve(b.doc, fresh.id, b.id).sketches[0], { id: fresh.id, points: [], curves: [], constraints: [] });
  // Deleting a line beside an arc keeps every point the arc uses, its
  // centre too, though no line touches that.
  const beside = drawLine(b.doc, fresh.id, [20, 0], [30, 0]);
  const kept = deleteCurve(beside.doc, fresh.id, beside.id).sketches[0];
  assert.deepEqual(kept.points.map((p) => p.id), ["point-3", "point-4", "point-5"]);
  assert.deepEqual(sketchCurves(kept).arcs, [{ start: [5, 0], end: [-5, 0], centre: [0, 0] }]);
  // Moving the centre moves the arc with it (curves name points).
  const moved = movePoint(doc, sketch, "point-3", 1, 1).sketches[0];
  assert.deepEqual(sketchCurves(moved).arcs, [{ start: [40, 0], end: [0, 40], centre: [1, 1] }]);
});

test("drawArc refuses what makes no sense, each with its own message (23a)", () => {
  const { doc, sketch } = lSketch();
  assert.throws(() => drawArc(doc, sketch, "point-3", "point-3", [5, 5]), /^Error: an arc can't start and end at the same point point-3$/);
  assert.throws(() => drawArc(doc, sketch, "point-3", "point-4", "point-4"), /^Error: an arc can't be round its own end point-4$/);
  assert.throws(() => drawArc(doc, sketch, "point-3", [9, 9], "point-3"), /^Error: an arc can't be round its own end point-3$/);
  assert.throws(() => drawArc(doc, sketch, "point-99", [9, 9], [0, 9]), /sketch-2 has no point point-99/);
  assert.throws(() => drawArc(doc, sketch, [Number.NaN, 0], [9, 9], [0, 9]), /a sketch point needs x and y in mm/);
  assert.throws(() => drawArc(doc, "sketch-77", [0, 0], [9, 9], [0, 9]), /there is no sketch sketch-77/);
});

test("a file with arcs saves and opens byte-identical, and a broken arc is refused when opened (23a)", () => {
  const { doc } = pie();
  const text = projectToJson({ ...emptyProject("Pie"), workspaces: { design: doc } });
  const opened = projectFromJson(text, DESIGN);
  assert.deepEqual(opened.workspaces.design, doc);
  assert.equal(projectToJson(opened), text);
  // Each case breaks the arc (curve 2) in exactly one way.
  const broken = (edit: (arc: Record<string, unknown>) => void) => {
    const d = structuredClone(doc);
    edit(d.sketches[0].curves[1] as unknown as Record<string, unknown>);
    return () => readDesignDocument(d);
  };
  assert.doesNotThrow(broken(() => {}));
  const cases: [(arc: Record<string, unknown>) => void, RegExp][] = [
    [(a) => (a.start = "point-99"), /^Error: Design sketch sketch-2: arc arc-9 starts at point-99, which is not one of the sketch's points$/],
    [(a) => (a.end = 4), /^Error: Design sketch sketch-2: arc arc-9 ends at 4, which is not one of the sketch's points$/],
    [(a) => delete a.centre, /^Error: Design sketch sketch-2: arc arc-9 is round undefined, which is not one of the sketch's points$/],
    [(a) => (a.end = "point-4"), /^Error: Design sketch sketch-2: arc arc-9 starts and ends at the same point$/],
    [(a) => (a.centre = "point-8"), /^Error: Design sketch sketch-2: arc arc-9 is round one of its own ends$/],
    [(a) => (a.centre = "point-4"), /^Error: Design sketch sketch-2: arc arc-9 is round one of its own ends$/],
  ];
  for (const [edit, message] of cases) assert.throws(broken(edit), message);
});

test("sketchOutline hands the kernel the arcs apart from the lines and circles (23a)", async () => {
  const { doc, sketch } = pie();
  const asked: unknown[][] = [];
  const kernel = { call: (async (...args: unknown[]) => (asked.push(args), { open: "x" })) } as unknown as KernelCalls;
  await assert.rejects(sketchOutline(kernel, doc, sketch), /^Error: Sketch 1 has no closed outline: x$/);
  assert.deepEqual(asked, [["sketch_outline", [{ a: [0, 0], b: [40, 0] }, { a: [0, 40], b: [0, 0] }], [], [{ start: [40, 0], end: [0, 40], centre: [0, 0] }]]]);
});
