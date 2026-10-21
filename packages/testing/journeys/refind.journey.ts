// Journey: references re-found by name after an edit to an earlier item
// (step 25a4), in the real Design workspace on the real WASM kernel
// (design-app.ts), and a live link another workspace holds through Design's
// lookup. Every position is checked on what the viewport was asked to draw:
// the highlighted face's triangles and the highlighted edge's lines, worked
// out by hand from the sizes, never read from the names. Two faces sharing a
// name can't be made on the real kernel yet (every sketch curve gives one
// side; a face split in two comes with cuts, booleans 44/48), so that case
// is in Design's own tests (workspaces/design/test/refind*.ts) on views
// written out by hand. Run with `npm run journeys`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { linkTo, RepresentationRegistry, resolveLink, type DisplayMesh, type GeometryReference, type StableId } from "@fission/core";
import {
  addSketch,
  BodyCache,
  deleteCurve,
  designLookup,
  drawLine,
  drawRectangle,
  editFeature,
  extrudeSketch,
  insertPreset,
  isSketchItem,
  joinBodies,
  movePoint,
  designWorkspace,
  highlightOf,
  partDocument,
  readDesignReference,
  rebuildTimeline,
  referenceLabel,
  registerDesign,
  sceneHit,
  sceneReference,
  settleKept,
  shownBodies,
  type DesignDocument,
} from "@fission/design";
import { app, kernel } from "./design-app.ts";

/** Every corner of the triangles on joined face `face`. */
function faceCorners(mesh: DisplayMesh, face: number): number[][] {
  const out: number[][] = [];
  mesh.triangle_faces.forEach((f, t) => {
    if (f !== face) return;
    for (let k = 0; k < 3; k++) {
      const i = mesh.indices[3 * t + k];
      out.push([mesh.positions[3 * i], mesh.positions[3 * i + 1], mesh.positions[3 * i + 2]]);
    }
  });
  return out;
}

/** Every end of the lines drawn for joined edge `edge`. */
function edgeEnds(mesh: DisplayMesh, edge: number): number[][] {
  const out: number[][] = [];
  mesh.edge_line_edges.forEach((e, s) => {
    if (e === edge) out.push(mesh.edge_lines.slice(6 * s, 6 * s + 3), mesh.edge_lines.slice(6 * s + 3, 6 * s + 6));
  });
  return out;
}

const near = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));
const span = (pts: number[][], k: number) => [Math.min(...pts.map((p) => p[k])), Math.max(...pts.map((p) => p[k]))];

/** The one face the highlight lights whose corners all have coordinate `k` equal to `at`. */
function litFace(a: Awaited<ReturnType<typeof app>>, k: number, at: number): number[][] {
  const mesh = a.mesh()!;
  const hits = a
    .highlight()
    .faces.map((f) => faceCorners(mesh, f))
    .filter((c) => c.length > 0 && c.every((p) => near(p[k], at)));
  assert.equal(hits.length, 1, `one lit face lies at ${"xyz"[k]} = ${at}: ${JSON.stringify(a.highlight())}`);
  return hits[0];
}

const ref = (kind: "face" | "edge", feature: string, part: string) => ({ kind, id: `${kind}:${feature}/${part}` as StableId }) as GeometryReference;

/**
 * The box (feature-1, 10 × 10 × 10 from the origin), Sketch 1 with a 40 × 30
 * rectangle from (100, 0) to (140, 30) extruded by 20 (Extrude 1), then a
 * 4 × 5 × 6 box after it, so an item follows the edited one.
 */
function design() {
  const made = addSketch(partDocument("box", 10, 10, 10));
  const rect = drawRectangle(made.doc, made.id, [100, 0], [140, 30]);
  const ex = extrudeSketch(rect.doc, made.id, 20);
  // The rectangle's lines run (100,0)→(140,0)→(140,30)→(100,30)→(100,0): bottom, right, top, left.
  const [bottom, right, , left] = rect.ids;
  return { doc: insertPreset(ex.doc, "box", 4, 5, 6).doc, sketch: made.id, extrude: ex.id, bottom, right, left };
}

