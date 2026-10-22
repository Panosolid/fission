// The step-26 second bug hunt's regressions (26h), each worked by hand, in
// the Design app as the shell runs it (design-app.ts) on the real kernel:
//   1. sizes typed and entered faster than the kernel answers go where
//      they were typed: each Enter takes the boxes as they were when it was
//      pressed, and empties them at once for the next side (e2e-races: a
//      fast "10, Tab, 90, Enter" placed the pointer's point instead);
//   2. a hover answered while a slow click waited its turn is where the
//      preview goes on from;
//   4. a size box emptied, or typed 0 or -5, takes nothing into the design
//      and gets its last size back once left (Ben's Fusion answer 8: -5 and
//      0 are not accepted and the value returns);
//   5. a pin on the middle of an edge between two sides follows that edge
//      when the outline turns over (a corner dragged across: every such
//      edge's name then reads the other way round), as a corner's pin does.
// Run with `npm run journeys` after the app build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { addSketch, BodyCache, drawArc, drawLine, extrudeSketch, joinBodies, movePoint, partDocument, pinNow, rebuildTimeline, shownBodies, sketchCurves, sketchLines, type DesignDocument } from "@fission/design";
import type { Plane } from "@fission/core";
import { app, kernel } from "./design-app.ts";

type App = Awaited<ReturnType<typeof app>>;

/** A few turns of the event loop, without waiting for the kernel (held, it answers nothing). */
const turns = async (n = 10) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

/**
 * Keys typed as a browser types them: into the box with the keys, else the
 * first starts typing through the shell's shortcut (inText is off for
 * them), and each key is one input event.
 */
async function type(a: App, text: string) {
  for (const ch of text) {
    const box = a.window.document.activeElement as unknown as HTMLInputElement | null;
    if (box?.closest?.("#typed-entry")) {
      box.value += ch;
      box.dispatchEvent(new a.window.Event("input", { bubbles: true }) as unknown as Event);
    } else a.press(`type-size-${ch}`);
    await turns(1);
  }
}

/** A key pressed in the box that has the keys (Tab, Enter). */
async function press(a: App, key: string) {
  const box = a.window.document.activeElement as unknown as HTMLElement;
  assert.ok(box.closest("#typed-entry"), `a typed box has the keys for ${key}`);
  box.dispatchEvent(new a.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }) as unknown as Event);
  await turns(1);
}

/** The open sketch's lines, as "x,y>x,y" each. */
const lines = (a: App) => sketchLines(a.doc().sketches.at(-1)!).map((l) => `${l.a}>${l.b}`);

test("1. two sides typed and entered while the kernel is slow each go where they were typed, not where the pointer is", async () => {
  const a = await app(partDocument("box", 40, 30, 20));
  a.$("#create-sketch")!.click();
  await a.settle();
  await a.pick({ plane: "XY" });
  await a.click(0, 0);
  // The pointer at (18.7, 31.2): nowhere a typed side ends, so a point placed there is the pointer's.
  a.pointer("move", [18.7, 31.2]);
  await a.settle();
  // The kernel slow from here: each Enter's placing waits behind the last one's outline check. The user types three
  // sides, 10 at 0°, 90° and 180°, each with Enter, faster than the kernel answers. The second Enter's placing can't
  // start before the first's check is answered, so the third side is typed while it waits: into empty boxes, which it
  // must not take (the bug: the boxes still held "10" and "90", the keys stayed in Angle, and "10" Tab "180" made them
  // "180" and "9010", so the second point went 180 mm at 10°, to (187.3, 31.3)).
  a.hold();
  for (const angle of ["0", "90", "180"]) {
    await type(a, "10");
    await press(a, "Tab");
    await type(a, angle);
    await press(a, "Enter");
    assert.equal((a.$("#typed-length") as HTMLInputElement).value, "", `Enter at ${angle}° empties the boxes at once, for the next side`);
    assert.equal(a.window.document.activeElement?.id, "typed-length", "with the keys back in Length");
  }
  await a.release();
  // By hand: from (0, 0), 10 at 0° ends at (10, 0); 10 at 90° from there at (10, 10); 10 at 180° at (0, 10).
  assert.deepEqual(lines(a), ["0,0>10,0", "10,0>10,10", "10,10>0,10"]);
  // Each Enter is its own undo step, as when typed slowly.
  assert.match((await a.undo()) ?? "", /^Draw line/);
  assert.deepEqual(lines(a), ["0,0>10,0", "10,0>10,10"]);
  assert.ok(await a.close(), "every body freed");
});

