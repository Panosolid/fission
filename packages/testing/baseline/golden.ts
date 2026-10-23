// The golden models' rebuild time and success, for tests/baseline.json
// (step 28b; src/golden-rebuild.ts runs them): for each model that builds
// today, `golden_<model>` (dashes as underscores) with
// - `kernel_calls`: every kernel call one rebuild from nothing makes, exact
//   (the frees after it are the runner's tidying, not the app's, and aren't
//   counted);
// - `relative_time`: the fastest of `runs` rebuilds divided by the
//   calibration workload's fastest (baseline/calibration.ts), as the app's
//   other times are;
// and `golden_models.failed_percent`: the models whose rebuild differs from
// their hand-worked answers, as a percent of those run (0 is a 100% success
// rate; any rise fails). Measured by baseline/app.ts on every pull request
// and by nightly/golden.ts each night.

import type { BodyView, KernelCalls } from "@fission/core";
import type { GoldenExpect } from "../src/golden.ts";
import { checkGolden, goldenDesign, measureGolden } from "../src/golden-rebuild.ts";
import { calibration, fastest, relative } from "./calibration.ts";

/** The metric name a model's lines go under: "l-bracket" is "golden_l_bracket". */
export const goldenMetric = (model: string) => `golden_${model.replace(/[^a-z0-9]+/g, "_")}`;

/** `calls` counting every call but the frees. */
function counting(calls: KernelCalls): KernelCalls & { calls: number } {
  const k = {
    calls: 0,
    call: ((op: string, ...args: unknown[]) => {
      if (op !== "body_free") k.calls++;
      return (calls.call as (op: string, ...a: unknown[]) => Promise<unknown>)(op, ...args);
    }) as KernelCalls["call"],
  };
  return k;
}

/** The real kernel with a bug planted (FISSION_BASELINE_FAULT=golden-volume): every body's volume a millionth too big, the rest of its answers untouched. */
export function volumeOff(calls: KernelCalls): KernelCalls {
  return {
    call: (async (op: string, ...args: unknown[]) => {
      const out = await (calls.call as (op: string, ...a: unknown[]) => Promise<unknown>)(op, ...args);
      return op === "body_view" ? { ...(out as BodyView), volume: (out as BodyView).volume * (1 + 1e-6) } : out;
    }) as KernelCalls["call"],
  };
}

/** Round to 4 decimals, as the baseline keeps percents and times. */
const four = (x: number) => Math.round(x * 10000) / 10000;

/** The failed percent of `failed` models out of `run`: 0 when none ran (nothing to fail). */
export const failedPercent = (failed: number, run: number) => (run === 0 ? 0 : four((failed / run) * 100));

export async function goldenMetrics(models: readonly GoldenExpect[], kernel: KernelCalls, runs = 25): Promise<Record<string, Record<string, number>>> {
  const out: Record<string, Record<string, number>> = {};
  let failed = 0;
  for (const want of models) {
    if ((await checkGolden(want, kernel)).problems.length > 0) failed++;
    const counted = counting(kernel);
    await measureGolden(goldenDesign(want.model), counted);
    const doc = goldenDesign(want.model);
    for (let i = 0; i < 3; i++) await measureGolden(doc, kernel); // warm the JIT
    let best = Infinity;
    for (let i = 0; i < runs; i++) best = Math.min(best, (await measureGolden(doc, kernel)).ms * 1e6);
    out[goldenMetric(want.model)] = { kernel_calls: counted.calls, relative_time: relative(best, fastest(calibration, 25)) };
  }
  out.golden_models = { failed_percent: failedPercent(failed, models.length) };
  return out;
}
