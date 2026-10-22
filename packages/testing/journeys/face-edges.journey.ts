// Step 26f on the real kernel: a sketch on a face snaps onto that face's
// edges and a point snapped there follows them (Fusion's answer Q4), in the
// Design app as the shell runs it (design-app.ts). A 40 × 30 × 20 box,
// Sketch 1 on its top:
//   - the pointer 0.4 mm from the back right corner (40, 30) shows "edge
//     endpoint 40,30", and near the right edge's middle "edge midpoint
//     40,15" (a pixel is 0.1 mm here, so the reach is 1 mm);
//   - a circle of radius 5 centred there is drawn with its centre exactly on
//     the corner and pinned to it, in the one "Draw circle" step;
//   - extruded 10 as a new body (24000 + 250π mm³, a little under as the
//     mesh draws it), then the box made 60 wide by Edit feature: the corner
//     is at (60, 30) and the circle and its cylinder go with it (12000 more),
//     one undo step back and forth;
//   - a file whose pin names an edge the box hasn't got opens with the
//     circle where it was and the sketch's row, bar item and the panel
//     warning that its point has lost its edge;
//   - a file saved with the circle's centre still at (40, 30) though the
//     box is 60 wide opens with it taken to (60, 30), no undo step;
//   - with only the box built, its width typed 6 then 60: the circle goes to
//     (60, 30) within the typing's one undo step.
// Then bugs planted in workspace.ts, each caught. Run with `npm run
// journeys` after the app build.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import type { DisplayMesh, WorkspacePlugin } from "@fission/core";
import { designWorkspace, partDocument, type DesignDocument } from "@fission/design";
import { app, close } from "./design-app.ts";

type App = Awaited<ReturnType<typeof app>>;

/** The one face of the mesh every point of which passes `on`, by kernel index. */
function faceWhere(mesh: DisplayMesh, on: (p: number[]) => boolean): number {
  const all = new Map<number, boolean>();
  mesh.triangle_faces.forEach((f, t) => {
    const ok = [0, 1, 2].every((k) => {
      const i = mesh.indices[3 * t + k];
      return on([mesh.positions[3 * i], mesh.positions[3 * i + 1], mesh.positions[3 * i + 2]]);
    });
    all.set(f, (all.get(f) ?? true) && ok);
  });
  const found = [...all].filter(([, ok]) => ok).map(([f]) => f);
  assert.equal(found.length, 1, `one face, got ${found}`);
  return found[0];
}

/** The snap shown on the sketch being edited ("" for none). */
const snapShown = (a: App) => a.drawings().find((d) => d.editing)?.editing?.snap?.label ?? "";
/** The circle's centre in Sketch 1 and the sketch's pins. */
function circleOf(a: App) {
  const s = a.doc().sketches[0];
  const c = s.curves.find((x) => x.kind === "circle");
  assert.ok(c && c.kind === "circle", "Sketch 1 has its circle");
  const p = s.points.find((x) => x.id === c.centre)!;
  return { centre: [p.x, p.y], point: p.id, pins: s.pins };
}
/** The mesh's points above z = 20.5 (the cylinder on the box): the middle of their extent along x and y, and its widths. */
function above(a: App): { middle: number[]; widths: number[] } {
  const pos = a.mesh()!.positions;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < pos.length; i += 3) if (pos[i + 2] > 20.5) (xs.push(pos[i]), ys.push(pos[i + 1]));
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  return { middle: [(x0 + x1) / 2, (y0 + y1) / 2], widths: [x1 - x0, y1 - y0] };
}
/** A cylinder of radius 5 round `centre`: the polygon drawn inside its circle is symmetric about its centre and a little under 10 wide. */
const roundAbout = (up: ReturnType<typeof above>, centre: number[]) => near(up.middle, centre) && up.widths.every((w) => w > 9.9 && w <= 10 + 1e-5);
/** A cylinder of radius 5 and height 10 as the mesh draws it: π · 5² · 10 = 250π, less what the polygon inside the circle cuts off (under 1 %). */
const round = (v: number) => v > 0.99 * 250 * Math.PI && v <= 250 * Math.PI;
const near = (got: number[], want: number[], tol = 1e-4) => got.every((g, k) => Math.abs(g - want[k]) <= tol);

const CORNER = "back+right&back+top&right+top";
const LOST = "Sketch 1: a point snapped to an edge has lost that edge, so it stays where it was.";

