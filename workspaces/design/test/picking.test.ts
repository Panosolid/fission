import { test } from "node:test";
import assert from "node:assert/strict";
import { createSelection } from "@fission/core";
import { pickChange, type SelectionChange } from "../src/picking.ts";

test("a pick on a face names that face of the feature on screen", () => {
  // The default box's top face is kernel face 1 (primitives.rs lists the
  // faces −Z, +Z, −Y, +Y, −X, +X), so a click on it is "face:feature-1/1".
  assert.deepEqual(pickChange({ face: 1, shift: false }, "feature-1"), { change: "set", item: { kind: "face", id: "face:feature-1/1" } });
  assert.deepEqual(pickChange({ face: 1, shift: true }, "feature-1"), { change: "toggle", item: { kind: "face", id: "face:feature-1/1" } });
  assert.deepEqual(pickChange({ face: null, shift: false }, "feature-1"), { change: "clear" });
  assert.deepEqual(pickChange({ face: null, shift: true }, "feature-1"), { change: "keep" });
});

test("click, Shift-click, Shift-click again and a click on nothing, applied to a real selection", () => {
  const selection = createSelection();
  const apply = (c: SelectionChange) => {
    if (c.change === "set") selection.set([c.item]);
    else if (c.change === "toggle") selection.toggle(c.item);
    else if (c.change === "clear") selection.clear();
  };
  const ids = () => selection.items.map((r) => r.id);
  apply(pickChange({ face: 1, shift: false }, "feature-1"));
  assert.deepEqual(ids(), ["face:feature-1/1"]);
  apply(pickChange({ face: 2, shift: true }, "feature-1")); // adds
  assert.deepEqual(ids(), ["face:feature-1/1", "face:feature-1/2"]);
  apply(pickChange({ face: null, shift: true }, "feature-1")); // a Shift slip keeps both
  assert.deepEqual(ids(), ["face:feature-1/1", "face:feature-1/2"]);
  apply(pickChange({ face: 1, shift: true }, "feature-1")); // takes it out
  assert.deepEqual(ids(), ["face:feature-1/2"]);
  apply(pickChange({ face: 5, shift: false }, "feature-1")); // a plain click replaces
  assert.deepEqual(ids(), ["face:feature-1/5"]);
  apply(pickChange({ face: null, shift: false }, "feature-1"));
  assert.deepEqual(ids(), []);
});

test("a pick with a bad face index is refused, not turned into an id", () => {
  assert.throws(() => pickChange({ face: -1, shift: false }, "feature-1"), /kernel index/);
  assert.throws(() => pickChange({ face: 1.5, shift: false }, "feature-1"), /kernel index/);
});
