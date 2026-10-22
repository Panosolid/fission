// Step 27c on the real kernel: a sketch on any plane snaps onto the edges
// of every body before it and follows them (the naming model's rules 11
// and 13), in the Design app as the shell runs it (design-app.ts). A
// 40 × 30 × 20 box, then Sketch 1 on the ground plane (XY), which is not
// on the box's faces at all:
//   - seen straight down from above the ground, the box's bottom corner
//     (40, 30, 0), the middle of the upright over it (40, 30, 10) and the
//     top corner (40, 30, 20) are one point, (40, 30): the pointer near it
//     shows "edge endpoint 40,30", and a circle of radius 2 centred there is
//     pinned to the corner on the sketch's own plane, the bottom's, naming
//     the box's feature, in the one "Draw circle" step;
//   - extruded 5 as a new body (24000 + 20π mm³, a little under as drawn),
//     then the box made 60 wide: the circle and its cylinder go to (60, 30);
//   - the box suppressed greys the sketch and its extrude, naming the box
//     (Q3 through the pin); a drop of the sketch before the box, or the box
//     after it, is refused in words;
//   - the box deleted asks first, saying the sketch keeps its point; then
//     the circle stays at (60, 30) with "point lost", one undo step back;
//   - saved and opened, the same file and the same view.
// Then a sketch on the front plane (XZ) pinned to the box's front top
// corner, (40, 0, 20) seen from the front as (40, 20), follows the box made
// 35 tall to (40, 35); and a sketch before the box is offered nothing of
// it. Bugs planted in Design's code for these rules are in
// planted/model-faults.ts (NAMING_PLANTS, step 27c). Run with `npm run
// journeys` after the app build.

import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyProject, projectFromJson, projectToJson } from "@fission/core";
import type { KernelCalls } from "@fission/core";
import { addSketch, BodyCache, changePreset, designWorkspace, drawCircle, dropState, extrudeSketch, partDocument, pinNewPoints, rebuildTimeline, reorderItem, settleKept, type DesignDocument, type EdgeTarget } from "@fission/design";
import { app, close, kernel } from "./design-app.ts";

type App = Awaited<ReturnType<typeof app>>;

/** The snap shown on the sketch being edited ("" for none). */
const snapShown = (a: App) => a.drawings().find((d) => d.editing)?.editing?.snap?.label ?? "";
/** The circle's centre in sketch `id` and the sketch's pins. */
function circleOf(a: App, id: string) {
  const s = a.doc().sketches.find((x) => x.id === id)!;
  const c = s.curves.find((x) => x.kind === "circle");
  assert.ok(c && c.kind === "circle", `${id} has its circle`);
  const p = s.points.find((x) => x.id === c.centre)!;
  return { centre: [p.x, p.y], point: p.id, pins: s.pins };
}
/** Each bar item's flags, by id: s suppressed, g greyed, w warned, f failed. */
function bar(a: App): Record<string, string> {
  const out: Record<string, string> = {};
  for (const li of a.window.document.querySelectorAll<HTMLElement>(".timeline-bar-item[data-item]")) {
    const d = li.dataset;
    out[d.item!] = (d.suppressed ? "s" : "") + (d.greyed ? "g" : "") + (d.warned ? "w" : "") + (d.failed ? "f" : "");
  }
  return out;
}
/** Whether a cylinder of radius 2 from z 0 to 5 is drawn round `centre`: rim points 2 mm from it (the polygon inside the circle), at both ends, either side. */
function cylinderAbout(a: App, centre: [number, number]): boolean {
  // The cylinder's rim points are 2 mm from the centre (the polygon inside the circle: at most 2); the box has no point
  // that near the centre other than its own corner, which is the centre itself.
  const pos = a.mesh()!.positions;
  const rim: number[][] = [];
  for (let i = 0; i < pos.length; i += 3) {
    const d = Math.hypot(pos[i] - centre[0], pos[i + 1] - centre[1]);
    if (d > 1.9 && d <= 2 + 1e-9 && pos[i + 2] >= -1e-9 && pos[i + 2] <= 5 + 1e-9) rim.push([pos[i], pos[i + 1], pos[i + 2]]);
  }
  // A rim at the bottom and the top, all round: points on both, each side of the centre.
  return rim.some((p) => p[2] < 1e-9) && rim.some((p) => p[2] > 5 - 1e-9) && rim.some((p) => p[0] > centre[0] + 1.9) && rim.some((p) => p[0] < centre[0] - 1.9);
}
/** A cylinder of radius 2 and height 5 as the mesh draws it: π · 2² · 5 = 20π, less what the polygon inside its circle cuts off (under 1 %). */
const round = (v: number) => v > 0.99 * 20 * Math.PI && v <= 20 * Math.PI + 1e-6;

