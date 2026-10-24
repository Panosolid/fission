// The naming success rate for tests/baseline.json (step 25b4): seeded
// timeline sessions of Design on the real kernel (as
// journeys/timeline.journey.ts runs them), each held reference checked
// against the model after every step and counted rather than failed
// (`RefTally` in src/timeline-session.ts). `miss_percent` is the share of
// those checks resolved otherwise than the model says (a reference lost,
// moved to another face, or found on two), so 0 is a 100% success rate,
// and any miss fails the baseline check (the owner's choice, 2026-10-21).
// `references` is how many were checked, shown and never judged.
//
// The same sessions give Tier 3's other simulated-user numbers
// (src/sim-numbers.ts, step 30d), as `simulated_users`: `wrong_percent`,
// the steps whose rebuild the model disagrees with (a session that fails
// a check stops there, counted, and the next seed runs), `invalid_percent`,
// the kernel's `body_build` answers that failed validate or crashed, both
// failing on any rise from 0, and `relative_time`, the fitted rebuild time
// from scratch per timeline feature over the calibration workload's
// (`timeFit`); `rebuilds` and `builds` are shown, never judged.
//
// FISSION_BASELINE_FAULT plants a bug to see each fail: lose-refs loses
// every fifth reference Design is asked for; invalid-bodies answers every
// tenth body_build as a body that failed validate; wrong-rebuild runs
// Design with its "cache-by-feature" bug (a sketch's edit never reaches its
// extrude); slow-rebuild makes every rebuild from scratch take 2.5 times
// as long.
import { KernelError, type KernelCalls } from "@fission/core";
import { emptySessionNumbers, randomSession, runSession, TimelineFailure, type RefTally } from "../src/timeline-session.ts";
import { designSubject, edgeMatches } from "../src/timeline-design.ts";
import { addSession, emptyNumbers, rates, timeFit, validateCounter } from "../src/sim-numbers.ts";
import { calibration, fastest, relative } from "./calibration.ts";

export const NAMING_SEEDS = 8;
export const NAMING_STEPS = 150;

export const SESSION_FAULTS = ["lose-refs", "invalid-bodies", "wrong-rebuild", "slow-rebuild"] as const;
export type SessionFault = (typeof SESSION_FAULTS)[number];

/** The real kernel with every tenth `body_build` answered as a body that failed validate (FISSION_BASELINE_FAULT=invalid-bodies). */
export function invalidEveryTenth(kernel: KernelCalls): KernelCalls {
  let builds = 0;
  return {
    call: (async (op: string, ...args: unknown[]) => {
      if (op === "body_build" && ++builds % 10 === 0) throw new KernelError({ kind: "invalid-result", inputs: [], message: "planted: the body failed validation" });
      return (kernel.call as (op: string, ...a: unknown[]) => Promise<unknown>)(op, ...args);
    }) as KernelCalls["call"],
  };
}

export interface SessionMetrics {
  naming_sessions: { miss_percent: number; references: number };
  simulated_users: { wrong_percent: number; invalid_percent: number; relative_time: number; rebuilds: number; builds: number };
}

export async function sessionMetrics(kernel: KernelCalls, fault?: SessionFault): Promise<SessionMetrics> {
  const tally: RefTally = { checked: 0, missed: 0 };
  const numbers = emptyNumbers();
  const counted = validateCounter(fault === "invalid-bodies" ? invalidEveryTenth(kernel) : kernel, numbers);
  let asked = 0;
  for (let seed = 1n; seed <= BigInt(NAMING_SEEDS); seed++) {
    const subject = designSubject(counted, fault === "wrong-rebuild" ? ["cache-by-feature"] : []);
    const resolve = subject.resolve.bind(subject);
    if (fault === "lose-refs") subject.resolve = async (name) => (++asked % 5 === 0 ? null : resolve(name));
    if (fault === "slow-rebuild") {
      const scratch = subject.rebuildFromScratch.bind(subject);
      subject.rebuildFromScratch = async () => {
        const t = performance.now();
        const r = await scratch();
        for (const end = performance.now() + 1.5 * (performance.now() - t); performance.now() < end; );
        return r;
      };
    }
    const reached = emptySessionNumbers();
    let failed: string | null = null;
    try {
      await runSession(subject, randomSession(seed, NAMING_STEPS), edgeMatches, tally, reached);
    } catch (e) {
      if (!(e instanceof TimelineFailure)) throw e;
      failed = e.check;
      console.error(`simulated users: seed ${seed} failed: ${e.message.slice(0, 300)}`);
    } finally {
      await subject.dispose();
    }
    addSession(numbers, reached, failed);
  }
  if (tally.checked === 0) throw new Error("the naming sessions checked no references");
  const fit = timeFit(numbers.timing);
  if (fit === null) throw new Error("the sessions timed rebuilds at fewer than two feature counts");
  const r = rates(numbers);
  return {
    naming_sessions: { miss_percent: Math.round((tally.missed / tally.checked) * 100 * 10000) / 10000, references: tally.checked },
    simulated_users: {
      wrong_percent: r.wrongRebuildPercent,
      invalid_percent: r.invalidPercent,
      relative_time: relative(fit.perFeature * 1e6, fastest(calibration, 25)),
      rebuilds: numbers.rebuilds,
      builds: r.answered,
    },
  };
}

/** The naming success rate alone (25b4). */
export async function namingRate(kernel: KernelCalls, fault?: "lose-refs"): Promise<{ miss_percent: number; references: number }> {
  return (await sessionMetrics(kernel, fault)).naming_sessions;
}
