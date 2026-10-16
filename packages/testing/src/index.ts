// @fission/testing: the test harness shared by every workspace. PLACEHOLDER.
//
// The kernel's own harness (kernel/tests/stateful.rs: seeded random
// operation chains, minimal failing chains kept forever, failure dumps,
// the OpenCascade oracle) stays in Rust. This package will give the
// TypeScript workspaces the same habits: every random test seeded and
// replayable, failures saved as the shortest chain that shows them,
// metrics checked against tests/baseline.json, and a dump to look at.
//
// DRAFT interfaces: will change when the first workspace needs them.

export { JOURNEYS, ROUND_TRIPS, type Journey } from "./journeys.ts";
export { MAGIC_JOURNEYS, judge, reportLine, type JourneyRun, type JourneyVerdict, type MagicJourney } from "./magic.ts";
export { EVAL_CASES, matches, runEval, successRates, type EvalCase, type EvalResult, type TaskType } from "./ai-eval.ts";

/** A random source that gives the same sequence for the same seed. */
export interface SeededRandom {
  readonly seed: bigint;
  next(): number;
}

/** A minimal failing case, saved so it replays forever. */
export interface Regression<Op> {
  seed: bigint;
  failure: string;
  ops: Op[];
}

export interface BaselineCheck {
  metric: string;
  baseline: number;
  now: number;
  /** Worse by more than the allowed margin (2% for rates, 15% for speed). */
  worse: boolean;
}

const MASK = (1n << 64n) - 1n;

/** The next raw 64-bit output of SplitMix64 and its new state. */
export function splitmix64(state: bigint): [bigint, bigint] {
  const s = (state + 0x9e3779b97f4a7c15n) & MASK;
  let z = s;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK;
  return [z ^ (z >> 31n), s];
}

/** A seeded random source (SplitMix64): the same seed gives the same sequence. */
export function seeded(seed: bigint): SeededRandom {
  let state = seed & MASK;
  return {
    seed,
    next() {
      const [out, s] = splitmix64(state);
      state = s;
      return Number(out >> 11n) / 2 ** 53; // top 53 bits → [0, 1)
    },
  };
}

/** Compares metrics with the saved baseline. Not implemented yet. */
export function checkBaseline(_metrics: Record<string, number>): BaselineCheck[] {
  throw new Error("not implemented");
}
