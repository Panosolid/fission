// Step 25c1: Design's verbs (X1, X6b) and hand-overs on a real timeline,
// not one preset part: Download STL on any body shown and on several at
// once, Copy as SVG of a sketch, every body shown handed to other
// workspaces. The kernel's own answers are checked in
// packages/testing/journeys/timeline-verbs.journey.ts; here the kernel is a
// fake that records what it was asked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ActionRegistry, emptyProject, RepresentationRegistry, type AnalysisOverlay, type KernelCalls, type Selected, type StlFile, type WorkspaceContext } from "@fission/core";
import { COPY_SVG, DOWNLOAD_STL, joinStl, registerDesignActions, representationsOf, shownBodyRefs, STL_OVERLAY, targetsOf, warnedMarks, type DesignRun } from "../src/actions.ts";
import { rowReference } from "../src/browser.ts";
import { addSketch, drawLine, drawRectangle } from "../src/sketch.ts";
import { extrudeSketch } from "../src/extrude.ts";
import { insertPreset, partDocument, specOf, type DesignDocument } from "../src/document.ts";
import { designLookup, designObjects, registerDesign } from "../src/representations.ts";
import { bodyReference, profileReference } from "../src/references.ts";
import { droppedNote, selectionRows, survivors } from "../src/selection.ts";
import { moveMarker, suppressItem } from "../src/timeline-edits.ts";
import type { Scene } from "../src/scene.ts";

/**
 * The timeline every test here reads, built by Design's own edits:
 *   feature-1   Box 40 × 30 × 20                Body 1
 *   sketch-2    Sketch 1: a 40 × 30 rectangle   (closed)
 *   feature-11  Extrude 1: Sketch 1 by 10       Body 2
 *   feature-12  Cylinder, suppressed            no body
 *   sketch-13   Sketch 2: one line              (open)
 *   feature-17  Slot 60 × 20 by 5 (profile-18)  Body 3, the marker on it
 *   feature-19  Sphere, after the marker        no body
 */
function timeline(): DesignDocument {
  let d = partDocument("box", 40, 30, 20);
  const s1 = addSketch(d);
  d = extrudeSketch(drawRectangle(s1.doc, s1.id, [0, 0], [40, 30]).doc, s1.id, 10).doc;
  const cylinder = insertPreset(d, "cylinder", 20, 20, 5);
  d = suppressItem(cylinder.doc, cylinder.id, true);
  const s2 = addSketch(d);
  d = drawLine(s2.doc, s2.id, [0, 0], [10, 0]).doc;
  const slot = insertPreset(d, "slot", 60, 20, 5);
  const sphere = insertPreset(slot.doc, "sphere", 10, 10, 10);
  return moveMarker(sphere.doc, slot.id);
}
const doc = timeline();
const body = (id: string): Selected => bodyReference(id);
const outline = (id: string): Selected => profileReference(id);

test("the timeline is the one the tests describe", () => {
  assert.deepEqual(
    doc.timeline.features.map((f) => `${f.id} ${f.provenance.self.label}${f.suppressed ? " (suppressed)" : ""}`),
    ["feature-1 Feature 1 (box)", "sketch-2 Sketch 1", "feature-11 Extrude 1", "feature-12 Feature 12 (cylinder) (suppressed)", "sketch-13 Sketch 2", "feature-17 Feature 17 (extrude)", "feature-19 Feature 19 (sphere)"],
  );
  assert.equal(doc.timeline.marker, "feature-17");
  assert.deepEqual(doc.profiles.map((p) => p.id), ["profile-18"]);
});

