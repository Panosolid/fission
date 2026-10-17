// Writes a training set: train.jsonl, validation.jsonl and manifest.json.
//   npm run generate -w @fission/training -- --count 5000 --seed 1 --out data [--ops set_part,export_stl]
// Needs the WASM build first (`npm run build` in apps/fission). --seed is
// decimal; --ops defaults to what the assistant panel offers (OFFERED).
// Node-only, like the tests, so the type check (browser types) skips it.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { DESIGN_COMMANDS } from "@fission/design";
import { EVAL_CASES, HELD_OUT_CASES } from "@fission/testing";
import { nodeKernel } from "../../packages/testing/src/node-kernel.ts";
import { dataset, generate, OFFERED, RECIPES, RULES } from "../src/index.ts";

const { values } = parseArgs({ options: { count: { type: "string", default: "2000" }, seed: { type: "string", default: "1" }, out: { type: "string", default: "data" }, ops: { type: "string" } } });
if (!/^\d+$/.test(values.seed!) || !/^\d+$/.test(values.count!)) throw new Error("--seed and --count take whole decimal numbers");
const seed = BigInt(values.seed!);
const specs = values.ops ? DESIGN_COMMANDS.filter((c) => values.ops!.split(",").includes(c.op)) : OFFERED;

const run = await generate({ seed, count: Number(values.count), specs, rules: RULES, recipes: RECIPES, kernel: nodeKernel(), heldOut: [...EVAL_CASES, ...HELD_OUT_CASES].map((c) => c.prompt) });
if (!run.ok) throw new Error(run.error);
if (run.conflicts.length > 0) throw new Error(`the same words meant two things, a recipe bug:\n${run.conflicts.join("\n")}`);
const out = dataset(run.examples, { specs, seed, drafts: run.drafts, dropped: run.dropped });
mkdirSync(values.out!, { recursive: true });
writeFileSync(join(values.out!, "train.jsonl"), out.train);
writeFileSync(join(values.out!, "validation.jsonl"), out.validation);
writeFileSync(join(values.out!, "manifest.json"), `${JSON.stringify(out.manifest, null, 2)}\n`);
console.log(`${out.manifest.train} training and ${out.manifest.validation} validation examples from ${run.drafts} drafts, in ${values.out}; dropped: ${JSON.stringify(run.dropped)}`);
