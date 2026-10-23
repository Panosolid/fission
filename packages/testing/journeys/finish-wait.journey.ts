// Finish Sketch pressed while the last click still waits for the kernel
// (found in 27b, #251: at 375 px with taps and a slow kernel, the circle of
// the last tap was lost). Every click waits its turn behind the kernel's
// rounding of it; Finish Sketch closed the sketch at once, so the click's
// turn came for a sketch no longer open and it was dropped. Finish Sketch
// now waits for the clicks made before it, so what was clicked is drawn and
// then the sketch closes. Worked by hand, in the Design app as the shell
// runs it (design-app.ts) on the real kernel, the kernel held to make it
// slow. Run with `npm run journeys` after the app build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { partDocument, sketchCurves, sketchLines } from "@fission/design";
import { app } from "./design-app.ts";

/** A few turns of the event loop, without waiting for the kernel (held, it answers nothing). */
const turns = async (n = 10) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

test("a circle's second tap, then Finish Sketch before the kernel answers: the circle is drawn and the sketch closes", async () => {
  const a = await app(partDocument("box", 40, 30, 20));
  a.$("#create-sketch")!.click();
  await a.settle();
  await a.pick({ plane: "XY" });
  await a.key("sketch-circle");
  await a.click(60, 0); // the centre, answered
  a.hold();
  a.pointer("click", [65, 0]); // the rim: 5 from the centre, so radius 5 (by hand: |(65, 0) − (60, 0)| = 5)
  await turns();
  a.$("#finish-sketch")!.click();
  await turns();
  assert.equal(a.sketching(), true, "still open while the click waits for the kernel");
  await a.release();
  assert.equal(a.sketching(), false, "closed once the click is drawn");
  const circles = sketchCurves(a.doc().sketches.at(-1)!).circles;
  assert.equal(circles.length, 1, "the circle kept");
  assert.deepEqual([circles[0].centre, circles[0].radius], [[60, 0], 5]);
  // One undo step for the circle, as when drawn slowly.
  assert.match((await a.undo()) ?? "", /circle/i);
  assert.equal(sketchCurves(a.doc().sketches.at(-1)!).circles.length, 0);
  assert.ok(await a.close(), "every body freed");
});

test("two line clicks, then Finish Sketch before the kernel answers either: both lines are drawn, in order", async () => {
  const a = await app(partDocument("box", 40, 30, 20));
  a.$("#create-sketch")!.click();
  await a.settle();
  await a.pick({ plane: "XY" });
  await a.click(50, 0);
  a.hold();
  a.pointer("click", [60, 0]);
  a.pointer("click", [60, 10]);
  await turns();
  a.$("#finish-sketch")!.click();
  await a.release();
  assert.equal(a.sketching(), false);
  assert.deepEqual(sketchLines(a.doc().sketches.at(-1)!).map((l) => `${l.a}>${l.b}`), ["50,0>60,0", "60,0>60,10"]);
  assert.ok(await a.close(), "every body freed");
});

test("Finish Sketch with no click waiting closes at once, as before", async () => {
  const a = await app(partDocument("box", 40, 30, 20));
  a.$("#create-sketch")!.click();
  await a.settle();
  await a.pick({ plane: "XY" });
  await a.click(50, 0);
  await a.click(60, 0);
  a.$("#finish-sketch")!.click();
  assert.equal(a.sketching(), false, "in the same turn as the press");
  await a.settle();
  assert.ok(await a.close(), "every body freed");
});

test("Escape still drops a click that waits for the kernel (it is a cancel)", async () => {
  const a = await app(partDocument("box", 40, 30, 20));
  a.$("#create-sketch")!.click();
  await a.settle();
  await a.pick({ plane: "XY" });
  await a.click(50, 0);
  a.hold();
  a.pointer("click", [60, 0]);
  await turns();
  a.press("clear-selection");
  await a.release();
  assert.deepEqual(sketchLines(a.doc().sketches.at(-1)!), []);
  assert.ok(await a.close(), "every body freed");
});
