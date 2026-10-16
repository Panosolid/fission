import { test } from "node:test";
import assert from "node:assert/strict";
import { DependencyGraph, type Cost } from "../src/model/graph.ts";

const node = (id: string, cost: Cost = "cheap") => ({ id, label: id, workspace: "design" as const, cost });

/**
 * sketch → extrude → { mass (cheap), stress (expensive) }; stress → report (cheap).
 * Worked by hand: changing the sketch makes all four downstream stale;
 * mass and report rebuild now, stress waits for a rerun.
 */
function project() {
  const g = new DependencyGraph();
  g.set(node("sketch"));
  g.set(node("extrude"), ["sketch"]);
  g.set(node("mass"), ["extrude"]);
  g.set(node("stress", "expensive"), ["extrude"]);
  g.set(node("report"), ["stress"]);
  return g;
}

test("a change marks everything downstream, and splits cheap from expensive", () => {
  const g = project();
  const s = g.changed("sketch");
  assert.deepEqual(new Set(s.updateNow), new Set(["extrude", "mass", "report"]));
  assert.deepEqual(s.awaitingRerun, ["stress"]);
  assert.deepEqual(new Set(g.stale()), new Set(["extrude", "mass", "stress", "report"]));
  assert.equal(g.isStale("sketch"), false, "the thing that changed is current by definition");
});

test("a change part-way down touches only what is below it", () => {
  const g = project();
  assert.deepEqual(g.changed("stress"), { updateNow: ["report"], awaitingRerun: [] });
  assert.equal(g.isStale("mass"), false);
});

test("a rebuilt result is fresh again; the rest stays marked", () => {
  const g = project();
  g.changed("sketch");
  g.markFresh("mass");
  assert.equal(g.isStale("mass"), false);
  assert.equal(g.isStale("stress"), true);
});

test("cycles and unknown inputs are refused", () => {
  const g = project();
  assert.throws(() => g.set(node("sketch"), ["report"]), /sketch would depend on itself through report/);
  assert.throws(() => g.set(node("loop"), ["loop"]), /loop depends on loop, which is not in the project/);
  assert.throws(() => g.set(node("x"), ["nowhere"]), /depends on nowhere, which is not in the project/);
});

test("removing an input marks its readers stale and reports the dangling input, never silently", () => {
  const g = project();
  g.remove("extrude");
  assert.equal(g.isStale("mass"), true);
  assert.deepEqual(new Set(g.missingInputs().map((m) => `${m.id}<-${m.missing}`)), new Set(["mass<-extrude", "stress<-extrude"]));
});

test("replacing a node keeps it in the same place", () => {
  const g = project();
  g.set({ ...node("mass"), label: "Mass properties" }, ["extrude"]);
  assert.deepEqual([...g.downstreamOf("extrude")].sort(), ["mass", "report", "stress"]);
});

test("onChange: told after each change that can alter what is shown, and not otherwise", () => {
  const g = new DependencyGraph();
  let calls = 0;
  const stop = g.onChange(() => calls++);
  // By hand: set, set (2); changed("a") marks b (3); changed("b") marks
  // nothing (no reader: still 3); markFresh("b") was stale (4); markFresh("b")
  // again was already fresh (still 4); remove("a") marks b stale and removes a
  // (two calls: 6); then stopped, so set(c) adds none.
  g.set(node("a"));
  g.set(node("b"), ["a"]);
  assert.equal(calls, 2);
  g.changed("a");
  assert.equal(calls, 3);
  g.changed("b");
  assert.equal(calls, 3);
  g.markFresh("b");
  assert.equal(calls, 4);
  g.markFresh("b");
  assert.equal(calls, 4);
  g.remove("a");
  assert.equal(calls, 6);
  stop();
  g.set(node("c"));
  assert.equal(calls, 6);
});
