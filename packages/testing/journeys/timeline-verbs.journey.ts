// Journey (step 25c1): Design's verbs and hand-overs on real timelines, on
// the real WASM kernel. Download STL takes any body shown and several at
// once (one file), Copy as SVG takes a sketch, and every body shown is an
// object other workspaces can link to. Hand-worked files first, then
// seeded timelines from Design's own edits (`timelineEdits`, the saved-file
// fuzzer's) checked against a model of what is shown written apart from
// Design (`buildModel`). Run with `npm run journeys` after the app build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ActionRegistry, emptyProject, outlineToSvg, RepresentationRegistry, type AnalysisOverlay, type KernelCalls, type Selected, type WorkspaceContext } from "@fission/core";
import {
  addSketch,
  askOutline,
  BodyCache,
  bodyReference,
  COPY_SVG,
  designLookup,
  designWorkspace,
  DOWNLOAD_STL,
  drawRectangle,
  extrudeSketch,
  isSketchItem,
  joinStl,
  partDocument,
  profileReference,
  rebuildTimeline,
  registerDesignActions,
  rowReference,
  shownBodyRefs,
  sketchCurves,
  sketchOutline,
  targetsOf,
  type DesignDocument,
  type Scene,
} from "@fission/design";
import { nodeKernel } from "../src/node-kernel.ts";
import { buildModel, timelineEdits } from "../src/project-fuzz.ts";
import { seeded } from "../src/index.ts";

const kernel = nodeKernel();

