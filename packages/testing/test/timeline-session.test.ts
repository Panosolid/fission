// The timeline session harness (src/timeline-session.ts): seeded sessions
// on the model run as a subject pass and reach every kind of outcome, the
// same seed gives the same session, the comparer's tolerance is checked at
// 0.9× and 1.1×, and every check is shown failing: each planted bug in
// MODEL_FAULTS is caught by the check meant for it. Step 24d runs the same
// sessions on Design's real timeline (journeys/timeline.journey.ts).
//
// Longer runs: FISSION_SEED (decimal) picks one seed, FISSION_TIMELINE_STEPS
// the session length. A failing session prints its seed and its steps cut
// down to a minimal list; save that as test/regressions/timeline/<seed>.json
// ({ "seed": "…", "check": "…", "steps": […] }) so it replays forever.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { MODEL_FAULTS, type ModelFault } from "../src/timeline-model.ts";
import { close, failureOf, MATCH_REL, modelSubject, randomSession, runSession, shrinkSession, TimelineFailure, type SessionCounts, type SessionOp, type TimelineSubject } from "../src/timeline-session.ts";

const SEEDS = process.env.FISSION_SEED ? [BigInt(process.env.FISSION_SEED)] : Array.from({ length: 12 }, (_, k) => BigInt(k + 1));
const STEPS = Number(process.env.FISSION_TIMELINE_STEPS ?? 150);

/** Runs a session; on failure, the message carries the seed and the shrunk steps to save. */
async function session(make: () => TimelineSubject, seed: bigint): Promise<SessionCounts> {
  const steps = randomSession(seed, STEPS);
  try {
    return await runSession(make(), steps);
  } catch (e) {
    if (!(e instanceof TimelineFailure)) throw e;
    const shrunk = await shrinkSession(make, steps);
    assert.fail(`seed ${seed}: ${e.message}\nminimal steps (save in test/regressions/timeline/${seed}.json):\n${JSON.stringify({ seed: String(seed), check: e.check, steps: shrunk })}`);
  }
}

test("the comparer's tolerance: 0.9 × MATCH_REL apart matches, 1.1 × doesn't, with a floor of 1 mm", () => {
  for (const v of [1000, 123456.75, 1]) {
    assert.equal(close(v, v * (1 + 0.9 * MATCH_REL)), true, `${v}`);
    assert.equal(close(v, v * (1 + 1.1 * MATCH_REL)), false, `${v}`);
  }
  // Below 1 the floor is absolute: 0.9e-6 apart matches at 0.001, 1.1e-6 doesn't.
  assert.equal(close(0.001, 0.001 + 0.9 * MATCH_REL), true);
  assert.equal(close(0.001, 0.001 + 1.1 * MATCH_REL), false);
  assert.equal(close(0, -0.9 * MATCH_REL), true);
});

test("the same seed gives the same steps and the same session", async () => {
  assert.deepEqual(randomSession(7n, 100), randomSession(7n, 100));
  assert.notDeepEqual(randomSession(7n, 100), randomSession(8n, 100));
  assert.deepEqual(await runSession(modelSubject(), randomSession(7n, 100)), await runSession(modelSubject(), randomSession(7n, 100)));
});

test("seeded sessions on the model pass, and reach every kind of outcome", async () => {
  const total: SessionCounts = {};
  for (const seed of SEEDS) for (const [k, v] of Object.entries(await session(() => modelSubject(), seed))) total[k] = (total[k] ?? 0) + v;
  if (process.env.FISSION_SEED) return; // one seed alone needn't reach everything
  const wanted = [
    ...["add-sketch", "add-extrude", "add-preset", "set-size", "move-corner", "delete-curve", "redraw-curve", "delete-item", "reorder", "suppress", "marker", "undo", "redo", "save-open", "hold-ref"].map((o) => `op:${o}`),
    "unchanged:undo",
    "unchanged:redo",
    "refused:before-dependency",
    "refused:after-dependent",
    ...["built", "suppressed", "rolled-back", "failed"].map((s) => `status:${s}`),
    // The owner's rule: an extrude whose sketch is lost keeps its last shape with a warning, so a session (whose extrudes
    // start from closed outlines) fails one only for a suppressed sketch; failing with no kept shape is hand-worked.
    "cause:suppressed-input",
    ...["deleted-input", "open-outline", "invalid-outline"].map((c) => `warning:${c}`),
    "ref:kept",
    "ref:missing",
    "ref:missing-on-built-feature",
  ];
  const missing = wanted.filter((k) => !total[k]);
  assert.deepEqual(missing, [], `never reached: ${missing.join(", ")}`);
});