test("hand-worked: Edit feature on Extrude 1 (20 → 35): its top face, right side and the edge between follow their names; the box before it is untouched", async () => {
  const d = design();
  const a = await app(d.doc);
  const top = ref("face", d.extrude, "end");
  const side = ref("face", d.extrude, `side:${d.right}`);
  const rim = ref("edge", d.extrude, `end+side:${d.right}`);
  const boxTop = ref("face", "feature-1", "top");
  a.selection.set([top, side, rim, boxTop]);
  await a.settle();
  // Before: Extrude 1's top at z = 20 spanning x 100 to 140; its right side at x = 140, z 0 to 20; the box's top at z = 10.
  assert.deepEqual(span(litFace(a, 2, 20), 0), [100, 140]);
  assert.deepEqual(span(litFace(a, 0, 140), 2), [0, 20]);
  assert.deepEqual(span(litFace(a, 2, 10), 0), [0, 10]);
  // The edge between the top and the right side: the line x = 140, z = 20, from y = 0 to 30.
  assert.equal(a.highlight().edges.length, 1);
  const ends = edgeEnds(a.mesh()!, a.highlight().edges[0]);
  assert.ok(
    ends.every((p) => near(p[0], 140) && near(p[2], 20)),
    JSON.stringify(ends),
  );
  assert.deepEqual(span(ends, 1), [0, 30]);

  // Edit feature: Extrude 1's distance typed as 35, OK. One undo step; the selection is the same four names.
  assert.equal(await a.menu(d.extrude, "edit"), null);
  const box = a.$("#edit-height") as HTMLInputElement;
  box.value = "35";
  a.$("#feature-edit-ok")!.click();
  await a.settle();
  assert.equal(a.history.undoLabel(), "Edit Extrude 1");
  assert.deepEqual(a.selection.items, [top, side, rim, boxTop]);
  assert.equal(a.note(), "", "nothing was taken out");
  // After: the top at z = 35, the side up to 35, the edge at z = 35; the box's top still at z = 10.
  assert.deepEqual(span(litFace(a, 2, 35), 0), [100, 140]);
  assert.deepEqual(span(litFace(a, 0, 140), 2), [0, 35]);
  assert.deepEqual(span(litFace(a, 2, 10), 0), [0, 10]);
  const after = edgeEnds(a.mesh()!, a.highlight().edges[0]);
  assert.ok(
    after.every((p) => near(p[0], 140) && near(p[2], 35)),
    JSON.stringify(after),
  );
  // Undo: back to 20, the same names lit there.
  await a.undo();
  assert.deepEqual(span(litFace(a, 0, 140), 2), [0, 20]);
  assert.deepEqual(a.selection.items, [top, side, rim, boxTop]);
  assert.ok(await a.close(), "every body freed");
});