/** The whole journey on Design (or a planted copy); throws at the first thing that differs. Returns the document it ended with. */
async function journey(plugin: WorkspacePlugin): Promise<DesignDocument> {
  const a = await app(partDocument("box", 40, 30, 20), plugin);
  a.$("#create-sketch")!.click();
  await a.settle();
  await a.pick({ face: faceWhere(a.mesh()!, (p) => p[2] === 20) });
  await a.key("sketch-circle");
  // ---- The snap: 0.4 mm (4 px) from the corner, 0.36 mm from the right edge's middle; 1.5 mm off, nothing. ----
  a.pointer("move", [39.6, 29.7]);
  await a.settle();
  assert.equal(snapShown(a), "edge endpoint 40,30");
  a.pointer("move", [40.3, 15.2]);
  await a.settle();
  assert.equal(snapShown(a), "edge midpoint 40,15");
  a.pointer("move", [38.5, 29.7]);
  await a.settle();
  assert.equal(snapShown(a), "", "1.5 mm from the corner is out of reach");
  // ---- The circle: centre on the corner, exactly, pinned, in one step. ----
  await a.click(39.6, 29.7);
  await a.click(45, 30);
  assert.equal(a.history.undoLabel(), "Draw circle");
  let c = circleOf(a);
  assert.deepEqual(c.centre, [40, 30]);
  assert.deepEqual(c.pins, [{ point: c.point, kind: "endpoint", name: CORNER }]);
  // The face's edges are not drawn into the sketch: it has one curve, the circle.
  assert.equal(a.doc().sketches[0].curves.length, 1);
  a.$("#sketch-extrude")!.click();
  await a.settle();
  (a.$("#extrude-distance") as HTMLInputElement).value = "10";
  (a.$("#extrude-ok") as HTMLButtonElement).click();
  await a.settle();
  const [box] = a.doc().timeline.features.map((f) => f.id);
  // 40 · 30 · 20 + π · 5² · 10, the cylinder drawn as a polygon inside its circle, so a little under.
  const built = a.volume();
  assert.ok(round(built - 24000), `built: ${built} mm³`);
  let up = above(a);
  assert.ok(roundAbout(up, [40, 30]), `the cylinder round (40, 30): ${JSON.stringify(up)}`);

  // ---- The box made 60 wide: the corner, the circle and its cylinder move to (60, 30). ----
  assert.equal(await a.menu(box, "edit"), null);
  (a.$("#edit-width") as HTMLInputElement).value = "60";
  a.$("#feature-edit-ok")!.click();
  await a.settle();
  const label = a.history.undoLabel();
  c = circleOf(a);
  assert.deepEqual(c.centre, [60, 30]);
  assert.deepEqual(c.pins, [{ point: c.point, kind: "endpoint", name: CORNER }]);
  // 60 · 30 · 20 + the same cylinder: 20 · 30 · 20 = 12000 more.
  assert.ok(close(a.volume() - built, 12000), `after: ${a.volume()} mm³`);
  up = above(a);
  assert.ok(roundAbout(up, [60, 30]), `the cylinder round (60, 30): ${JSON.stringify(up)}`);
  assert.equal(a.warning(), null);
  // One undo step back, and forward again.
  assert.equal(await a.undo(), label);
  assert.deepEqual(circleOf(a).centre, [40, 30]);
  assert.ok(close(a.volume(), built));
  await a.redo();
  assert.deepEqual(circleOf(a).centre, [60, 30]);
  const doc = a.doc();
  assert.ok(await a.close(), "every body freed");
  return doc;
}

/** A file whose pin names a corner the box hasn't got: the circle stays where it is, and the sketch warns on its row, its bar item and the panel. */
async function lostPin(plugin: WorkspacePlugin, start: DesignDocument) {
  const doc: DesignDocument = { ...start, sketches: start.sketches.map((s) => (s.pins ? { ...s, pins: s.pins.map((p) => ({ ...p, name: "back+left&back+top&right+top" })) } : s)) };
  const a = await app(doc, plugin);
  const [, sketch, extrude] = a.doc().timeline.features.map((f) => f.id);
  assert.deepEqual(circleOf(a).centre, [60, 30]);
  assert.ok(round(a.volume() - 36000), `opened: ${a.volume()} mm³`);
  assert.equal(a.warning(), LOST);
  const row = a.$(`[data-node="timeline"] .tree-row[data-node="${sketch}"]`)!;
  assert.ok(row.classList.contains("kept") && row.title === LOST, `the sketch's row: ${row.className} "${row.title}"`);
  assert.ok(!a.$(`[data-node="timeline"] .tree-row[data-node="${extrude}"]`)!.classList.contains("kept"), "the extrude has no warning: its sketch still makes an outline");
  assert.equal(a.$(`.timeline-bar-item[data-item="${sketch}"]`)!.dataset.warned, "true");
  // Not drawn red: its plane is where it should be, only a point is held.
  assert.ok(!a.drawings().some((d) => d.lost), "nothing drawn as lost");
  assert.ok(await a.close(), "every body freed");
}

