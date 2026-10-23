// The golden models' nightly run on the real kernel (step 28b;
// src/golden-night.ts, nightly/golden.ts, baseline/golden.ts): a clean
// night passes with every model's kernel calls as worked out by hand and
// tests/baseline.json holds them; then the run as the nightly job starts
// it, with each planted bug (`GOLDEN_FAULTS`), must fail, write the folder
// collect-results.sh keeps, and have .github/scripts/file_issues.py file
// the kinds it should (dry run: it prints what it would file). Run with
// `npm run journeys` after the app build.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildable } from "../src/golden-rebuild.ts";
import { goldenNight, shuffled } from "../src/golden-night.ts";
import { seeded } from "../src/index.ts";
import { goldenMetric, goldenMetrics } from "../baseline/golden.ts";
import { nodeKernel } from "../src/node-kernel.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const kernel = nodeKernel();

test("a clean night: every model right and the same in every shuffled round, nothing leaked", async () => {
  const models = buildable();
  const night = await goldenNight(kernel, models, 7n, 3);
  assert.deepEqual(night.failures, []);
  // Each round's order is the seed's shuffle of the files' order, round after round from one stream,
  // and with 6! = 720 orders, three rounds in file order would be a shuffle that does nothing.
  const names = models.map((m) => m.model);
  const r = seeded(7n);
  assert.deepEqual(night.orders, [1, 2, 3].map(() => shuffled(names, r.next)));
  assert.ok(night.orders.some((o) => o.join() !== names.join()), "every round in the files' order");
  assert.equal(night.lines.length, models.length);
  for (const l of night.lines) assert.match(l, /^[a-z-]+: 3 rebuilds, fastest \d+\.\d ms, slowest \d+\.\d ms, OK$/);
  assert.equal(await kernel.call("body_count"), 0);
});

test("each model's kernel calls are as worked out by hand, and tests/baseline.json holds them", async () => {
  const metrics = await goldenMetrics(buildable(), kernel, 1);
  // One rebuild from nothing: each sketch's outline once, each body built once and viewed once
  // (the runner's frees after aren't counted), so 2 × bodies + sketches, from each project file:
  // bracket-two-holes, one extrude of a profile the part holds itself: 2 × 1 + 0 = 2;
  // enclosure, the starting box and 4 sketched walls: 2 × 5 + 4 = 14; gear, one sketch: 2 × 1 + 1 = 3;
  // l-bracket, one sketch: 3; stepped-boss, the box and 2 sketches: 2 × 3 + 2 = 8;
  // thirty-features, the box and 15 sketches: 2 × 16 + 15 = 47.
  const calls = Object.fromEntries(Object.entries(metrics).filter(([k]) => k !== "golden_models").map(([k, m]) => [k, m.kernel_calls]));
  assert.deepEqual(calls, {
    [goldenMetric("bracket-two-holes")]: 2 * 1 + 0,
    [goldenMetric("enclosure")]: 2 * 5 + 4,
    [goldenMetric("gear")]: 2 * 1 + 1,
    [goldenMetric("l-bracket")]: 2 * 1 + 1,
    [goldenMetric("stepped-boss")]: 2 * 3 + 2,
    [goldenMetric("thirty-features")]: 2 * 16 + 15,
  });
  assert.deepEqual(metrics.golden_models, { failed_percent: 0 });
  const baseline = JSON.parse(readFileSync(join(ROOT, "tests/baseline.json"), "utf8")).metrics as Record<string, number>;
  for (const [k, n] of Object.entries(calls)) assert.equal(baseline[`app.${k}.kernel_calls`], n, k);
  assert.equal(baseline["app.golden_models.failed_percent"], 0);
  for (const m of Object.values(metrics)) for (const v of Object.values(m)) assert.ok(Number.isFinite(v));
});

