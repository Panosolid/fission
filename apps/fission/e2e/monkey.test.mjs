// The monkey tester's pure half (monkey-core.mjs), worked by hand, and its
// plants (monkey-plants.mjs) still applying. Run by `npm test`.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { documentRules, editFile, expectedView, nextAction, rng, shrink, signature, SKIP_TARGETS, weighted } from "./monkey-core.mjs";
import { MONKEY_PLANTS } from "./monkey-plants.mjs";

/** A box, Sketch 2 on XY, and an extrude of Sketch 2: the smallest file with both kinds of body. */
function design() {
  return {
    nextId: 6,
    profiles: [],
    sketches: [{ id: "sketch-2", plane: "XY", points: [{ id: "point-4", x: 0, y: 0 }], curves: [{ id: "circle-5", kind: "circle", centre: "point-4", radius: 5 }] }],
    timeline: {
      features: [
        { id: "feature-1", dependsOn: [], intent: { type: "box", parameters: { width: 40, depth: 30, height: 20 } }, suppressed: false },
        { id: "sketch-2", dependsOn: [], intent: { type: "sketch", parameters: { plane: "XY" } }, suppressed: false },
        { id: "feature-3", dependsOn: ["sketch-2"], intent: { type: "extrude", parameters: { sketch: "sketch-2", distance: 10 } }, suppressed: false },
      ],
    },
  };
}

test("the generator replays from its seed", () => {
  const a = rng(7);
  const b = rng(7);
  const c = rng(8);
  const first = Array.from({ length: 20 }, a);
  assert.deepEqual(Array.from({ length: 20 }, b), first);
  assert.notDeepEqual(Array.from({ length: 20 }, c), first);
  assert.ok(first.every((x) => x >= 0 && x < 1));
});

test("a weight of 0 is never picked, and the others in proportion", () => {
  const random = rng(1);
  const counts = { a: 0, b: 0, never: 0 };
  for (let i = 0; i < 4000; i++) counts[weighted(random, { a: 1, b: 3, never: 0 })]++;
  assert.equal(counts.never, 0);
  // b is 3 of every 4 picks: 3000 expected; 4000 draws spread it by about sqrt(4000 × 3/4 × 1/4) ≈ 27, so 150 is over 5 of those.
  assert.ok(Math.abs(counts.b - 3000) < 150, `b picked ${counts.b} times`);
});

test("what a file should show, worked by hand", () => {
  // Nothing suppressed, no marker: the box and the extrude both build, so 2 bodies; nothing is after a marker.
  assert.deepEqual(expectedView(design()), {
    items: [
      { id: "feature-1", suppressed: false, rolledBack: false },
      { id: "sketch-2", suppressed: false, rolledBack: false },
      { id: "feature-3", suppressed: false, rolledBack: false },
    ],
    bodies: 2,
  });
  // The marker on Sketch 2: the extrude after it is rolled back, leaving the box alone (1 body).
  const marked = design();
  marked.timeline.marker = "sketch-2";
  assert.equal(expectedView(marked).bodies, 1);
  assert.deepEqual(expectedView(marked).items.map((i) => i.rolledBack), [false, false, true]);
  // The marker at the start: nothing builds, everything is after it.
  marked.timeline.marker = "start";
  assert.equal(expectedView(marked).bodies, 0);
  assert.deepEqual(expectedView(marked).items.map((i) => i.rolledBack), [true, true, true]);
  // Sketch 2 suppressed: the extrude of it can't build, the box still does (1 body).
  const off = design();
  off.timeline.features[1].suppressed = true;
  assert.equal(expectedView(off).bodies, 1);
  // Sketch 2 deleted: the extrude builds from its kept shape only if one was kept.
  const gone = design();
  gone.timeline.features.splice(1, 1);
  gone.sketches = [];
  assert.equal(expectedView(gone).bodies, 1);
  gone.kept = { "feature-3": { points: [], curves: [] } };
  assert.equal(expectedView(gone).bodies, 2);
});

