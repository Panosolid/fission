// Step 26d on the real kernel: Create sketch in the Design app offers the
// three origin planes and the flat faces of the bodies shown; a face
// picked gets a sketch on it, looked at square on from outside the body
// (a back or bottom face from behind or below), drawn on with the same
// clicks and snaps as the ground plane, and extruded out of the body; a
// curved face is refused in words (Q5) and nothing is recorded. Faces are
// found by where the kernel's mesh puts them (every point of the top at
// z = 20), not by Design's numbering, and every body's corners are worked
// out by hand from the frame rule (docs/progress/cad.md, 26a's plan).

import { test } from "node:test";
import assert from "node:assert/strict";
import type { DisplayMesh } from "@fission/core";
import { CURVED_FACE, partDocument } from "@fission/design";
import { app, close } from "./design-app.ts";

type App = Awaited<ReturnType<typeof app>>;

/** The faces of a mesh every one of whose points passes `on`, by kernel index (joined numbering). */
function facesWhere(mesh: DisplayMesh, on: (p: number[]) => boolean): number[] {
  const all = new Map<number, boolean>();
  mesh.triangle_faces.forEach((f, t) => {
    const ok = [0, 1, 2].every((k) => {
      const i = mesh.indices[3 * t + k];
      return on([mesh.positions[3 * i], mesh.positions[3 * i + 1], mesh.positions[3 * i + 2]]);
    });
    all.set(f, (all.get(f) ?? true) && ok);
  });
  return [...all].filter(([, ok]) => ok).map(([f]) => f);
}

/** The one face of the mesh every point of which passes `on`. */
function faceWhere(a: App, on: (p: number[]) => boolean): number {
  const found = facesWhere(a.mesh()!, on);
  assert.equal(found.length, 1, `one face, got ${found}`);
  return found[0];
}

/** The mesh's points, as [x, y, z]. */
const points = (mesh: DisplayMesh) => Array.from({ length: mesh.positions.length / 3 }, (_, i) => [mesh.positions[3 * i], mesh.positions[3 * i + 1], mesh.positions[3 * i + 2]]);

/** Create sketch from the toolbar. */
async function createSketch(a: App) {
  a.$("#create-sketch")!.click();
  await a.settle();
}

/** A closed rectangle from (x0, y0) to (x1, y1) with the line tool, the last click a hair off the first corner (it snaps there and ends the chain). */
async function rectangle(a: App, [x0, y0]: number[], [x1, y1]: number[]) {
  for (const [x, y] of [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0 + 0.3, y0 - 0.2]]) await a.click(x, y);
}

/** The sketch just drawn extruded by `distance` from the sketch panel's Extrude. */
async function extrude(a: App, distance: number) {
  a.$("#sketch-extrude")!.click();
  await a.settle();
  (a.$("#extrude-distance") as HTMLInputElement).value = String(distance);
  (a.$("#extrude-ok") as HTMLButtonElement).click();
  await a.settle();
}

const near = (got: readonly number[], want: readonly number[], what: string) => assert.ok(got.every((v, i) => Math.abs(v - want[i]) < 1e-9), `${what}: [${got}] vs [${want}]`);

test("Create sketch offers the three origin planes and every face of the box, all flat", async () => {
  const a = await app(partDocument("box", 40, 30, 20));
  await createSketch(a);
  assert.deepEqual(a.planes().planes.map((p) => [p.id, p.offered]), [["XY", true], ["XZ", true], ["YZ", true]]);
  assert.deepEqual([...a.planes().faces].sort(), [0, 1, 2, 3, 4, 5]);
  // The panel's buttons are all on.
  for (const id of ["XY", "XZ", "YZ"]) assert.equal((a.$(`#sketch-plane-${id}`) as HTMLButtonElement).disabled, false, id);
  assert.match(a.$("#sketch-prompt")!.textContent!, /flat face/);
  assert.ok(await a.close(), "every body freed");
});