test("hand-worked: each body shown offers Download STL, each profile or sketch with curves Copy as SVG; the rest nothing", () => {
  const r = new ActionRegistry();
  registerDesignActions(r, () => assert.fail("nothing is saved"));
  const verbs = (refs: Selected[], failed?: ReadonlySet<string>) => r.actionsFor(targetsOf(refs, doc, failed)).map((a) => a.label);
  // Bodies 1 to 3: the box, Extrude 1 and the slot, before and at the marker, not suppressed.
  for (const id of ["feature-1", "feature-11", "feature-17"]) assert.deepEqual(verbs([body(id)]), ["Download STL"], id);
  // The suppressed cylinder, the sphere after the marker, a sketch's id and an id the design lacks: no body.
  for (const id of ["feature-12", "feature-19", "sketch-2", "feature-99"]) assert.deepEqual(verbs([body(id)]), [], id);
  // Several bodies at once: one file of them all.
  assert.deepEqual(verbs([body("feature-1"), body("feature-11"), body("feature-17")]), ["Download STL"]);
  // One body the design doesn't show spoils the lot: the verb is for every target or none.
  assert.deepEqual(verbs([body("feature-1"), body("feature-12")]), []);
  // A body the last rebuild failed is not shown, so it offers nothing either.
  assert.deepEqual(verbs([body("feature-11")], new Set(["feature-11"])), []);
  // Outlines: the slot's profile, Sketch 1 (closed) and Sketch 2 (open: the kernel says why when asked).
  for (const id of ["profile-18", "sketch-2", "sketch-13"]) assert.deepEqual(verbs([outline(id)]), ["Copy as SVG"], id);
  assert.deepEqual(representationsOf(outline("sketch-2"), doc), ["outline"]);
  // A sketch with no curves has nothing to copy; nor has a solid feature's id as an outline.
  const empty = addSketch(doc);
  assert.deepEqual(r.actionsFor(targetsOf([outline(empty.id)], empty.doc)), []);
  assert.deepEqual(verbs([outline("feature-1")]), []);
  // Copy as SVG takes one outline, never two.
  assert.deepEqual(verbs([outline("sketch-2"), outline("profile-18")]), []);
});

test("hand-worked: the toolbar's STL takes every body shown, in build order; none for a design with no body", () => {
  assert.deepEqual(shownBodyRefs(doc).map((b) => b.id), ["body:feature-1", "body:feature-11", "body:feature-17"]);
  assert.deepEqual(shownBodyRefs(doc, new Set(["feature-11"])).map((b) => b.id), ["body:feature-1", "body:feature-17"]);
  assert.deepEqual(shownBodyRefs(moveMarker(doc, "start")), []);
});

test("a sketch's Timeline row and its Sketches row select its outline; an empty sketch's rows select nothing", () => {
  assert.deepEqual(rowReference("sketch-2", doc), outline("sketch-2"));
  assert.deepEqual(rowReference("sketches/sketch-2", doc), outline("sketch-2"));
  assert.deepEqual(rowReference("sketches/sketch-13", doc), outline("sketch-13"));
  const empty = addSketch(doc);
  assert.equal(rowReference(empty.id, empty.doc), null);
  assert.equal(rowReference(`sketches/${empty.id}`, empty.doc), null);
  // Bodies and profiles as before; a solid feature that builds no body selects nothing.
  assert.deepEqual(rowReference("feature-11", doc), body("feature-11"));
  assert.deepEqual(rowReference("profile-18", doc), outline("profile-18"));
  assert.equal(rowReference("feature-12", doc), null);
  assert.equal(rowReference("sketches/feature-1", doc), null);
});

test("a selected sketch is named as the browser names it, kept while it has curves, and its loss said as a sketch's", () => {
  assert.deepEqual(selectionRows([outline("sketch-2"), outline("profile-18")], null, doc), [
    { name: "Sketch 1", type: "outline", id: "outline:sketch-2" },
    { name: "Slot with round ends profile", type: "outline", id: "outline:profile-18" },
  ]);
  const scene = { bodies: [], mesh: { positions: [], normals: [], indices: [], triangle_faces: [], edge_lines: [], edge_line_edges: [] }, faceStart: [], edgeStart: [] } as Scene;
  assert.deepEqual(survivors([outline("sketch-2"), outline("profile-18")], scene, ["profile-18"]), { kept: [outline("profile-18")], dropped: [outline("sketch-2")], shared: [] });
  assert.equal(droppedNote([outline("sketch-2")], [], new Set(["sketch-2"])), "Taken out of the selection: the sketch. The sketch is gone or has no curves now.");
  assert.equal(
    droppedNote([outline("sketch-2"), outline("profile-18")], [], new Set(["sketch-2"])),
    "Taken out of the selection: the sketch, the profile. The part has no profile now. The sketch is gone or has no curves now.",
  );
});

