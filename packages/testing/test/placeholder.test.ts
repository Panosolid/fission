import { test } from "node:test";
import assert from "node:assert/strict";
import { checkBaseline, seeded } from "../src/index.ts";

test("the shared harness is a placeholder and says so", () => {
  assert.throws(() => seeded(1n), /not implemented/);
  assert.throws(() => checkBaseline({}), /not implemented/);
});

test("every journey and round trip that isn't ready says what it waits for", async () => {
  const { JOURNEYS, ROUND_TRIPS } = await import("../src/journeys.ts");
  assert.deepEqual(JOURNEYS.filter((j) => j.status === "ready").map((j) => j.name), ["Design to STL"]);
  for (const j of JOURNEYS) if (j.status !== "ready") assert.ok(j.status.waitsFor.length > 0, j.name);
  assert.ok(ROUND_TRIPS.every((r) => r.waitsFor.length > 0));
});