test("hand-worked: the box's top picked, a 20 × 20 square drawn and extruded 10 makes a block on top: z 20 to 30, 28000 mm³", async () => {
  const a = await app(partDocument("box", 40, 30, 20));
  await createSketch(a);
  await a.pick({ face: faceWhere(a, (p) => p[2] === 20) });
  assert.ok(a.sketching(), "the sketch is open");
  assert.deepEqual(a.planes().planes, [], "the planes go once a face is picked");
  const item = a.doc().timeline.features.at(-1)!;
  assert.equal(item.intent.parameters.plane, "face:feature-1/top");
  assert.equal(item.provenance.self.label, "Sketch 1");
  // Looked at square on from above: the ground plane's frame lifted to the top, z = 20.
  const look = a.looks().at(-1)!;
  near(look.plane.origin, [0, 0, 20], "origin");
  near(look.plane.normal, [0, 0, 1], "normal");
  near(look.plane.xAxis, [1, 0, 0], "x");
  assert.equal(look.side, 1);
  const edited = a.drawings().find((d) => d.editing)!;
  near(edited.plane.origin, [0, 0, 20], "drawn at the top");
  assert.equal(edited.side, undefined, "faces along its normal");
  await rectangle(a, [10, 5], [30, 25]);
  // The last click, 0.36 mm off (10, 5), snapped onto it (snaps reach 10 pixels of 0.1 mm): four lines round four shared points.
  const sketch = a.doc().sketches.at(-1)!;
  assert.equal(sketch.curves.length, 4);
  assert.deepEqual(sketch.points.map((p) => [p.x, p.y]), [[10, 5], [30, 5], [30, 25], [10, 25]]);
  await extrude(a, 10);
  // 40 · 30 · 20 = 24000 for the box, 20 · 20 · 10 = 4000 for the block.
  assert.ok(close(a.volume(), 28000), `${a.volume()} mm³`);
  const top = points(a.mesh()!).filter((p) => p[2] > 20 + 1e-9);
  assert.ok(top.length > 0 && top.every((p) => p[2] === 30 && [10, 30].includes(p[0]) && [5, 25].includes(p[1])), `the block's top corners: ${JSON.stringify(top.slice(0, 8))}`);
  assert.ok(await a.close(), "every body freed");
});

test("hand-worked: the bottom picked is looked at from below (side −1), drawn in the world's x and y, and extruded down out of the box", async () => {
  const a = await app(partDocument("box", 40, 30, 20));
  await createSketch(a);
  await a.pick({ face: faceWhere(a, (p) => p[2] === 0) });
  assert.equal(a.doc().timeline.features.at(-1)!.intent.parameters.plane, "face:feature-1/bottom");
  // The ground plane's frame, normal +Z into the box, faced against: the camera goes below (viewport/views.ts).
  const look = a.looks().at(-1)!;
  near(look.plane.origin, [0, 0, 0], "origin");
  near(look.plane.normal, [0, 0, 1], "normal");
  assert.equal(look.side, -1, "looked at from below, outside the box");
  assert.equal(a.drawings().find((d) => d.editing)!.side, -1);
  // The sketch panel's Look at turns the same way.
  a.$("#sketch-look-at")!.click();
  await a.settle();
  assert.equal(a.looks().at(-1)!.side, -1);
  await rectangle(a, [10, 5], [30, 25]);
  await extrude(a, 10);
  assert.ok(close(a.volume(), 28000), `${a.volume()} mm³`);
  // Out of the box, down: z 0 to −10, at the world's x 10..30 and y 5..25 (Q2: a face sketch's coordinates are the world's).
  const below = points(a.mesh()!).filter((p) => p[2] < -1e-9);
  assert.ok(below.length > 0 && below.every((p) => p[2] === -10 && [10, 30].includes(p[0]) && [5, 25].includes(p[1])), JSON.stringify(below.slice(0, 8)));
  assert.ok(await a.close(), "every body freed");
});

test("hand-worked: the back (y = 30) is looked at from behind, x and y the world's X and Z, extruded back out to y = 40", async () => {
  const a = await app(partDocument("box", 40, 30, 20));
  await createSketch(a);
  await a.pick({ face: faceWhere(a, (p) => p[1] === 30) });
  const look = a.looks().at(-1)!;
  // The front plane's frame (normal −Y, into the box), at (0, 30, 0), faced against: the camera at +Y.
  near(look.plane.origin, [0, 30, 0], "origin");
  near(look.plane.normal, [0, -1, 0], "normal");
  near(look.plane.xAxis, [1, 0, 0], "x");
  assert.equal(look.side, -1);
  await rectangle(a, [10, 5], [30, 15]);
  await extrude(a, 10);
  // 24000 + 20 · 10 · 10 = 26000.
  assert.ok(close(a.volume(), 26000), `${a.volume()} mm³`);
  const behind = points(a.mesh()!).filter((p) => p[1] > 30 + 1e-9);
  assert.ok(behind.length > 0 && behind.every((p) => p[1] === 40 && [10, 30].includes(p[0]) && [5, 15].includes(p[2])), JSON.stringify(behind.slice(0, 8)));
  assert.ok(await a.close(), "every body freed");
});

