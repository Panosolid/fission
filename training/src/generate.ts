// The generator: random drafts from the recipes, each kept only if every
// command passes the same checks as a model's answer (parseCommand), the
// project it is asked about and the answer both build on the real kernel,
// and it isn't one of the held-out evaluation prompts.

import { commandListSchema, parseCommand, type Command, type CommandSpec, type KernelCalls } from "@fission/core";
import { seeded } from "@fission/testing";
import type { CommandRule, Draft, Recipe, ReplayState } from "./recipe.ts";

export interface Example extends Draft {
  /** Stable id: a hash of the setup and the prompt. */
  id: string;
  recipe: string;
}

export interface GenerateOptions {
  seed: bigint;
  /** How many examples to keep. */
  count: number;
  /** The commands the model is offered; drafts using any other are not made. */
  specs: readonly CommandSpec[];
  rules: readonly CommandRule[];
  recipes: readonly Recipe[];
  kernel: KernelCalls;
  /** Prompts the model is scored on (EVAL_CASES and HELD_OUT_CASES): no example may read like one, numbers aside. */
  heldOut: readonly string[];
  /** Give up after this many drafts (default 20 per example asked for). */
  maxDrafts?: number;
}

export type Generated =
  | { ok: true; examples: Example[]; drafts: number; dropped: Record<string, number>; conflicts: string[] }
  | { ok: false; error: string };

/** FNV-1a, 64 bits, as hex: a stable short id for text. */
export function hash(text: string): string {
  let h = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(text)) h = ((h ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn;
  return h.toString(16).padStart(16, "0");
}

/** The command API's version: a hash of the schema the model answers with. A model is labelled with the version it learned. */
export function commandApiVersion(specs: readonly CommandSpec[]): string {
  return hash(JSON.stringify(commandListSchema(specs)));
}

/** A prompt with its numbers taken out, to compare wordings: "Make a box 40 by 30 mm." → "make a box # by # mm". */
export function wording(prompt: string): string {
  return prompt
    .toLowerCase()
    .replace(/\d+(\.\d+)?/g, "#")
    .replace(/[.?!]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Builds commands in order on the kernel; the first refusal, or null when all build. */
export async function replay(kernel: KernelCalls, rules: readonly CommandRule[], commands: readonly Command[], state: ReplayState = {}): Promise<{ state: ReplayState } | { refused: string }> {
  for (const [i, c] of commands.entries()) {
    const rule = rules.find((x) => x.op === c.op);
    if (!rule) return { refused: `command ${i + 1}: no rule builds ${c.op}` };
    const applied = await rule.apply(kernel, state, c);
    if (!applied.ok) return { refused: `command ${i + 1} (${c.op}): ${applied.reason}` };
    state = applied.state;
  }
  return { state };
}

/** Why a draft can't be used, or null. Exported so tests can show each check refusing. */
export async function checkDraft(d: Draft, o: Pick<GenerateOptions, "specs" | "rules" | "kernel">, heldOut: ReadonlySet<string>): Promise<string | null> {
  if (d.commands.length === 0) return "no commands";
  for (const c of [...d.setup, ...d.commands]) {
    const parsed = parseCommand(c, o.specs);
    if (!parsed.ok) return `not a valid command: ${parsed.error}`;
    // What parseCommand passes is what the model sends; it must be the command itself, not a cleaned-up copy.
    if (JSON.stringify(parsed.command) !== JSON.stringify(c)) return "not a valid command: changed by parsing";
  }
  if (heldOut.has(wording(d.prompt))) return "held out for evaluation";
  const before = await replay(o.kernel, o.rules, d.setup);
  if ("refused" in before) return `setup refused: ${before.refused}`;
  const after = await replay(o.kernel, o.rules, d.commands, before.state);
  if ("refused" in after) return `answer refused: ${after.refused}`;
  return null;
}

/** Counts by the reason's first words ("answer refused: command 1 (set_part)"), so the report stays short. */
const reasonKey = (why: string) => why.split(":").slice(0, 2).join(":").trim();

/** Same seed and code, same examples, in the same order. */
export async function generate(o: GenerateOptions): Promise<Generated> {
  const offered = new Set(o.specs.map((s) => s.op));
  for (const op of offered) {
    if (!o.rules.some((x) => x.op === op)) return { ok: false, error: `no rule builds the command ${op}: add one beside the recipes (training/src)` };
    if (!o.recipes.some((x) => x.ops.includes(op))) return { ok: false, error: `no recipe asks for the command ${op}: add one beside the rules (training/src)` };
  }
  const recipes = o.recipes.filter((x) => x.ops.every((op) => offered.has(op)));
  const heldOut = new Set(o.heldOut.map(wording));
  const r = seeded(o.seed);
  const examples: Example[] = [];
  const answers = new Map<string, string>(); // setup + prompt → answer
  const dropped: Record<string, number> = {};
  const conflicts: string[] = [];
  const drop = (why: string) => (dropped[why] = (dropped[why] ?? 0) + 1);
  const maxDrafts = o.maxDrafts ?? 20 * o.count;
  let drafts = 0;
  while (examples.length < o.count && drafts < maxDrafts) {
    drafts++;
    const recipe = recipes[Math.floor(r.next() * recipes.length)];
    const d = recipe.sample(r);
    if (!d) {
      drop("not a sensible request");
      continue;
    }
    const key = `${JSON.stringify(d.setup)}\n${d.prompt}`;
    const answer = JSON.stringify(d.commands);
    const seen = answers.get(key);
    if (seen !== undefined) {
      // The same words about the same part must always mean the same thing.
      if (seen !== answer) conflicts.push(`${d.prompt} (${recipe.id}): ${seen} vs ${answer}`);
      drop("duplicate");
      continue;
    }
    const why = await checkDraft(d, o, heldOut);
    if (why) {
      drop(reasonKey(why));
      continue;
    }
    answers.set(key, answer);
    examples.push({ ...d, id: hash(key), recipe: recipe.id });
  }
  return { ok: true, examples, drafts, dropped, conflicts };
}