test("hand-worked: Edit Sketch draws a new left side on a ⊐ whose extrude kept its rectangle: the old left face is taken out with the note, the top follows to 60 wide", async () => {
  // Sketch 1's left side deleted and its right corners moved out to x = 160 (a ⊐ 60 wide, open): Extrude 1 keeps the 40 × 30 rectangle.
  const d = design();
  const sketch = d.doc.sketches.find((s) => s.id === d.sketch)!;
  const at = (x: number, y: number) => sketch.points.find((p) => p.x === x && p.y === y)!.id;
  const [r0, r1] = [at(140, 0), at(140, 30)];
  let doc = await settleKept(kernel, d.doc, deleteCurve(d.doc, d.sketch, d.left));
  doc = await settleKept(kernel, doc, movePoint(movePoint(doc, d.sketch, r0, 160, 0), d.sketch, r1, 160, 30));
  const a = await app(doc);
  assert.match(a.warning() ?? "", /^Extrude 1 keeps its last shape/);
  // The kept shape still names its sides by the curves it was built from, the deleted left line among them.
  const top = ref("face", d.extrude, "end");
  const oldLeft = ref("face", d.extrude, `side:${d.left}`);
  const bottomSide = ref("face", d.extrude, `side:${d.bottom}`);
  a.selection.set([top, oldLeft, bottomSide]);
  await a.settle();
  assert.deepEqual(span(litFace(a, 0, 100), 2), [0, 20], "the kept left side at x = 100");
  assert.deepEqual(span(litFace(a, 2, 20), 0), [100, 140]);

  // Edit Sketch, the left side drawn again from (100, 30) to (100, 0) (a new line, a new id), Finish Sketch.
  assert.equal(await a.menu(d.sketch, "edit-sketch"), null);
  await a.click(100, 30);
  await a.click(100, 0);
  await a.finish();
  assert.equal(a.warning(), null);
  // The old left face's curve is gone from the body: taken out, with the note; the top and the bottom side follow, 60 wide now.
  assert.deepEqual(a.selection.items, [top, bottomSide]);
  assert.equal(a.note(), `Taken out of the selection: Side of ${d.left} face. The edit took them off the body, so they could not be followed.`);
  assert.doesNotMatch(a.note(), /more than one/);
  assert.deepEqual(span(litFace(a, 2, 20), 0), [100, 160]);
  assert.deepEqual(span(litFace(a, 1, 0), 0), [100, 160], "the bottom side, y = 0, from x = 100 to 160");
  assert.ok(await a.close(), "every body freed");
});

test("hand-worked: a link another workspace holds to Extrude 1's top face follows Edit feature, and warns once its sketch's side is gone", async () => {
  const d = design();
  const cache = new BodyCache(kernel);
  const registry = new RepresentationRegistry();
  registerDesign(registry, kernel);
  const lookupOf = async (doc: DesignDocument) => designLookup(doc, joinBodies(await shownBodies(doc, await rebuildTimeline(doc, cache, kernel), cache)), kernel);
  const topLink = linkTo("load-1", { kind: "geometry", origin: { workspace: "design", id: d.extrude, label: "Top of Extrude 1" }, ref: ref("face", d.extrude, "end") }, ["solid"]);
  const sideLink = linkTo("load-2", { kind: "geometry", origin: { workspace: "design", id: d.extrude, label: "Right of Extrude 1" }, ref: ref("face", d.extrude, `side:${d.right}`) }, ["solid"]);
  // Delivered as the exact solid its face is on: Extrude 1, the 40 × 30 rectangle by 20.
  const solid = async (doc: DesignDocument) => {
    const s = resolveLink(topLink, await lookupOf(doc));
    assert.equal(s.state, "live");
    const rep = (await registry.deliver((s as { object: never }).object, ["solid"])).representation as { spec: { extrude: { distance: number } } };
    return rep.spec.extrude.distance;
  };
  assert.equal(await solid(d.doc), 20);
  // Edit feature, 20 → 35: the same link, now the 35 mm solid.
  const edited = editFeature(d.doc, d.extrude, { height: 35 });
  assert.equal(await solid(edited), 35);
  assert.equal(resolveLink(sideLink, await lookupOf(edited)).state, "live");
  // The right side deleted and drawn again (a new id): the closed outline builds, the top link still live, the side link warns.
  const gone = deleteCurve(edited, d.sketch, d.right);
  const sketch = gone.sketches.find((s) => s.id === d.sketch)!;
  const p = (x: number, y: number) => sketch.points.find((q) => q.x === x && q.y === y)!.id;
  const redrawn = await settleKept(kernel, edited, drawLine(gone, d.sketch, p(140, 0), p(140, 30)).doc);
  assert.equal(await solid(redrawn), 35);
  assert.deepEqual(resolveLink(sideLink, await lookupOf(redrawn)), {
    state: "unresolved",
    warning: "Linked to Right of Extrude 1 in Design, which can't be found after the last edit. Pick a new source or break the link to keep the last copy.",
  });
  await cache.clear();
});

// ---------------------------------------------------------------- seeded

const SEEDS = Number(process.env.FISSION_SESSIONS ?? 8);
const STEPS = Number(process.env.FISSION_SESSION_STEPS ?? 40);

