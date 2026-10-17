// Examples as training records: the chat the model will see in the app
// (the same system prompt, the user's words, the answer as the JSON the
// panel parses), one per line, split into training and validation.

import type { CommandSpec } from "@fission/core";
import { systemPrompt } from "@fission/ai";
import { commandApiVersion, type Example } from "./generate.ts";

export interface ChatRecord {
  id: string;
  task: string;
  recipe: string;
  messages: [{ role: "system"; content: string }, { role: "user"; content: string }, { role: "assistant"; content: string }];
}

/** `specs`: the commands offered, which the system prompt describes (AI4), as the panel's does. */
export function toRecord(e: Example, specs: readonly CommandSpec[]): ChatRecord {
  return {
    id: e.id,
    task: e.task,
    recipe: e.recipe,
    messages: [
      { role: "system", content: systemPrompt(e.setup, specs) },
      { role: "user", content: e.prompt },
      { role: "assistant", content: JSON.stringify({ commands: e.commands }) },
    ],
  };
}

/** Whether an example goes to validation: decided by its id, so it never moves between runs. */
export function isValidation(e: Example, percent: number): boolean {
  return Number(BigInt(`0x${e.id}`) % 100n) < percent;
}

export interface Dataset {
  train: string;
  validation: string;
  manifest: Manifest;
}

export interface Manifest {
  generator: string;
  /** The command API the examples were made for; a model is labelled with it. */
  commandApi: string;
  ops: string[];
  seed: string;
  train: number;
  validation: number;
  byTask: Record<string, number>;
  byRecipe: Record<string, number>;
  drafts: number;
  dropped: Record<string, number>;
}

const jsonl = (records: readonly ChatRecord[]) => records.map((x) => `${JSON.stringify(x)}\n`).join("");
const tally = (xs: readonly string[]) => Object.fromEntries([...new Set(xs)].sort().map((k) => [k, xs.filter((x) => x === k).length]));

/** The files a run writes: train.jsonl, validation.jsonl and manifest.json. */
export function dataset(examples: readonly Example[], o: { specs: readonly CommandSpec[]; seed: bigint; drafts: number; dropped: Record<string, number>; validationPercent?: number }): Dataset {
  const percent = o.validationPercent ?? 10;
  const train = examples.filter((e) => !isValidation(e, percent)).map((e) => toRecord(e, o.specs));
  const validation = examples.filter((e) => isValidation(e, percent)).map((e) => toRecord(e, o.specs));
  return {
    train: jsonl(train),
    validation: jsonl(validation),
    manifest: {
      generator: "fission-training 0.1",
      commandApi: commandApiVersion(o.specs),
      ops: o.specs.map((s) => s.op),
      seed: o.seed.toString(),
      train: train.length,
      validation: validation.length,
      byTask: tally(examples.map((e) => e.task)),
      byRecipe: tally(examples.map((e) => e.recipe)),
      drafts: o.drafts,
      dropped: o.dropped,
    },
  };
}
