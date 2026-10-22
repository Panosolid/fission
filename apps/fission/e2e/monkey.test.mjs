// The monkey tester's pure half (monkey-core.mjs), worked by hand, and its
// plants (monkey-plants.mjs) still applying. Run by `npm test`.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { documentRules, editFile, expectedView, kernelVerdict, modelVolume, nextAction, outlineArea, reusedIds, editLeaks, rng, shrink, signature, SKIP_TARGETS, weighted } from "./monkey-core.mjs";
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
    solids: ["feature-1", "feature-3"],
    bodies: 2,
    rows: [
      { row: "body-1", place: 1, id: "feature-1" },
      { row: "body-2", place: 2, id: "feature-3" },
    ],
  });
  // Finding 5: the box failed (the bar marks it): no row for it, and the extrude keeps its number, Body 2.
  assert.deepEqual(expectedView(design(), new Set(["feature-1"])).rows, [{ row: "body-2", place: 2, id: "feature-3" }]);
  assert.equal(expectedView(design(), new Set(["feature-1"])).bodies, 1);
  // A failed mark on an item that builds nothing anyway (a sketch) changes no row.
  assert.equal(expectedView(design(), new Set(["sketch-2"])).bodies, 2);
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

test("whether the kernel builds a solid, from the file where it is plain", () => {
  const box = (width, depth = 30, height = 20) => ({ intent: { type: "box", parameters: { width, depth, height } } });
  // The kernel takes 0.001 mm to 1,000,000 mm; judged only ten times inside or outside that.
  assert.equal(kernelVerdict(box(40)), "builds");
  assert.equal(kernelVerdict(box(0.01)), "builds");
  assert.equal(kernelVerdict(box(1e5)), "builds");
  for (const bad of [-5, 0, -0, 1e-9, 1e-4, 1e308, 999999999 * 100, NaN, Infinity, null, "12"]) assert.equal(kernelVerdict(box(bad)), "fails", `width ${bad}`);
  // Between the bands: not judged (0.001 and 1e6 are the kernel's own limits; 0.0002 and 5e6 sit either side of them).
  for (const near of [0.0002, 0.001, 0.005, 1e6, 5e6]) assert.equal(kernelVerdict(box(near)), null, `width ${near}`);
  // One bad size fails it, whichever.
  assert.equal(kernelVerdict(box(40, 30, -1)), "fails");
  assert.equal(kernelVerdict({ intent: { type: "cylinder", parameters: { diameter: 40, height: 0 } } }), "fails");
  assert.equal(kernelVerdict({ intent: { type: "sphere", parameters: { diameter: 7 } } }), "builds");
  // A sketch extrude: a distance of 0 or no number fails; any other distance is not judged (its outline decides).
  const ex = (distance) => ({ intent: { type: "extrude", parameters: { sketch: "sketch-2", distance } } });
  assert.equal(kernelVerdict(ex(0)), "fails");
  assert.equal(kernelVerdict(ex(null)), "fails");
  assert.equal(kernelVerdict(ex(10)), null);
  // A ready-made outline's extrude is not judged.
  assert.equal(kernelVerdict({ intent: { type: "extrude", parameters: { profile: "profile-1", distance: 0 } } }), null);
});