const BOTTOM = "back+bottom&back+right&bottom+right";
const LOST = "Sketch 1: a point snapped to an edge has lost that edge, so it stays where it was.";
const DESIGN = [designWorkspace];
const reopened = (doc: DesignDocument) => projectFromJson(projectToJson({ ...emptyProject("Body pins"), workspaces: { design: doc } }), DESIGN).workspaces.design as DesignDocument;

test("hand-worked: a sketch on the ground plane snaps onto the box's corner seen from below, follows it, and is greyed, refused, asked and held through that pin", async () => {
  const a = await app(partDocument("box", 40, 30, 20), designWorkspace);
  a.$("#create-sketch")!.click();
  await a.settle();
  await a.pick({ plane: "XY" });
  const [box, sketch] = a.doc().timeline.features.map((f) => f.id);
  await a.key("sketch-circle");
  // ---- The snap: 0.4 mm from (40, 30); three of the box's points land there, the ground's corner first. ----
  a.pointer("move", [39.6, 29.7]);
  await a.settle();
  assert.equal(snapShown(a), "edge endpoint 40,30");
  // The middle of the box's front bottom edge, (20, 0, 0) seen from above: (20, 0).
  a.pointer("move", [20.3, 0.2]);
  await a.settle();
  assert.equal(snapShown(a), "edge midpoint 20,0");
  await a.click(39.6, 29.7);
  await a.click(42, 30);
  assert.equal(a.history.undoLabel(), "Draw circle");
  let c = circleOf(a, sketch);
  assert.deepEqual(c.centre, [40, 30]);
  assert.deepEqual(c.pins, [{ point: c.point, kind: "endpoint", name: BOTTOM, feature: box }]);
  assert.deepEqual(a.doc().timeline.features[1].dependsOn, [box], "the sketch is built on the box now");
  a.$("#sketch-extrude")!.click();
  await a.settle();
  (a.$("#extrude-distance") as HTMLInputElement).value = "5";
  (a.$("#extrude-ok") as HTMLButtonElement).click();
  await a.settle();
  if (a.sketching()) await a.finish();
  const extrude = a.doc().timeline.features[2].id;
  // 40 · 30 · 20 = 24000 for the box, π · 2² · 5 = 20π for the cylinder (the bodies overlap: no boolean yet).
  const built = a.volume();
  assert.ok(round(built - 24000), `built: ${built} mm³`);
  assert.ok(cylinderAbout(a, [40, 30]), "the cylinder round (40, 30)");

  // ---- The box made 60 wide: the corner, the circle and its cylinder go to (60, 30), one undo step. ----
  assert.equal(await a.menu(box, "edit"), null);
  (a.$("#edit-width") as HTMLInputElement).value = "60";
  a.$("#feature-edit-ok")!.click();
  await a.settle();
  const edit = a.history.undoLabel();
  c = circleOf(a, sketch);
  assert.deepEqual(c.centre, [60, 30]);
  assert.deepEqual(c.pins, [{ point: c.point, kind: "endpoint", name: BOTTOM, feature: box }]);
  // 20 · 30 · 20 = 12000 more box; the same cylinder.
  assert.ok(close(a.volume() - built, 12000), `after: ${a.volume()} mm³`);
  assert.ok(cylinderAbout(a, [60, 30]), "the cylinder round (60, 30)");
  assert.equal(a.warning(), null);
  assert.equal(await a.undo(), edit);
  assert.deepEqual(circleOf(a, sketch).centre, [40, 30]);
  await a.redo();
  assert.deepEqual(circleOf(a, sketch).centre, [60, 30]);

  // ---- The box suppressed: the sketch and its extrude greyed through the pin, naming the box (Q3, rule 13). ----
  assert.equal(await a.menu(box, "suppress"), null);
  assert.deepEqual(bar(a), { [box]: "s", [sketch]: "g", [extrude]: "g" });
  assert.equal(a.$(`.timeline-bar-item[data-item="${sketch}"]`)!.title, `2. ${a.doc().timeline.features[1].intent.summary} (greyed: Feature 1 (box) is suppressed)`);
  assert.equal(a.volume(), 0, "nothing built");
  assert.equal(a.warning(), null, "no warning while greyed");
  assert.equal(await a.undo(), "Suppress Feature 1 (box)");
  assert.deepEqual(bar(a), { [box]: "", [sketch]: "", [extrude]: "" });

  // ---- Drops across the pin's link refused in words. ----
  assert.deepEqual(dropState(a.doc(), sketch, 0), { kind: "refused", message: "Sketch 1 can't go before Feature 1 (box): it is snapped to an edge of Feature 1 (box)" });
  assert.deepEqual(dropState(a.doc(), box, 2), { kind: "refused", message: "Feature 1 (box) can't go after Sketch 1: Sketch 1 is snapped to an edge of it" });

  // ---- Saved and opened: the same file, the same view. ----
  const doc = a.doc();
  assert.deepEqual(reopened(doc), doc);
  const was = a.volume();

  // ---- The box deleted: asked first; the circle held at (60, 30) with its point lost, one undo step. ----
  assert.equal(await a.menu(box, "delete"), null);
  assert.ok((a.$("#delete-ask") as HTMLDialogElement).open, "asked first");
  assert.equal(a.$("#delete-ask-words")!.textContent, "Sketch 1 is snapped to an edge of Feature 1 (box). If you delete it, Sketch 1 keeps its snapped points where they are and shows they are lost. Undo brings Feature 1 (box) back.");
  a.$("#delete-ask-confirm")!.click();
  await a.settle();
  assert.deepEqual(a.doc().timeline.features.map((f) => f.id), [sketch, extrude]);
  assert.deepEqual(circleOf(a, sketch).centre, [60, 30]);
  assert.equal(a.warning(), LOST);
  assert.deepEqual(bar(a), { [sketch]: "w", [extrude]: "" }, "the sketch warned; its extrude still builds from its outline");
  assert.ok(round(a.volume()), `the cylinder alone: ${a.volume()} mm³`);
  assert.ok(cylinderAbout(a, [60, 30]), "still round (60, 30)");
  assert.equal(await a.undo(), "Delete Feature 1 (box)");
  assert.ok(close(a.volume(), was));
  assert.equal(a.warning(), null);
  assert.ok(await a.close(), "every body freed");

  // Opened from the saved file: the same view.
  const b = await app(reopened(doc), designWorkspace);
  assert.ok(close(b.volume(), was), `opened: ${b.volume()} mm³`);
  assert.deepEqual(circleOf(b, sketch).centre, [60, 30]);
  assert.equal(b.history.undoLabel(), null, "opening is no undo step");
  assert.ok(await b.close(), "every body freed");
});

