// Preview, then accept as one undo step or reject (AI2): on the real
// history, with a stand-in part whose one command sets its shape and sizes
// as Design's set_part does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHistory, type Command } from "@fission/core";
import { proposeAction, systemPrompt } from "../src/index.ts";
import { rng, SEED } from "./fakes.ts";

function rig() {
  const part: Record<string, unknown> = { shape: "box", width: 40, depth: 30, height: 20 };
  const h = createHistory({ capture: () => JSON.stringify(part), restore: (s) => Object.assign(part, JSON.parse(s)) });
  const run = (c: Command) => {
    if (c.op !== "set_part") throw new Error(`no command ${c.op}`);
    for (const [k, v] of Object.entries(c)) if (k !== "op") part[k] = v;
    h.record("Change part");
  };
  const options = (label = "box 50 × 30 × 20 mm") => ({ label, history: h, run, current: () => ({ ...part }), state: () => JSON.stringify(part) });
  return { part, h, run, options };
}
const setPart = (sizes: Record<string, unknown>): Command => ({ op: "set_part", ...sizes });

test("hand-worked: the preview lists only what changes, before and after, and changes nothing", async () => {
  const { part, h, options } = rig();
  const action = proposeAction([setPart({ shape: "box", width: 50, depth: 30, height: 20 })], options());
  // The part is a box 40 × 30 × 20; the command asks for 50 × 30 × 20: only width moves, 40 → 50.
  assert.deepEqual(await action.preview(), {
    label: "AI: box 50 × 30 × 20 mm",
    highlights: [],
    parameterChanges: [{ feature: "set_part", parameter: "width", before: 40, after: 50 }],
  });
  assert.deepEqual(part, { shape: "box", width: 40, depth: 30, height: 20 });
  assert.equal(h.canUndo(), false, "a preview is not a step");
});

test("accept is one AI: step that Undo takes back whole; reject leaves everything as it was", async () => {
  const { part, h, options } = rig();
  const yes = proposeAction([setPart({ shape: "cylinder", width: 25 }), setPart({ height: 60 })], options("cylinder ⌀25 × 60 mm"));
  await yes.accept();
  assert.deepEqual(part, { shape: "cylinder", width: 25, depth: 30, height: 60 });
  assert.equal(h.undoLabel(), "AI: cylinder ⌀25 × 60 mm");
  h.undo();
  assert.deepEqual(part, { shape: "box", width: 40, depth: 30, height: 20 });
  assert.equal(h.canUndo(), false, "two commands, one step");

  const no = proposeAction([setPart({ width: 99 })], options());
  no.reject();
  assert.equal(no.decided, true);
  assert.deepEqual(part, { shape: "box", width: 40, depth: 30, height: 20 });
  assert.equal(h.canUndo(), false);
  await assert.rejects(no.accept(), /already accepted or rejected/, "a rejected change can't be accepted later");
});

test("an accept after the project changed is refused, and changes nothing", async () => {
  const { part, h, run, options } = rig();
  const action = proposeAction([setPart({ width: 50 })], options());
  run(setPart({ depth: 10 })); // the user edits while the preview is up
  await assert.rejects(action.accept(), /changed after this preview.*nothing was changed/);
  assert.deepEqual(part, { shape: "box", width: 40, depth: 10, height: 20 });
  assert.equal(h.undoLabel(), "Change part", "the user's own edit is the last step");
});

test("a command that fails puts everything back: no half change, no step", async () => {
  const { part, h, options } = rig();
  const action = proposeAction([setPart({ width: 70 }), { op: "explode" }], options());
  await assert.rejects(action.accept(), /no command explode/);
  assert.deepEqual(part, { shape: "box", width: 40, depth: 30, height: 20 });
  assert.equal(h.canUndo(), false);
});

test("nothing to propose is refused", () => {
  assert.throws(() => proposeAction([], rig().options()), /no commands/);
});

test("seeded random: accept then undo, or reject, always leaves the part exactly as it was", async () => {
  const r = rng(SEED);
  for (let run = 0; run < 300; run++) {
    const { part, h, options } = rig();
    const before = JSON.stringify(part);
    const commands = Array.from({ length: 1 + r.int(3) }, () =>
      setPart(Object.fromEntries(["shape", "width", "depth", "height"].filter(() => r.next() < 0.5).map((k) => [k, k === "shape" ? r.pick(["box", "cylinder", "sphere"]) : 1 + r.int(100)]))),
    );
    const action = proposeAction(commands, options(`run ${run}`));
    const preview = await action.preview();
    // The model of the part: apply each command's fields in order.
    const expected: Record<string, unknown> = JSON.parse(before);
    for (const c of commands) for (const [k, v] of Object.entries(c)) if (k !== "op") expected[k] = v;
    const changes = preview.parameterChanges.length > 0;
    if (r.next() < 0.5) {
      action.reject();
    } else {
      await action.accept();
      assert.deepEqual(part, expected, `seed ${SEED}, run ${run}`);
      assert.equal(h.canUndo(), JSON.stringify(expected) !== before, `seed ${SEED}, run ${run}: a step only when something changed`);
      if (h.canUndo()) {
        assert.equal(h.undoLabel(), `AI: run ${run}`);
        h.undo();
        assert.equal(h.canUndo(), false, `seed ${SEED}, run ${run}: exactly one step`);
      }
    }
    assert.equal(JSON.stringify(part), before, `seed ${SEED}, run ${run}`);
    // The preview is honest when the commands don't overlap: it says something changes exactly when something would.
    if (commands.length === 1) assert.equal(changes, JSON.stringify(expected) !== before, `seed ${SEED}, run ${run}`);
  }
});

test("the prompt names the part as its commands and asks to keep unmentioned sizes", () => {
  const p = systemPrompt([{ op: "set_part", shape: "box", width: 40, depth: 30, height: 20 }], []);
  assert.match(p, /The part now is made by these commands: \[\{"op":"set_part","shape":"box","width":40,"depth":30,"height":20\}\]/);
  assert.match(p, /Keep every size the user doesn't mention/);
});
