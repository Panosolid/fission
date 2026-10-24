// Insert ▾ (insert.ts, U0d): every preset is a whole new body at the
// marker at the default sizes, never a change to a body already there;
// the menu lists every shape and an honest, off Community item.
import { test } from "node:test";
import assert from "node:assert/strict";
import { partDocument, partFeature, type DesignDocument } from "../src/document.ts";
import { SHAPES } from "../src/commands.ts";
import { COMMUNITY_OFF, INSERT_SIZES, inserted, insertSections, insertStep } from "../src/insert.ts";
import { freshDesign } from "../src/start-fresh.ts";

test("hand-worked: a box inserted into an empty design, then a cylinder beside it, each its own body", () => {
  // Empty design, counter 1: the box takes feature-1 at 40 × 30 × 20 (the panel's defaults), the counter goes to 2.
  const one = inserted(freshDesign(), "box");
  assert.equal(one.id, "feature-1");
  assert.deepEqual(one.doc, partDocument("box", 40, 30, 20));
  // The cylinder takes feature-2, a diameter of 40 (the width) and a height of 20; the box is untouched.
  const two = inserted(one.doc, "cylinder");
  assert.equal(two.id, "feature-2");
  assert.equal(two.doc.nextId, 3);
  assert.deepEqual(two.doc.timeline.features.map((f) => f.id), ["feature-1", "feature-2"]);
  assert.deepEqual(two.doc.timeline.features[0], one.doc.timeline.features[0], "the box is the same feature, the same sizes");
  assert.deepEqual(two.doc.timeline.features[1].intent.parameters, { diameter: 40, height: 20 });
  // A profile shape takes a second id for its outline: a slot is feature-3 with profile-4.
  const three = inserted(two.doc, "slot");
  assert.equal(three.id, "feature-3");
  assert.deepEqual(three.doc.profiles.map((p) => p.id), ["profile-4"]);
  assert.equal(three.doc.nextId, 5);
  assert.deepEqual(INSERT_SIZES, { width: 40, depth: 30, height: 20 });
});

test("an insert never changes a body already there, whatever the part is (a change in place is the Shape choice's)", () => {
  for (const kind of SHAPES) {
    const before = partDocument("star", 50, 50, 5);
    const after = inserted(before, kind).doc;
    assert.equal(after.timeline.features.length, 2, `${kind}: one more body`);
    assert.deepEqual(after.timeline.features[0], before.timeline.features[0], `${kind}: the star is as it was`);
    // partDocument gives the star feature-1 and its outline profile-1, the counter at 2: the new body is feature-2.
    assert.equal(partFeature(after)?.id, "feature-2", `${kind}: the new body is the part the panel edits`);
  }
});

test("at the marker: put in just after it, and the marker moves onto it", () => {
  // Box feature-1, then a second box feature-2, marker back on feature-1: the insert goes between them.
  const two = inserted(partDocument("box", 40, 30, 20), "box").doc;
  const rolled: DesignDocument = { ...two, timeline: { ...two.timeline, marker: "feature-1" } };
  const after = inserted(rolled, "sphere").doc;
  assert.deepEqual(after.timeline.features.map((f) => f.id), ["feature-1", "feature-3", "feature-2"]);
  assert.equal(after.timeline.marker, "feature-3");
});

test("the menu: every shape under Presets in the command's order, then Community, off and saying why", () => {
  const ran: string[] = [];
  const [presets, community] = insertSections((k) => ran.push(k));
  assert.equal(presets.heading, "Presets");
  assert.deepEqual(presets.items.map((i) => [i.id, i.label, i.data?.shape]), [
    ["insert-box", "Box", "box"],
    ["insert-cylinder", "Cylinder", "cylinder"],
    ["insert-sphere", "Sphere", "sphere"],
    ["insert-l-bracket", "L-bracket", "l-bracket"],
    ["insert-plate", "Plate", "plate"],
    ["insert-slot", "Slot", "slot"],
    ["insert-star", "Star", "star"],
  ]);
  assert.equal(presets.items[3].title, "Add an L-bracket as a new body");
  assert.equal(presets.items[0].title, "Add a box as a new body");
  presets.items[4].run();
  assert.deepEqual(ran, ["plate"]);
  assert.equal(community.heading, "From Community");
  assert.equal(community.items.length, 1);
  assert.equal(community.items[0].off, COMMUNITY_OFF, "a placeholder never pretends to work");
  assert.equal(insertStep("l-bracket"), "Insert L-bracket");
});
