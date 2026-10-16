// The AI evaluation suite: fixed prompts, each with a project state and
// the commands a correct answer contains. runEval works with any
// AIProvider; real providers arrive after the placeholders (A1), and the
// first real runs with Design commands after step 32 (A7). Success rates
// per task type are tracked over time like the fuzzer's metrics.

import { type Command, type CommandSpec } from "@fission/core";
import { askForCommands, type AIProvider } from "@fission/ai";

export type TaskType = "create" | "edit-parameter" | "reference-geometry" | "explain";

export interface EvalCase {
  id: string;
  taskType: TaskType;
  prompt: string;
  /** The project the prompt is asked about, as the commands that build it (empty: a new project). */
  setup: Command[];
  /** Parameters a correct answer must contain; others are ignored. Lengths compare to 1e-9 relative. */
  expected: Partial<Command>[];
  /** Cases that need commands not built yet name what they wait for, and are skipped by runEval. */
  waitsFor?: string;
}

export const EVAL_CASES: readonly EvalCase[] = [
  { id: "box-by-sizes", taskType: "create", prompt: "Make a box 40 by 30 by 20 mm.", setup: [], expected: [{ op: "set_part", shape: "box", width: 40, depth: 30, height: 20 }] },
  { id: "cylinder-diameter", taskType: "create", prompt: "I need a cylinder 25 mm across and 60 mm tall.", setup: [], expected: [{ op: "set_part", shape: "cylinder", width: 25, height: 60 }] },
  { id: "sphere-radius", taskType: "create", prompt: "A ball with a radius of 15 mm.", setup: [], expected: [{ op: "set_part", shape: "sphere", width: 30 }] },
  {
    id: "wider-box",
    taskType: "edit-parameter",
    prompt: "Make it 10 mm wider.",
    setup: [{ op: "set_part", shape: "box", width: 40, depth: 30, height: 20 }],
    expected: [{ op: "set_part", shape: "box", width: 50, depth: 30, height: 20 }],
  },
  {
    id: "hole-top-centre",
    taskType: "reference-geometry",
    prompt: "Add a 5 mm hole in the middle of the top face.",
    setup: [{ op: "set_part", shape: "box", width: 40, depth: 30, height: 20 }],
    expected: [{ op: "hole", face: "<stable id of the top face>", diameter: 5, depth: "through" }],
    waitsFor: "the hole command and stable face ids (steps 32 and 49)",
  },
];

const same = (a: unknown, b: unknown) =>
  typeof a === "number" && typeof b === "number" ? Math.abs(a - b) <= 1e-9 * Math.max(Math.abs(a), Math.abs(b)) : a === b;

/** Whether the answer contains each expected command (by the parameters given), in order. */
export function matches(actual: Command[], expected: Partial<Command>[]): boolean {
  let i = 0;
  for (const c of actual) if (i < expected.length && Object.entries(expected[i]).every(([k, v]) => same(c[k], v))) i++;
  return i === expected.length;
}

export interface EvalResult {
  id: string;
  taskType: TaskType;
  passed: boolean;
  detail: string;
}

/** Runs every ready case against a provider. */
export async function runEval(provider: AIProvider, cases: readonly EvalCase[], specs: readonly CommandSpec[]): Promise<EvalResult[]> {
  const results: EvalResult[] = [];
  for (const c of cases) {
    if (c.waitsFor) continue;
    const system = `You edit a CAD project by answering with commands. The project so far was made by: ${JSON.stringify(c.setup)}`;
    const answer = await askForCommands(provider, { system, messages: [{ role: "user", content: c.prompt }] }, specs);
    const passed = answer.ok && matches(answer.commands, c.expected);
    results.push({ id: c.id, taskType: c.taskType, passed, detail: answer.ok ? JSON.stringify(answer.commands) : answer.error });
  }
  return results;
}

/** Success rate per task type, 0–1. */
export function successRates(results: readonly EvalResult[]): Partial<Record<TaskType, number>> {
  const out: Partial<Record<TaskType, number>> = {};
  for (const t of new Set(results.map((r) => r.taskType))) {
    const of = results.filter((r) => r.taskType === t);
    out[t] = of.filter((r) => r.passed).length / of.length;
  }
  return out;
}