/** The check each planted bug must be caught by. */
const CAUGHT_BY: Record<ModelFault, string> = {
  "reorder-past-dependency": "outcome differs from the model",
  "build-suppressed": "the rebuild differs from the model",
  "ignore-marker": "the rebuild differs from the model",
  "reuse-ids": "a new id is already in use",
  "side-names-by-list": "the rebuild differs from the model",
  "stale-extrude-cache": "the rebuild differs from a rebuild from scratch",
  "cascade-delete": "the rebuild differs from the model",
  "keep-redo": "outcome differs from the model",
  "save-drops-suppressed": "save and open changed the rebuild",
  "resolve-falls-back": "a broken reference resolved to another face",
  "edit-leaks": "an edit changed an item that doesn't depend on it",
  "sphere-one-name": "two faces share a name",
  "rebuild-drifts": "rebuilding twice differs",
  "resolve-last-body-only": "a reference was lost",
  "save-stamps": "saving again changed the file",
  "uprights-as-given": "the rebuild differs from the model",
  "cap-edges-swapped": "the rebuild differs from the model",
  "end-edges-named-start": "two edges share a name",
  "lost-sketch-fails": "the rebuild differs from the model",
  "kept-not-forgotten": "the rebuild differs from the model",
  "save-drops-kept": "save and open changed the rebuild",
  "warning-dropped": "the rebuild differs from the model",
};

/** The first seed whose session the planted bug fails, and how. */
async function firstFailure(make: () => TimelineSubject): Promise<{ seed: bigint; failure: TimelineFailure } | null> {
  for (const seed of Array.from({ length: 12 }, (_, k) => BigInt(k + 1))) {
    const failure = await failureOf(make, randomSession(seed, 150));
    if (failure) return { seed, failure };
  }
  return null;
}

for (const fault of MODEL_FAULTS)
  test(`planted bug "${fault}" is caught: ${CAUGHT_BY[fault]}`, async () => {
    const found = await firstFailure(() => modelSubject([fault]));
    assert.ok(found, `no session caught ${fault}`);
    assert.equal(found.failure.check, CAUGHT_BY[fault], found.failure.message);
  });

test("without a rebuild from scratch, a stale cache is still caught by the model", async () => {
  const make = (): TimelineSubject => {
    const { rebuildFromScratch: _, ...rest } = modelSubject(["stale-extrude-cache"]);
    return rest;
  };
  assert.equal((await firstFailure(make))?.failure.check, "the rebuild differs from the model");
});

test("a failing session shrinks to a list no single step can be dropped from", async () => {
  for (const fault of ["keep-redo", "cascade-delete"] as const) {
    const make = () => modelSubject([fault]);
    const found = await firstFailure(make);
    assert.ok(found);
    const steps = randomSession(found.seed, 150);
    const shrunk = await shrinkSession(make, steps);
    assert.ok(shrunk.length <= found.failure.step + 1);
    assert.equal((await failureOf(make, shrunk))?.check, CAUGHT_BY[fault]);
    for (let k = 0; k < shrunk.length; k++) assert.notEqual((await failureOf(make, [...shrunk.slice(0, k), ...shrunk.slice(k + 1)]))?.check, CAUGHT_BY[fault], `step ${k} of ${fault}'s list can go`);
    // And the shrunk list still passes on the model itself.
    await assert.doesNotReject(() => runSession(modelSubject(), shrunk));
  }
});

const REGRESSIONS = new URL("./regressions/timeline/", import.meta.url);
test("saved timeline regressions replay", { skip: !existsSync(REGRESSIONS) && "none saved yet" }, async () => {
  for (const file of readdirSync(REGRESSIONS).filter((f) => f.endsWith(".json"))) {
    const saved: { seed: string; check: string; steps: SessionOp[] } = JSON.parse(readFileSync(new URL(file, REGRESSIONS), "utf8"));
    await assert.doesNotReject(() => runSession(modelSubject(), saved.steps), file);
  }
});