// ---- Download STL of one body and of several ----

/** A binary STL of `n` triangles, each 50 bytes of `fill + t`, under `name`'s header (as the kernel writes it: "Panosolid STL: <name>", spaces after). */
function stl(name: string, n: number, fill: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(84 + 50 * n).fill(0x20, 0, 80);
  bytes.set(new TextEncoder().encode(`Panosolid STL: ${name}`));
  new DataView(bytes.buffer).setUint32(80, n, true);
  for (let t = 0; t < n; t++) bytes.fill(fill + t, 84 + 50 * t, 84 + 50 * (t + 1));
  return bytes;
}

test("hand-worked: two STL files joined: one header, the counts summed, the triangles unchanged in order", () => {
  // A: 1 triangle (bytes 10); B: 2 triangles (bytes 20, then 21). Joined:
  // 80 + 4 + 50 · 3 = 234 bytes; the count at byte 80 is 1 + 2 = 3, little
  // endian (03 00 00 00); then A's triangle, then B's two.
  const joined = joinStl([stl("box", 1, 10), stl("extrude", 2, 20)], "2 bodies");
  assert.equal(joined.length, 234);
  assert.equal(new TextDecoder().decode(joined.subarray(0, 80)), "Panosolid STL: 2 bodies".padEnd(80, " "));
  assert.deepEqual([...joined.subarray(80, 84)], [3, 0, 0, 0]);
  assert.ok(joined.subarray(84, 134).every((b) => b === 10));
  assert.ok(joined.subarray(134, 184).every((b) => b === 20));
  assert.ok(joined.subarray(184, 234).every((b) => b === 21));
  // A file with no triangles adds nothing but is no error.
  assert.deepEqual([...joinStl([stl("a", 0, 0), stl("b", 1, 7)], "x").subarray(80, 84)], [1, 0, 0, 0]);
});

test("joinStl refuses a file whose length disagrees with its count, or too short for a header, and writes nothing", () => {
  const long = new Uint8Array(85);
  assert.throws(() => joinStl([stl("a", 1, 1), long], "x"), /^Error: STL file 2 is 85 bytes, which is not 84 \+ 50 for each of its triangles$/);
  assert.throws(() => joinStl([new Uint8Array(83)], "x"), /^Error: STL file 1 is 83 bytes/);
  // One byte short of its one triangle, and one byte over.
  assert.throws(() => joinStl([stl("a", 1, 1).subarray(0, 133)], "x"), /STL file 1 is 133 bytes/);
  const over = new Uint8Array(135);
  over.set(stl("a", 1, 1));
  assert.throws(() => joinStl([over], "x"), /STL file 1 is 135 bytes/);
  // A long name is cut at the header's 80 bytes, never spilling into the count.
  const named = joinStl([stl("a", 1, 1)], "n".repeat(100));
  assert.deepEqual([...named.subarray(80, 84)], [1, 0, 0, 0]);
});

/** The kernel's outline of a 40 × 30 rectangle from (0, 0). */
const RECTANGLE = { outer: { path: { corners: [0, 0, 40, 0, 40, 30, 0, 30], bulges: [0, 0, 0, 0] } }, holes: [] };

