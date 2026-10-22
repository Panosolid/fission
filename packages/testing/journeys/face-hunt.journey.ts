// The step-26 bug hunt's regressions (26g), each worked by hand, in the
// Design app as the shell runs it (design-app.ts) on the real kernel:
//   1. a sketch on a face moved by Edit feature, then lost by a shape
//      change, stays where it last was (Fusion's last place), not where it
//      was first drawn: the app settles every edit it records, as the
//      naming harness settles Design after every edit;
//   2. with nothing built after an extrude of a sketch, the size boxes
//      show a box's own sizes, never the extrude's distance as its height;
//   3. a sketch after the rollback marker is not drawn (the reference app
//      hides everything after it), so a face sketch never shows at a place
//      its face has left;
//   5. settling a sketch click or an edit holds no bodies of its own in the
//      kernel (the monkey's seed 8): the kernel never holds more bodies
//      than the design builds;
//   6. a size no file can hold (Infinity) is refused in the panel, as Edit
//      feature refuses it, not taken into a design that can't be saved.
// Run with `npm run journeys` after the app build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyProject, projectFromJson, projectToJson, type DisplayMesh } from "@fission/core";
import { addSketch, designWorkspace, drawRectangle, extrudeSketch, partDocument, type DesignDocument } from "@fission/design";
import { app } from "./design-app.ts";

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

/** A circle of radius 3 round (cx, cy) on a new sketch on the face `on` picks, finished. */
async function circleOnFace(a: App, on: (p: number[]) => boolean, cx: number, cy: number) {
  a.$("#create-sketch")!.click();
  await a.settle();
  await a.pick({ face: faceWhere(a.mesh()!, on) });
  await a.key("sketch-circle");
  await a.click(cx, cy);
  await a.click(cx + 3, cy);
  await a.finish();
}

/** The finished sketches drawn: each one's origin and whether drawn lost. */
const drawn = (a: App) => a.drawings().filter((d) => !d.editing).map((d) => ({ origin: [...d.plane.origin], lost: d.lost === true }));

/** Clicks the toolbar's shape button `label`. */
async function shape(a: App, label: string) {
  const b = [...a.window.document.querySelectorAll("button")].find((x) => x.textContent === label) as unknown as HTMLButtonElement;
  assert.ok(b, `a ${label} button`);
  b.click();
  await a.settle();
}

const reopen = (doc: DesignDocument) => projectFromJson(projectToJson({ ...emptyProject("Hunt"), workspaces: { design: doc } }), [designWorkspace]).workspaces.design as DesignDocument;

test("1. a face sketch moved by Edit feature and then lost by a shape change stays where it last was, in that change's one undo step", async () => {
  // A 40 × 30 × 20 box from the origin: its right face is the plane x = 40. A sketch drawn there takes
  // YZ's frame (rule 8: the origin plane most nearly parallel), its origin where the world's origin
  // meets the plane square on: (40, 0, 0).
  const a = await app(partDocument("box", 40, 30, 20));
  await circleOnFace(a, (p) => p[0] === 40, 15, 10);
  assert.deepEqual(drawn(a), [{ origin: [40, 0, 0], lost: false }]);
  // Edit feature: width 60, so the right face is x = 60 and the sketch goes with it, to (60, 0, 0).
  const [box, sketch] = a.doc().timeline.features.map((f) => f.id);
  assert.equal(await a.menu(box, "edit"), null);
  (a.$("#edit-width") as HTMLInputElement).value = "60";
  a.$("#feature-edit-ok")!.click();
  await a.settle();
  assert.deepEqual(drawn(a), [{ origin: [60, 0, 0], lost: false }]);
  // Cylinder: the box becomes a cylinder (bottom, top, side), so the "right" face is gone. The sketch
  // stays where it last was, x = 60 (Fusion's last place), not x = 40, where it was first drawn.
  await shape(a, "Cylinder");
  assert.deepEqual(drawn(a), [{ origin: [60, 0, 0], lost: true }]);
  const face = a.doc().sketches.find((s) => s.id === sketch)!.face!;
  assert.deepEqual(face.held, { origin: [60, 0, 0], xAxis: [0, 1, 0], normal: [1, 0, 0] });
  assert.deepEqual(face.frame.origin, [40, 0, 0], "the frame as drawn is kept");
  // One undo step: Undo puts the box back (the sketch found on it again, nothing held), Redo the cylinder.
  assert.equal(a.history.undoLabel(), "Change shape to Cylinder");
  await a.undo();
  assert.deepEqual(drawn(a), [{ origin: [60, 0, 0], lost: false }]);
  assert.equal(a.doc().sketches.find((s) => s.id === sketch)!.face!.held, undefined);
  await a.redo();
  assert.deepEqual(drawn(a), [{ origin: [60, 0, 0], lost: true }]);
  // Saved and opened: still there.
  const doc = reopen(a.doc());
  assert.ok(await a.close());
  const b = await app(doc);
  assert.deepEqual(drawn(b), [{ origin: [60, 0, 0], lost: true }]);
  // Back to a box: found again, at the box's right face (the cylinder's diameter, 60, is the new box's width: x = 60), nothing held.
  await shape(b, "Box");
  assert.deepEqual(drawn(b), [{ origin: [60, 0, 0], lost: false }]);
  assert.equal(b.doc().sketches.find((s) => s.id === sketch)!.face!.held, undefined, "a face found again holds nothing");
  assert.ok(await b.close());
});

