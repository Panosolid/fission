// One run for `run.ts`, in a process of its own so the planted source is
// loaded fresh: Design's seeded timeline sessions on the real kernel
// (12 seeds × 150 steps, as journeys/timeline.journey.ts runs them) until
// one fails. Prints one line of JSON: the failing check, seed and message,
// or `{"check":null}` when every session passed ("threw: …" when
// the plant made Design throw rather than fail a check). Needs the WASM build.

import { nodeKernel } from "../src/node-kernel.ts";
import { designSubject, edgeMatches } from "../src/timeline-design.ts";
import { failureOf, randomSession } from "../src/timeline-session.ts";

const STEPS = 150;
let out: { check: string | null; seed?: string; message?: string } = { check: null };
for (let seed = 1n; seed <= 12n; seed++) {
  const subject = designSubject(nodeKernel());
  try {
    const failure = await failureOf(() => subject, randomSession(seed, STEPS), edgeMatches);
    if (failure) {
      out = { check: failure.check, seed: String(seed), message: failure.message.slice(0, 300) };
      break;
    }
  } catch (e) {
    // Not one of the session's checks: the plant broke Design outright. Recorded as such, never as caught by a check.
    out = { check: `threw: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`, seed: String(seed) };
    break;
  } finally {
    await subject.dispose().catch(() => undefined);
  }
}
console.log(JSON.stringify(out));
