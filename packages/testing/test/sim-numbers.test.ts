// Tier 3's simulated-user numbers (src/sim-numbers.ts, step 30d) and the
// session bots' waiting moves (timeline-session.ts WAITING_MOVES): the
// counting by hand, the line fit by hand, the kernel counter on every kind
// of answer, and the waiting moves held until their step is in LANDED and
// refused loudly once it is, before the model learns them. The numbers on
// Design and the real kernel, with planted bugs that each move their own
// number: journeys/timeline-fuzz.journey.ts and baseline/naming.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { KernelError, type KernelCalls } from "@fission/core";
import { addSession, emptyNumbers, percent, rates, REFERENCE_CHECKS, timeFit, validateCounter } from "../src/sim-numbers.ts";
import { emptySessionNumbers, modelSubject, randomOp, randomSession, runSession, WAITING_MOVES, WaitingMoveError, type SessionNumbers, type SessionOp } from "../src/timeline-session.ts";
import { seeded } from "../src/index.ts";
import { LANDED } from "../src/landed.ts";
import { LANDED as GOLDEN_LANDED } from "../src/golden.ts";

const session = (o: Partial<SessionNumbers>): SessionNumbers => ({ ...emptySessionNumbers(), ...o });

test("a round's numbers by hand: three sessions, one stopped at a wrong rebuild and one at a lost reference", () => {
  const n = emptyNumbers();
  addSession(n, session({ rebuilds: 10, withFailedFeature: 2, references: 4, timing: { 3: [2, 5, 11] } }), null);
  addSession(n, session({ rebuilds: 7, references: 1, timing: { 3: [1, 4, 4], 6: [1, 9, 9] } }), "the rebuild differs from the model");
  addSession(n, session({ rebuilds: 3, references: 5 }), "a reference was lost");
  // Rebuilds 10 + 7 + 3 = 20, one wrong (the second session's last): 5%. References 4 + 1 + 5 = 10, one wrong: 10%.
  // Failed features 2 of 20 rebuilds: 10%. Timing at 3 features: 2 + 1 rebuilds, fastest min(5, 4) = 4, total 11 + 4 = 15.
  assert.deepEqual({ ...n, timing: undefined }, { ...emptyNumbers(), sessions: 3, failedSessions: 2, rebuilds: 20, wrongRebuilds: 1, withFailedFeature: 2, references: 10, wrongReferences: 1, timing: undefined });
  assert.deepEqual(n.timing, { 3: [3, 4, 15], 6: [1, 9, 9] });
  const r = rates(n);
  assert.deepEqual([r.wrongRebuildPercent, r.wrongReferencePercent, r.failedFeaturePercent], [5, 10, 10]);
  // Bodies left in the kernel fail the session but are neither a wrong rebuild nor a wrong reference.
  addSession(n, session({ rebuilds: 5 }), "bodies left in the kernel");
  assert.deepEqual([n.failedSessions, n.wrongRebuilds, n.wrongReferences, n.rebuilds], [3, 1, 1, 25]);
  // Every reference check timeline-session.ts can fail counts as a reference, every other check as a rebuild.
  for (const c of REFERENCE_CHECKS) {
    const m = emptyNumbers();
    addSession(m, session({ references: 1 }), c);
    assert.deepEqual([m.wrongReferences, m.wrongRebuilds], [1, 0], c);
  }
});

test("percents to 4 decimals as the baseline keeps them; nothing out of nothing is 0", () => {
  // One wrong of 4,466: 100 / 4466 = 0.022391..., kept as 0.0224 (the smallest rise the baseline can see).
  assert.equal(percent(1, 4466), 0.0224);
  assert.equal(percent(15, 150), 10);
  assert.equal(percent(0, 0), 0);
  assert.equal(percent(1, 3), 33.3333);
});

test("the line through the fastest rebuild at each feature count, by hand", () => {
  // Fastest 3, 5 and 7 ms at 1, 2 and 3 features lie on 1 + 2n: per feature 2, intercept 1. How many rebuilds
  // each count had, and their totals, don't move the line.
  const f = timeFit({ 1: [9, 3, 50], 2: [1, 5, 5], 3: [2, 7, 30] })!;
  assert.ok(Math.abs(f.perFeature - 2) < 1e-12 && Math.abs(f.intercept - 1) < 1e-12 && f.points === 3, JSON.stringify(f));
  // Off the line: (0, 0), (1, 1), (2, 1), (3, 2): means 1.5 and 1; Sxx = 2.25 + 0.25 + 0.25 + 2.25 = 5,
  // Sxy = (−1.5)(−1) + (−0.5)(0) + (0.5)(0) + (1.5)(1) = 3, so per feature 3/5 = 0.6 and intercept 1 − 0.6 × 1.5 = 0.1.
  const g = timeFit({ 0: [1, 0, 0], 1: [1, 1, 1], 2: [1, 1, 1], 3: [1, 2, 2] })!;
  assert.ok(Math.abs(g.perFeature - 0.6) < 1e-12 && Math.abs(g.intercept - 0.1) < 1e-12, JSON.stringify(g));
  // One count is no line.
  assert.equal(timeFit({ 4: [3, 1, 3] }), null);
  assert.equal(timeFit({}), null);
});