/** Design's Download STL with a kernel that answers export_stl with `file(name)`, recording what it was asked. */
function downloading(file: (name: string) => StlFile, scene?: Scene | null) {
  const saved: { name: string; bytes: number[] }[] = [];
  const r = new ActionRegistry();
  registerDesignActions(r, (bytes, name) => saved.push({ name, bytes: [...bytes] }));
  const calls: unknown[][] = [];
  const overlays: (AnalysisOverlay | string)[] = [];
  const project = emptyProject();
  project.workspaces.design = doc;
  const ctx = {
    project,
    scene,
    // Extrude 1's outline is asked of the kernel first: Sketch 1's 40 × 30 rectangle.
    kernel: { call: async (...args: unknown[]) => (args[0] === "sketch_outline" ? { closed: RECTANGLE } : (calls.push(args), file(args[2] as string))) },
    viewport: { setOverlay: (o: AnalysisOverlay) => overlays.push(o), clearOverlay: (id: string) => overlays.push(`clear ${id}`) },
  } as unknown as DesignRun;
  return { run: (targets: Selected[]) => r.get(DOWNLOAD_STL)!.run(targets, ctx as WorkspaceContext), saved, calls, overlays };
}

test("hand-worked: an earlier body downloads alone, as its own shape (Body 1 is not the part)", async () => {
  const d = downloading(() => ({ bytes: stl("box", 1, 5), rounding: 0, warning: null }));
  assert.deepEqual(await d.run([body("feature-1")]), { message: "", bad: false });
  // The box's own spec: feature-1's, not the part's (the slot, feature-17).
  assert.deepEqual(d.calls, [["export_stl", specOf(doc, doc.timeline.features[0]), "box"]]);
  assert.deepEqual(d.saved, [{ name: "fission-box.stl", bytes: [...stl("box", 1, 5)] }]);
});

test("hand-worked: two bodies picked slot first come out in build order, joined into one file", async () => {
  // The box answers 1 triangle of 30s, the slot's extrude 2 of 40, 41.
  const d = downloading((name) => ({ bytes: name === "box" ? stl(name, 1, 30) : stl(name, 2, 40), rounding: 0, warning: null }));
  assert.deepEqual(await d.run([body("feature-17"), body("feature-1")]), { message: "", bad: false });
  assert.deepEqual(d.calls.map((c) => c[2]), ["box", "slot"]);
  assert.equal(d.saved.length, 1);
  assert.equal(d.saved[0].name, "fission-2-bodies.stl");
  assert.deepEqual(d.saved[0].bytes, [...joinStl([stl("box", 1, 30), stl("slot", 2, 40)], "2 bodies")]);
  assert.deepEqual(d.overlays, [`clear ${STL_OVERLAY}`]);
});

/** Two bodies on screen: the box (6 faces from 0) and Extrude 1 (6 faces from 6); the slot failed. */
const twoShown = { bodies: [{ feature: "feature-1", view: { faces: 6 } }, { feature: "feature-11", view: { faces: 6 } }], faceStart: [0, 6] } as unknown as Scene;

test("hand-worked: the precision overlay marks only the faces of the bodies that warned", () => {
  // Extrude 1 is body 2 of 2, its faces joined 6 + 0 … 6 + 5 = 6 … 11.
  assert.deepEqual(warnedMarks(["feature-11"], twoShown), [6, 7, 8, 9, 10, 11].map((face) => ({ target: { face }, severity: "warning" })));
  assert.deepEqual(warnedMarks(["feature-1"], twoShown), [0, 1, 2, 3, 4, 5].map((face) => ({ target: { face }, severity: "warning" })));
  // Every body shown warned: the whole view, as one mark.
  assert.deepEqual(warnedMarks(["feature-1", "feature-11"], twoShown), [{ target: { body: true }, severity: "warning" }]);
  // No scene (a run from outside Design), or a body not on it: the whole view rather than a wrong face.
  assert.deepEqual(warnedMarks(["feature-11"], null), [{ target: { body: true }, severity: "warning" }]);
  assert.deepEqual(warnedMarks(["feature-17"], twoShown), [{ target: { body: true }, severity: "warning" }]);
});

