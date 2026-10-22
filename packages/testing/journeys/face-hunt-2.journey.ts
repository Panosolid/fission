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
//      edge's name then reads the other way round), as a corner's pin does;
//   6. nasty faces worked by hand: a face at exactly 45° between XZ and YZ
//      (the frame rule's tie), and a side turned exactly a right angle and
//      just past it, placed by the rebuild and opened in the app.
// Run with `npm run journeys` after the app build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { addFaceSketch, addSketch, BodyCache, drawArc, drawCircle, drawLine, drawnOnFace, facePlane, settleKept, extrudeSketch, joinBodies, movePoint, partDocument, pinNow, rebuildTimeline, shownBodies, sketchCurves, sketchLines, type DesignDocument } from "@fission/design";
import { emptyProject, projectFromJson, projectToJson, type Plane } from "@fission/core";
import { app, kernel } from "./design-app.ts";
import { designWorkspace } from "@fission/design";

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

test("1c. an Enter whose turn comes after another tool was chosen is dropped, as a click is", async () => {
  const a = await app(partDocument("box", 40, 30, 20));
  a.$("#create-sketch")!.click();
  await a.settle();
  await a.pick({ plane: "XY" });
  await a.click(0, 0);
  // The kernel slow: a click at (10, 0) waits for its rounding; 5 at 90° typed and entered meanwhile (its turn after
  // the click's); then R, the rectangle tool, before the kernel answers.
  a.hold();
  a.pointer("click", [10, 0]);
  await turns();
  await type(a, "5");
  await press(a, "Tab");
  await type(a, "90");
  await press(a, "Enter");
  a.press("sketch-rectangle");
  await a.release();
  // The click was for the line tool too, so it is dropped (the tool changed while the kernel snapped it); so is the
  // Enter: nothing is drawn, and the rectangle tool has no corner yet.
  assert.deepEqual(lines(a), []);
  assert.deepEqual(a.drawings().find((d) => d.editing)?.editing?.points ?? [], [], "no corner placed by the Enter");
  assert.ok(await a.close(), "every body freed");
});

/** A line sketch on XY of a fresh box design, its chain started at (0, 0), the pointer then at `p` (answered). */
async function lineFrom00(p: [number, number]) {
  const a = await app(partDocument("box", 40, 30, 20));
  a.$("#create-sketch")!.click();
  await a.settle();
  await a.pick({ plane: "XY" });
  await a.click(0, 0);
  a.pointer("move", p);
  await a.settle();
  return a;
}

test("1d. a length typed while a slow click is placed stays in its box for the next side", async () => {
  const a = await lineFrom00([18.7, 31.2]);
  a.hold();
  a.pointer("click", [10, 0]);
  await turns();
  await type(a, "7");
  await a.release();
  assert.deepEqual(lines(a), ["0,0>10,0"], "the click placed where it was clicked (nothing was typed as it was made)");
  assert.equal((a.$("#typed-length") as HTMLInputElement).value, "7", "the 7 typed since is kept");
  assert.ok(await a.close(), "every body freed");
});

test("1e. an Enter places from where the pointer was as it was pressed, not where it went after", async () => {
  // The pointer at (18.7, 31.2), then (kernel slow) moved to (0, 10), 5 typed and Enter, then moved to (10, 0) before
  // the kernel answers any of it. By hand: 5 from (0, 0) toward (0, 10) is (0, 5).
  const a = await lineFrom00([18.7, 31.2]);
  a.hold();
  a.pointer("move", [0, 10]);
  await type(a, "5");
  await press(a, "Enter");
  a.pointer("move", [10, 0]);
  await a.release();
  assert.deepEqual(lines(a), ["0,0>0,5"]);
  assert.ok(await a.close(), "every body freed");
});