test("1b. found again, moved, then lost again: it stays where it last was, not where it was held the first time", async () => {
  const a = await app(partDocument("box", 40, 30, 20));
  await circleOnFace(a, (p) => p[0] === 40, 15, 10);
  await shape(a, "Cylinder"); // lost at x = 40, held there
  assert.deepEqual(drawn(a), [{ origin: [40, 0, 0], lost: true }]);
  await shape(a, "Box"); // found again: the box 40 wide (the cylinder's diameter), x = 40
  assert.deepEqual(drawn(a), [{ origin: [40, 0, 0], lost: false }]);
  // The width typed in the panel: 55, so the right face is x = 55, and the sketch follows.
  const width = a.$("#width") as HTMLInputElement;
  width.value = "55";
  width.dispatchEvent(new a.window.Event("input") as unknown as Event);
  await a.settle();
  assert.deepEqual(drawn(a), [{ origin: [55, 0, 0], lost: false }]);
  await shape(a, "Sphere"); // no flat face at all: lost at x = 55, its last place, not 40, the first hold
  assert.deepEqual(drawn(a), [{ origin: [55, 0, 0], lost: true }]);
  assert.ok(await a.close());
});

test("2. with nothing built after an extrude of a sketch, the size boxes are a box's, not the extrude's distance", async () => {
  // A box, and a 20 × 10 rectangle extruded 10 beside it (the part, so the panel shows "Extrude by 10").
  const made = addSketch(partDocument("box", 40, 30, 20));
  const a = await app(extrudeSketch(drawRectangle(made.doc, made.id, [50, 0], [70, 10]).doc, made.id, 10).doc);
  const value = (k: string) => (a.$(`#${k}`) as HTMLInputElement).value;
  assert.equal(value("height"), "10");
  const [box, , extrude] = a.doc().timeline.features.map((f) => f.id);
  await a.menu(box, "suppress"); // the extrude is still the part
  assert.equal(value("height"), "10");
  await a.menu(extrude, "suppress"); // nothing builds
  assert.equal(a.$("#no-part")!.hidden, false);
  // The boxes are a new box's (40, 30, 20, a fresh design's), not 10, the extrude's distance, as its height.
  assert.deepEqual(["width", "depth", "height"].map(value), ["40", "30", "20"]);
  // A width typed adds that box: 5 × 30 × 20.
  const width = a.$("#width") as HTMLInputElement;
  width.value = "5";
  width.dispatchEvent(new a.window.Event("input") as unknown as Event);
  await a.settle();
  assert.deepEqual(a.doc().timeline.features.at(-1)!.intent.parameters, { width: 5, depth: 30, height: 20 });
  assert.ok(await a.close());
});