/** Mulberry32, so a failing session replays from its seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The start of every session: the box, two extruded rectangles and a box after them. */
function sessionDesign() {
  let doc = partDocument("box", 40, 30, 20);
  for (const [x0, w, h, dist] of [
    [100, 40, 30, 20],
    [200, 30, 20, 10],
  ]) {
    const made = addSketch(doc);
    doc = extrudeSketch(drawRectangle(made.doc, made.id, [x0, 0], [x0 + w, h]).doc, made.id, dist).doc;
  }
  return insertPreset(doc, "box", 4, 5, 6).doc;
}

/**
 * One session in the real workspace: random picks of faces, edges and
 * bodies (from the bodies a rebuild of the document shows, built apart
 * from the app's), Edit feature with random sizes, Edit Sketch with a
 * random line, the part's shape from the toolbar, Undo, Redo, suppress,
 * the marker and deletes; after every step the selection is checked against
 * that independent scene: a face or edge kept is on its body under its name,
 * one dropped is not (and the note names it), the highlight is exactly the
 * kept faces and edges (and the selected bodies' faces), one row per item,
 * and the note never says two faces share a name (it can't happen on the
 * real kernel yet). Returns the first failure, or null.
 */
/** What the sessions reached, so the test can say every kind of step and outcome came up. */
const REACHED: Record<string, number> = {};
const reach = (k: string) => void (REACHED[k] = (REACHED[k] ?? 0) + 1);

