// The golden models' nightly run (step 28b; .github/workflows/nightly.yml,
// job golden, through golden/nightly.ts): every model that builds today
// rebuilt `rounds` times on one kernel, in an order shuffled by the seed
// each round, so a model is rebuilt after every other one. Each rebuild is
// checked against its hand-worked answers (`checkGolden`), and against
// its own first rebuild exactly: the kernel and Design must give the same
// answer every time, whatever ran before (booleans.md rule 5), which the
// every-PR journey, one rebuild per model in file order, can't see. Last,
// the kernel's body store must be empty, so no rebuild leaked a body.
//
// With `steps`, each shown body's STEP file is read from the kernel too
// (step 29b3, `body_step`), the same text every round, and round 1's go
// out as `GoldenNight.steps`, one line each with the model's hand-worked
// volume, area and faces, for prototypes/oracle/golden_step.py to have
// OpenCascade judge.
//
// A failure is written as a report that .github/scripts/file_issues.py
// reads like a fuzzer's: a first line naming the run, then one
// "failure: <model>: <first problem> | <the rest, the round, how to
// replay>" line per failing model, so each kind of failure is one
// `random-testing` issue.

import type { BodyView, KernelCalls } from "@fission/core";
import { evaluate, type GoldenExpect, type Measured } from "../src/golden.ts";
import { checkGolden, firstDifference, type GoldenStep } from "./rebuild.ts";
import { seeded } from "../src/index.ts";

export interface GoldenFailure {
  /** The model, or "the run" for what no one model did (a leaked body). */
  model: string;
  /** The round it first failed in, from 1. */
  round: number;
  problems: string[];
}

export interface GoldenNight {
  seed: bigint;
  rounds: number;
  models: number;
  failures: GoldenFailure[];
  /** One line per model: rounds run, fastest and slowest rebuild, OK or FAILED. */
  lines: string[];
  /** Each round's order, for the report. */
  orders: string[][];
  /** With `steps`: round 1's STEP file of every shown body, a line each for golden_step.py. */
  steps: GoldenStepLine[];
}

/** One body's STEP file and its model's hand-worked answers for it (prototypes/oracle/golden_step.py reads these). */
export interface GoldenStepLine extends GoldenStep {
  model: string;
  /** The hand-worked volume, area and face count (`BodyExpect`), evaluated; null for a body the model doesn't expect (its own failure already). */
  volume: number | null;
  area: number | null;
  faces: number | null;
}

/**
 * Bugs the nightly run must catch, planted on purpose in the kernel's
 * answers (FISSION_GOLDEN_FAULT, journeys/golden-night.journey.ts):
 * - "volume": the gear's volume a millionth too big (a body of more than
 *   50 faces; no other model has one), a wrong answer on one model;
 * - "drift": every body's volume off by a ten-trillionth more on each view
 *   than the last, far inside the comparer's billionth, so every answer
 *   passes and only the same-every-round check sees it;
 * - "leak": bodies never freed, which only the store count at the end sees.
 */
export const GOLDEN_FAULTS = ["volume", "drift", "leak"] as const;
export type GoldenFault = (typeof GOLDEN_FAULTS)[number];

export function plantGoldenFault(kernel: KernelCalls, fault: GoldenFault): KernelCalls {
  let views = 0;
  return {
    call: (async (op: string, ...args: unknown[]) => {
      if (fault === "leak" && op === "body_free") return undefined;
      const out = await (kernel.call as (op: string, ...a: unknown[]) => Promise<unknown>)(op, ...args);
      if (op !== "body_view") return out;
      const v = out as BodyView;
      if (fault === "volume" && v.faces > 50) return { ...v, volume: v.volume * (1 + 1e-6) };
      if (fault === "drift") return { ...v, volume: v.volume * (1 + ++views * 1e-13) };
      return out;
    }) as KernelCalls["call"],
  };
}

