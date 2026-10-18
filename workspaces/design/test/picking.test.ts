import { test } from "node:test";
import assert from "node:assert/strict";
import { createSelection } from "@fission/core";
import { nameBody } from "../src/naming.ts";
import { pickChange, type SelectionChange } from "../src/picking.ts";
import { BOX_VIEW, onlyBody } from "./views.ts";

const box = onlyBody(BOX_VIEW, nameBody("feature-1", BOX_VIEW, () => null));

test("a pick on a face names that face of the feature on screen", () => {
  // The default box's top face is kernel face 1 (primitives.rs lists the
  // faces −Z, +Z, −Y, +Y, −X, +X), so a click on it is "face:feature-1/top".
  assert.deepEqual(pickChange({ face: 1, shift: false }, box), { change: "set", item: { kind: "face", id: "face:feature-1/top" } });
  assert.deepEqual(pickChange({ face: 1, shift: true }, box), { change: "toggle", item: { kind: "face", id: "face:feature-1/top" } });
  assert.deepEqual(pickChange({ face: null, shift: false }, box), { change: "clear" });
  assert.deepEqual(pickChange({ face: null, shift: true }, box), { change: "keep" });
});

test("a pick on an edge names that edge, and wins over a face", () => {
  // The default box's top front edge joins corners 4 and 5 (primitives.rs:
  // the −Z face makes edges 0-3, the +Z face 4-7, and its first is 4→5),
  // where the front and the top meet: "edge:feature-1/front+top".
  assert.deepEqual(pickChange({ face: null, edge: 4, shift: false }, box), { change: "set", item: { kind: "edge", id: "edge:feature-1/front+top" } });
  assert.deepEqual(pickChange({ face: null, edge: 4, shift: true }, box), { change: "toggle", item: { kind: "edge", id: "edge:feature-1/front+top" } });
  assert.deepEqual(pickChange({ face: 1, edge: 4, shift: false }, box), { change: "set", item: { kind: "edge", id: "edge:feature-1/front+top" } });
  assert.deepEqual(pickChange({ face: 1, edge: null, shift: false }, box), { change: "set", item: { kind: "face", id: "face:feature-1/top" } });
  assert.deepEqual(pickChange({ face: null, edge: null, shift: false }, box), { change: "clear" });
  assert.throws(() => pickChange({ face: null, edge: -2, shift: false }, box), /kernel index/);
});

test("click, Shift-click, Shift-click again and a click on nothing, applied to a real selection", () => {
  const selection = createSelection();
  const apply = (c: SelectionChange) => {
    if (c.change === "set") selection.set([c.item]);
    else if (c.change === "toggle") selection.toggle(c.item);
    else if (c.change === "clear") selection.clear();
  };
  const ids = () => selection.items.map((r) => r.id);
  apply(pickChange({ face: 1, shift: false }, box));
  assert.deepEqual(ids(), ["face:feature-1/top"]);
  apply(pickChange({ face: 2, shift: true }, box)); // adds
  assert.deepEqual(ids(), ["face:feature-1/top", "face:feature-1/front"]);
  apply(pickChange({ face: null, shift: true }, box)); // a Shift slip keeps both
  assert.deepEqual(ids(), ["face:feature-1/top", "face:feature-1/front"]);
  apply(pickChange({ face: 1, shift: true }, box)); // takes it out
  assert.deepEqual(ids(), ["face:feature-1/front"]);
  apply(pickChange({ face: 5, shift: false }, box)); // a plain click replaces
  assert.deepEqual(ids(), ["face:feature-1/right"]);
  apply(pickChange({ face: null, shift: false }, box));
  assert.deepEqual(ids(), []);
});

test("a pick with a bad face index is refused, not turned into an id", () => {
  assert.throws(() => pickChange({ face: -1, shift: false }, box), /kernel index/);
  assert.throws(() => pickChange({ face: 1.5, shift: false }, box), /kernel index/);
});

test("before a body is built, or on a face or edge with no name, a click changes nothing", () => {
  assert.deepEqual(pickChange({ face: 1, shift: false }, null), { change: "keep" });
  // Past the box's faces (an index the names don't cover), and a face the kernel gave no role.
  assert.deepEqual(pickChange({ face: 6, shift: false }, box), { change: "keep" });
  const unnamed = nameBody("feature-1", { ...BOX_VIEW, face_roles: [null, ...BOX_VIEW.face_roles.slice(1)] } as typeof BOX_VIEW, () => null);
  assert.deepEqual(pickChange({ face: 0, shift: true }, onlyBody(BOX_VIEW, unnamed)), { change: "keep" });
  // Empty space still clears.
  assert.deepEqual(pickChange({ face: null, shift: false }, null), { change: "clear" });
});
