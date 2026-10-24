// Tier 3's simulated-user numbers (kernel/CLAUDE.md, Tier 3 item 4; step
// 30d): seeded timeline sessions build random models on the real kernel,
// edit early steps and rebuild, and these four numbers say how that went:
// - rebuilds right: steps whose rebuild the model agrees with in everything
//   the session checks (timeline-session.ts `runSession`); a session stops
//   at its first wrong rebuild, so that step is the one counted wrong;
// - references right: held face references that resolved to the face the
//   model names, or to nothing when the model has none (25a4);
// - bodies passing validate: the kernel's answers to `body_build`, every
//   one of which goes through `validate::checked`: a body passed it, an
//   "invalid-result" failed it, and an "internal" failure or a trap (how a
//   panic reaches JavaScript) is a kernel failure, counted with them, since
//   it is a result nobody checked; "invalid-input" is the user's input
//   refused, before there is anything to validate;
// - rebuild time against feature count: each rebuild from scratch (what
//   opening the file costs) timed with the number of timeline items it
//   built, fitted as a straight line through the fastest time at each count.
// Also counted, as what a user would see rather than a bug: rebuilds in
// which some feature failed as the model says it must.
//
// Used by the nightly fuzzing's timeline job (fuzz/timeline.ts: one line
// per round in numbers.jsonl, summed into the summary by
// .github/scripts/sim_numbers.py) and by tests/baseline.json's
// `app.simulated_users` (baseline/naming.ts, every pull request).

import type { KernelCalls } from "@fission/core";
import type { SessionNumbers } from "./timeline-session.ts";

/** The checks that are about held references (timeline-session.ts); every other failed check is a wrong rebuild. */
export const REFERENCE_CHECKS: readonly string[] = ["a reference resolved to more than one face", "a reference was lost", "a broken reference resolved to another face"];

/** A whole round's numbers: its sessions' `SessionNumbers` summed, the failures sorted, and the kernel's answers counted. */
export interface SimNumbers extends SessionNumbers {
  sessions: number;
  /** Sessions that stopped at a failed check (or left bodies in the kernel). */
  failedSessions: number;
  /** Rebuilds a session stopped at, for any check but a reference's. */
  wrongRebuilds: number;
  /** References a session stopped at. */
  wrongReferences: number;
  /** `body_build` answered with a body (it passed validate). */
  builds: number;
  /** `body_build` answered "invalid-result": the body failed validate. */
  invalidBuilds: number;
  /** `body_build` that failed otherwise than the four kinds above: "internal", or a trap. */
  crashedBuilds: number;
  /** `body_build` refused as "invalid-input" (the user's to fix; not judged). */
  refusedBuilds: number;
}

export const emptyNumbers = (): SimNumbers => ({
  sessions: 0,
  failedSessions: 0,
  rebuilds: 0,
  wrongRebuilds: 0,
  withFailedFeature: 0,
  references: 0,
  wrongReferences: 0,
  builds: 0,
  invalidBuilds: 0,
  crashedBuilds: 0,
  refusedBuilds: 0,
  timing: {},
});

/** One session's counts added into a round's, with the check it failed at (null when it passed). */
export function addSession(into: SimNumbers, s: SessionNumbers, failedCheck: string | null): void {
  into.sessions++;
  into.rebuilds += s.rebuilds;
  into.withFailedFeature += s.withFailedFeature;
  into.references += s.references;
  for (const [n, [k, fastest, total]] of Object.entries(s.timing)) {
    const [k0, f0, t0] = into.timing[Number(n)] ?? [0, Infinity, 0];
    into.timing[Number(n)] = [k0 + k, Math.min(f0, fastest), t0 + total];
  }
  if (failedCheck === null) return;
  into.failedSessions++;
  if (REFERENCE_CHECKS.includes(failedCheck)) into.wrongReferences++;
  else if (failedCheck !== "bodies left in the kernel") into.wrongRebuilds++;
}

/**
 * `kernel` with its `body_build` answers counted into `n` (builds,
 * invalid, crashed, refused); every answer is passed on unchanged.
 */
export function validateCounter(kernel: KernelCalls, n: SimNumbers): KernelCalls {
  return {
    call: (async (op: string, ...args: unknown[]) => {
      const call = kernel.call as (op: string, ...a: unknown[]) => Promise<unknown>;
      if (op !== "body_build") return call(op, ...args);
      try {
        const body = await call(op, ...args);
        n.builds++;
        return body;
      } catch (e) {
        const kind = (e as { kind?: unknown }).kind;
        if (kind === "invalid-input") n.refusedBuilds++;
        else if (kind === "invalid-result") n.invalidBuilds++;
        else n.crashedBuilds++;
        throw e;
      }
    }) as KernelCalls["call"],
  };
}

/** `part` of `whole` as a percent to 4 decimals, as tests/baseline.json keeps percents; 0 of nothing is 0. */
export const percent = (part: number, whole: number): number => (whole === 0 ? 0 : Math.round((part / whole) * 100 * 10000) / 10000);

/** The four numbers as percents of what went wrong (0 is 100% right), and how many each was out of. */
export function rates(n: SimNumbers) {
  const answered = n.builds + n.invalidBuilds + n.crashedBuilds;
  return {
    wrongRebuildPercent: percent(n.wrongRebuilds, n.rebuilds),
    wrongReferencePercent: percent(n.wrongReferences, n.references),
    invalidPercent: percent(n.invalidBuilds + n.crashedBuilds, answered),
    failedFeaturePercent: percent(n.withFailedFeature, n.rebuilds),
    answered,
  };
}

/**
 * Rebuild time against feature count: the least-squares line through the
 * fastest rebuild at each feature count, ms = intercept + perFeature × n
 * (each count one point, however many rebuilds it had, so the many small
 * timelines don't outweigh the few big ones). Null with fewer than two
 * counts.
 */
export function timeFit(timing: SessionNumbers["timing"]): { perFeature: number; intercept: number; points: number } | null {
  const pts = Object.entries(timing).map(([n, [, fastest]]) => [Number(n), fastest] as const);
  if (pts.length < 2) return null;
  const mx = pts.reduce((s, [x]) => s + x, 0) / pts.length;
  const my = pts.reduce((s, [, y]) => s + y, 0) / pts.length;
  const sxx = pts.reduce((s, [x]) => s + (x - mx) ** 2, 0);
  const sxy = pts.reduce((s, [x, y]) => s + (x - mx) * (y - my), 0);
  const perFeature = sxy / sxx;
  return { perFeature, intercept: my - perFeature * mx, points: pts.length };
}

/** A round's numbers as one line of the nightly numbers.jsonl (sim_numbers.py reads it); Infinity never occurs in a count that has rebuilds. */
export function numbersLine(n: SimNumbers, extra: Record<string, unknown>): string {
  return JSON.stringify({ ...extra, ...n });
}