/** `items` shuffled by `next` (Fisher–Yates: each order equally likely). */
export function shuffled<T>(items: readonly T[], next: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export async function goldenNight(kernel: KernelCalls, models: readonly GoldenExpect[], seed: bigint, rounds: number, options: { steps?: boolean } = {}): Promise<GoldenNight> {
  const random = seeded(seed);
  const first = new Map<string, Measured | null>();
  const failed = new Map<string, GoldenFailure>();
  const times = new Map<string, number[]>();
  const orders: string[][] = [];
  const firstSteps = new Map<string, GoldenStep[]>();
  const fail = (model: string, round: number, problems: string[]) => {
    const f = failed.get(model);
    if (!f) failed.set(model, { model, round, problems: [...problems] });
    else for (const p of problems) if (!f.problems.includes(p)) f.problems.push(p);
  };
  for (let round = 1; round <= rounds; round++) {
    const order = shuffled(models, random.next);
    orders.push(order.map((m) => m.model));
    for (const want of order) {
      const { problems, got, ms, steps } = await checkGolden(want, kernel, options);
      (times.get(want.model) ?? times.set(want.model, []).get(want.model)!).push(ms);
      if (problems.length > 0) fail(want.model, round, problems);
      if (!first.has(want.model)) first.set(want.model, got);
      else {
        const d = firstDifference(first.get(want.model), got);
        if (d !== null) fail(want.model, round, [`rebuilt differently in round ${round} than in round 1: ${d}`]);
      }
      if (steps === undefined) continue;
      const earlier = firstSteps.get(want.model);
      if (!earlier) firstSteps.set(want.model, steps);
      else {
        const d = firstDifference(earlier, steps);
        if (d !== null) fail(want.model, round, [`its STEP files were written differently in round ${round} than in round 1: ${d.slice(0, 300)}`]);
      }
    }
  }
  const left = Number(await kernel.call("body_count"));
  if (left !== 0) fail("the run", rounds, [`${left} bodies left in the kernel's store after every rebuild was tidied`]);
  const lines = models.map((m) => {
    const ms = times.get(m.model) ?? [];
    const ok = !failed.has(m.model);
    return `${m.model}: ${ms.length} rebuilds, fastest ${Math.min(...ms).toFixed(1)} ms, slowest ${Math.max(...ms).toFixed(1)} ms, ${ok ? "OK" : "FAILED"}`;
  });
  const stepLines = models.flatMap((m) =>
    (firstSteps.get(m.model) ?? []).map((s) => {
      const want = m.bodies.find((b) => b.item === s.item);
      return { model: m.model, ...s, volume: want ? evaluate(want.volume.is) : null, area: want ? evaluate(want.area.is) : null, faces: want ? want.topology.faces : null };
    }),
  );
  return { seed, rounds, models: models.length, failures: [...failed.values()], lines, orders, steps: stepLines };
}

/** The command that runs this night again. */
export const replay = (night: Pick<GoldenNight, "seed" | "rounds">) => `FISSION_SEED=${night.seed} FISSION_GOLDEN_ROUNDS=${night.rounds} npm run golden -w @fission/testing (after npm run kernel -w @fission/app)`;

/** The report file_issues.py reads (golden-report.txt): empty when nothing failed. */
export function goldenReport(night: GoldenNight): string {
  if (night.failures.length === 0) return "";
  const out = [`Golden models, seed ${night.seed}: ${night.rounds} rounds of ${night.models} models (tests/golden), ${night.failures.length} failed`];
  for (const f of night.failures) {
    const [head, ...rest] = f.problems;
    // One line each: a problem's own line breaks would start lines file_issues.py doesn't read.
    const flat = (s: string) => s.replace(/\s*\n\s*/g, " ");
    const order = night.orders[f.round - 1]?.join(", ") ?? "";
    out.push(`failure: ${f.model}: ${flat(head)} | ${rest.map(flat).map((p) => `also: ${p}; `).join("")}first in round ${f.round} (order: ${order}); replay: ${replay(night)}`);
  }
  return out.join("\n") + "\n";
}