test("a good file keeps every rule, and each broken rule is named", () => {
  assert.deepEqual(documentRules(design()), []);
  const twice = design();
  twice.sketches[0].curves.push({ id: "point-4", kind: "line" });
  assert.deepEqual(documentRules(twice), ["id point-4 is used twice"]);
  const counter = design();
  counter.nextId = 5; // circle-5 was handed out, so the counter must be past 5
  assert.deepEqual(documentRules(counter), ["id circle-5 is not below nextId 5"]);
  const marker = design();
  marker.timeline.marker = "feature-9";
  assert.deepEqual(documentRules(marker), ["the marker names feature-9, which is not in the timeline"]);
  const order = design();
  [order.timeline.features[1], order.timeline.features[2]] = [order.timeline.features[2], order.timeline.features[1]];
  assert.deepEqual(documentRules(order), ["feature-3 is built from sketch-2, which comes after it"]);
  const lost = design();
  lost.timeline.features.splice(1, 1);
  assert.deepEqual(documentRules(lost), ["sketch sketch-2 has 0 timeline items"]);
});

test("the edits made to a file before opening it", () => {
  const text = JSON.stringify({ workspaces: { design: design() } });
  const read = (edit, at) => JSON.parse(editFile(text, edit, at)).workspaces.design.timeline;
  assert.equal(read("suppress", 4).features[1].suppressed, true); // 4 mod 3 items = item 1, Sketch 2
  assert.equal(read("marker", 2).marker, "feature-3");
  assert.equal(read("marker-start", 0).marker, "start");
  assert.deepEqual(read("swap", 0).features.map((f) => f.id), ["sketch-2", "feature-1", "feature-3"]);
  assert.deepEqual(read("drop", 1).features.map((f) => f.id), ["feature-1", "feature-3"]);
  assert.equal(read("bad-number", 0).features[0].intent.parameters.width, -1); // item 0, its first number (width), value 0 of [-1, 0, 1e308, "12"]
  assert.deepEqual(JSON.parse(editFile(text, "same", 0)), JSON.parse(text));
  assert.throws(() => JSON.parse(editFile(text, "truncate", 40)), SyntaxError); // 45% of the file
});

test("the shrinker finds the actions that matter, by hand", async () => {
  const list = [1, 2, 3, 4, 5, 6, 7, 8];
  // Fails only with both 3 and 6: nothing smaller fails, and dropping either passes.
  assert.deepEqual((await shrink(list, async (l) => l.includes(3) && l.includes(6))).list, [3, 6]);
  assert.deepEqual((await shrink(list, async (l) => l.includes(5))).list, [5]);
  // A list that fails only whole stays whole.
  assert.deepEqual((await shrink(list, async (l) => l.length === 8)).list, list);
  // The budget is kept.
  let tries = 0;
  await shrink(list, async () => (tries++, false), 5);
  assert.equal(tries, 5);
});

test("a failure's kind ignores its numbers", () => {
  assert.equal(signature({ check: "Bodies group matches the file", message: "3 bodies listed, the file builds 2" }), signature({ check: "Bodies group matches the file", message: "1 bodies listed, the file builds 0" }));
  assert.notEqual(signature({ check: "a", message: "x 1" }), signature({ check: "b", message: "x 1" }));
});

test("the next action is the same for the same seed, and never a skipped button", () => {
  const page = { targets: [...SKIP_TARGETS].map((sel) => ({ sel })).concat([{ sel: "#extrude", hot: true }, { sel: "#ok" }]), inputs: [{ sel: "#width", type: "number" }], rows: [], sketching: false, haveSave: true };
  const run = (seed) => {
    const random = rng(seed);
    return Array.from({ length: 300 }, () => nextAction(random, page));
  };
  assert.deepEqual(run(3), run(3));
  const clicked = run(3).filter((a) => a.do === "click").map((a) => a.sel);
  assert.ok(clicked.length > 20);
  assert.ok(clicked.every((s) => !SKIP_TARGETS.has(s)), "a skipped button was clicked");
});

test("every monkey plant still applies to its file", () => {
  for (const [name, p] of Object.entries(MONKEY_PLANTS))
    for (const e of p.edits) {
      const text = readFileSync(new URL(`../../../${e.file}`, import.meta.url), "utf8");
      assert.equal(text.split(e.find).length, 2, `${name}: its text is not in ${e.file} exactly once`);
    }
});