/**
 * A file saved with the circle's centre where it was snapped, (40, 30), but
 * the box 60 wide (its points not followed: a file from before the edit
 * settled, or written by hand): opened, the rebuild finds the corner at
 * (60, 30), so the centre is taken there, drawn and built there (the
 * cylinder round (60, 30)), with no warning, and opening is still no undo
 * step (hunt 26g: edits settle before they are drawn, so this is the case
 * the rebuild's taking in is left for).
 */
async function stale(plugin: WorkspacePlugin, end: DesignDocument) {
  const point = end.sketches[0].curves.find((x) => x.kind === "circle")!;
  const centre = (point as { centre: string }).centre;
  const doc: DesignDocument = { ...end, sketches: end.sketches.map((s, i) => (i === 0 ? { ...s, points: s.points.map((p) => (p.id === centre ? { ...p, x: 40, y: 30 } : p)) } : s)) };
  const a = await app(doc, plugin);
  assert.deepEqual(circleOf(a).centre, [60, 30], "the centre taken to the corner");
  const up = above(a);
  assert.ok(roundAbout(up, [60, 30]), `the cylinder round (60, 30): ${JSON.stringify(up)}`);
  assert.equal(a.warning(), null);
  assert.equal(a.history.undoLabel(), null, "opening is no undo step");
  assert.ok(await a.close(), "every body freed");
}

/**
 * The box's width typed, 6 then 60 (one step, as typing in a box is), with
 * a circle pinned to the top's back right corner and nothing extruded from
 * it (so the box is the part the panel edits): the circle follows to
 * (60, 30) inside that one step, and one undo puts the width and the
 * circle back.
 */
async function typed(plugin: WorkspacePlugin) {
  const a = await app(partDocument("box", 40, 30, 20), plugin);
  a.$("#create-sketch")!.click();
  await a.settle();
  await a.pick({ face: faceWhere(a.mesh()!, (p) => p[2] === 20) });
  await a.key("sketch-circle");
  await a.click(39.6, 29.7);
  await a.click(45, 30);
  await a.finish();
  const width = a.$("#width") as HTMLInputElement;
  for (const v of ["6", "60"]) {
    width.value = v;
    width.dispatchEvent(new a.window.Event("input") as unknown as Event);
    await a.settle();
  }
  assert.deepEqual(circleOf(a).centre, [60, 30]);
  assert.equal(await a.undo(), "Change width");
  assert.deepEqual(circleOf(a).centre, [40, 30], "one undo: the width and the circle back");
  assert.equal((a.$("#width") as HTMLInputElement).value, "40", "the box shown is 40 wide again");
  assert.equal(a.history.undoLabel(), "Draw circle", "the typing was one step");
  assert.ok(await a.close(), "every body freed");
}

test("hand-worked: the box's width typed with a circle pinned to its top's corner: the circle follows in the typing's one undo step", async () => {
  await typed(designWorkspace);
});

test("hand-worked: on a box's top the pointer snaps onto a corner and an edge's middle; a circle centred on the corner is pinned there and follows it when the box is made wider, one undo step each way", async () => {
  await journey(designWorkspace);
});

test("hand-worked: a file whose pin names a corner that isn't there opens with the circle held and its sketch warned on its row, bar item and the panel", async () => {
  await lostPin(designWorkspace, await journey(designWorkspace));
});

// ---- Bugs planted in workspace.ts, each caught ----

const WORKSPACE = new URL("../../../workspaces/design/src/workspace.ts", import.meta.url);

