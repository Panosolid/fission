// The AI evaluation suite: fixed prompts, each with a project state and
// the commands a correct answer contains. runEval works with any
// AIProvider; scripts/ai-eval-ollama.ts runs it on real models through
// Ollama (the A10 check, AI3). Success rates
// per task type are tracked over time like the fuzzer's metrics.

import { type Command, type CommandSpec } from "@fission/core";
import { askForCommands, systemPrompt, type AIProvider } from "@fission/ai";

export type TaskType = "create" | "edit-parameter" | "reference-geometry" | "explain";

export interface EvalCase {
  id: string;
  taskType: TaskType;
  prompt: string;
  /** The project the prompt is asked about, as the commands that build it (empty: a new project). */
  setup: Command[];
  /** Parameters the part must have after the answer; others are ignored. Lengths compare to 1e-9 relative. */
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
  // AI3: more cases, so the A10 check has more than four answers to judge. Expected sizes worked by hand.
  { id: "cube", taskType: "create", prompt: "A 25 mm cube.", setup: [], expected: [{ op: "set_part", shape: "box", width: 25, depth: 25, height: 25 }] },
  // 4 cm = 40 mm, 3 cm = 30 mm, 2 cm = 20 mm.
  { id: "box-in-cm", taskType: "create", prompt: "Make a box 4 cm by 3 cm by 2 cm.", setup: [], expected: [{ op: "set_part", shape: "box", width: 40, depth: 30, height: 20 }] },
  { id: "plate-sizes", taskType: "create", prompt: "A plate 80 by 60 mm and 5 mm thick.", setup: [], expected: [{ op: "set_part", shape: "plate", width: 80, depth: 60, height: 5 }] },
  // Radius 6 → diameter (width) 12; long = height 100.
  { id: "rod-radius", taskType: "create", prompt: "A rod with a 6 mm radius, 100 mm long.", setup: [], expected: [{ op: "set_part", shape: "cylinder", width: 12, height: 100 }] },
  {
    id: "twice-as-tall",
    taskType: "edit-parameter",
    prompt: "Make it twice as tall.",
    setup: [{ op: "set_part", shape: "box", width: 40, depth: 30, height: 20 }],
    expected: [{ op: "set_part", shape: "box", width: 40, depth: 30, height: 40 }], // 2 × 20
  },
  {
    id: "depth-to-15",
    taskType: "edit-parameter",
    prompt: "Reduce the depth to 15.",
    setup: [{ op: "set_part", shape: "box", width: 40, depth: 30, height: 20 }],
    expected: [{ op: "set_part", shape: "box", width: 40, depth: 15, height: 20 }],
  },
  {
    id: "shorter-cylinder",
    taskType: "edit-parameter",
    prompt: "Make it 10 mm shorter.",
    setup: [{ op: "set_part", shape: "cylinder", width: 25, depth: 30, height: 60 }],
    expected: [{ op: "set_part", shape: "cylinder", width: 25, height: 50 }], // 60 − 10
  },
  {
    id: "box-to-sphere",
    taskType: "edit-parameter",
    prompt: "Turn it into a sphere just as wide.",
    setup: [{ op: "set_part", shape: "box", width: 40, depth: 30, height: 20 }],
    expected: [{ op: "set_part", shape: "sphere", width: 40 }],
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

// AI4: the held-out set. Written before the prompt was changed and never
// used while writing it, so a better score here means the prompt got
// better at the job, not at these particular sentences. It covers the same
// kinds of mistake the first run found (radius, cube, units) in new words,
// plus answers that must stay as they are (a diameter is not doubled).
// Never edit these to match a prompt; add new held-out cases instead.
const BOX: Command = { op: "set_part", shape: "box", width: 40, depth: 30, height: 20 };
const CYLINDER: Command = { op: "set_part", shape: "cylinder", width: 25, depth: 30, height: 60 };
export const HELD_OUT_CASES: readonly EvalCase[] = [
  // Radius 9 → diameter (width) 18.
  { id: "held-cylinder-radius", taskType: "create", prompt: "A cylinder with a radius of 9 mm and a height of 40 mm.", setup: [], expected: [{ op: "set_part", shape: "cylinder", width: 18, height: 40 }] },
  // Already a diameter: stays 40, not 80.
  { id: "held-cylinder-diameter", taskType: "create", prompt: "A cylinder 40 mm in diameter and 10 mm high.", setup: [], expected: [{ op: "set_part", shape: "cylinder", width: 40, height: 10 }] },
  // "Across" is the diameter: 5 cm = 50 mm.
  { id: "held-sphere-cm", taskType: "create", prompt: "A sphere 5 cm across.", setup: [], expected: [{ op: "set_part", shape: "sphere", width: 50 }] },
  // A cube is a box with three equal sides: 18, 18, 18.
  { id: "held-cube-sides", taskType: "create", prompt: "Make a cube, 18 mm on each side.", setup: [], expected: [{ op: "set_part", shape: "box", width: 18, depth: 18, height: 18 }] },
  // 3 cm = 30 mm on every side.
  { id: "held-cube-cm", taskType: "create", prompt: "I want a cube with 3 cm sides.", setup: [], expected: [{ op: "set_part", shape: "box", width: 30, depth: 30, height: 30 }] },
  // 1 inch = 25.4 mm exactly, so 2 in = 50.8 mm.
  { id: "held-box-inches", taskType: "create", prompt: "A box 2 inches wide, 1 inch deep and 1 inch tall.", setup: [], expected: [{ op: "set_part", shape: "box", width: 50.8, depth: 25.4, height: 25.4 }] },
  // 0.5 m = 500 mm.
  { id: "held-box-metres", taskType: "create", prompt: "A box 0.5 m wide, 200 mm deep and 100 mm tall.", setup: [], expected: [{ op: "set_part", shape: "box", width: 500, depth: 200, height: 100 }] },
  // Radius 1.5 cm = 15 mm → diameter 30 mm.
  { id: "held-ball-radius-cm", taskType: "create", prompt: "A ball, radius 1.5 cm.", setup: [], expected: [{ op: "set_part", shape: "sphere", width: 30 }] },
  // New radius 20 → width 40; the height 60 is kept.
  { id: "held-set-radius", taskType: "edit-parameter", prompt: "Make the radius 20 mm.", setup: [CYLINDER], expected: [{ op: "set_part", shape: "cylinder", width: 40, height: 60 }] },
  // 2 cm = 20 mm, so the height 20 becomes 40.
  { id: "held-taller-cm", taskType: "edit-parameter", prompt: "Make it 2 cm taller.", setup: [BOX], expected: [{ op: "set_part", shape: "box", width: 40, depth: 30, height: 40 }] },
  // The sphere's width 30 is its diameter, so radius 15; double → 30, diameter 60.
  { id: "held-double-radius", taskType: "edit-parameter", prompt: "Double its radius.", setup: [{ op: "set_part", shape: "sphere", width: 30, depth: 30, height: 30 }], expected: [{ op: "set_part", shape: "sphere", width: 60 }] },
  // 40 / 2 = 20.
  { id: "held-half-width", taskType: "edit-parameter", prompt: "Make it half as wide.", setup: [BOX], expected: [{ op: "set_part", shape: "box", width: 20, depth: 30, height: 20 }] },
  // "Across" is already the diameter: 50; the height 60 is kept.
  { id: "held-across-edit", taskType: "edit-parameter", prompt: "Make it 50 mm across.", setup: [CYLINDER], expected: [{ op: "set_part", shape: "cylinder", width: 50, height: 60 }] },
  // Diameter 30 → width 30; the box's height 20 is kept.
  { id: "held-box-to-cylinder", taskType: "edit-parameter", prompt: "Change it to a cylinder 30 mm in diameter.", setup: [BOX], expected: [{ op: "set_part", shape: "cylinder", width: 30, height: 20 }] },
];

const same = (a: unknown, b: unknown) =>
  typeof a === "number" && typeof b === "number" ? Math.abs(a - b) <= 1e-9 * Math.max(Math.abs(a), Math.abs(b)) : a === b;

/** Whether `actual` contains each expected command (by the parameters given), in order: command by command, for any commands. */
export function commandsMatch(actual: readonly Command[], expected: readonly Partial<Command>[]): boolean {
  let i = 0;
  for (const c of actual) if (i < expected.length && Object.entries(expected[i]).every(([k, v]) => same(c[k], v))) i++;
  return i === expected.length;
}

/**
 * The part after these commands, as set_part's parameters. Until the
 * timeline (step 32) the part is one set_part: each command's parameters
 * replace the ones it names and the rest are kept, as Design's run does.
 */
export function partAfter(commands: readonly Partial<Command>[]): Record<string, unknown> {
  const part: Record<string, unknown> = {};
  for (const c of commands) for (const [k, v] of Object.entries(c)) if (k !== "op") part[k] = v;
  return part;
}

/**
 * Whether the part the answer leaves (on top of the setup) has every
 * expected parameter. Judged on the result, so a wrong command after a
 * right one fails, and a size left out to keep it is right (AI4).
 */
export function matches(setup: readonly Command[], actual: readonly Command[], expected: readonly Partial<Command>[]): boolean {
  if (expected.length > 0 && actual.length === 0) return false;
  const part = partAfter([...setup, ...actual]);
  return actual.every((c) => c.op === "set_part") && Object.entries(partAfter(expected)).every(([k, v]) => same(part[k], v));
}

export interface EvalResult {
  id: string;
  taskType: TaskType;
  passed: boolean;
  /** 1 or 2 when the answer was usable (2: only after the retry); 0 when it never was. */
  attempts: 0 | 1 | 2;
  detail: string;
}

/** Runs every ready case against a provider. */
export async function runEval(provider: AIProvider, cases: readonly EvalCase[], specs: readonly CommandSpec[]): Promise<EvalResult[]> {
  const results: EvalResult[] = [];
  for (const c of cases) {
    if (c.waitsFor) continue;
    const system = systemPrompt(c.setup, specs);
    const answer = await askForCommands(provider, { system, messages: [{ role: "user", content: c.prompt }] }, specs);
    const passed = answer.ok && matches(c.setup, answer.commands, c.expected);
    results.push({ id: c.id, taskType: c.taskType, passed, attempts: answer.ok ? answer.attempts : 0, detail: answer.ok ? JSON.stringify(answer.commands) : answer.error });
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