test("1b. an Enter that places nothing gives back the size it took, and never over a size typed since", async () => {
  const a = await app(partDocument("box", 40, 30, 20));
  a.$("#create-sketch")!.click();
  await a.settle();
  await a.pick({ plane: "XY" });
  await a.click(0, 0);
  // The pointer off the view: a length alone, with no pointer to give its way, places nothing.
  a.pointer("move", null);
  await a.settle();
  await type(a, "10");
  await press(a, "Enter");
  await a.settle();
  assert.match(a.$("#sketch-grid-error")!.textContent ?? "", /Move the pointer/, "it says why");
  assert.equal((a.$("#typed-length") as HTMLInputElement).value, "10", "the length is given back to fix or finish");
  assert.deepEqual(lines(a), []);
  // Enter again, and 7 typed before the refusal comes back (the same turn of the event loop): the 7 stays.
  const box = a.$("#typed-length") as HTMLInputElement;
  box.dispatchEvent(new a.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }) as unknown as Event);
  assert.equal(box.value, "", "taken at once");
  box.value = "7";
  box.dispatchEvent(new a.window.Event("input", { bubbles: true }) as unknown as Event);
  await a.settle();
  assert.equal(box.value, "7", "what was typed since is kept");
  assert.ok(await a.close(), "every body freed");
});

/** The open sketch's preview segments, as "x,y>x,y" each. */
const preview = (a: App) => (a.drawings().find((d) => d.editing)?.editing?.preview ?? []).map(([p, q]) => `${p}>${q}`);

test("2. a hover answered while a slow click waited its turn is where the preview goes on from, not the click", async () => {
  const a = await app(partDocument("box", 40, 30, 20));
  a.$("#create-sketch")!.click();
  await a.settle();
  await a.pick({ plane: "XY" });
  await a.click(0, 0);
  // The kernel slow: the click at (10, 0) waits for its rounding, then its outline check; the click at (10, 10) waits
  // its turn behind both. The pointer then moves on to (3, 4), and that hover is answered before the second click's
  // own rounding is even asked for.
  a.hold();
  a.pointer("click", [10, 0]);
  a.pointer("click", [10, 10]);
  a.pointer("move", [3, 4]);
  await a.release();
  assert.deepEqual(lines(a), ["0,0>10,0", "10,0>10,10"], "both clicks placed");
  // By hand: the chain goes on from (10, 10) toward the pointer, at (3, 4) (a 0.1 mm pixel, so no snap reaches it:
  // the nearest point, (0, 0), is 5 mm away).
  assert.deepEqual(preview(a), ["10,10>3,4"]);
  assert.ok(await a.close(), "every body freed");
});