test("the kernel counter sorts every body_build answer and passes each on unchanged", async () => {
  const answers: (() => unknown)[] = [
    () => 7,
    () => {
      throw new KernelError({ kind: "invalid-input", inputs: [], message: "open outline" });
    },
    () => {
      throw new KernelError({ kind: "invalid-result", inputs: [], message: "failed validation" });
    },
    () => {
      throw new KernelError({ kind: "internal", inputs: [], message: "unreachable" });
    },
    () => {
      throw new Error("RuntimeError: unreachable executed"); // a trap that isn't a KernelError
    },
    () => 8,
  ];
  let k = 0;
  const fake = { call: (async (op: string) => (op === "body_build" ? answers[k++]() : `other ${op}`)) as KernelCalls["call"] };
  const n = emptyNumbers();
  const counted = validateCounter(fake, n);
  const got: unknown[] = [];
  for (let i = 0; i < answers.length; i++) got.push(await counted.call("body_build", { box: { width: 1, depth: 1, height: 1 } } as never).catch((e: Error) => e.message));
  assert.deepEqual(got, [7, "open outline", "failed validation", "unreachable", "RuntimeError: unreachable executed", 8]);
  assert.deepEqual([n.builds, n.refusedBuilds, n.invalidBuilds, n.crashedBuilds], [2, 1, 1, 2]);
  // Other calls are neither counted nor changed.
  assert.equal(await counted.call("body_count"), "other body_count");
  assert.equal(n.builds + n.refusedBuilds + n.invalidBuilds + n.crashedBuilds, 6);
  // Passing validate: 2 of the 5 answered (the refusal never reached validate), so 3 of 5 = 60% failed.
  assert.equal(rates(n).invalidPercent, 60);
  assert.equal(rates(n).answered, 5);
});

test("the waiting moves: one list of landed steps, each move its own op, drawn as itself", () => {
  // Golden models and session moves read the same list (landed.ts), so a step turns both on at once.
  assert.equal(GOLDEN_LANDED, LANDED);
  assert.equal(LANDED.size, 0, "a step landed: its waiting moves now need the model (see WAITING_MOVES)");
  assert.deepEqual(WAITING_MOVES.map((m) => [m.op, m.from]), [["add-combine", "35"], ["set-combine", "35"], ["add-extrude-into", "39"], ["set-extrude-operation", "39"]]);
  const r = seeded(5n);
  for (const m of WAITING_MOVES) {
    assert.ok(m.weight > 0 && m.does.length > 20 && m.model.length > 20, m.op);
    for (let i = 0; i < 50; i++) {
      const op = m.draw(r) as Record<string, unknown>;
      assert.equal(op.op, m.op);
      for (const [key, v] of Object.entries(op)) if (typeof v === "number" && key !== "distance") assert.ok(v >= 0 && v < 1, `${m.op}.${key} = ${v} is a fraction`);
    }
  }
});

test("with nothing landed every seed draws exactly the steps it drew before the waiting moves were written", () => {
  // sha256 of JSON.stringify(randomSession(12345n, 300)), taken from main before step 30d (and 2,000 seeds of
  // 200 steps compared there, all equal): the nightly's and the regressions' seeds still replay.
  assert.equal(createHash("sha256").update(JSON.stringify(randomSession(12345n, 300))).digest("hex").slice(0, 16), "2c6779fbc5fd64b4");
  const waiting = new Set(WAITING_MOVES.map((m) => m.op as string));
  for (let s = 1n; s <= 200n; s++) for (const op of randomSession(s, 300)) assert.ok(!waiting.has(op.op), `seed ${s} drew ${op.op}`);
  assert.deepEqual(randomSession(9n, 100, new Set()), randomSession(9n, 100));
});

test("a landed step's moves are drawn as often as their weights say, and only that step's", () => {
  // The 16 moves of WEIGHTS weigh 121 together; with 35 landed, add-combine (6) and set-combine (3) join:
  // 6/130 = 4.615% and 3/130 = 2.308% of draws. Over 40,000 draws the standard error is about 0.1 points, so
  // each must land within 0.5 points (five of them).
  const count = (landed: Set<string>) => {
    const r = seeded(11n);
    const c: Record<string, number> = {};
    for (let i = 0; i < 40_000; i++) {
      const op = randomOp(r, landed).op;
      c[op] = (c[op] ?? 0) + 1;
    }
    return c;
  };
  const c35 = count(new Set(["35"]));
  assert.ok(Math.abs((c35["add-combine"] / 40_000) * 100 - (6 / 130) * 100) < 0.5, `${c35["add-combine"]}`);
  assert.ok(Math.abs((c35["set-combine"] / 40_000) * 100 - (3 / 130) * 100) < 0.5, `${c35["set-combine"]}`);
  assert.equal(c35["add-extrude-into"], undefined);
  assert.equal(c35["set-extrude-operation"], undefined);
  const both = count(new Set(["35", "39"]));
  for (const m of WAITING_MOVES) assert.ok(both[m.op] > 0, m.op);
});

test("a landed move the model doesn't know yet stops the session with words naming its step, never passing quietly", async () => {
  for (const m of WAITING_MOVES) {
    const r = seeded(3n);
    const steps: SessionOp[] = [{ op: "add-preset", kind: "box", sizes: [10, 20, 30] }, m.draw(r)];
    await assert.rejects(
      runSession(modelSubject(), steps),
      (e: Error) => e instanceof WaitingMoveError && e.message.includes(`${m.op} waits for step ${m.from}`) && e.message.includes("timeline-model.ts"),
    );
  }
  // A whole seeded session with 35 landed meets one.
  const steps = randomSession(1n, 400, new Set(["35"]));
  assert.ok(steps.some((s) => s.op === "add-combine" || s.op === "set-combine"));
  await assert.rejects(runSession(modelSubject(), steps), WaitingMoveError);
});
