// Journey: the pointer over an open sketch, in the real workspace on the
// real WASM kernel. Each move asks the kernel to round the pointer, so the
// answer comes back later; what it shows must still be where the pointer
// is when it comes. Run with `npm run journeys` after the app build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { partDocument } from "@fission/design";
import { app } from "./design-app.ts";

/** The snap the open sketch shows, in words ("" for none). */
const snapShown = (a: Awaited<ReturnType<typeof app>>) => a.drawings().find((d) => d.editing)?.editing?.snap?.label ?? "";

test("regression (26d e2e, sketch-pixels under load): a move answered after the pointer left the view shows no snap and no preview; a tap keeps its preview", async () => {
  const a = await app(partDocument("box", 40, 30, 20));
  a.$("#create-sketch")!.click();
  await a.settle();
  await a.pick({ plane: "XY" });
  // A line from (0, 0) to (20, 0), the chain still open.
  await a.click(0, 0);
  await a.click(20, 0);
  // Over (0.05, 0.03): 0.06 mm from the start at (0, 0) (the chain's own end at (20, 0) is no snap for its next line), well inside the 1 mm a 0.1 mm pixel's snap reaches.
  a.pointer("move", [0.05, 0.03]);
  await a.settle();
  assert.match(snapShown(a), /0,0/, "the hover snaps to the point it is near (the control: the snap is shown when the pointer stays)");
  // The same move, and the pointer off the view before the kernel answers it: nothing may be left shown.
  a.pointer("move", [0.05, 0.03]);
  a.pointer("move", null);
  await a.settle();
  assert.equal(snapShown(a), "", "the pointer left the view, so no snap is shown");
  assert.equal(a.drawings().find((d) => d.editing)?.editing?.preview.length, 0, "and no preview");
  // A tap: the finger leaves the view before the kernel has placed the point (the viewer says so on pointerleave,
  // which a touch fires as it lifts). The point is placed, and the preview, the hint and the typed boxes stay by the
  // tap, as a phone needs them (typed-entry.mjs, 375 px with taps). At (0.05, 10.03), 10 mm from every point, so it
  // snaps to none and the chain goes on: the preview is the next line, from the point placed.
  a.pointer("click", [0.05, 10.03]);
  a.pointer("move", null);
  await a.settle();
  const drawn = a.drawings().find((d) => d.editing)!;
  assert.equal(drawn.lines.length, 2, "the tap drew the second line");
  assert.equal(drawn.editing?.preview.length, 1, "the preview stays at the tap");
  assert.deepEqual(drawn.editing?.preview[0][0], drawn.editing?.points.at(-1), "from the point placed");
  assert.ok(Math.hypot(drawn.editing!.points.at(-1)![0] - 0.05, drawn.editing!.points.at(-1)![1] - 10.03) < 0.1, "which is where the tap was, to the pixel");
  assert.ok(await a.close(), "every body freed");
});