test("hand-worked: the right side (x = 40) faces out (side +1): x along Y, y along Z, extruded to x = 50", async () => {
  const a = await app(partDocument("box", 40, 30, 20));
  await createSketch(a);
  await a.pick({ face: faceWhere(a, (p) => p[0] === 40) });
  const look = a.looks().at(-1)!;
  near(look.plane.origin, [40, 0, 0], "origin");
  near(look.plane.normal, [1, 0, 0], "normal");
  near(look.plane.xAxis, [0, 1, 0], "x");
  assert.equal(look.side, 1);
  await rectangle(a, [5, 5], [25, 15]);
  await extrude(a, 10);
  assert.ok(close(a.volume(), 26000), `${a.volume()} mm³`);
  const out = points(a.mesh()!).filter((p) => p[0] > 40 + 1e-9);
  assert.ok(out.length > 0 && out.every((p) => p[0] === 50 && [5, 25].includes(p[1]) && [5, 15].includes(p[2])), JSON.stringify(out.slice(0, 8)));
  assert.ok(await a.close(), "every body freed");
});

test("hand-worked: the front plane from its button: looked at from the front, x along X and y along Z, extruded 5 toward the viewer (y 0 to −5)", async () => {
  const a = await app(partDocument("box", 40, 30, 20));
  await createSketch(a);
  a.$("#sketch-plane-XZ")!.click();
  await a.settle();
  assert.equal(a.doc().timeline.features.at(-1)!.intent.parameters.plane, "XZ");
  const look = a.looks().at(-1)!;
  near(look.plane.normal, [0, -1, 0], "normal");
  assert.equal(look.side, 1);
  await rectangle(a, [50, 0], [70, 10]);
  await extrude(a, 5);
  // 24000 + 20 · 10 · 5 = 25000.
  assert.ok(close(a.volume(), 25000), `${a.volume()} mm³`);
  const front = points(a.mesh()!).filter((p) => p[0] > 40 + 1e-9);
  // Placed through the front plane's frame (a quarter turn), so a coordinate may come out a few ulps off: 1e-12 mm.
  const on = (v: number, of: number[]) => of.some((w) => Math.abs(v - w) < 1e-12);
  assert.ok(front.length > 0 && front.every((p) => on(p[0], [50, 70]) && on(p[1], [0, -5]) && on(p[2], [0, 10])), JSON.stringify(front.slice(0, 8)));
  assert.ok(await a.close(), "every body freed");
});

test("the side plane from a pick in the view: looked at from the right", async () => {
  const a = await app(partDocument("box", 40, 30, 20));
  await createSketch(a);
  await a.pick({ plane: "YZ" });
  assert.equal(a.doc().timeline.features.at(-1)!.intent.parameters.plane, "YZ");
  near(a.looks().at(-1)!.plane.normal, [1, 0, 0], "normal");
  assert.ok(await a.close(), "every body freed");
});

test("Q5: a cylinder's round side is refused in words, nothing is recorded and the planes stay; its top is then sketched on", async () => {
  const a = await app(partDocument("cylinder", 20, 20, 10));
  await createSketch(a);
  const zs = (f: number) => facesWhere(a.mesh()!, (p) => p[2] === f);
  const [bottom, top] = [zs(0), zs(10)];
  assert.equal(bottom.length, 1);
  assert.equal(top.length, 1);
  // Two caps flat, the side not: only the caps are offered to light.
  assert.deepEqual([...a.planes().faces].sort(), [bottom[0], top[0]].sort());
  const side = [0, 1, 2].find((f) => f !== bottom[0] && f !== top[0])!;
  const before = a.history.undoLabel();
  const items = a.doc().timeline.features.length;
  await a.pick({ face: side });
  assert.equal(a.sketching(), false, "no sketch opened");
  assert.equal(a.doc().timeline.features.length, items, "no sketch added");
  assert.equal(a.history.undoLabel(), before, "nothing recorded");
  const refused = a.$("#sketch-pick-error")!;
  assert.equal(refused.hidden, false);
  assert.equal(refused.textContent, CURVED_FACE);
  assert.equal(a.planes().planes.length, 3, "the planes stay offered");
  await a.pick({ face: top[0] });
  assert.ok(a.sketching());
  assert.equal(a.doc().timeline.features.at(-1)!.intent.parameters.plane, "face:feature-1/top");
  near(a.looks().at(-1)!.plane.origin, [0, 0, 10], "on the top");
  assert.ok(await a.close(), "every body freed");
});

