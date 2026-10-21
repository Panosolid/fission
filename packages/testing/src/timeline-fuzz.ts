// Long seeded timeline sessions for the nightly fuzzing (step 25b3): Design's
// timeline on the real kernel (`designSubject`, timeline-design.ts) checked
// against the timeline model step by step (`runSession`,
// timeline-session.ts), as journeys/timeline.journey.ts does for 12 seeds ×
// 150 steps, but long (FISSION_TIMELINE_STEPS, 500 by default), so the
// timelines grow to dozens of items with edits to early ones, deep undo
// and many save and open round trips. After every session the kernel holds
// no more bodies than before it (a leak fails like any check).
//
// A failing session is cut to its failing step and then shrunk, one step
// dropped at a time while the same check still fails, for as long as the
// time allowed for it lasts (the real kernel makes each try slow); the
// report says whether it is 1-minimal. `fuzz/timeline.ts` runs rounds until
// the time is up; journeys/timeline-fuzz.journey.ts checks this module
// with a planted bug.

import type { KernelCalls } from "@fission/core";
import { randomSession, runSession, TimelineFailure, type SessionCounts, type SessionOp } from "./timeline-session.ts";
import { designSubject, edgeMatches, type DesignFault } from "./timeline-design.ts";

/** The first line of a report, as .github/scripts/file_issues.py knows it. */
export const REPORT_HEAD = "Timeline sessions";

/** One session's seed in a round: a different stream per session, the same for the same round seed. */
export const timelineSeed = (seed: bigint, i: number): bigint => (seed * 1_000_003n + BigInt(i)) & ((1n << 64n) - 1n);

export interface TimelineFuzzFailure {
  seed: bigint;
  steps: number;
  check: string;
  message: string;
  /** The steps that still fail the same check: cut and shrunk. */
  shrunk: SessionOp[];
  /** Whether no single step of `shrunk` can be dropped (the shrink finished in its time). */
  minimal: boolean;
}

/** Runs `steps` on a fresh Design subject; the failure, or null. Frees every body it built either way. */
async function attempt(kernel: KernelCalls, steps: readonly SessionOp[], faults: readonly DesignFault[], counts?: SessionCounts): Promise<TimelineFailure | null> {
  const subject = designSubject(kernel, faults);
  try {
    const c = await runSession(subject, steps, edgeMatches);
    if (counts) for (const [k, v] of Object.entries(c)) counts[k] = (counts[k] ?? 0) + v;
    return null;
  } catch (e) {
    if (e instanceof TimelineFailure) return e;
    throw e;
  } finally {
    await subject.dispose();
  }
}

/**
 * `steps` cut to the failing step, then single steps dropped, last first,
 * while the same check still fails; stops when no step can go (minimal)
 * or at `deadline` (Date.now() ms) with what it has.
 */
export async function shrinkTimeline(kernel: KernelCalls, steps: readonly SessionOp[], first: TimelineFailure, faults: readonly DesignFault[], deadline: number): Promise<{ steps: SessionOp[]; minimal: boolean }> {
  let cur = steps.slice(0, first.step + 1);
  for (let changed = true; changed; ) {
    changed = false;
    for (let k = cur.length - 1; k >= 0; k--) {
      if (Date.now() > deadline) return { steps: cur, minimal: false };
      const shorter = [...cur.slice(0, k), ...cur.slice(k + 1)];
      if ((await attempt(kernel, shorter, faults))?.check === first.check) {
        cur = shorter;
        changed = true;
      }
    }
  }
  return { steps: cur, minimal: true };
}

export interface RoundOptions {
  sessions: number;
  steps: number;
  /** Bugs planted in Design's side (the journey's proof that a round fails). */
  faults?: readonly DesignFault[];
  /** Milliseconds each failing session may spend shrinking. */
  shrinkMs?: number;
}

/** One round: `sessions` sessions of `steps` steps from `seed`; every failure (a check, or bodies left in the kernel) with its shrunk steps, and the counts of what the clean sessions reached. */
export async function timelineRound(kernel: KernelCalls, seed: bigint, o: RoundOptions): Promise<{ failures: TimelineFuzzFailure[]; counts: SessionCounts }> {
  const faults = o.faults ?? [];
  const failures: TimelineFuzzFailure[] = [];
  const counts: SessionCounts = {};
  for (let i = 0; i < o.sessions; i++) {
    const s = timelineSeed(seed, i);
    const steps = randomSession(s, o.steps);
    const before = await kernel.call("body_count");
    const failed = await attempt(kernel, steps, faults, counts);
    const left = (await kernel.call("body_count")) - before;
    if (failed) {
      const { steps: shrunk, minimal } = await shrinkTimeline(kernel, steps, failed, faults, Date.now() + (o.shrinkMs ?? 10 * 60_000));
      failures.push({ seed: s, steps: o.steps, check: failed.check, message: failed.message, shrunk, minimal });
    } else if (left !== 0) failures.push({ seed: s, steps: o.steps, check: "bodies left in the kernel", message: `${left} more bodies after the session than before it`, shrunk: steps, minimal: false });
  }
  return { failures, counts };
}

/** The report the nightly workflow keeps and files an issue from: the head line, one "failure:" line, the shrunk steps. */
export function timelineReport(f: TimelineFuzzFailure): string {
  const replay = `cd packages/testing && FISSION_SEED=${f.seed} FISSION_TIMELINE_STEPS=${f.steps} node --experimental-strip-types --no-warnings --test journeys/timeline.journey.ts`;
  return [
    `${REPORT_HEAD}, seed ${f.seed}, ${f.steps} steps: 1 kind(s) of failure`,
    `failure: ${f.check} | ${f.message.slice(0, 400)} | replay: ${replay}`,
    `shrunk to ${f.shrunk.length} step(s)${f.minimal ? " (1-minimal)" : " (shrinking ran out of time; not minimal)"}:`,
    ...f.shrunk.map((op, k) => `  ${k}. ${JSON.stringify(op)}`),
  ].join("\n") + "\n";
}