/** The night as the nightly job runs it (2 rounds, timed once), with `fault` planted; its exit code, what it wrote, and what file_issues.py would file from it. */
function night(fault?: string) {
  const dir = mkdtempSync(join(tmpdir(), "golden-night-"));
  try {
    const { FISSION_GOLDEN_FAULT: _, ...outside } = process.env;
    const env = { ...outside, FISSION_SEED: "3", FISSION_GOLDEN_ROUNDS: "2", FISSION_GOLDEN_TIMING_RUNS: "1", FISSION_GOLDEN_OUT: join(dir, "golden"), ...(fault ? { FISSION_GOLDEN_FAULT: fault } : {}) };
    const run = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "nightly/golden.ts"], { cwd: join(ROOT, "packages/testing"), env, encoding: "utf8" });
    const folder = join(dir, "golden", "seed-golden-3");
    const report = existsSync(join(folder, "golden-report.txt")) ? readFileSync(join(folder, "golden-report.txt"), "utf8") : null;
    const measured = JSON.parse(readFileSync(join(dir, "golden", "measured.json"), "utf8")) as Record<string, number>;
    const issues = spawnSync("python3", [join(ROOT, ".github/scripts/file_issues.py"), dir, "--dry-run"], { env: { ...process.env, RUN_URL: "RUN", COMMIT: "abc1234", BRANCH: "main" }, encoding: "utf8" });
    assert.equal(issues.status, 0, issues.stderr);
    return { status: run.status, stdout: run.stdout + run.stderr, report, measured, filed: issues.stdout.trim().split("\n") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the nightly run as the job starts it: clean, it passes and files nothing", () => {
  const n = night();
  assert.equal(n.status, 0, n.stdout);
  assert.equal(n.report, null);
  assert.equal(n.measured["app.golden_models.failed_percent"], 0);
  assert.equal(n.measured["app.golden_l_bracket.kernel_calls"], 3);
  assert.deepEqual(n.filed, ["No problems found in this run."]);
});

test("a wrong answer on one model fails the night, its success rate, and files one issue for that model", () => {
  const n = night("volume");
  assert.equal(n.status, 1, n.stdout);
  // Only the gear has more than 50 faces: one of six wrong, 1 / 6 · 100 = 16.6667%.
  assert.equal(n.measured["app.golden_models.failed_percent"], 16.6667);
  assert.match(n.report!, /^Golden models, seed 3: 2 rounds of 6 models \(tests\/golden\), 1 failed\nfailure: gear: Body 1 \(feature-\d+\): volume [\d.]+, not [\d.]+ \(10\*pi\*\(50\^2 \+ 44\^2\)\/2\) \| first in round 1 /);
  assert.deepEqual(n.filed, ["create  golden model gear: Body # (feature#): volume #, not # (#*pi*(#^# + #^#)/#)"]);
});

test("answers that pass but change from round to round fail the night: every model, one issue each", () => {
  const n = night("drift");
  assert.equal(n.status, 1, n.stdout);
  // A ten-trillionth per view is far inside the comparer's billionth: no answer is wrong, so the success rate holds.
  assert.equal(n.measured["app.golden_models.failed_percent"], 0);
  const lines = n.report!.trim().split("\n");
  assert.equal(lines.length, 1 + 6);
  for (const l of lines.slice(1)) assert.match(l, /^failure: [a-z-]+: rebuilt differently in round 2 than in round 1: bodies\[0\]\.volume: [\d.]+ then [\d.]+ \| first in round 2 /);
  assert.equal(n.filed.length, 6);
  assert.ok(n.filed.every((f) => /^create  golden model [a-z-]+: rebuilt differently in round # than in round #: bodies\[#\]\.volume: # then #$/.test(f)), n.filed.join("\n"));
});

test("a body never freed fails the night with the count worked out by hand", () => {
  const n = night("leak");
  assert.equal(n.status, 1, n.stdout);
  // Each rebuild builds every body once: 1 + 5 + 1 + 1 + 3 + 16 = 27 (bracket-two-holes, enclosure, gear,
  // l-bracket, stepped-boss, thirty-features); 2 rounds, none freed: 54 left.
  assert.match(n.report!, /\nfailure: the run: 54 bodies left in the kernel's store after every rebuild was tidied \| first in round 2 /);
  assert.deepEqual(n.filed, ["create  golden model the run: # bodies left in the kernel's store after every rebuild was tidied"]);
});