test("a pick on empty space or an edge does nothing while the planes are offered; Undo takes a face sketch away in one step", async () => {
  const a = await app(partDocument("box", 40, 30, 20));
  await createSketch(a);
  await a.pick({ face: null });
  await a.pick({ face: null, edge: 3 });
  assert.equal(a.sketching(), false);
  assert.equal(a.planes().planes.length, 3);
  await a.pick({ face: faceWhere(a, (p) => p[0] === 0) });
  assert.equal(a.doc().timeline.features.at(-1)!.intent.parameters.plane, "face:feature-1/left");
  assert.equal(await a.undo(), "Create sketch");
  assert.equal(a.doc().timeline.features.length, 1, "only the box is left");
  assert.ok(await a.close(), "every body freed");
});

test("a second body's faces are offered after the first's, and a face of it is sketched on", async () => {
  const a = await app(partDocument("box", 40, 30, 20));
  await createSketch(a);
  await a.pick({ face: faceWhere(a, (p) => p[2] === 20) });
  await rectangle(a, [10, 5], [30, 25]);
  await extrude(a, 10);
  await createSketch(a);
  // The box's 6 faces and the block's 6.
  assert.deepEqual([...a.planes().faces].sort((x, y) => x - y), [...Array(12).keys()]);
  await a.pick({ face: faceWhere(a, (p) => p[2] === 30) });
  const item = a.doc().timeline.features.at(-1)!;
  assert.match(String(item.intent.parameters.plane), /^face:feature-\d+\/end$/, "the block's end cap");
  assert.notEqual(item.dependsOn[0], "feature-1", "it depends on the block, not the box");
  near(a.looks().at(-1)!.plane.origin, [0, 0, 30], "on the block's top");
  assert.ok(await a.close(), "every body freed");
});

test("every tool draws on a face as on the ground plane: on the back (side −1) a rectangle, a circle centred on its corner by a snap, a 3-point arc and a tangent arc from its end", async () => {
  const a = await app(partDocument("box", 40, 30, 20));
  await createSketch(a);
  await a.pick({ face: faceWhere(a, (p) => p[1] === 30) });
  await a.key("sketch-rectangle");
  for (const [x, y] of [[5, 5], [35, 15]]) await a.click(x, y);
  await a.key("sketch-circle");
  // 0.36 mm off the corner (35, 15): within the 1 mm snap, so the circle's centre is that corner, shared.
  for (const [x, y] of [[35.3, 15.2], [40, 15]]) await a.click(x, y);
  await a.key("sketch-arc");
  // From the corner (5, 15) to (15, 15) through (10, 18): a free end at (15, 15).
  for (const [x, y] of [[5, 15], [15, 15], [10, 18]]) await a.click(x, y);
  await a.key("sketch-tangent");
  for (const [x, y] of [[15, 15], [25, 25]]) await a.click(x, y);
  const s = a.doc().sketches.at(-1)!;
  const kinds = s.curves.map((c) => c.kind).sort();
  assert.deepEqual(kinds, ["arc", "arc", "circle", "line", "line", "line", "line"]);
  const corner = s.points.find((p) => p.x === 35 && p.y === 15)!;
  const circle = s.curves.find((c) => c.kind === "circle")!;
  assert.equal(circle.kind === "circle" && circle.centre, corner.id, "the circle's centre is the rectangle's corner");
  assert.equal(circle.kind === "circle" && circle.radius, 5);
  // The sketch is on the back face, and every one of those clicks was in its own (world X, Z) coordinates.
  assert.equal(a.doc().timeline.features.at(-1)!.intent.parameters.plane, "face:feature-1/back");
  assert.ok(await a.close(), "every body freed");
});
