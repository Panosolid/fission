// The generator's checks, each shown refusing a draft broken in exactly
// its way, on a stand-in kernel (the real one: journeys/kernel.journey.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCommandList, type Command, type CommandSpec, type WorkspacePlugin } from "@fission/core";
import { systemPrompt } from "@fission/ai";
import { circuitWorkspace } from "@fission/circuit";
import { DESIGN_COMMANDS, designWorkspace } from "@fission/design";
import { imageWorkspace } from "@fission/image";
import { laserWorkspace } from "@fission/laser";
import { layoutWorkspace } from "@fission/layout";
import { manufactureWorkspace } from "@fission/manufacture";
import { renderWorkspace } from "@fission/render";
import { simulateWorkspace } from "@fission/simulate";
import { sliceWorkspace } from "@fission/slice";
import { vectorWorkspace } from "@fission/vector";
import { EVAL_CASES } from "@fission/testing";
import { checkDraft, commandApiVersion, dataset, DESIGN_RECIPES, DESIGN_RULES, generate, hash, isValidation, OFFERED, RECIPES, RULES, toRecord, wording, type Draft, type Recipe } from "../src/index.ts";
import { fakeKernel } from "./fakes.ts";

const box: Command = { op: "set_part", shape: "box", width: 40, depth: 30, height: 20 };
const draft = (commands: Command[], setup: Command[] = []): Draft => ({ task: "create", setup, prompt: "Make a box 40 by 30 by 20 mm.", commands });
const opts = (kernel = fakeKernel()) => ({ specs: DESIGN_COMMANDS, rules: DESIGN_RULES, kernel });
const one = (d: Draft | null, id = "test.one"): Recipe => ({ id, ops: ["set_part"], sample: () => d });

test("hand-worked: FNV-1a matches its published test vectors", () => {
  // From the FNV reference (isthe.com/chongo/tech/comp/fnv): the empty string and "a".
  assert.equal(hash(""), "cbf29ce484222325");
  assert.equal(hash("a"), "af63dc4c8601ec8c");
  assert.equal(hash("foobar"), "85944171f73967e8");
});

test("hand-worked: a set_part is built as the viewer builds it", async () => {
  const k = fakeKernel();
  assert.equal(await checkDraft(draft([{ op: "set_part", shape: "cylinder", width: 25, depth: 25, height: 60 }]), opts(k), new Set()), null);
  // A cylinder's width is its diameter, so the kernel gets radius 25 / 2 = 12.5 and the height 60.
  assert.deepEqual(k.calls, [{ op: "make_cylinder", args: [12.5, 60] }]);
});

test("a prompt's wording leaves out its numbers", () => {
  assert.equal(wording("Make a box 40 by 30.5 by 20 mm."), "make a box # by # by # mm");
  assert.equal(wording("  Reduce the   depth to 15!"), "reduce the depth to #");
});

test("every check refuses a draft broken in its way", async () => {
  const cases: [string, Draft, string][] = [
    ["no answer", draft([]), "no commands"],
    ["a shape Design doesn't have", draft([{ ...box, shape: "cube" }]), "not a valid command: set_part: shape must be one of"],
    ["a size of 0", draft([{ ...box, width: 0 }]), "not a valid command: set_part: width must be a length"],
    ["a size as text", draft([{ ...box, depth: "30" }]), "not a valid command: set_part: depth must be a length"],
    ["a parameter it doesn't have", draft([{ ...box, colour: "red" }]), 'not a valid command: set_part has no parameter "colour"'],
    ["a missing size", draft([{ op: "set_part", shape: "box", width: 40, depth: 30 }]), "not a valid command: set_part needs height"],
    ["a command that isn't offered", draft([{ op: "fillet", radius: 2 }]), 'not a valid command: unknown command "fillet"'],
    ["a bad setup", draft([box], [{ ...box, height: -1 }]), "not a valid command: set_part: height must be a length"],
    ["export with no part", draft([{ op: "export_stl" }]), "answer refused: command 1 (export_stl): there is no part to export"],
  ];
  for (const [name, d, why] of cases) assert.ok((await checkDraft(d, opts(), new Set()))?.startsWith(why), `${name}: ${await checkDraft(d, opts(), new Set())}`);
  // The same draft, mended, passes: so each refusal was for that one break.
  assert.equal(await checkDraft(draft([box]), opts(), new Set()), null);
  assert.equal(await checkDraft(draft([{ op: "export_stl" }], [box]), opts(), new Set()), null);
});

