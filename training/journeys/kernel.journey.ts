// The generator on the real kernel (the WASM build, as the app runs it):
// every kept example builds a valid part whose volume is the one its
// sizes give, worked out by hand; drafts the kernel can't build are
// dropped, and the kernel really does drop some.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DESIGN_COMMANDS, buildSpec, specFor } from "@fission/design";
import { EVAL_CASES } from "@fission/testing";
import { nodeKernel } from "../../packages/testing/src/node-kernel.ts";
import { checkDraft, generate, RECIPES, RULES, type Draft } from "../src/index.ts";

const SEED = 0xa11n;
const kernel = nodeKernel();

/** The volume a box, cylinder or sphere of these sizes has, by the formulas; null for the extruded profiles. */
function volumeOf(shape: string, w: number, d: number, h: number): number | null {
  if (shape === "box") return w * d * h;
  if (shape === "cylinder") return Math.PI * (w / 2) ** 2 * h; // πr²h with r = w/2
  if (shape === "sphere") return (4 / 3) * Math.PI * (w / 2) ** 3; // 4/3 πr³
  return null;
}

test("1,000 examples on the real kernel: each builds the part its sizes give", async () => {
  const g = await generate({ seed: SEED, count: 1_000, specs: DESIGN_COMMANDS, rules: RULES, recipes: RECIPES, kernel, heldOut: EVAL_CASES.map((c) => c.prompt) });
  assert.ok(g.ok);
  assert.equal(g.examples.length, 1_000);
  assert.deepEqual(g.conflicts, []);
  // The kernel turned some drafts down (slots shorter than they are wide, for one), so it is checking.
  const refused = Object.entries(g.dropped).filter(([k]) => k.includes("refused")).reduce((n, [, v]) => n + v, 0);
  assert.ok(refused > 0, JSON.stringify(g.dropped));
  let checked = 0;
  for (const e of g.examples) {
    const last = [...e.setup, ...e.commands].filter((c) => c.op === "set_part").at(-1)!;
    const { shape, width, depth, height } = last as { shape: Parameters<typeof specFor>[0]; width: number; depth: number; height: number };
    const view = await buildSpec(kernel, specFor(shape, width, depth, height));
    assert.deepEqual(view.errors, [], `${e.id}: ${e.prompt}`);
    const expected = volumeOf(shape, width, depth, height);
    if (expected !== null) {
      // 1e-6 relative: the kernel's tolerance for mass properties (MASS_PROPS_REL in kernel/src/tolerance.rs).
      assert.ok(Math.abs(view.volume - expected) <= 1e-6 * expected, `${e.id} ${e.prompt}: volume ${view.volume}, by hand ${expected}`);
      checked++;
    } else assert.ok(view.volume > 0);
  }
  assert.ok(checked > 300, `${checked} volumes checked by hand`);
});

test("the real kernel refuses what it can't build, and the draft is dropped", async () => {
  const o = { specs: DESIGN_COMMANDS, rules: RULES, kernel };
  const d = (width: number, depth: number, shape = "box"): Draft => ({ task: "create", setup: [], prompt: "x", commands: [{ op: "set_part", shape, width, depth, height: 10 }] });
  // Each passes parseCommand (every size is a positive length), so the kernel alone is what refuses it.
  assert.match((await checkDraft(d(2e6, 10), o, new Set()))!, /^answer refused: command 1 \(set_part\): the kernel refused it/); // past the 1e6 mm modelling range
  assert.match((await checkDraft(d(1e-4, 10), o, new Set()))!, /^answer refused: command 1 \(set_part\): the kernel refused it/); // under the 1e-3 mm smallest feature
  assert.match((await checkDraft(d(10, 40, "slot"), o, new Set()))!, /^answer refused: command 1 \(set_part\): the kernel refused it/); // a slot wider than it is long
  // The same drafts in range build.
  assert.equal(await checkDraft(d(2e3, 10), o, new Set()), null);
  assert.equal(await checkDraft(d(40, 10, "slot"), o, new Set()), null);
});

test("an export on the real kernel is a whole binary STL", async () => {
  const box = { op: "set_part", shape: "box", width: 40, depth: 30, height: 20 };
  assert.equal(await checkDraft({ task: "export", setup: [box], prompt: "x", commands: [{ op: "export_stl" }] }, { specs: DESIGN_COMMANDS, rules: RULES, kernel }, new Set()), null);
  const stl = await kernel.call("export_stl", specFor("box", 40, 30, 20), "part");
  // A box is 6 faces of 2 triangles: 12 triangles, 84 + 12 × 50 = 684 bytes.
  assert.equal(new DataView(stl.bytes.buffer).getUint32(80, true), 12);
  assert.equal(stl.bytes.length, 684);
});
