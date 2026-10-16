import { test } from "node:test";
import assert from "node:assert/strict";
import { JOURNEYS, MAGIC_JOURNEYS, judge, reportLine, seeded, type MagicJourney } from "../src/index.ts";

const ready: MagicJourney = { name: "ready one", steps: ["a"], clickLimit: 3, secondsLimit: 5, status: "ready" };
const waiting: MagicJourney = { ...ready, name: "waiting one", status: { waitsFor: "Laser (L1)" } };

test("hand-worked: 3 clicks in 2.4 s against limits of 3 clicks and 5 s passes", () => {
  // 3 ≤ 3 clicks and 2,400 ms ≤ 5 × 1,000 ms, so it passes; seconds = 2400 / 1000 = 2.4.
  assert.deepEqual(judge(ready, { clicks: 3, ms: 2400 }), { kind: "pass", clicks: 3, seconds: 2.4 });
  assert.equal(reportLine(ready, judge(ready, { clicks: 3, ms: 2400 })), "PASS ready one: 3 clicks (limit 3), 2.40 s (limit 5 s)");
});

test("time limit boundaries: 0.9× passes, exactly the limit passes, 1.1× fails", () => {
  // 0.9 × 5 s = 4,500 ms; 1.1 × 5 s = 5,500 ms.
  assert.equal(judge(ready, { clicks: 1, ms: 4500 }).kind, "pass");
  assert.equal(judge(ready, { clicks: 1, ms: 5000 }).kind, "pass");
  assert.deepEqual(judge(ready, { clicks: 1, ms: 5500 }), { kind: "fail", reasons: ["5.50 s, limit 5 s"] });
});

test("click limit boundaries: the limit passes, one more click fails", () => {
  // Clicks are whole, so 0.9×/1.1× of 3 (2.7, 3.3) round to the limit and one over it.
  assert.equal(judge(ready, { clicks: 3, ms: 1 }).kind, "pass");
  assert.deepEqual(judge(ready, { clicks: 4, ms: 1 }), { kind: "fail", reasons: ["4 clicks, limit 3"] });
  assert.deepEqual(judge(ready, { clicks: 4, ms: 6000 }), { kind: "fail", reasons: ["4 clicks, limit 3", "6.00 s, limit 5 s"] });
});

test("a pending journey never passes, even with a perfect run", () => {
  for (const run of [null, { clicks: 1, ms: 1 }, { clicks: 99, ms: 1e9 }]) {
    assert.deepEqual(judge(waiting, run), { kind: "pending", waitsFor: "Laser (L1)" });
  }
  assert.equal(reportLine(waiting, judge(waiting, null)), "PENDING waiting one: waits for Laser (L1)");
});

test("a ready journey not walked, or measured wrongly, fails", () => {
  assert.deepEqual(judge(ready, null), { kind: "fail", reasons: ["not walked"] });
  for (const run of [{ clicks: 0, ms: 10 }, { clicks: 1.5, ms: 10 }, { clicks: 2, ms: NaN }, { clicks: 2, ms: -1 }, { clicks: 2, ms: Infinity }]) {
    assert.equal(judge(ready, run).kind, "fail", JSON.stringify(run));
  }
  assert.deepEqual(judge(ready, { clicks: 0, ms: NaN }), { kind: "fail", reasons: ["bad click count 0", "bad time NaN ms"] });
});

test("seeded random runs agree with a simple model (5 seeds × 500 runs)", () => {
  for (const seed of [1n, 2n, 3n, 4n, 5n]) {
    const r = seeded(seed);
    for (let i = 0; i < 500; i++) {
      const journey: MagicJourney = {
        ...ready,
        clickLimit: 1 + Math.floor(r.next() * 10),
        secondsLimit: 1 + Math.floor(r.next() * 30),
        status: r.next() < 0.2 ? { waitsFor: "x" } : "ready",
      };
      const run = r.next() < 0.05 ? null : { clicks: 1 + Math.floor(r.next() * 12), ms: r.next() * 35000 };
      const got = judge(journey, run).kind;
      const model =
        journey.status !== "ready" ? "pending" : run === null ? "fail" : run.clicks <= journey.clickLimit && run.ms <= journey.secondsLimit * 1000 ? "pass" : "fail";
      assert.equal(got, model, `seed ${seed} run ${i}: ${JSON.stringify({ journey, run })}`);
    }
  }
});

test("the list: exactly the Design-only journey is ready; every other one says what it waits for", () => {
  assert.deepEqual(MAGIC_JOURNEYS.filter((j) => j.status === "ready").map((j) => j.name), ["Design: shape to STL"]);
  const names = MAGIC_JOURNEYS.map((j) => j.name);
  assert.equal(new Set(names).size, names.length, "names are unique");
  for (const j of MAGIC_JOURNEYS) {
    assert.ok(j.steps.length > 0 && Number.isInteger(j.clickLimit) && j.clickLimit > 0 && j.secondsLimit > 0, j.name);
    if (j.status !== "ready") assert.ok(j.status.waitsFor.length > 0, j.name);
  }
  // Every waiting "zero exports" journey also has a magic moment, so none is forgotten.
  for (const z of JOURNEYS.filter((j) => j.status !== "ready")) assert.ok(names.includes(z.name), z.name);
});
