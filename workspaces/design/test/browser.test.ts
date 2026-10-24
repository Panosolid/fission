import { test } from "node:test";
import assert from "node:assert/strict";
import { XY_PLANE, type Feature } from "@fission/core";
import { browserTree, rowItem, type BrowserNode } from "../src/browser.ts";
import { partDocument, type DesignDocument } from "../src/document.ts";
import { addSketch, drawLine } from "../src/sketch.ts";

/** Each node as "label" or [label, children], for comparing whole trees. */
const shape = (nodes: BrowserNode[]): unknown[] => nodes.map((n) => (n.children ? [n.label, shape(n.children)] : n.label));

const ORIGIN = ["Origin", ["XY plane", "XZ plane", "YZ plane", "X axis", "Y axis", "Z axis"]];

const feature = (id: string, summary: string, suppressed = false): Feature => ({
  id,
  intent: { type: "box", parameters: {}, summary },
  provenance: { self: { workspace: "design", id, label: id }, from: [] },
  dependsOn: [],
  suppressed,
});

test("a hand-built two-feature document: rows in build order, one body, the origin", () => {
  // Written out by hand, not from partDocument: the timeline lists both
  // features numbered 1 and 2 with their summaries, the second suppressed;
  // the first still builds, so there is one body.
  const doc: DesignDocument = {
    version: 2,
    nextId: 3,
    sketches: [],
    profiles: [{ id: "profile-1", kind: "slot", width: 40, depth: 10, plane: XY_PLANE }],
    timeline: { features: [feature("feature-1", "Extrude: slot by 5 mm"), feature("feature-2", "Box: 1 × 2 × 3 mm", true)] },
  };
  assert.deepEqual(shape(browserTree(doc)), [
    ["Timeline", ["1. Extrude: slot by 5 mm", "2. Box: 1 × 2 × 3 mm (suppressed)"]],
    ["Sketches", []],
    ["Profiles", ["Slot with round ends profile"]],
    ["Bodies", ["Body 1"]],
    ORIGIN,
  ]);
  // Rows keep the feature's own id, so a click names the feature.
  assert.deepEqual(browserTree(doc)[0].children!.map((n) => n.id), ["feature-1", "feature-2"]);
  // A profile's row keeps the profile's id, so a click names the profile.
  assert.deepEqual(browserTree(doc)[2].children!.map((n) => n.id), ["profile-1"]);
});

test("with every feature suppressed there is no body", () => {
  const doc: DesignDocument = { version: 2, nextId: 2, profiles: [], sketches: [], timeline: { features: [feature("feature-1", "Sphere: ⌀4 mm", true)] } };
  assert.deepEqual(shape(browserTree(doc))[3], ["Bodies", []]);
});

test("today's one-step part: feature #1 with its intent summary", () => {
  assert.deepEqual(shape(browserTree(partDocument("cylinder", 40, 30, 20))), [
    ["Timeline", ["1. Cylinder: ⌀40 × 20 mm"]],
    ["Sketches", []],
    ["Profiles", []],
    ["Bodies", ["Body 1"]],
    ORIGIN,
  ]);
});

test("ids are unique across the tree, so a highlighted row is never ambiguous", () => {
  const ids: string[] = [];
  const walk = (ns: BrowserNode[]) => ns.forEach((n) => (ids.push(n.id), n.children && walk(n.children)));
  // With two sketches, each a timeline row and a Sketches row.
  const one = addSketch(partDocument("plate", 40, 30, 20));
  walk(browserTree(addSketch(one.doc).doc));
  assert.equal(ids.filter((id) => id.includes(one.id)).length, 2);
  assert.equal(new Set(ids).size, ids.length);
});

test("sketches are timeline rows in build order and rows of their own in Sketches", () => {
  // A box, then Sketch 1 and Sketch 2 on the ground plane: ids from the counter, 2 and 3.
  const one = addSketch(partDocument("box", 40, 30, 20));
  const two = addSketch(drawLine(one.doc, one.id, [0, 0], [5, 0]).doc);
  const tree = browserTree(two.doc);
  assert.deepEqual(shape(tree).slice(0, 2), [
    ["Timeline", ["1. Box: 40 × 30 × 20 mm", "2. Sketch 1 on the XY plane", "3. Sketch 2 on the XY plane"]],
    ["Sketches", ["Sketch 1", "Sketch 2"]],
  ]);
  // sketch-2's line took point-3, point-4 and line-5, so the second sketch is sketch-6.
  assert.deepEqual(tree[0].children!.map((n) => n.id), ["feature-1", "sketch-2", "sketch-6"]);
  assert.deepEqual(tree[1].children!.map((n) => n.id), ["sketches/sketch-2", "sketches/sketch-6"]);
});

test("U0a: the Timeline and the Origin start folded, every other group open, like Fusion's browser", () => {
  // Fusion's browser has no Timeline group (the bar along the bottom is its
  // timeline) and shows the Origin folded; Sketches, Profiles and Bodies are
  // the rows people use, so they start open. Leaves never fold.
  const tree = browserTree(partDocument("box", 40, 30, 20));
  assert.deepEqual(
    tree.map((n) => [n.id, n.startsFolded === true]),
    [
      ["timeline", true],
      ["sketches", false],
      ["profiles", false],
      ["bodies", false],
      ["origin", true],
    ],
  );
  const leaves = tree.flatMap((n) => n.children ?? []);
  assert.ok(leaves.length > 0 && leaves.every((n) => n.startsFolded === undefined), "no row is a folding group");
});

test("hand-worked: the item each row's menu and double-click act on; a Body row's is the feature that makes it", () => {
  // The hand-built document of the first test, with a third feature: feature-1 (an extrude) builds Body 1,
  // feature-2 is suppressed so builds none, feature-3 (a box) builds Body 2.
  const doc: DesignDocument = {
    version: 2,
    nextId: 4,
    sketches: [],
    profiles: [{ id: "profile-1", kind: "slot", width: 40, depth: 10, plane: XY_PLANE }],
    timeline: { features: [feature("feature-1", "Extrude: slot by 5 mm"), feature("feature-2", "Box: 1 × 2 × 3 mm", true), feature("feature-3", "Box: 4 × 5 × 6 mm")] },
  };
  assert.equal(rowItem("body-1", doc), "feature-1");
  assert.equal(rowItem("body-2", doc), "feature-3", "Body 2 skips the suppressed feature-2");
  assert.equal(rowItem("body-3", doc), null, "no third body");
  assert.equal(rowItem("feature-2", doc), "feature-2", "a Timeline row is its own item");
  assert.equal(rowItem("sketches/sketch-9", doc), "sketch-9", "a Sketches row is its sketch");
  assert.equal(rowItem("profile-1", doc), null, "a profile row has no item");
  assert.equal(rowItem("origin-xy", doc), null, "nor an origin row");
  // With feature-1 failed in the last rebuild, Body 1 is feature-3's (bodyRows numbers by place among the builders,
  // so feature-3 keeps "body-2" and there is no body-1 row).
  assert.equal(rowItem("body-2", doc, new Set(["feature-1"])), "feature-3");
  assert.equal(rowItem("body-1", doc, new Set(["feature-1"])), null);
});