test("3. a centre arc's way round follows the pointer's moves made while the kernel placed its start", async () => {
  const a = await app(partDocument("box", 40, 30, 20));
  a.$("#create-sketch")!.click();
  await a.settle();
  await a.pick({ plane: "XY" });
  a.$("#sketch-create")!.click();
  a.$("#sketch-menu-centre")!.click();
  await a.settle();
  // The kernel slow: the centre clicked at (20, 10) and the start at (20, 20), straight above it, each waiting on the
  // kernel's rounding; the pointer then goes a little counter-clockwise from straight up (to the left) before either
  // is placed.
  a.hold();
  a.pointer("move", [21, 12]);
  a.pointer("click", [20, 10]);
  a.pointer("move", [20, 20]);
  a.pointer("click", [20, 20]);
  a.pointer("move", [19, 20]);
  a.pointer("move", [17, 19]);
  await a.release();
  // Then 270 typed: three quarters round the way the pointer went, counter-clockwise from 90° to 360°, so by hand the
  // end is (20 + 10, 10) = (30, 10), and the arc runs counter-clockwise from (20, 20) to (30, 10).
  await type(a, "270");
  await press(a, "Enter");
  await a.settle();
  const arcs = sketchCurves(a.doc().sketches.at(-1)!).arcs;
  assert.equal(arcs.length, 1, "the arc is drawn");
  assert.deepEqual([arcs[0].start, arcs[0].end, arcs[0].centre], [[20, 20], [30, 10], [20, 10]]);
  assert.ok(await a.close(), "every body freed");
});

test("4. a size box emptied or typed 0 or -5 records nothing, says why, and gets its last size back when left", async () => {
  const a = await app(partDocument("box", 40, 30, 20));
  const sizes = () => a.doc().timeline.features[0].intent.parameters;
  const undo = a.history.undoLabel();
  const builds = a.builds();
  const height = a.$("#height") as HTMLInputElement;
  const typeIn = async (text: string) => {
    height.value = text;
    height.dispatchEvent(new a.window.Event("input") as unknown as Event);
    await a.settle();
  };
  // A browser's number box reads "-" and "" alike as empty; "-0" is 0.
  for (const [typed, words] of [["", "Type the height in mm."], ["0", "The height must be more than 0 mm."], ["-0", "The height must be more than 0 mm."], ["-5", "The height must be more than 0 mm."]] as const) {
    await typeIn(typed);
    assert.equal(a.error(), words, `"${typed}" says why`);
    assert.deepEqual(sizes(), { width: 40, depth: 30, height: 20 }, `"${typed}": the design keeps its sizes`);
  }
  assert.equal(a.history.undoLabel(), undo, "no undo step");
  assert.equal(a.builds(), builds, "nothing went to the kernel");
  // Leaving the box (change fires as it loses the keys): the last size the design took comes back, and the words go.
  height.dispatchEvent(new a.window.Event("change") as unknown as Event);
  await a.settle();
  assert.equal(height.value, "20");
  assert.equal(a.error(), "");
  // A good size after: taken. Then 0.5 typed through "0" and "0.": the 0 is refused on the way, 0.5 is taken, and
  // leaving keeps it.
  await typeIn("25");
  assert.deepEqual(sizes(), { width: 40, depth: 30, height: 25 });
  await typeIn("0");
  await typeIn("0.5");
  assert.deepEqual(sizes(), { width: 40, depth: 30, height: 0.5 });
  assert.equal(a.error(), "");
  height.dispatchEvent(new a.window.Event("change") as unknown as Event);
  await a.settle();
  assert.equal(height.value, "0.5");
  // Undo goes back to 25, then to 20: the refused texts were never steps.
  assert.equal(await a.undo(), "Change height");
  assert.deepEqual(sizes(), { width: 40, depth: 30, height: 20 }, "typing in one box is one step: 25 and 0.5 merged");
  assert.ok(await a.close(), "every body freed");
});

/** The extrude's body as the app shows it (the last body), on the real kernel. */
async function extruded(doc: DesignDocument) {
  const cache = new BodyCache(kernel);
  const body = joinBodies(await shownBodies(doc, await rebuildTimeline(doc, cache, kernel), cache)).bodies.at(-1)!;
  await cache.clear();
  return body;
}
/** The name of the edge whose middle is at `p`. */
const edgeAt = (body: Awaited<ReturnType<typeof extruded>>, p: number[]) => body.names.edges[body.view.edge_middles.findIndex((m) => m.every((c, k) => Math.abs(c - p[k]) < 1e-9))];
/** The plane y = 0 seen from the front: sketch x is world x, sketch y is world z (normal −y, so y = normal × x = +z). */
const FRONT: Plane = { origin: [0, 0, 0], xAxis: [1, 0, 0], normal: [0, -1, 0] };

