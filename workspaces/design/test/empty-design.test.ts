// Step 24f4: a design with no body (nothing built: the marker at the start,
// every solid suppressed, rolled back or deleted, or only sketches left) is
// a design like any other. It opens, saves and reopens as it is; the part
// is none (`partFeature`), so the panel says so and blanks the body's
// numbers, Download STL has nothing to offer, other workspaces see no
// solid, and what reads the part's view is told it changed; a size typed
// or a shape chosen adds a new body at the marker. Hand-worked here; the
// seeded sessions (packages/testing: history-fuzz, timeline-data, the
// timeline sessions, the project loader fuzzer) reach these states at
// random, and apps/fission/e2e/timeline.mjs checks them in the browser.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ChangeNotes, DependencyGraph, emptyProject, projectFromJson, projectToJson, type BodyView, type KernelCalls, type Selected, type WorkspaceContext } from "@fission/core";
import { builds, lastFeature, partDocument, partFeature, partOf, readDesignDocument, withPart, type DesignDocument } from "../src/document.ts";
import { addSketch, drawRectangle } from "../src/sketch.ts";
import { extrudeSketch, setExtrudeDistance } from "../src/extrude.ts";
import { deleteItem, moveMarker, suppressItem } from "../src/timeline-edits.ts";
import { DOWNLOAD_STL, NO_BODY_STL, partBody, registerDesignActions, representationsOf } from "../src/actions.ts";
import { ActionRegistry } from "@fission/core";
import { designObjects } from "../src/representations.ts";
import { PART_VIEW, syncGraph } from "../src/graph.ts";
import { NO_BODY_FEATURE, NO_PART, propertiesPanel } from "../src/properties.ts";

/** The box (feature-1), Sketch 1 (sketch-2: a 40 × 30 rectangle, points and lines 3 to 10) and Extrude 1 of it by 10 (feature-11); the counter at 12. */
function part(): DesignDocument {
  const s = addSketch(partDocument("box", 40, 30, 20));
  const rect = drawRectangle(s.doc, s.id, [0, 0], [40, 30]);
  return extrudeSketch(rect.doc, s.id, 10).doc;
}

/** The five ways a design builds nothing, each from part(). */
const EMPTY: [string, () => DesignDocument][] = [
  // Nothing is at or before the start.
  ["the marker at the start", () => moveMarker(part(), "start")],
  // Both solids off; Sketch 1 builds, but a sketch is no body.
  ["both solids suppressed", () => suppressItem(suppressItem(part(), "feature-1", true), "feature-11", true)],
  // The box off; Extrude 1 is on but its sketch is off, so it fails.
  ["the box and Sketch 1 suppressed", () => suppressItem(suppressItem(part(), "feature-1", true), "sketch-2", true)],
  // Extrude 1 and the box deleted: Sketch 1 alone.
  ["only Sketch 1 left", () => deleteItem(deleteItem(part(), "feature-11"), "feature-1")],
  // All three deleted, last first: an empty timeline.
  ["everything deleted", () => deleteItem(deleteItem(deleteItem(part(), "feature-11"), "sketch-2"), "feature-1")],
];

const reopen = (d: DesignDocument) => projectFromJson(projectToJson({ ...emptyProject("Empty"), workspaces: { design: d } }), [{ id: "design", readData: readDesignDocument }]).workspaces.design as DesignDocument;

test("hand-worked: each of the five ways to build nothing has no part, and opens, saves and reopens as it is", () => {
  // The design with everything built has Extrude 1 as its part (the last solid that builds).
  assert.equal(partFeature(part())?.id, "feature-11");
  for (const [name, make] of EMPTY) {
    const d = make();
    assert.equal(partFeature(d), null, name);
    assert.equal(partOf(d), null, name);
    assert.ok(!d.timeline.features.some((f) => f.intent.type !== "sketch" && builds(d, f)), `${name}: no solid builds`);
    assert.throws(() => lastFeature(d), /^Error: Design builds no body: every solid feature is suppressed, rolled back or deleted$/, name);
    // Opened as it is, and saved again byte for byte.
    const text = projectToJson({ ...emptyProject("Empty"), workspaces: { design: d } });
    assert.deepEqual(reopen(d), d, name);
    assert.equal(projectToJson({ ...emptyProject("Empty"), workspaces: { design: reopen(d) } }), text, name);
  }
  // Everything deleted leaves nothing behind but the counter: no profiles, sketches or kept shapes.
  const gone = EMPTY[4][1]();
  assert.deepEqual(gone, { ...part(), profiles: [], sketches: [], timeline: { features: [] } });
  assert.equal(gone.nextId, 12);
});