const PLANTS: { name: string; find: string; replace: string }[] = [
  // The face's edges never offered.
  { name: "no-edge-targets", find: "const edgeTargets = (id: string) => sketchEdgeTargets(designDoc(), id, lastScene, sketchPlane(designDoc(), id, placedNow));", replace: "const edgeTargets = (id: string) => sketchEdgeTargets(designDoc(), id, lastScene, sketchPlane(designDoc(), id, placedNow)).slice(0, 0);" },
  // A sketch just made on a face (not rebuilt since) offers no edges: the 26f bug this journey found, the targets looked only at the rebuild's placements.
  { name: "new-sketch-no-edges", find: "const edgeTargets = (id: string) => sketchEdgeTargets(designDoc(), id, lastScene, sketchPlane(designDoc(), id, placedNow));", replace: "const edgeTargets = (id: string) => sketchEdgeTargets(designDoc(), id, lastScene, placedNow.get(id));" },
  // A click snaps onto the edges but its point is never pinned.
  { name: "click-not-pinned", find: "      let next = pinNewPoints(before, done.doc, done.tool.sketch, edges);", replace: "      let next = done.doc;" },
  // The hover shows the edge's snap, but the click ignores it.
  { name: "click-ignores-edges", find: "      const snapped = snapOnSketch(designDoc(), mode.tool, at, rounded, pointer.pixel, edges).at;", replace: "      const snapped = snapOnSketch(designDoc(), mode.tool, at, rounded, pointer.pixel).at;" },
  // The settle runs on the click's document, dropping the pin made from it.
  { name: "settle-drops-pin", find: "          next = await settleKept(kernel, before, next, bodies);\n        } catch (e) {\n          return sketchBox.showError(e instanceof Error ? e.message : String(e));\n        }\n        // Undo, Escape", replace: "          next = await settleKept(kernel, before, done.doc, bodies);\n        } catch (e) {\n          return sketchBox.showError(e instanceof Error ? e.message : String(e));\n        }\n        // Undo, Escape" },
  // The rebuild's followed points never taken into the document: drawn, saved and held where they were snapped.
  { name: "followed-not-taken", find: "      if (value.followed !== doc && designDoc() === doc && !ctx.history.restoring()) takeIn(doc, value.followed);", replace: "      if (value.followed !== doc && designDoc() === doc && !ctx.history.restoring() && false) takeIn(doc, value.followed);" },
  // Taken in as a step of their own: one undo takes back only the point (an opened file gets an undo step).
  { name: "followed-own-step", find: "    ctx.history.amend(true);", replace: "    ctx.projectChanged(\"Follow\");" },
  // Taken in ending the merge: the typing in one box becomes a step per key.
  { name: "followed-splits-typing", find: "    ctx.history.amend(true);", replace: "    ctx.history.amend();" },
  // A sketch whose pinned point is held says nothing.
  { name: "points-silent", find: "      if (r.points) out.push(", replace: "      if (r.points && false) out.push(" },
];

/** Design with `plant` made: a copy of workspace.ts beside it (so its imports resolve), loaded, then deleted. */
async function planted(plant: { name: string; find: string; replace: string }): Promise<WorkspacePlugin> {
  const text = readFileSync(WORKSPACE, "utf8");
  const at = text.indexOf(plant.find);
  assert.ok(at >= 0 && text.indexOf(plant.find, at + 1) < 0, `${plant.name}: the text to replace must be in workspace.ts exactly once`);
  const file = new URL(`workspace.planted-edges-${plant.name}.ts`, WORKSPACE);
  writeFileSync(file, text.slice(0, at) + plant.replace + text.slice(at + plant.find.length));
  try {
    return (await import(file.href)).designWorkspace;
  } finally {
    rmSync(file);
  }
}

test("hand-worked: a file opened with a pinned point away from its corner takes it to the corner, drawn and built there, and opening is no undo step", async () => {
  await stale(designWorkspace, await journey(designWorkspace));
});

test("each bug planted in workspace.ts is caught by the journeys", async () => {
  // The copy unplanted passes, so a catch is the plant's and not the copying's.
  const unplanted = await planted({ name: "none", find: "let fits = 0;", replace: "let fits = 0;" });
  const end = await journey(unplanted);
  await lostPin(unplanted, end);
  await stale(unplanted, end);
  await typed(unplanted);
  for (const plant of PLANTS) {
    const design = await planted(plant);
    const caught = await journey(design)
      .then(async (doc) => (await lostPin(design, doc), await stale(design, doc)))
      .then(() => typed(design))
      .then(
        () => null,
        (e: Error) => e.message.split("\n")[0],
      );
    assert.ok(caught !== null, `${plant.name} was not caught`);
    if (process.env.FISSION_PLANTED_REPORT) console.log(`${plant.name}: ${caught}`);
  }
});