test("hand-worked: a sketch on the front plane pins the box's front top corner, (40, 0, 20) seen from the front as (40, 20), and follows the box made 35 tall", async () => {
  const a = await app(partDocument("box", 40, 30, 20), designWorkspace);
  a.$("#create-sketch")!.click();
  await a.settle();
  await a.pick({ plane: "XZ" });
  const [box, sketch] = a.doc().timeline.features.map((f) => f.id);
  await a.key("sketch-circle");
  // The XZ frame: x along the world's x, y = normal × x = (0, −1, 0) × (1, 0, 0) = (0, 0, 1), the world's z. The front
  // top corner (40, 0, 20) is on the plane and comes first; the back one (40, 30, 20), 30 behind it, lands on it too.
  a.pointer("move", [39.7, 20.2]);
  await a.settle();
  assert.equal(snapShown(a), "edge endpoint 40,20");
  await a.click(39.7, 20.2);
  await a.click(42, 20);
  const c = circleOf(a, sketch);
  assert.deepEqual(c.centre, [40, 20]);
  assert.deepEqual(c.pins, [{ point: c.point, kind: "endpoint", name: "front+right&front+top&right+top", feature: box }]);
  await a.finish();
  assert.equal(await a.menu(box, "edit"), null);
  (a.$("#edit-height") as HTMLInputElement).value = "35";
  a.$("#feature-edit-ok")!.click();
  await a.settle();
  assert.deepEqual(circleOf(a, sketch).centre, [40, 35], "up with the top");
  // Deeper (along the front plane's normal): the corner seen from the front doesn't move.
  assert.equal(await a.menu(box, "edit"), null);
  (a.$("#edit-depth") as HTMLInputElement).value = "50";
  a.$("#feature-edit-ok")!.click();
  await a.settle();
  assert.deepEqual(circleOf(a, sketch).centre, [40, 35]);
  assert.equal(a.warning(), null);
  assert.ok(await a.close(), "every body freed");
});