test("1f. an Enter after a tap (no move since) goes from the tap, not from a hover before it", async () => {
  // A hover at (0, 10), then a tap at (10, 0) with no move (a finger): the line to (10, 0) is drawn and the next one
  // starts there with the pointer on it, so a length alone has no way to go: refused, nothing drawn. (Taken from the
  // hover before the tap, it would have gone toward (0, 10).)
  const a = await lineFrom00([0, 10]);
  await a.click(10, 0);
  await type(a, "5");
  await press(a, "Enter");
  await a.settle();
  assert.deepEqual(lines(a), ["0,0>10,0"]);
  assert.match(a.$("#sketch-grid-error")!.textContent ?? "", /Move the pointer/);
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

test("2b. a tap with no move since a hover goes on from the tap", async () => {
  // A hover at (3, 4), answered; then a tap at (10, 10), no move: the line to (10, 10) is drawn, and the preview goes
  // on from the tap, where the finger was (nothing to draw yet), never back toward the old hover.
  const a = await lineFrom00([3, 4]);
  await a.click(10, 10);
  assert.deepEqual(lines(a), ["0,0>10,10"]);
  assert.deepEqual(preview(a), ["10,10>10,10"]);
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
  // Left with no change event (Firefox in CI's browsers job gave none for a number box left empty after 0 and -5):
  // losing the keys alone brings the size back.
  await typeIn("-5");
  assert.equal(a.error(), "The height must be more than 0 mm.");
  height.dispatchEvent(new a.window.FocusEvent("blur") as unknown as Event);
  await a.settle();
  assert.equal(height.value, "20", "blur alone");
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

const reopen = (doc: DesignDocument) => projectFromJson(projectToJson({ ...emptyProject("Hunt"), workspaces: { design: doc } }), [designWorkspace]).workspaces.design as DesignDocument;

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

/** A triangle (corners in order) drawn on a new XY sketch of `doc` and extruded `d`; its sketch and point ids. */
function triangle(doc: DesignDocument, corners: [number, number][], d: number) {
  const made = addSketch(doc);
  let next = drawLine(made.doc, made.id, corners[0], corners[1]).doc;
  let pts = next.sketches.at(-1)!.points;
  next = drawLine(next, made.id, pts[1].id, corners[2]).doc;
  pts = next.sketches.at(-1)!.points;
  next = drawLine(next, made.id, pts[2].id, pts[0].id).doc;
  return { doc: extrudeSketch(next, made.id, d).doc, sketch: made.id, points: pts.map((p) => p.id) };
}
/** The last body's face whose outward normal is `n` (to 1e-12), its name and where a sketch drawn there lies. */
async function faceAlong(doc: DesignDocument, n: number[]) {
  const body = await extruded(doc);
  const f = body.view.face_normals.findIndex((m) => m !== null && m.every((c, k) => Math.abs(c - n[k]) < 1e-12));
  assert.ok(f >= 0, `a face along ${n}`);
  return { body, f, drawn: drawnOnFace(body.view, f)!, plane: facePlane(body.names.feature, body.names.faces[f]!) };
}
const near = (got: readonly number[], want: readonly number[], what: string) => assert.ok(got.every((g, k) => Math.abs(g - want[k]) < 1e-12), `${what}: ${got} is not ${want}`);
/** Where sketch point (s, t) lies in the world through `p`: origin + s · x + t · (normal × x). */
function world(p: Plane, s: number, t: number): number[] {
  const [n, x] = [p.normal, p.xAxis];
  const y = [n[1] * x[2] - n[2] * x[1], n[2] * x[0] - n[0] * x[2], n[0] * x[1] - n[1] * x[0]];
  return [0, 1, 2].map((k) => p.origin[k] + s * x[k] + t * y[k]);
}
/** Sketch `id`'s placement as the rebuild places it now (a face sketch's frame, turned with its face). */
async function placed(doc: DesignDocument, id: string) {
  const cache = new BodyCache(kernel);
  const r = (await rebuildTimeline(doc, cache, kernel)).results[id];
  await cache.clear();
  assert.equal(r?.status, "built", `${id} placed: ${JSON.stringify(r)}`);
  return (r as { placement: { plane: Plane; side: 1 | -1 } }).placement;
}

test("6a. a face at exactly 45° between the XZ and YZ planes takes XZ's frame (the tie goes to the first), worked by hand", async () => {
  // The right triangle (100, 0), (140, 0), (100, 40): its long side runs from (140, 0) to (100, 40), outward normal
  // (1, 1, 0)/√2, as near XZ's normal (0, −1, 0) as YZ's (1, 0, 0): |n · (0, −1, 0)| = |n · (1, 0, 0)| = 1/√2. The tie
  // goes to XZ. Its side is −1 (the face looks against (0, −1, 0)), so the frame's normal is −outward = (−1, −1, 0)/√2;
  // x is XZ's (1, 0, 0) turned the shortest way from (0, −1, 0) onto it: with c = 1/√2 and w = (0, −1, 0) × n =
  // (0, 0, −1/√2), x = c (1, 0, 0) + w × (1, 0, 0) = (1/√2, −1/√2, 0). Its origin is the plane's nearest point to the
  // world's: n (n · (140, 0, 0)) = (−a, −a, 0)(−140 a) with a = 1/√2, so (70, 70, 0).
  const a = Math.SQRT1_2;
  const t = triangle(partDocument("box", 40, 30, 20), [[100, 0], [140, 0], [100, 40]], 20);
  const { body, drawn, plane } = await faceAlong(t.doc, [a, a, 0]);
  assert.equal(drawn.side, -1);
  near(drawn.plane.normal, [-a, -a, 0], "normal");
  near(drawn.plane.xAxis, [a, -a, 0], "x");
  near(drawn.plane.origin, [70, 70, 0], "origin");
  // Sketch y is normal × x = (0, 0, 1): sketch (s, t) is (70 + s/√2, 70 − s/√2, t). The face's middle, (120, 20, 10),
  // is s = 50√2, t = 10. A circle there, extruded 5 into the triangle (side −1: away from the frame's normal).
  const made = addFaceSketch(t.doc, { plane, feature: body.feature }, drawn);
  let doc = drawCircle(made.doc, made.id, [50 * Math.SQRT2, 10], 2).doc;
  near(world(drawn.plane, 50 * Math.SQRT2, 10), [120, 20, 10], "the middle by hand");
  doc = extrudeSketch(doc, made.id, 5).doc;
  // Placed by the rebuild where it was drawn, and the same after a save and open (the frame read back bit for bit).
  near((await placed(doc, made.id)).plane.xAxis, [a, -a, 0], "placed x");
  assert.deepEqual(reopen(doc), doc, "the file reads back the same");
  // Opened in the app: the 45° sketch drawn where it was placed, not lost.
  const app1 = await app(doc);
  const drawnNow = app1.drawings().find((d) => d.plane.normal[0] < 0 && d.plane.normal[1] < 0)!;
  assert.ok(drawnNow && !drawnNow.lost, "the 45° sketch drawn, not lost");
  near(drawnNow.plane.origin, [70, 70, 0], "drawn at its origin");
  assert.ok(await app1.close(), "every body freed");
});

test("6b. a side turned exactly a right angle, and just past it, carries its sketch round, worked by hand", async () => {
  // The right triangle A (100, 0), B (120, 0), C (100, 20): side AB faces (0, −1, 0), so a sketch there takes XZ's frame
  // as it is: origin (0, 0, 0), x (1, 0, 0), y = z; sketch (110, 10) is the world's (110, 0, 10). A circle there.
  const t = triangle(partDocument("box", 40, 30, 20), [[100, 0], [120, 0], [100, 20]], 20);
  const { body, drawn, plane } = await faceAlong(t.doc, [0, -1, 0]);
  near(drawn.plane.origin, [0, 0, 0], "origin");
  near(drawn.plane.xAxis, [1, 0, 0], "x");
  const made = addFaceSketch(t.doc, { plane, feature: body.feature }, drawn);
  const doc = drawCircle(made.doc, made.id, [110, 10], 2).doc;
  // B to (100, −20) and C to (120, 0): the triangle turned a right angle clockwise about A, AB now faces (−1, 0, 0).
  // frameNow: n · outward = 0, so the sketch keeps the outward side, n = (−1, 0, 0); x turned the shortest way from
  // (0, −1, 0) to (−1, 0, 0), with c = 0 and w = (0, 0, −1): x = w × (1, 0, 0) = (0, −1, 0); the origin n (n · A) =
  // (100, 0, 0). Sketch (110, 10) is then (100, 0, 0) + 110 (0, −1, 0) + 10 (0, 0, 1) = (100, −110, 10): the frame
  // turns about the plane's point nearest the world's origin, as Fusion's sketch on a face does (its origin the
  // world's origin seen square onto the face), so a point not pinned to the face swings round with it.
  let turned = movePoint(movePoint(doc, t.sketch, t.points[1], 100, -20), t.sketch, t.points[2], 120, 0);
  turned = await settleKept(kernel, doc, turned);
  const now = await placed(turned, made.id);
  near(now.plane.normal, [-1, 0, 0], "normal");
  near(now.plane.xAxis, [0, -1, 0], "x");
  near(now.plane.origin, [100, 0, 0], "origin");
  near(world(now.plane, 110, 10), [100, -110, 10], "the circle's centre");
  // Just past it, 91° clockwise about A: B (100 − 20 sin 1°, −20 cos 1°) and C (100 + 20 cos 1°, −20 sin 1°). AB runs
  // along (−sin 1°, −cos 1°) with the inside on its left, (cos 1°, −sin 1°), so it faces outward (−cos 1°, sin 1°, 0):
  // a little against its drawn normal (n · outward = −sin 1° < 0), so the frame takes −outward = (cos 1°, −sin 1°, 0)
  // (it stays on the side it was drawn, facing into the body) and turns 89° rather than 91°: still placed, square and
  // unit (the kernel would refuse a frame that isn't).
  const [s1, c1] = [Math.sin(Math.PI / 180), Math.cos(Math.PI / 180)];
  const past = movePoint(movePoint(doc, t.sketch, t.points[1], 100 - 20 * s1, -20 * c1), t.sketch, t.points[2], 100 + 20 * c1, -20 * s1);
  const p91 = (await placed(await settleKept(kernel, doc, past), made.id)).plane;
  near(p91.normal, [c1, -s1, 0], "the normal against the outward one");
  const dot = (u: readonly number[], v: readonly number[]) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  assert.ok(Math.abs(dot(p91.xAxis, p91.xAxis) - 1) < 1e-15 && Math.abs(dot(p91.xAxis, p91.normal)) < 1e-15, "square and unit");
  // The turned design opened in the app: the sketch drawn on the turned face, not lost.
  const a = await app(turned);
  const d = a.drawings().find((x) => Math.abs(x.plane.normal[0] + 1) < 1e-12);
  assert.ok(d && !d.lost, "drawn on the turned face, not lost");
  assert.ok(await a.close(), "every body freed");
});