test("the kernel decides: a refusal, failed checks or no volume each drop the draft", async () => {
  const refuses = fakeKernel((op) => {
    if (op === "make_box") throw new Error("box sizes must be at least 0.001 mm");
  });
  assert.equal(await checkDraft(draft([box]), opts(refuses), new Set()), "answer refused: command 1 (set_part): the kernel refused it: box sizes must be at least 0.001 mm");
  const invalid = fakeKernel(() => ({ errors: ["face 3 is not closed"], volume: 1 }));
  assert.equal(await checkDraft(draft([box]), opts(invalid), new Set()), "answer refused: command 1 (set_part): the kernel's checks failed: face 3 is not closed");
  const flat = fakeKernel(() => ({ errors: [], volume: 0 }));
  assert.equal(await checkDraft(draft([box]), opts(flat), new Set()), "answer refused: command 1 (set_part): the part has no volume (0)");
  // The setup is built first, and its refusal is named as the setup's.
  assert.match((await checkDraft(draft([box], [box]), opts(refuses), new Set()))!, /^setup refused: command 1 \(set_part\)/);
  // An STL with no triangles, or one that would lose detail, is refused.
  const empty = fakeKernel((op) => (op === "export_stl" ? { bytes: new Uint8Array(84), rounding: 0, warning: null } : undefined));
  assert.match((await checkDraft(draft([{ op: "export_stl" }], [box]), opts(empty), new Set()))!, /the STL has no triangles \(84 bytes\)/);
  const lossy = fakeKernel((op) => (op === "export_stl" ? { bytes: new Uint8Array(134), rounding: 0.01, warning: "corners move 0.01 mm" } : undefined));
  assert.match((await checkDraft(draft([{ op: "export_stl" }], [box]), opts(lossy), new Set()))!, /would lose detail: corners move 0.01 mm/);
});

test("a held-out evaluation prompt is never a training example, numbers aside", async () => {
  const heldOut = new Set(EVAL_CASES.map((c) => wording(c.prompt)));
  // "Make a box 40 by 30 by 20 mm." is an evaluation case; the same words with other numbers are held out too.
  assert.equal(await checkDraft({ ...draft([box]), prompt: "Make a box 41 by 31 by 21 mm." }, opts(), heldOut), "held out for evaluation");
  assert.equal(await checkDraft({ ...draft([box]), prompt: "Make a box 40 by 30 by 20 cm." }, opts(), heldOut), null);
  for (const seed of [1n, 2n]) {
    const g = await generate({ seed, count: 2_000, specs: DESIGN_COMMANDS, rules: RULES, recipes: RECIPES, kernel: fakeKernel(), heldOut: EVAL_CASES.map((c) => c.prompt) });
    assert.ok(g.ok);
    assert.ok(g.dropped["held out for evaluation"] > 0, "the recipes do write held-out wordings, so this check is doing work");
    for (const e of g.examples) assert.ok(!heldOut.has(wording(e.prompt)), e.prompt);
  }
});

test("the same words about the same part always mean one thing", async () => {
  const g = await generate({ seed: 3n, count: 50, specs: OFFERED, rules: RULES, recipes: [one(draft([box])), one(draft([{ ...box, width: 41 }]), "test.other")], kernel: fakeKernel(), heldOut: [] });
  assert.ok(g.ok);
  assert.equal(g.examples.length, 1);
  assert.ok(g.conflicts.length > 0 && g.conflicts[0].includes('"width":41'), g.conflicts[0]);
});

test("a recipe that can't make a sensible request is counted, not forced", async () => {
  const g = await generate({ seed: 3n, count: 5, specs: OFFERED, rules: RULES, recipes: [one(null)], kernel: fakeKernel(), heldOut: [], maxDrafts: 30 });
  assert.ok(g.ok);
  assert.deepEqual([g.examples.length, g.drafts, g.dropped["not a sensible request"]], [0, 30, 30]);
});

test("a command without a rule or a recipe stops the generator, naming it", async () => {
  const hole: CommandSpec = { op: "hole", summary: "a hole", params: {} };
  const base = { seed: 1n, count: 1, kernel: fakeKernel(), heldOut: [] };
  const noRule = await generate({ ...base, specs: [...DESIGN_COMMANDS, hole], rules: RULES, recipes: RECIPES });
  assert.deepEqual(noRule, { ok: false, error: "no rule builds the command hole: add one beside the recipes (training/src)" });
  const rule = { op: "hole", apply: async () => ({ ok: true as const, state: {} }) };
  const noRecipe = await generate({ ...base, specs: [...DESIGN_COMMANDS, hole], rules: [...RULES, rule], recipes: RECIPES });
  assert.deepEqual(noRecipe, { ok: false, error: "no recipe asks for the command hole: add one beside the rules (training/src)" });
});