test("5. a pin on the middle of an edge between two sides follows it when the outline turns over, as a corner's pin does", async () => {
  // A triangle A (0, 0), B (20, 0), C (10, 10) on XY, extruded 10. The upright edge at A, between the sides from CA and
  // AB, has its middle at (0, 0, 5): in the front plane, sketch (0, 5).
  let { doc, id } = addSketch(partDocument("box", 40, 30, 20));
  doc = drawLine(doc, id, [0, 0], [20, 0]).doc;
  let pts = doc.sketches.at(-1)!.points;
  doc = drawLine(doc, id, pts[1].id, [10, 10]).doc;
  pts = doc.sketches.at(-1)!.points;
  doc = drawLine(doc, id, pts[2].id, pts[0].id).doc;
  doc = extrudeSketch(doc, id, 10).doc;
  const before = await extruded(doc);
  const name = edgeAt(before, [0, 0, 5]);
  assert.match(name ?? "", /^side:.+>side:.+$/, "an edge between two sides, named in order");
  const pin = { point: "p", kind: "midpoint" as const, name: name! };
  assert.deepEqual(pinNow(pin, before.view, before.names, FRONT), { at: [0, 5] }, "the control: found where it is");
  // C dragged to (10, −10), across AB: the outline turns the other way round, A and its edge stay where they were.
  const turned = movePoint(doc, id, pts[2].id, 10, -10);
  const after = await extruded(turned);
  const [a, b] = name!.split(">");
  assert.equal(edgeAt(after, [0, 0, 5]), `${b}>${a}`, "the same edge, its name now the other way round");
  assert.deepEqual(pinNow(pin, after.view, after.names, FRONT), { at: [0, 5] }, "the pin follows its edge (before: point-lost)");
  // A corner's pin there already did: its name leaves the order out.
});

test("5b. on a half disc, whose two upright edges are each named both ways round, a middle's pin keeps to its own edge", async () => {
  // The line from P (0, 0) to Q (20, 0), the arc from Q round (10, 0) back to P: two upright edges, at P and at Q, named
  // "arc>line" and "line>arc". The pin on the one at P, (0, 0, 5), is found there, never on the one at Q.
  let { doc, id } = addSketch(partDocument("box", 40, 30, 20));
  doc = drawLine(doc, id, [0, 0], [20, 0]).doc;
  const [p, q] = doc.sketches.at(-1)!.points;
  doc = drawArc(doc, id, q.id, p.id, [10, 0]).doc;
  doc = extrudeSketch(doc, id, 10).doc;
  const body = await extruded(doc);
  const name = edgeAt(body, [0, 0, 5])!;
  const [a, b] = name.split(">");
  assert.equal(edgeAt(body, [20, 0, 5]), `${b}>${a}`, "the other upright edge is its name the other way round");
  assert.deepEqual(pinNow({ point: "p", kind: "midpoint", name }, body.view, body.names, FRONT), { at: [0, 5] });
  // P and Q swapped: the line now runs from (20, 0) to (0, 0), the arc below it. P's edge went with P, to (20, 0, 5),
  // and its name with it: the pin follows P.
  const swapped = movePoint(movePoint(doc, id, p.id, 20, 0), id, q.id, 0, 0);
  const after = await extruded(swapped);
  assert.equal(edgeAt(after, [20, 0, 5]), name, "the name went with P");
  assert.deepEqual(pinNow({ point: "p", kind: "midpoint", name }, after.view, after.names, FRONT), { at: [20, 5] });
});
