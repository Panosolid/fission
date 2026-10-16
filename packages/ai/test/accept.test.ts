// Accepted AI commands are one labelled undo step (step 20c): on the real
// history, with a stand-in project of two numbers and a run that does each
// command as a user's button would.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHistory, type Command } from "@fission/core";
import { acceptCommands } from "../src/index.ts";

function rig() {
  const part = { width: 40, depth: 30 };
  const h = createHistory({ capture: () => JSON.stringify(part), restore: (s) => Object.assign(part, JSON.parse(s)) });
  /** The user's own commands; each reports its change as the shell's projectChanged would. */
  const run = (c: Command) => {
    if (c.op !== "set_size") throw new Error(`no command ${c.op}`);
    const v = c.value as number;
    if (!(v > 0)) throw new Error(`${c.key} must be greater than 0, got ${v}`);
    part[c.key as "width" | "depth"] = v;
    h.record(`Change ${c.key}`, c.key as string);
  };
  return { part, h, run };
}
const size = (key: string, value: number): Command => ({ op: "set_size", key, value });

test("hand-worked: two accepted commands are one step labelled AI:, undone in one go", () => {
  const { part, h, run } = rig();
  acceptCommands(h, "AI: made it 50 × 35", [size("width", 50), size("depth", 35)], run);
  // Two changes, one step: 40×30 → 50×35. One undo is back at 40×30; nothing older to undo.
  assert.equal(h.undoLabel(), "AI: made it 50 × 35");
  assert.equal(h.undo(), "AI: made it 50 × 35");
  assert.deepEqual(part, { width: 40, depth: 30 });
  assert.equal(h.canUndo(), false);
  assert.equal(h.redo(), "AI: made it 50 × 35");
  assert.deepEqual(part, { width: 50, depth: 35 });
});

test("the label gets the AI: prefix once", () => {
  const { h, run } = rig();
  acceptCommands(h, "  widened the box ", [size("width", 60)], run);
  assert.equal(h.undoLabel(), "AI: widened the box");
});

test("a refused command takes back the ones before it: never half a change", () => {
  const { part, h, run } = rig();
  acceptCommands(h, "first", [size("width", 45)], run);
  assert.throws(() => acceptCommands(h, "AI: two", [size("depth", 33), size("width", -1)], run), /width must be greater than 0, got -1/);
  // Depth 33 was applied, then put back: 45×30, and Undo still names the first step.
  assert.deepEqual(part, { width: 45, depth: 30 });
  assert.equal(h.undoLabel(), "AI: first");
});

test("nothing to accept, or no label, is refused before anything runs", () => {
  const { h, run } = rig();
  assert.throws(() => acceptCommands(h, "AI: nothing", [], run), /no commands to accept/);
  assert.throws(() => acceptCommands(h, "  ", [size("width", 50)], run), /needs a label/);
  assert.equal(h.canUndo(), false);
});
