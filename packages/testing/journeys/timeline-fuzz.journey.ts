// The nightly timeline fuzzing (src/timeline-fuzz.ts, step 25b3) on the
// real kernel: a short clean round finds nothing and leaves no bodies; a
// round with a bug planted in Design's side finds it, shrinks it to a
// 1-minimal list of steps that fails the same check with the bug and
// passes without it, and writes a report file_issues.py can read.
import { test } from "node:test";
import assert from "node:assert/strict";
import { nodeKernel } from "../src/node-kernel.ts";
import { runSession, TimelineFailure } from "../src/timeline-session.ts";
import { designSubject, edgeMatches } from "../src/timeline-design.ts";
import { REPORT_HEAD, timelineReport, timelineRound, timelineSeed } from "../src/timeline-fuzz.ts";

test("a short clean round of timeline sessions finds nothing and leaves the kernel as it was", async () => {
  const kernel = nodeKernel();
  const before = await kernel.call("body_count");
  const { failures, counts } = await timelineRound(kernel, 25n, { sessions: 2, steps: 60 });
  assert.deepEqual(failures, []);
  assert.equal(await kernel.call("body_count"), before);
  // The sessions really ran: steps of several kinds, bodies built.
  for (const k of ["op:add-sketch", "op:add-extrude", "op:undo", "status:built"]) assert.ok(counts[k] > 0, `never ${k}`);
});

test("session seeds: the same round seed gives the same seeds, each session its own", () => {
  assert.equal(timelineSeed(7n, 0), 7_000_021n);
  assert.equal(timelineSeed(7n, 1), 7_000_022n);
  assert.equal(timelineSeed(7n, 1), timelineSeed(7n, 1));
  // Kept to 64 bits: (2^64 - 1) × 1,000,003 + 0 wraps to -1,000,003 mod 2^64.
  assert.equal(timelineSeed((1n << 64n) - 1n, 0), (1n << 64n) - 1_000_003n);
});

test("a round with a bug planted in Design (a refused reorder made anyway) finds it, shrinks it to 1-minimal steps and reports it", async () => {
  const kernel = nodeKernel();
  const faults = ["reorder-unchecked"] as const;
  const { failures } = await timelineRound(kernel, 3n, { sessions: 3, steps: 80, faults, shrinkMs: 5 * 60_000 });
  assert.ok(failures.length > 0, "the planted bug was not found");
  const f = failures[0];
  assert.equal(f.minimal, true);
  assert.ok(f.shrunk.length <= 8, `shrunk to ${f.shrunk.length} steps`);
  // The shrunk steps fail the same check with the bug, and pass on Design as it is.
  const run = async (fs: typeof faults | []) => {
    const s = designSubject(kernel, fs);
    try {
      await runSession(s, f.shrunk, edgeMatches);
      return null;
    } catch (e) {
      if (e instanceof TimelineFailure) return e.check;
      throw e;
    } finally {
      await s.dispose();
    }
  };
  assert.equal(await run(faults), f.check);
  assert.equal(await run([]), null);
  // Dropping any one step loses the failure (1-minimal), checked here apart from the shrinker.
  for (let k = 0; k < f.shrunk.length; k++) {
    const s = designSubject(kernel, faults);
    let check: string | null = null;
    try {
      await runSession(s, [...f.shrunk.slice(0, k), ...f.shrunk.slice(k + 1)], edgeMatches);
    } catch (e) {
      if (!(e instanceof TimelineFailure)) throw e;
      check = e.check;
    } finally {
      await s.dispose();
    }
    assert.notEqual(check, f.check, `step ${k} can be dropped`);
  }
  // The report: the head file_issues.py knows, one failure line with the check first, the replay, every step.
  const lines = timelineReport(f).trimEnd().split("\n");
  assert.ok(lines[0].startsWith(`${REPORT_HEAD}, seed ${f.seed}, 80 steps`), lines[0]);
  assert.ok(lines[1].startsWith(`failure: ${f.check} | `), lines[1]);
  assert.match(lines[1], new RegExp(`replay: .*FISSION_SEED=${f.seed} FISSION_TIMELINE_STEPS=80 `));
  assert.equal(lines.length, 3 + f.shrunk.length);
});

test("a round whose bodies aren't all freed (the kernel skips the first body_free) reports the bodies left in the kernel", async () => {
  // The session itself can't see a body that is never freed (it reads only what is built); the round's body_count can.
  const real = nodeKernel();
  let skipped = 0;
  const kernel = {
    call: ((op: string, ...args: unknown[]) => {
      if (op === "body_free" && skipped === 0) {
        skipped++;
        return Promise.resolve(undefined);
      }
      return (real.call as (op: string, ...a: unknown[]) => Promise<unknown>)(op, ...args);
    }) as typeof real.call,
  };
  const { failures } = await timelineRound(kernel, 4n, { sessions: 1, steps: 40 });
  assert.equal(skipped, 1);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].check, "bodies left in the kernel");
  // One body_free skipped: exactly one body more than before.
  assert.equal(failures[0].message, "1 more bodies after the session than before it");
});