test("a warning on one of two bodies names it by its row, marks it alone, and the file is still saved", async () => {
  const warning = "single-precision numbers: this part's corners move by up to 1.250e-2 mm";
  const d = downloading((name) => ({ bytes: stl(name, 1, 1), rounding: name === "extrude" ? 0.0125 : 0, warning: name === "extrude" ? warning : null }), twoShown);
  // Picked Extrude 1 first; the file is still in build order, and the message names its row.
  assert.deepEqual(await d.run([body("feature-11"), body("feature-1")]), { message: `Body 2: ${warning}`, bad: true });
  assert.equal(d.saved.length, 1, "the file is still saved: the warning says how far it is off");
  assert.deepEqual(d.saved[0].bytes, [...joinStl([stl("box", 1, 1), stl("extrude", 1, 1)], "2 bodies")]);
  // Only Extrude 1's six faces, 6 to 11, are marked.
  assert.deepEqual(d.overlays, [{ id: STL_OVERLAY, label: "Too big for an accurate STL", detail: warning, marks: warnedMarks(["feature-11"], twoShown) }]);
});

test("Design's own run refuses a body the scene does not show (the last rebuild failed it), before asking the kernel", async () => {
  const d = downloading(() => assert.fail("the kernel must not be asked"), twoShown);
  assert.deepEqual(await d.run([body("feature-17")]), { message: "body:feature-17 is not a body shown in the design, so there is nothing to download.", bad: true });
  assert.deepEqual(d.saved, []);
});

// ---- Every body shown, handed to other workspaces ----

test("every body shown is an object other workspaces can link to; the suppressed, rolled-back and failed are not", () => {
  const kernel = {} as KernelCalls;
  assert.deepEqual(
    designObjects(doc, kernel).map((o) => `${o.type} ${o.id}`),
    ["design.profile profile-18", "design.sketch sketch-2", "design.sketch sketch-13", "design.feature feature-1", "design.feature feature-11", "design.feature feature-17"],
  );
  const object = (id: string) => ({ kind: "object" as const, origin: { workspace: "design" as const, id, label: id } });
  // Before any rebuild (no scene) the document decides; after one, a body the scene lacks is gone.
  const before = designLookup(doc, null, kernel);
  assert.equal((before(object("feature-1")) as { id: string } | null)?.id, "feature-1");
  assert.equal(before(object("feature-12")), null);
  assert.equal(before(object("feature-19")), null);
  const after = designLookup(doc, twoShown, kernel);
  assert.equal((after(object("feature-11")) as { id: string } | null)?.id, "feature-11");
  assert.equal(after(object("feature-17")), null, "the slot failed in this rebuild, so a link to it warns");
  // A sketch is found by its id, scene or not.
  assert.equal((after(object("sketch-2")) as { type: string } | null)?.type, "design.sketch");
});

test("Copy as SVG of a sketch goes through the registry to the kernel; an open one's refusal says the kernel's why", async () => {
  // The kernel's sketch_outline: Sketch 1 closed (a 40 × 30 rectangle), Sketch 2 open.
  const kernel = {
    call: async (op: string, lines: unknown[]) => {
      assert.equal(op, "sketch_outline");
      return lines.length === 4 ? { closed: RECTANGLE } : { open: "the end at (10, 0) is not joined to another line or arc" };
    },
  } as unknown as KernelCalls;
  const representations = new RepresentationRegistry();
  registerDesign(representations, kernel);
  const copied: string[] = [];
  const r = new ActionRegistry();
  registerDesignActions(r, () => assert.fail("nothing is saved"), async (svg) => void copied.push(svg));
  const project = emptyProject();
  project.workspaces.design = doc;
  const ctx = { project, representations, kernel } as unknown as WorkspaceContext;
  const copy = (id: string) => r.get(COPY_SVG)!.run([outline(id)], ctx);
  assert.deepEqual(await copy("sketch-13"), { message: "Could not copy the sketch: Sketch 2 has no closed outline: the end at (10, 0) is not joined to another line or arc", bad: true });
  assert.deepEqual(copied, []);
  const done = await copy("sketch-2");
  if (done.bad) return assert.fail(done.message);
  // The rectangle (0,0) to (40,30): 40 × 30 mm, titled by the sketch's own name.
  assert.equal(done.message, "Copied as SVG: Sketch 1, 40 × 30 mm.");
  assert.match(copied[0], /width="40mm" height="30mm" viewBox="0 -30 40 30"/);
  assert.match(copied[0], /<title>Sketch 1<\/title>/);
});