/** Volume of a binary STL: Σ (a · (b × c)) / 6 over its triangles. */
function stlVolume(bytes: Uint8Array): number {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = v.getUint32(80, true);
  let six = 0;
  for (let t = 0; t < n; t++) {
    const p = (k: number) => v.getFloat32(84 + 50 * t + 12 + 4 * k, true);
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = [0, 1, 2, 3, 4, 5, 6, 7, 8].map(p);
    six += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return six / 6;
}
const count = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(80, true);

/** Design's two verbs, the representation registry and a project holding `doc`, with what was saved and copied. */
function app(doc: DesignDocument) {
  const saved: { name: string; bytes: Uint8Array }[] = [];
  const copied: string[] = [];
  const actions = new ActionRegistry();
  registerDesignActions(actions, (bytes, name) => void saved.push({ name, bytes }), async (svg) => void copied.push(svg));
  const representations = new RepresentationRegistry();
  designWorkspace.registerRepresentations!(representations, kernel);
  const project = emptyProject("Verbs");
  project.workspaces.design = doc;
  const overlays: (AnalysisOverlay | string)[] = [];
  const viewport = { setOverlay: (o: AnalysisOverlay) => overlays.push(o), clearOverlay: (id: string) => overlays.push(`clear ${id}`) };
  const ctx = { project, kernel, representations, viewport } as unknown as WorkspaceContext;
  return { actions, ctx, saved, copied, overlays, run: (id: string, targets: Selected[]) => actions.get(id)!.run(targets, ctx) };
}

/** A 40 × 30 × 20 box and Sketch 1, a 40 × 30 rectangle from (0, 0), extruded 10 mm. */
function boxAndExtrude(): { doc: DesignDocument; sketch: string } {
  const s = addSketch(partDocument("box", 40, 30, 20));
  return { doc: extrudeSketch(drawRectangle(s.doc, s.id, [0, 0], [40, 30]).doc, s.id, 10).doc, sketch: s.id };
}

test("hand-worked: a box and an extruded rectangle download as one STL of 24 triangles holding 24000 + 12000 mm³", async () => {
  const { doc } = boxAndExtrude();
  const extrude = doc.timeline.features.at(-1)!.id;
  const a = app(doc);
  // The toolbar's STL: every body shown, Body 1 then Body 2.
  const bodies = shownBodyRefs(doc);
  assert.deepEqual(bodies.map((b) => b.id), ["body:feature-1", `body:${extrude}`]);
  assert.deepEqual(await a.run(DOWNLOAD_STL, bodies), { message: "", bad: false });
  assert.equal(a.saved.length, 1);
  const [file] = a.saved;
  assert.equal(file.name, "fission-2-bodies.stl");
  // Each body's six flat faces are two triangles each: 12 + 12 = 24, so
  // 80 + 4 + 50 · 24 = 1284 bytes. The volumes add, overlapping or not
  // (each triangle's signed tetrahedron is counted once): the box 40 · 30 ·
  // 20 = 24000, the extrude 40 · 30 · 10 = 12000, 36000 in all. Every corner
  // is a whole number of mm, exact in single precision.
  assert.equal(count(file.bytes), 24);
  assert.equal(file.bytes.length, 1284);
  assert.equal(stlVolume(file.bytes), 36000);
  assert.equal(new TextDecoder().decode(file.bytes.subarray(0, 23)), "Panosolid STL: 2 bodies");
  // The same as each body downloaded alone, joined: the triangles are the kernel's, unchanged.
  await a.run(DOWNLOAD_STL, [bodies[0]]);
  await a.run(DOWNLOAD_STL, [bodies[1]]);
  assert.deepEqual(a.saved.slice(1).map((s) => [s.name, count(s.bytes), stlVolume(s.bytes)]), [["fission-box.stl", 12, 24000], ["fission-extrude.stl", 12, 12000]]);
  assert.deepEqual([...file.bytes.subarray(84)], [...joinStl([a.saved[1].bytes, a.saved[2].bytes], "2 bodies").subarray(84)]);
});

test("hand-worked: Copy as SVG of the rectangle sketch, from its own row, on the kernel's outline", async () => {
  const { doc, sketch } = boxAndExtrude();
  const a = app(doc);
  // The sketch's Timeline row selects its outline, and that offers Copy as SVG.
  const ref = rowReference(sketch, doc)!;
  assert.deepEqual(ref, profileReference(sketch));
  assert.deepEqual(a.actions.actionsFor(targetsOf([ref], doc)).map((x) => x.label), ["Copy as SVG"]);
  assert.deepEqual(await a.run(COPY_SVG, [ref]), { message: "Copied as SVG: Sketch 1, 40 × 30 mm.", bad: false });
  // 40 mm wide and 30 tall; y flips for SVG, so the box is x 0 to 40, y −30 to 0.
  assert.match(a.copied[0], /width="40mm" height="30mm" viewBox="0 -30 40 30"/);
  assert.equal(a.copied[0], outlineToSvg(await sketchOutline(kernel, doc, sketch), "Sketch 1").text);
});

test("seeded: on random timelines, the verbs, the toolbar's STL, the copies and the links agree with a model of what is shown", async () => {
  const reached = { earlier: 0, notShown: 0, failed: 0, several: 0, closed: 0, open: 0, profile: 0 };
  for (let seed = 1n; seed <= 200n; seed++) {
    const r = seeded(seed);
    const doc = timelineEdits(r, partDocument("box", 40, 30, 20));
    const where = `seed ${seed}`;
    const cache = new BodyCache(kernel);
    const build = await rebuildTimeline(doc, cache, kernel as KernelCalls);
    await cache.close();
    const failed = new Set(Object.keys(build.results).filter((id) => build.results[id].status === "failed"));
    // The model: the solid items buildModel says build, less the kernel's failures, in timeline order.
    const building = new Set(buildModel(doc).building);
    const solids = doc.timeline.features.filter((f) => !isSketchItem(f));
    const shown = solids.filter((f) => building.has(f.id) && !failed.has(f.id)).map((f) => f.id);
    reached.earlier += shown.length > 1 ? 1 : 0;
    reached.several += shown.length > 2 ? 1 : 0;
    reached.notShown += solids.some((f) => !building.has(f.id)) ? 1 : 0;
    reached.failed += failed.size > 0 ? 1 : 0;
    const a = app(doc);
    const verbs = (refs: Selected[]) => a.actions.actionsFor(targetsOf(refs, doc, failed)).map((x) => x.label);
    for (const f of solids) assert.deepEqual(verbs([bodyReference(f.id)]), shown.includes(f.id) ? ["Download STL"] : [], `${where}: ${f.id}`);
    assert.deepEqual(shownBodyRefs(doc, failed).map((b) => b.id), shown.map((id) => `body:${id}`), where);
    // A scene of what was shown, for the links (they read only which features it holds).
    const scene = { bodies: shown.map((feature) => ({ feature })), faceStart: [], edgeStart: [] } as unknown as Scene;
    const lookup = designLookup(doc, scene, kernel as KernelCalls);
    for (const f of solids) assert.equal(lookup({ kind: "object", origin: { workspace: "design", id: f.id, label: f.id } }) !== null, shown.includes(f.id), `${where}: link to ${f.id}`);
    // The toolbar's STL: one file holding each shown body's own file's triangles, in order.
    if (shown.length > 0) {
      const all = await a.run(DOWNLOAD_STL, shownBodyRefs(doc, failed));
      assert.equal(all.bad, false, `${where}: ${all.message}`);
      const alone = [];
      for (const id of shown) {
        await a.run(DOWNLOAD_STL, [bodyReference(id)]);
        alone.push(a.saved.at(-1)!.bytes);
      }
      const joined = a.saved[0].bytes;
      assert.equal(a.saved[0].name, shown.length === 1 ? a.saved[1].name : `fission-${shown.length}-bodies.stl`, where);
      assert.equal(count(joined), alone.reduce((n, b) => n + count(b), 0), where);
      assert.deepEqual([...joined.subarray(84)], [...alone.flatMap((b) => [...b.subarray(84)])], where);
    }
    // Every profile and every sketch with curves offers Copy as SVG; it copies exactly when the kernel finds a closed outline.
    for (const p of doc.profiles) {
      reached.profile++;
      assert.deepEqual(verbs([profileReference(p.id)]), ["Copy as SVG"], `${where}: ${p.id}`);
    }
    for (const s of doc.sketches) {
      const ref = profileReference(s.id);
      if (s.curves.length === 0) {
        assert.deepEqual(verbs([ref]), [], `${where}: empty ${s.id}`);
        continue;
      }
      assert.deepEqual(verbs([ref]), ["Copy as SVG"], `${where}: ${s.id}`);
      // The kernel's own answer: closed, open (why), or the curves refused outright (an arc it can't take).
      const answer = await askOutline(kernel as KernelCalls, sketchCurves(s)).then((o) => ("closed" in o ? "closed" : "open"), (e: Error) => e.message);
      const copy = await a.run(COPY_SVG, [ref]);
      assert.equal(copy.bad, answer !== "closed", `${where}: ${s.id}: ${copy.message}`);
      if (answer === "open") assert.match(copy.message, /^Could not copy the sketch: Sketch \d+ has no closed outline: /, where);
      else if (answer !== "closed") assert.equal(copy.message, `Could not copy the sketch: ${answer}`, where);
      reached[answer === "closed" ? "closed" : "open"]++;
    }
  }
  // Every case was reached: an earlier body beside the part, three or more bodies, a body not shown, a failed one, closed and open sketches, profiles.
  for (const [what, n] of Object.entries(reached)) assert.ok(n > 0, `never reached: ${what} (${JSON.stringify(reached)})`);
});