async function refindSession(seed: number, steps: number, plugin = designWorkspace): Promise<string | null> {
  const r = mulberry32(seed);
  const a = await app(sessionDesign(), plugin);
  const cache = new BodyCache(kernel);
  const sceneNow = async () => joinBodies(await shownBodies(a.doc(), await rebuildTimeline(a.doc(), cache, kernel), cache));
  const pickOf = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
  const fail = (step: number, what: string) => {
    // FISSION_FUZZ_OUT: the document and selection at the failure, written there, so it can be opened and looked at.
    if (process.env.FISSION_FUZZ_OUT)
      writeFileSync(`${process.env.FISSION_FUZZ_OUT}/refind-seed-${seed}.json`, JSON.stringify({ seed, step, what, selection: a.selection.items, doc: a.doc() }, null, 1));
    return `seed ${seed} step ${step}: ${what}`;
  };
  try {
    for (let step = 0; step < steps; step++) {
      const before = [...a.selection.items];
      const doc = a.doc();
      const solids = doc.timeline.features.filter((f) => !isSketchItem(f)).map((f) => f.id);
      const sketches = doc.sketches.map((s) => s.id);
      const roll = r();
      let picked = false;
      if (roll < 0.3) {
        const s = await sceneNow();
        const refs: GeometryReference[] = [];
        for (let k = 0, n = 1 + Math.floor(r() * 3); k < n && s.bodies.length > 0; k++) {
          const b = pickOf(s.bodies);
          const kind = r() < 0.6 ? "face" : r() < 0.85 ? "edge" : "body";
          if (kind === "body") refs.push({ kind: "body", id: `body:${b.feature}` as StableId });
          else {
            const part = pickOf((kind === "face" ? b.names.faces : b.names.edges).filter((x) => x !== null));
            if (part) refs.push(ref(kind, b.names.feature, part));
          }
        }
        a.selection.set(refs);
        await a.settle();
        picked = true;
        reach("pick");
      } else if (roll < 0.5 && solids.length > 0) {
        const id = pickOf(solids);
        if ((await a.menu(id, "edit")) === null) {
          for (const input of [...a.window.document.querySelectorAll("#feature-edit input")] as unknown as HTMLInputElement[])
            input.value = r() < 0.15 ? pickOf(["0", "-5", "", "abc"]) : String(1 + Math.floor(r() * 60));
          a.$("#feature-edit-ok")!.click();
          await a.settle();
          reach(a.$("#feature-edit")!.hidden ? "edit" : "edit-refused");
          if (!a.$("#feature-edit")!.hidden) {
            a.$("#feature-edit-cancel")!.click();
            await a.settle();
          }
        }
      } else if (roll < 0.6 && sketches.length > 0) {
        if ((await a.menu(pickOf(sketches), "edit-sketch")) === null) {
          // A line between two corners of the shapes, or a stray one: an edit that may leave the outline open.
          const corners = [100, 140, 200, 230].flatMap((x) => [0, 20, 30].map((y) => [x, y] as [number, number]));
          await a.click(...pickOf(corners));
          await a.click(...pickOf(corners));
          await a.finish();
          reach("edit-sketch");
        }
      } else if (roll < 0.7) {
        // The part's shape from the toolbar (the last preset): a box made a cylinder or a sphere takes faces off it.
        const button = a.$(`[data-shape="${pickOf(["box", "cylinder", "sphere"])}"]`);
        if (button && !(button as HTMLButtonElement).disabled) {
          button.click();
          await a.settle();
          reach("shape");
        }
      } else if (roll < 0.82) {
        if (a.history.canUndo()) reach("undo");
        await a.undo();
      } else if (roll < 0.92) {
        if (a.history.canRedo()) reach("redo");
        await a.redo();
      } else {
        const items = doc.timeline.features;
        if (items.length > 0) {
          const item = pickOf(items);
          const entry = pickOf([item.suppressed ? "unsuppress" : "suppress", "marker", "delete"]);
          if ((await a.menu(item.id, entry)) === null) {
            reach(entry);
            if (entry === "delete" && (a.$("#delete-ask") as HTMLDialogElement | null)?.open) {
              const go = r() < 0.7;
              a.$(go ? "#delete-ask-confirm" : "#delete-ask-cancel")!.click();
              await a.settle();
              reach(go ? "delete-asked-confirmed" : "delete-asked-cancelled");
            }
          }
        }
      }
      if (a.sketching()) await a.finish();

      // The checks, on a scene built apart from the app's.
      const s = await sceneNow();
      const now = a.selection.items;
      const onBody = (item: GeometryReference) => {
        const rd = readDesignReference(item);
        const b = rd ? s.bodies.find((x) => (rd.kind === "body" ? x.feature === rd.featureId : x.names.feature === rd.featureId)) : undefined;
        return { rd, b };
      };
      for (const item of now) {
        const { rd, b } = onBody(item);
        if (!rd || rd.kind === "body" || !b) continue;
        if (!(rd.kind === "face" ? b.names.faces : b.names.edges).includes(rd.part!)) return fail(step, `${item.id} kept, but its body has no ${rd.kind} of that name`);
      }
      if (!picked) {
        const gone = before.filter((x) => !now.some((y) => y.id === x.id));
        for (const item of gone) {
          const { rd, b } = onBody(item);
          if (rd && rd.kind !== "body" && b && (rd.kind === "face" ? b.names.faces : b.names.edges).includes(rd.part!)) return fail(step, `${item.id} taken out, but its body still has it`);
          if (!a.note().includes(referenceLabel(item))) return fail(step, `${item.id} taken out without the note naming it: ${JSON.stringify(a.note())}`);
        }
        if (now.some((x) => !before.some((y) => y.id === x.id))) return fail(step, "an edit added to the selection");
        if (gone.length > 0) reach("dropped");
        if (now.some((x) => x.kind !== "body" && before.some((y) => y.id === x.id)) && JSON.stringify(a.doc()) !== JSON.stringify(doc)) reach("kept-through-an-edit");
      }
      const want = highlightOf(now, s);
      const got = a.highlight();
      const sorted = (xs: readonly number[]) => [...xs].sort((p, q) => p - q);
      if (want.body !== got.body || JSON.stringify(sorted(want.faces)) !== JSON.stringify(sorted(got.faces)) || JSON.stringify(sorted(want.edges)) !== JSON.stringify(sorted(got.edges)))
        return fail(step, `the highlight ${JSON.stringify(got)} is not the selection's ${JSON.stringify(want)}`);
      // Every lit face or edge is one the selection names (or on a selected body), named back from the independent scene.
      for (const [kind, list] of [
        ["face", got.faces],
        ["edge", got.edges],
      ] as const)
        for (const i of list) {
          const named = sceneReference(kind, s, i);
          const body = `body:${s.bodies[sceneHit(s, kind, i)!.body].feature}`;
          if (!now.some((x) => (named !== null && x.id === named.id) || (kind === "face" && x.id === body)))
            return fail(step, `${kind} ${i} (${named?.id ?? "no name"}) lit, but nothing selected names it: ${now.map((x) => x.id).join(" ")}`);
        }
      if (a.window.document.querySelectorAll("#selection-list li").length !== now.length) return fail(step, "one row per selected item");
      if (/more than one/.test(a.note())) return fail(step, `a note says two faces share a name: ${a.note()}`);
    }
    await cache.clear();
    return (await a.close()) ? null : fail(steps, "a body was not freed");
  } catch (e) {
    await cache.clear();
    await a.close();
    return fail(-1, (e as Error).stack ?? String(e));
  }
}

