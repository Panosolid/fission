// Step 24d1: seeded sessions on Design's timeline data against the
// timeline model (src/timeline-data.ts), every kind of step reached, and
// each planted bug caught by its own check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomSession } from "../src/timeline-session.ts";
import { DATA_FAULT_CHECK, DATA_FAULTS, dataFailure, runDataSession } from "../src/timeline-data.ts";

const SEEDS = Array.from({ length: 12 }, (_, i) => BigInt(2401 + i));
const STEPS = 150;

test("Design's timeline data matches the model over 12 seeds × 150 steps, reaching every kind of step", () => {
  const total: Record<string, number> = {};
  for (const seed of SEEDS) {
    const counts = runDataSession(randomSession(seed, STEPS));
    for (const [k, v] of Object.entries(counts)) total[k] = (total[k] ?? 0) + v;
  }
  for (const k of ["op:add-sketch", "op:add-extrude", "op:add-preset", "op:set-size", "op:suppress", "op:marker", "op:undo", "op:redo", "op:save-open", "nothing-built"])
    assert.ok((total[k] ?? 0) >= 5, `${k} reached ${total[k] ?? 0} times: ${JSON.stringify(total)}`);
});

test("each bug planted on the Design side is caught by its own check", () => {
  for (const fault of DATA_FAULTS) {
    const failure = SEEDS.map((seed) => dataFailure(randomSession(seed, STEPS), [fault])).find((f) => f !== null);
    assert.ok(failure, `${fault} was not caught`);
    assert.ok(DATA_FAULT_CHECK[fault].includes(failure.check), `${fault}: ${failure.message}`);
  }
});