test("hand-worked: a sketch before the box is offered nothing of it; moved after the box, it is", async () => {
  const made = addSketch(partDocument("box", 40, 30, 20));
  const first = reorderItem(made.doc, made.id, 0);
  assert.ok("doc" in first);
  const a = await app(first.doc, designWorkspace);
  assert.equal(await a.menu(made.id, "edit-sketch"), null);
  await a.key("sketch-circle");
  a.pointer("move", [39.6, 29.7]);
  await a.settle();
  assert.equal(snapShown(a), "", "the box is after the sketch: nothing of it to snap to");
  await a.finish();
  // Dragged after the box (place 1): the corner is offered.
  const after = reorderItem(a.doc(), made.id, 1);
  assert.ok("doc" in after);
  assert.ok(await a.close());
  const b = await app(after.doc, designWorkspace);
  assert.equal(await b.menu(made.id, "edit-sketch"), null);
  await b.key("sketch-circle");
  b.pointer("move", [39.6, 29.7]);
  await b.settle();
  assert.equal(snapShown(b), "edge endpoint 40,30");
  await b.finish();
  assert.ok(await b.close());
});

/** Box 1 (40 × 30 × 20), Sketch 1 on XY with a circle of radius 2 pinned to its bottom back right corner (40, 30), extruded 5. */
function pinnedOnGround(): DesignDocument {
  const made = addSketch(partDocument("box", 40, 30, 20));
  const corner: EdgeTarget = { at: [40, 30], kind: "endpoint", name: BOTTOM, feature: "feature-1" };
  const doc = pinNewPoints(made.doc, drawCircle(made.doc, made.id, [40, 30], 2).doc, made.id, [corner]);
  return extrudeSketch(doc, made.id, 5).doc;
}

test("hand-worked: settling an edit follows a pin on a sketch on an origin plane, as the naming harness settles every edit", async () => {
  const before = pinnedOnGround();
  const after = changePreset(before, "feature-1", "box", 60, 30, 20);
  const settled = await settleKept(kernel, before, after);
  const s = settled.sketches[0];
  const centre = s.points.find((p) => p.id === (s.curves[0] as { centre: string }).centre)!;
  // The corner (60, 30, 0) seen from above: (60, 30).
  assert.deepEqual([centre.x, centre.y], [60, 30]);
  // Settled is settled: again, the same object.
  assert.equal(await settleKept(kernel, settled, settled), settled);
});

test("hand-worked: a rebuild asks the kernel once for each body: an extrude of a pinned sketch waits for its points to follow", async () => {
  // Box 1 made 60 wide with the circle still at (40, 30) (a file not settled): the rebuild takes the centre to (60, 30)
  // and builds the cylinder there. Asked ahead with the centre where the file has it, the kernel would build a cylinder
  // at (40, 30) no feature keeps, as well: 3 bodies built, not 2.
  const doc = changePreset(pinnedOnGround(), "feature-1", "box", 60, 30, 20);
  let built = 0;
  const counting: KernelCalls = { call: ((op: string, ...args: unknown[]) => ((op === "body_build" && built++), (kernel.call as (o: string, ...a: unknown[]) => unknown)(op, ...args))) as KernelCalls["call"] };
  const cache = new BodyCache(counting);
  try {
    const b = await rebuildTimeline(doc, cache, counting);
    const r = b.results[doc.timeline.features[1].id];
    assert.ok(r.status === "built" && r.pinned?.[0].at[0] === 60 && r.pinned[0].at[1] === 30, JSON.stringify(r));
    assert.equal(built, 2, "the box and the cylinder, once each");
  } finally {
    await cache.clear();
  }
});