test(`seeded: ${SEEDS} sessions × ${STEPS} steps of picks, Edit feature, Edit Sketch, Undo, Redo, suppress, the marker and deletes keep the selection on its faces by name`, async () => {
  for (let seed = 1; seed <= SEEDS; seed++) assert.equal(await refindSession(seed, STEPS), null);
  for (const k of ["pick", "edit", "edit-refused", "edit-sketch", "shape", "undo", "redo", "suppress", "marker", "delete", "dropped", "kept-through-an-edit"])
    assert.ok((REACHED[k] ?? 0) >= 3, `${k} reached ${REACHED[k] ?? 0} times: ${JSON.stringify(REACHED)}`);
});

const WORKSPACE = new URL("../../../workspaces/design/src/workspace.ts", import.meta.url);

/** Bugs planted in workspace.ts's wiring of the selection through a rebuild, each of which the seeded sessions must catch. */
const PLANTS = [
  { name: "dropped-kept", find: "        ctx.selection.set(kept);", replace: "        ctx.selection.set([...kept, ...dropped]);", caught: "its body has no" },
  { name: "note-hidden", find: "      note = droppedNote(dropped, shared, selectedSketches);", replace: '      note = "";', caught: "without the note naming it" },
  {
    name: "highlight-first-only",
    find: "    viewport.showSelection(highlightOf(items, lastScene));",
    replace: "    viewport.showSelection(highlightOf(items.slice(0, 1), lastScene));",
    caught: "the highlight",
  },
];

/** Design with `plant` made: a copy of workspace.ts beside it (so its imports resolve), loaded, then deleted. */
async function planted(plant: { name: string; find: string; replace: string }): Promise<typeof designWorkspace> {
  const text = readFileSync(WORKSPACE, "utf8");
  const at = text.indexOf(plant.find);
  assert.ok(at >= 0 && text.indexOf(plant.find, at + 1) < 0, `${plant.name}: the text to replace must be in workspace.ts exactly once`);
  const file = new URL(`workspace.planted-refind-${plant.name}.ts`, WORKSPACE);
  writeFileSync(file, text.slice(0, at) + plant.replace + text.slice(at + plant.find.length));
  try {
    return (await import(file.href)).designWorkspace;
  } finally {
    rmSync(file);
  }
}

test("each bug planted in workspace.ts's selection wiring is caught by the seeded sessions, by the check that should catch it", async () => {
  const clean = await planted({ name: "none", find: "let fits = 0;", replace: "let fits = 0;" });
  for (let seed = 1; seed <= 2; seed++) assert.equal(await refindSession(seed, STEPS, clean), null);
  for (const plant of PLANTS) {
    const design = await planted(plant);
    let caught: string | null = null;
    for (let seed = 1; seed <= SEEDS && caught === null; seed++) caught = await refindSession(seed, STEPS, design);
    assert.ok(caught !== null, `${plant.name} was not caught by ${SEEDS} sessions`);
    assert.ok(caught.includes(plant.caught), `${plant.name} was caught by another check: ${caught}`);
  }
});
