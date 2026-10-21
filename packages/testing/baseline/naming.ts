// The naming success rate for tests/baseline.json (step 25b4): seeded
// timeline sessions of Design on the real kernel (as
// journeys/timeline.journey.ts runs them), each held reference checked
// against the model after every step and counted rather than failed
// (`RefTally` in src/timeline-session.ts). `miss_percent` is the share of
// those checks resolved otherwise than the model says (a reference lost,
// moved to another face, or found on two), so 0 is a 100% success rate,
// and any miss fails the baseline check (the owner's choice, 2026-10-21).
// `references` is how many were checked, shown and never judged.
// FISSION_BASELINE_FAULT=lose-refs loses every fifth reference Design is
// asked for, to see the check fail.
import type { KernelCalls } from "@fission/core";
import { randomSession, runSession, type RefTally } from "../src/timeline-session.ts";
import { designSubject, edgeMatches } from "../src/timeline-design.ts";

export const NAMING_SEEDS = 8;
export const NAMING_STEPS = 150;

export async function namingRate(kernel: KernelCalls, fault?: "lose-refs"): Promise<{ miss_percent: number; references: number }> {
  const tally: RefTally = { checked: 0, missed: 0 };
  let asked = 0;
  for (let seed = 1n; seed <= BigInt(NAMING_SEEDS); seed++) {
    const subject = designSubject(kernel);
    const resolve = subject.resolve.bind(subject);
    if (fault === "lose-refs") subject.resolve = async (name) => (++asked % 5 === 0 ? null : resolve(name));
    try {
      await runSession(subject, randomSession(seed, NAMING_STEPS), edgeMatches, tally);
    } finally {
      await subject.dispose();
    }
  }
  if (tally.checked === 0) throw new Error("the naming sessions checked no references");
  return { miss_percent: Math.round((tally.missed / tally.checked) * 100 * 10000) / 10000, references: tally.checked };
}
