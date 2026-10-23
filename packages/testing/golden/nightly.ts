// The golden models' nightly run (step 28b; golden/night.ts has the
// checks; .github/workflows/nightly.yml, job golden): FISSION_GOLDEN_ROUNDS
// rounds (default 20) of every model that builds today, shuffled by
// FISSION_SEED (decimal; a fresh random one if unset), then each model's
// rebuild time, kernel calls and the success rate measured for
// tests/baseline.json (baseline/golden.ts). Needs the WASM build. With
// FISSION_GOLDEN_OUT=<dir> it writes <dir>/report.txt (a line per model,
// for summary.txt on test-results), <dir>/measured.json (the metrics, as
// .github/scripts/baseline.py --measured reads them) and, if anything
// failed, <dir>/seed-golden-<seed>/golden-report.txt, which
// .github/scripts/file_issues.py turns into `random-testing` issues.
// Exits 1 if anything failed. FISSION_GOLDEN_FAULT=volume, drift or leak
// plants a bug in the kernel's answers (`GOLDEN_FAULTS`), to see it caught;
// FISSION_GOLDEN_TIMING_RUNS (default 25) is how many rebuilds each time is
// the fastest of. Every shown body's STEP file goes to
// <dir>/golden-step.jsonl (step 29b3) for prototypes/oracle/golden_step.py,
// each with its first face flipped when FISSION_STEP_FAULT is set
// (src/step-fault.ts), which that script must then catch in every body.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { goldenMetrics } from "../baseline/golden.ts";
import { buildable } from "./rebuild.ts";
import { GOLDEN_FAULTS, goldenNight, goldenReport, plantGoldenFault, replay, type GoldenFault } from "./night.ts";
import { nodeKernel } from "../src/node-kernel.ts";
import { flipFirstFace } from "../src/step-fault.ts";
import type { KernelCalls } from "@fission/core";

const roundsText = process.env.FISSION_GOLDEN_ROUNDS?.trim() || "20";
if (!/^\d+$/.test(roundsText) || Number(roundsText) < 1) throw new Error("FISSION_GOLDEN_ROUNDS is a whole number above 0");
const given = process.env.FISSION_SEED?.trim();
if (given !== undefined && given !== "" && !/^\d+$/.test(given)) throw new Error("FISSION_SEED is a decimal number");
const seed = given ? BigInt(given) : randomBytes(8).readBigUInt64LE();
const out = process.env.FISSION_GOLDEN_OUT;

const timingText = process.env.FISSION_GOLDEN_TIMING_RUNS?.trim() || "25";
if (!/^\d+$/.test(timingText) || Number(timingText) < 1) throw new Error("FISSION_GOLDEN_TIMING_RUNS is a whole number above 0");
const fault = process.env.FISSION_GOLDEN_FAULT?.trim() || undefined;
if (fault !== undefined && !(GOLDEN_FAULTS as readonly string[]).includes(fault)) throw new Error(`FISSION_GOLDEN_FAULT is ${fault}, not one of ${GOLDEN_FAULTS.join(", ")}`);

/** `kernel` with every STEP file it writes given the planted fault. */
const flippingSteps = (kernel: KernelCalls): KernelCalls => ({
  call: (async (op: string, ...args: unknown[]) => {
    const out = await (kernel.call as (op: string, ...a: unknown[]) => Promise<unknown>)(op, ...args);
    return op === "body_step" ? flipFirstFace(out as string) : out;
  }) as KernelCalls["call"],
});

const planted = fault ? plantGoldenFault(nodeKernel(), fault as GoldenFault) : nodeKernel();
const kernel = process.env.FISSION_STEP_FAULT !== undefined ? flippingSteps(planted) : planted;
const models = buildable();
const night = await goldenNight(kernel, models, seed, Number(roundsText), { steps: true });
const metrics = await goldenMetrics(models, kernel, Number(timingText));
const report = goldenReport(night);
const lines = [`seed ${seed}, ${night.rounds} rounds of ${night.models} models; ${night.failures.length === 0 ? "every answer right and the same every round" : `${night.failures.length} FAILED`}; replay: ${replay(night)}`, ...night.lines];
console.log(lines.join("\n"));
if (report) process.stdout.write(report);
if (out) {
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "report.txt"), lines.join("\n") + "\n");
  const flat: Record<string, number> = {};
  for (const [op, m] of Object.entries(metrics)) for (const [kind, v] of Object.entries(m)) flat[`app.${op}.${kind}`] = v;
  writeFileSync(join(out, "measured.json"), JSON.stringify(flat, null, 2) + "\n");
  writeFileSync(join(out, "golden-step.jsonl"), night.steps.map((s) => JSON.stringify(s) + "\n").join(""));
  if (report) {
    const dir = join(out, `seed-golden-${seed}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "golden-report.txt"), report);
  }
}
process.exit(night.failures.length > 0 ? 1 : 0);