test("volumes from the file, worked by hand", () => {
  const d = design();
  const [box, , extrude] = d.timeline.features;
  assert.equal(modelVolume(d, box), 24000); // 40 × 30 × 20
  const near = (a, b) => assert.ok(Math.abs(a - b) <= 1e-12 * b, `${a} is not ${b}`); // the two sides round π products in a different order
  near(modelVolume(d, extrude), 250 * Math.PI); // a circle of radius 5 (area 25π) by 10
  // A right triangle with legs 3 and 4, its lines in any direction: area 3 × 4 / 2 = 6.
  const tri = {
    points: [{ id: "a", x: 0, y: 0 }, { id: "b", x: 3, y: 0 }, { id: "c", x: 0, y: 4 }],
    curves: [{ kind: "line", start: "a", end: "b" }, { kind: "line", start: "c", end: "b" }, { kind: "line", start: "c", end: "a" }],
  };
  assert.equal(outlineArea(tri), 6);
  // One line short of a loop, or an arc in it: the model can't say.
  assert.equal(outlineArea({ ...tri, curves: tri.curves.slice(0, 2) }), null);
  assert.equal(outlineArea({ ...tri, curves: [...tri.curves.slice(0, 2), { kind: "arc", start: "c", end: "a" }] }), null);
  // Two loops (27e: a projected face beside a drawn one): not one outline, so null, not the first loop walked twice (12).
  const two = {
    points: [...tri.points, { id: "d", x: 10, y: 0 }, { id: "e", x: 13, y: 0 }, { id: "f", x: 10, y: 4 }],
    curves: [...tri.curves, { kind: "line", start: "d", end: "e" }, { kind: "line", start: "e", end: "f" }, { kind: "line", start: "f", end: "d" }],
  };
  assert.equal(outlineArea(two), null);
  // Projected edges (27d) join the outline by Design's own rules: the model doesn't say.
  assert.equal(outlineArea({ ...tri, projected: [{ id: "projection-9", feature: "feature-1", edge: "front+top", made: "x" }] }), null);
  near(modelVolume(d, { intent: { type: "cylinder", parameters: { diameter: 10, height: 2 } } }), 50 * Math.PI); // π·5²·2
  near(modelVolume(d, { intent: { type: "sphere", parameters: { diameter: 6 } } }), 36 * Math.PI); // (4/3)π·3³
  // The sketch gone: the kept shape's area counts.
  const gone = design();
  gone.sketches = [];
  gone.kept = { "feature-3": tri };
  assert.equal(modelVolume(gone, gone.timeline.features[2]), 60); // 6 × 10
});

test("add-solid appends a body with the next id", () => {
  const text = JSON.stringify({ workspaces: { design: design() } });
  const d = JSON.parse(editFile(text, "add-solid", 1)).workspaces.design; // 1: a cylinder
  assert.equal(d.nextId, 7);
  const f = d.timeline.features.at(-1);
  assert.equal(f.id, "feature-6");
  assert.deepEqual(f.intent, { type: "cylinder", parameters: { diameter: 14, height: 30 }, summary: "Cylinder: ⌀14 × 30 mm" });
  assert.deepEqual(documentRules(d), []);
  assert.equal(expectedView(d).bodies, 3);
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
  // 27e: a projection's id is one of the counter's too, and it names what it made in its sketch.
  const projected = design();
  projected.sketches[0].projected = [{ id: "point-4", feature: "feature-1", edge: "front+top", made: "circle-5" }];
  assert.deepEqual(documentRules(projected), ["id point-4 is used twice"]);
  projected.sketches[0].projected = [{ id: "projection-6", feature: "feature-1", edge: "front+top", made: "line-9" }];
  projected.nextId = 7;
  assert.deepEqual(documentRules(projected), ["projection projection-6 names line-9, which is not in sketch sketch-2"]);
});

test("a new id comes from the counter, worked by hand (25a5)", () => {
  const before = design(); // ids 1 to 5 handed out, the counter at 6
  // Nothing new: nothing to judge.
  assert.deepEqual(reusedIds(before, design()), []);
  // A new sketch taking the counter's 6 (and the counter moving to 7) is right.
  const drawn = design();
  drawn.sketches.push({ id: "sketch-6", plane: "XY", points: [], curves: [] });
  drawn.timeline.features.push({ id: "sketch-6", dependsOn: [], intent: { type: "sketch", parameters: { plane: "XY" } }, suppressed: false });
  drawn.nextId = 7;
  assert.deepEqual(reusedIds(before, drawn), []);
  // The "reuse-ids" plant's way: Sketch 2 and its extrude deleted leave feature-1 the largest id in use, so a sketch made next
  // takes 1 + 1 = 2 instead of the counter's 6: sketch-2 again, a number handed out before.
  const deleted = design();
  deleted.timeline.features = deleted.timeline.features.filter((f) => f.id === "feature-1");
  deleted.sketches = [];
  const reused = structuredClone(deleted);
  reused.sketches.push({ id: "sketch-2", plane: "XY", points: [], curves: [] });
  reused.timeline.features.push({ id: "sketch-2", dependsOn: [], intent: { type: "sketch", parameters: { plane: "XY" } }, suppressed: false });
  assert.deepEqual(reusedIds(deleted, reused), ["sketch-2 is new, but the counter was already at 6: its number was handed out before"]);
  // One below the counter (5) is caught; the counter itself (6) is not: the boundary, exactly.
  const five = structuredClone(deleted);
  five.profiles.push({ id: "profile-5" });
  assert.equal(reusedIds(deleted, five).length, 1);
  const six = structuredClone(deleted);
  six.profiles.push({ id: "profile-6" });
  assert.deepEqual(reusedIds(deleted, six), []);
  // A curve or point inside a sketch counts as well as a feature.
  const curve = design();
  curve.sketches[0].curves.push({ id: "line-2", kind: "line" });
  assert.equal(reusedIds(before, curve).length, 1);
});