test("hand-worked: a box typed into a design with no body goes in at the marker, with the counter's next id, and is the part", () => {
  // Marker at the start: the new box (feature-12, the counter at 12) goes
  // in first, at place 0, and the marker moves onto it, so the box builds
  // and everything after it stays rolled back.
  const atStart = withPart(EMPTY[0][1](), "box", 50, 30, 20);
  assert.deepEqual(atStart.timeline.features.map((f) => f.id), ["feature-12", "feature-1", "sketch-2", "feature-11"]);
  assert.equal(atStart.timeline.marker, "feature-12");
  assert.equal(partFeature(atStart)?.id, "feature-12");
  assert.deepEqual(partOf(atStart), { shape: "box", sizes: { width: 50, depth: 30, height: 20 } });
  assert.equal(atStart.nextId, 13);
  // Both solids suppressed, no marker: the new box goes last, the others stay off.
  const off = withPart(EMPTY[1][1](), "cylinder", 10, 10, 5);
  assert.deepEqual(off.timeline.features.map((f) => [f.id, f.suppressed]), [["feature-1", true], ["sketch-2", false], ["feature-11", true], ["feature-12", false]]);
  assert.equal(partFeature(off)?.id, "feature-12");
  // Everything deleted: the box alone, feature-12 (ids are never reused, so not feature-1).
  const fromNothing = withPart(EMPTY[4][1](), "box", 40, 30, 20);
  assert.deepEqual(fromNothing.timeline.features.map((f) => f.id), ["feature-12"]);
  assert.equal(partFeature(fromNothing)?.id, "feature-12");
  // The extrude distance box has no part to change, and says so.
  assert.throws(() => setExtrudeDistance(EMPTY[0][1](), 15), /^Error: the design has no body to change the distance of$/);
});

const view: BodyView = {
  mesh: { positions: [], normals: [], indices: [], triangle_faces: [], edge_lines: [], edge_line_edges: [] },
  volume: 24000,
  area: 5200,
  vertices: 8,
  edges: 12,
  faces: 6,
  errors: [],
};

test("no body to download, and no solid for other workspaces: the sketch's outline still is", async () => {
  const d = EMPTY[1][1]();
  const body: Selected = { kind: "body", id: "body:feature-11" };
  assert.equal(partBody(d), null);
  assert.deepEqual(representationsOf(body, d), []);
  assert.equal(partBody(part())?.id, "body:feature-11");
  // Download STL asked for a body that is not shown: a bad outcome, never a call to the kernel.
  const r = new ActionRegistry();
  registerDesignActions(r, () => assert.fail("nothing is saved"));
  const project = emptyProject();
  project.workspaces.design = d;
  const ctx = { project, kernel: { call: () => assert.fail("no kernel call") }, viewport: {} } as unknown as WorkspaceContext;
  assert.deepEqual(await r.get(DOWNLOAD_STL)!.run([body], ctx), { message: "body:feature-11 is not a body shown in the design, so there is nothing to download.", bad: true });
  assert.equal(NO_BODY_STL, "There is no body to download: nothing in the timeline builds.");
  // Other workspaces see Sketch 1's outline, and no design.feature.
  const kernel = {} as KernelCalls;
  assert.deepEqual(designObjects(d, kernel).map((o) => o.type), ["design.sketch"]);
  // Both bodies shown are offered (25c1): the box (feature-1) and Extrude 1 (feature-11), in build order.
  assert.deepEqual(designObjects(part(), kernel).map((o) => `${o.type} ${o.id}`), ["design.sketch sketch-2", "design.feature feature-1", "design.feature feature-11"]);
});

test("hand-worked: the part's view reads nothing once no body builds, and a result reading it is told the marker moved", () => {
  const g = new DependencyGraph();
  const notes = new ChangeNotes();
  const before = part();
  syncGraph(g, before, null, notes);
  g.set({ id: "stress", label: "Stress", workspace: "simulate", cost: "expensive" }, [PART_VIEW]);
  for (const id of g.stale()) g.markFresh(id);
  assert.deepEqual([...g.upstreamOf(PART_VIEW)].sort(), ["feature-11", "sketch-2"]);
  // The marker to the start changes no feature's own data (only the timeline's
  // marker), so Stress hears of it through the part: Extrude 1 then, none now.
  // The note names what the user did (25c2), not "the part".
  const after = moveMarker(before, "start");
  syncGraph(g, after, before, notes);
  assert.deepEqual([...g.upstreamOf(PART_VIEW)], []);
  assert.deepEqual(notes.current(g).map((n) => [n.node, n.state, n.text]), [["stress", "needs-rerun", "Stress out of date: you moved the timeline marker in Design. Rerun it in Simulate."]]);
});

test("the panel with no body: the feature says so, the numbers are blank, and the Parameters say how to add one", async () => {
  const { Window } = await import("happy-dom");
  const doc = new Window().document as unknown as Document;
  const slot = doc.createElement("aside");
  doc.body.append(slot);
  const p = propertiesPanel(slot);
  const $ = (id: string) => slot.querySelector<HTMLElement>(`#${id}`)!;
  // A body first, so blanking is seen to clear it.
  p.showFeature(part().timeline.features[2]);
  p.showBody({ ...view, errors: ["a gap"] }, "Body 2");
  assert.equal($("no-part").hidden, true);
  p.showFeature(null);
  p.showNoBody();
  assert.equal($("intent").textContent, NO_BODY_FEATURE);
  assert.equal($("provenance").textContent, "—");
  assert.equal($("no-part").hidden, false);
  assert.equal($("no-part").textContent, NO_PART);
  assert.equal($("body-heading").textContent, "Body");
  assert.deepEqual(["volume", "area", "topology", "status"].map((id) => $(id).textContent), ["—", "—", "—", "—"]);
  assert.equal($("status").className, "");
  assert.equal($("body-problems").hidden, true);
  // A body again: the note goes.
  p.showFeature(part().timeline.features[0]);
  assert.equal($("no-part").hidden, true);
});
