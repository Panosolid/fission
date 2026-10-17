// Every example says what its command does: an independent reading of the
// words (reader.ts) must give the same commands, over thousands of seeded
// examples. Then each way a recipe could mislabel its words is put in on
// purpose, and the check must catch it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DESIGN_COMMANDS } from "@fission/design";
import { matches } from "@fission/testing";
import type { Command } from "@fission/core";
import { DESIGN_RECIPES, DESIGN_RULES, generate, type Example, type Recipe } from "../src/index.ts";
import { fakeKernel } from "./fakes.ts";
import { read } from "./reader.ts";

const same = (a: Command[], b: Command[]) => a.length === b.length && matches(a, b) && matches(b, a);

/** Examples whose words read as something else, with what they read as. */
function disagreements(examples: readonly Example[]): string[] {
  const out: string[] = [];
  for (const e of examples) {
    const reading = read(e.prompt, e.setup);
    if (!reading || !same(reading, e.commands)) out.push(`${e.recipe}: "${e.prompt}" on ${JSON.stringify(e.setup)}: the command says ${JSON.stringify(e.commands)}, the words read as ${JSON.stringify(reading)}`);
  }
  return out;
}

const run = async (seed: bigint, recipes: readonly Recipe[] = DESIGN_RECIPES, count = 3_000) => {
  const g = await generate({ seed, count, specs: DESIGN_COMMANDS, rules: DESIGN_RULES, recipes, kernel: fakeKernel(), heldOut: [] });
  assert.ok(g.ok);
  return g;
};

test("3 seeds × 3,000 examples: the words and the command always agree", async () => {
  for (const seed of [1n, 2n, 0x5eedn]) {
    const g = await run(seed);
    assert.equal(g.examples.length, 3_000);
    assert.deepEqual(g.conflicts, [], `seed ${seed}`);
    const bad = disagreements(g.examples);
    assert.deepEqual(bad.slice(0, 5), [], `seed ${seed}: ${bad.length} disagree`);
    // Every recipe and every shape is reached, so the agreement covers them all.
    assert.deepEqual(new Set(g.examples.map((e) => e.recipe)), new Set(DESIGN_RECIPES.map((r) => r.id)));
    assert.equal(new Set(g.examples.flatMap((e) => e.commands.map((c) => c.shape)).filter(Boolean)).size, 7);
  }
});

/** A recipe made wrong on purpose: each of its drafts passes through `spoil`. */
const spoiled = (spoil: (e: { prompt: string; commands: Command[] }) => Command[] | null): Recipe[] =>
  DESIGN_RECIPES.map((r) => ({
    ...r,
    sample(rand) {
      const d = r.sample(rand);
      const commands = d && spoil(d);
      return d && commands ? { ...d, commands } : d;
    },
  }));
const setPart = (cs: Command[], change: (c: Command) => Command) => cs.map((c) => (c.op === "set_part" ? change(c) : c));

test("deliberate breaks: each mislabelling is caught", async () => {
  const breaks: [string, (e: { prompt: string; commands: Command[] }) => Command[] | null][] = [
    // A radius written as the diameter (the A10 models' own mistake).
    ["radius as diameter", (e) => (/radius/.test(e.prompt) ? setPart(e.commands, (c) => ({ ...c, width: (c.width as number) / 2 })) : null)],
    // Centimetres not converted.
    ["cm not converted", (e) => (/\d ?(cm|centimet)/.test(e.prompt) ? setPart(e.commands, (c) => ({ ...c, width: (c.width as number) / 10 })) : null)],
    // Inches taken as 25 mm.
    ["inch as 25 mm", (e) => (/\d ?(in\b|inch|")/.test(e.prompt) ? setPart(e.commands, (c) => ({ ...c, height: ((c.height as number) / 25.4) * 25 })) : null)],
    // "Wider" made narrower.
    ["sign flipped", (e) => (/wider/.test(e.prompt) ? setPart(e.commands, (c) => ({ ...c, width: (c.width as number) - 2 })) : null)],
    // Width and depth swapped.
    ["width and depth swapped", (e) => (e.commands[0]?.depth !== e.commands[0]?.width ? setPart(e.commands, (c) => ({ ...c, width: c.depth, depth: c.width })) : null)],
    // An edit forgets a size it should keep.
    ["kept size changed", (e) => (/twice as tall/.test(e.prompt) ? setPart(e.commands, (c) => ({ ...c, width: (c.width as number) + 1 })) : null)],
    // The wrong shape.
    ["wrong shape", (e) => (/\bball\b/.test(e.prompt) ? setPart(e.commands, (c) => ({ ...c, shape: "cylinder" })) : null)],
    // The export forgotten.
    ["export dropped", (e) => (/\bstl\b/i.test(e.prompt) && e.commands.length === 2 ? e.commands.slice(0, 1) : null)],
  ];
  for (const [name, spoil] of breaks) {
    const g = await run(7n, spoiled(spoil), 1_500);
    assert.ok(disagreements(g.examples).length > 0, `${name} was not caught`);
  }
});
