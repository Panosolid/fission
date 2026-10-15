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

/** A seeded random source. Not implemented yet. */
export function seeded(_seed: bigint): SeededRandom {
  throw new Error("not implemented");
}

/** Compares metrics with the saved baseline. Not implemented yet. */
export function checkBaseline(_metrics: Record<string, number>): BaselineCheck[] {
  throw new Error("not implemented");
}