test("an Edit feature step changes only its item's sizes, worked by hand (25a5)", () => {
  const before = design();
  // Extrude feature-3's distance 10 → 25: one item, only its sizes. Nothing leaks.
  const edited = design();
  edited.timeline.features[2].intent.parameters.distance = 25;
  assert.deepEqual(editLeaks(before, edited), []);
  // The box's width 40 → 50 with its summary: still only its sizes.
  const box = design();
  box.timeline.features[0].intent = { type: "box", parameters: { width: 50, depth: 30, height: 20 }, summary: "Box: 50 × 30 × 20 mm" };
  assert.deepEqual(editLeaks(before, box), []);
  // The "edit-leaks" plant's way: the box changed too when the extrude was edited.
  const leak = structuredClone(edited);
  leak.timeline.features[0].intent.parameters.height = 25;
  assert.deepEqual(editLeaks(before, leak), ["2 items changed (feature-1, feature-3), not one"]);
  // The edited item suppressed, the marker moved, the sketch or the counter touched: each named.
  const off = structuredClone(edited);
  off.timeline.features[2].suppressed = true;
  assert.deepEqual(editLeaks(before, off), ["feature-3 changed more than its sizes"]);
  const marker = structuredClone(edited);
  marker.timeline.marker = "sketch-2";
  assert.deepEqual(editLeaks(before, marker), ["the marker moved"]);
  const sketch = structuredClone(edited);
  sketch.sketches[0].curves[0].radius = 6;
  assert.deepEqual(editLeaks(before, sketch), ["its sketches changed"]);
  const counter = structuredClone(edited);
  counter.nextId = 7;
  assert.deepEqual(editLeaks(before, counter), ["its nextId changed"]);
  // An item gone or moved is not an edit at all.
  const dropped = design();
  dropped.timeline.features.pop();
  assert.deepEqual(editLeaks(before, dropped), ["the items went from feature-1, sketch-2, feature-3 to feature-1, sketch-2"]);
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
  const page = { prompt: false, targets: [...SKIP_TARGETS].map((sel) => ({ sel })).concat([{ sel: "#extrude", hot: true }, { sel: "#ok" }]), inputs: [{ sel: "#width", type: "number" }], rows: [], sketching: false, haveSave: true };
  const run = (seed) => {
    const random = rng(seed);
    return Array.from({ length: 300 }, () => nextAction(random, page));
  };
  assert.deepEqual(run(3), run(3));
  const clicked = run(3).filter((a) => a.do === "click").map((a) => a.sel);
  assert.ok(clicked.length > 20);
  assert.ok(clicked.every((s) => !SKIP_TARGETS.has(s)), "a skipped button was clicked");
});

test("MONKEY_FOCUS=edit opens item menus and double-clicks about four times as often (25a5)", () => {
  const page = { prompt: false, targets: [{ sel: "#extrude", hot: true }], inputs: [], rows: [{ sel: "li[data-item=\"sketch-2\"]", sketch: true }], sketching: false, haveSave: true };
  const share = (focus) => {
    const random = rng(5);
    const all = Array.from({ length: 4000 }, () => nextAction(random, { ...page, focus }));
    return all.filter((a) => a.do === "menu" || a.do === "double").length / all.length;
  };
  // Without it menu and double weigh 5 + 4 = 9 of 30 + 12 + 3 + 4 + 2 + 12 + 5 + 6 + 4 + 3 + 6 + 1 + 7 + 4 + 3 + 4 = 106: 8.5%.
  // With it 20 + 16 = 36 of 133: 27%. 4000 draws spread a share by about sqrt(0.27 × 0.73 / 4000) ≈ 0.7%, so 2% is three of those.
  assert.ok(Math.abs(share(undefined) - 9 / 106) < 0.02, `without focus ${share(undefined)}`);
  assert.ok(Math.abs(share("edit") - 36 / 133) < 0.02, `with focus ${share("edit")}`);
});

test("every monkey plant still applies to its file", () => {
  for (const [name, p] of Object.entries(MONKEY_PLANTS))
    for (const e of p.edits) {
      const text = readFileSync(new URL(`../../../${e.file}`, import.meta.url), "utf8");
      assert.equal(text.split(e.find).length, 2, `${name}: its text is not in ${e.file} exactly once`);
    }
});