test("3. a sketch after the rollback marker is not drawn, so a face sketch never shows where its face was", async () => {
  // A sketch on the box's top (z = 20), the box then made 40 high: the sketch goes to z = 40.
  const a = await app(partDocument("box", 40, 30, 20));
  await circleOnFace(a, (p) => p[2] === 20, 15, 10);
  const [box] = a.doc().timeline.features.map((f) => f.id);
  assert.equal(await a.menu(box, "edit"), null);
  (a.$("#edit-height") as HTMLInputElement).value = "40";
  a.$("#feature-edit-ok")!.click();
  await a.settle();
  assert.deepEqual(drawn(a), [{ origin: [0, 0, 40], lost: false }]);
  // The marker on the box: the sketch is after it, so it isn't drawn (it was drawn at z = 20, inside the box).
  await a.menu(box, "marker");
  assert.deepEqual(drawn(a), []);
  // An XY sketch after the marker isn't drawn either; the marker at the end draws both again.
  await a.menu(box, "marker");
  const [, sketch] = a.doc().timeline.features.map((f) => f.id);
  await a.menu(sketch, "marker");
  assert.deepEqual(drawn(a), [{ origin: [0, 0, 40], lost: false }]);
  assert.ok(await a.close());
});

test("5. settling a click or an edit holds no bodies of its own: the kernel holds just the bodies the design builds", async () => {
  // The monkey's seed 8, shrunk: Create sketch, a face picked, then "Infinity" typed as the height. Each body the
  // design builds is held once (its BodyCache); settling a face sketch's edits built the box again on caches of its
  // own and kept it, so the kernel held a body the Bodies group didn't list.
  const a = await app(partDocument("box", 40, 30, 20));
  assert.equal(await a.bodies(), 1, "the box");
  // A circle on the top (z = 20): each click settles (the box placed again, to place the sketch). Still the box alone.
  a.$("#create-sketch")!.click();
  await a.settle();
  await a.pick({ face: faceWhere(a.mesh()!, (p) => p[2] === 20) });
  await a.key("sketch-circle");
  await a.click(15, 10);
  await a.click(18, 10);
  assert.equal(await a.bodies(), 1, "after a click on the face sketch");
  await a.finish();
  assert.equal(await a.bodies(), 1, "after Finish Sketch");
  // The height typed: 25 builds a box 25 high in place of the 20 one (settled against the 20 one): one body.
  const height = a.$("#height") as HTMLInputElement;
  height.value = "25";
  height.dispatchEvent(new a.window.Event("input") as unknown as Event);
  await a.settle();
  assert.equal(await a.bodies(), 1, "after a typed height");
  assert.deepEqual(drawn(a), [{ origin: [0, 0, 25], lost: false }], "the sketch went up with the top");
  // "Infinity" typed into the box: a browser's number box reads it as empty, so 0, which the kernel refuses (its words
  // shown): nothing builds, and the kernel holds nothing.
  height.value = "";
  height.dispatchEvent(new a.window.Event("input") as unknown as Event);
  await a.settle();
  assert.equal(a.error(), "height must be between 0.001 and 1000000 mm, got 0");
  assert.equal(await a.bodies(), 0, "after a size the kernel refuses");
  assert.ok(await a.close());
});

test("6. a size typed that no file can hold is refused, as Edit feature refuses it: the design keeps its sizes", async () => {
  // Where a box takes "Infinity" as typed (this DOM does; a browser's number box reads it as empty), the design took
  // it: its undo step couldn't be saved ("is Infinity, not a number a file can hold"), and nothing was built or said.
  const a = await app(partDocument("box", 40, 30, 20));
  const sizes = () => a.doc().timeline.features[0].intent.parameters;
  const undo = a.history.undoLabel();
  for (const [box, words] of [["height", "Type the height in mm."], ["width", "Type the width in mm."], ["depth", "Type the depth in mm."]] as const) {
    for (const typed of ["Infinity", "-Infinity", "1e999"]) {
      const input = a.$(`#${box}`) as HTMLInputElement;
      const was = input.value;
      input.value = typed;
      input.dispatchEvent(new a.window.Event("input") as unknown as Event);
      await a.settle();
      assert.equal(a.error(), words, `${typed} in ${box}`);
      assert.deepEqual(sizes(), { width: 40, depth: 30, height: 20 }, `${typed} in ${box}: the design keeps its sizes`);
      input.value = was;
    }
  }
  assert.equal(a.history.undoLabel(), undo, "no undo step");
  // A good size after: taken, and the refusal goes.
  const height = a.$("#height") as HTMLInputElement;
  height.value = "25";
  height.dispatchEvent(new a.window.Event("input") as unknown as Event);
  await a.settle();
  assert.deepEqual(sizes(), { width: 40, depth: 30, height: 25 });
  assert.equal(a.error(), "");
  assert.equal(await a.bodies(), 1);
  assert.ok(await a.close());
});