test("every command of every workspace has a rule and a recipe", () => {
  const plugins: WorkspacePlugin[] = [designWorkspace, renderWorkspace, simulateWorkspace, manufactureWorkspace, laserWorkspace, sliceWorkspace, circuitWorkspace, vectorWorkspace, imageWorkspace, layoutWorkspace];
  const ops = plugins.flatMap((p) => p.commands.map((c) => c.op));
  assert.ok(ops.includes("set_part") && ops.includes("export_stl"));
  for (const op of ops) {
    assert.ok(RULES.some((r) => r.op === op), `no rule for ${op}`);
    assert.ok(RECIPES.some((r) => r.ops.includes(op)), `no recipe for ${op}`);
  }
});

test("only offered commands are taught: today's panel offers set_part alone", async () => {
  assert.deepEqual(OFFERED.map((c) => c.op), ["set_part"]);
  const g = await generate({ seed: 5n, count: 1_000, specs: OFFERED, rules: RULES, recipes: RECIPES, kernel: fakeKernel(), heldOut: [] });
  assert.ok(g.ok);
  assert.ok(g.examples.every((e) => e.commands.every((c) => c.op === "set_part")));
  assert.ok(!g.examples.some((e) => /\bstl\b/i.test(e.prompt)));
});

test("same seed, same data; another seed, other data", async () => {
  const make = async (seed: bigint) => {
    const g = await generate({ seed, count: 500, specs: DESIGN_COMMANDS, rules: RULES, recipes: RECIPES, kernel: fakeKernel(), heldOut: [] });
    assert.ok(g.ok);
    return dataset(g.examples, { specs: DESIGN_COMMANDS, seed, drafts: g.drafts, dropped: g.dropped });
  };
  const [a, b, c] = [await make(9n), await make(9n), await make(10n)];
  assert.equal(a.train, b.train);
  assert.equal(a.validation, b.validation);
  assert.deepEqual(a.manifest, b.manifest);
  assert.notEqual(a.train, c.train);
});

test("a record is the chat the app has: the same system prompt, and an answer the panel accepts", async () => {
  const g = await generate({ seed: 4n, count: 300, specs: DESIGN_COMMANDS, rules: RULES, recipes: DESIGN_RECIPES, kernel: fakeKernel(), heldOut: [] });
  assert.ok(g.ok);
  for (const e of g.examples) {
    const rec = toRecord(e);
    assert.equal(rec.messages[0].content, systemPrompt(e.setup));
    assert.equal(rec.messages[1].content, e.prompt);
    const parsed = parseCommandList(rec.messages[2].content, DESIGN_COMMANDS);
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.commands, e.commands);
  }
});

test("validation is about a tenth, chosen by id so it never moves between runs", async () => {
  const g = await generate({ seed: 6n, count: 2_000, specs: DESIGN_COMMANDS, rules: RULES, recipes: RECIPES, kernel: fakeKernel(), heldOut: [] });
  assert.ok(g.ok);
  const v = g.examples.filter((e) => isValidation(e, 10)).length;
  // 2,000 examples at 10%: 200 expected, standard deviation √(2000 × 0.1 × 0.9) ≈ 13.4, so 150 to 250 is beyond 3.5 deviations either way.
  assert.ok(v > 150 && v < 250, `${v} of 2,000`);
  // An id whose value mod 100 is 9 is validation at 10%, and not at 9%.
  const e = { ...g.examples[0], id: (109n).toString(16).padStart(16, "0") };
  assert.deepEqual([isValidation(e, 10), isValidation(e, 9)], [true, false]);
  const d = dataset(g.examples, { specs: DESIGN_COMMANDS, seed: 6n, drafts: g.drafts, dropped: g.dropped });
  assert.equal(d.manifest.train + d.manifest.validation, 2_000);
  assert.equal(d.train.split("\n").length - 1, d.manifest.train);
});

test("the command API version changes when a command changes", () => {
  const before = commandApiVersion(DESIGN_COMMANDS);
  assert.equal(before, commandApiVersion(DESIGN_COMMANDS));
  const widened = DESIGN_COMMANDS.map((c) => (c.op === "set_part" ? { ...c, summary: `${c.summary} ` } : c));
  assert.notEqual(before, commandApiVersion(widened));
  assert.notEqual(before, commandApiVersion(OFFERED));
});
