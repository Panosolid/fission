// The fixed JavaScript workload app times are divided by (`relative_time`
// in tests/baseline.json), so a faster or slower machine mostly cancels
// out, and the fastest-of-n timer. Shared by baseline/app.ts and
// baseline/golden.ts.
import { seeded } from "../src/index.ts";

export function calibration() {
  const r = seeded(1n);
  const xs = Array.from({ length: 100_000 }, () => r.next());
  xs.sort((a, b) => a - b);
  return JSON.parse(JSON.stringify(xs.slice(0, 20_000))).length;
}

/** The fastest of `runs` runs, in nanoseconds: interruptions only ever add time, so the minimum is the steadiest. */
export const fastest = (f: () => unknown, runs: number) => {
  let best = Infinity;
  for (let i = 0; i < runs; i++) {
    const t = process.hrtime.bigint();
    f();
    best = Math.min(best, Number(process.hrtime.bigint() - t));
  }
  return best;
};

/** `ns` as a share of the calibration workload's fastest run, to 4 decimals, as tests/baseline.json keeps it. */
export const relative = (ns: number, calibrationNs: number) => Math.round((ns / calibrationNs) * 10000) / 10000;
