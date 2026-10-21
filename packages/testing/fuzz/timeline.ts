// Long seeded timeline sessions for the nightly fuzzing workflow
// (.github/workflows/fuzz.yml, step 25b3): rounds of FISSION_TIMELINE_SESSIONS
// sessions (default 5) × FISSION_TIMELINE_STEPS steps (default 500) of
// Design's timeline on the real kernel against the model
// (src/timeline-fuzz.ts), a new seed each round, until FISSION_FUZZ_SECONDS
// have passed. Needs the WASM build. The first seed is FISSION_SEED
// (decimal) or a fresh random one. With FISSION_FUZZ_OUT=<dir>, each round
// is a line of <dir>/log.csv, and a failing session writes
// <dir>/seed-<seed>/fuzz-report.txt (what failed, how to replay it, the
// shrunk steps) and steps.json ({ seed, check, steps }, the shrunk steps to
// keep as a regression). Exits 1 if anything failed.
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { splitmix64 } from "../src/index.ts";
import { nodeKernel } from "../src/node-kernel.ts";
import { timelineReport, timelineRound } from "../src/timeline-fuzz.ts";

const whole = (name: string, fallback: number) => {
  const v = process.env[name]?.trim();
  if (v === undefined || v === "") return fallback;
  if (!/^\d+$/.test(v) || Number(v) < 1) throw new Error(`${name} is a whole number above 0`);
  return Number(v);
};
const SESSIONS = whole("FISSION_TIMELINE_SESSIONS", 5);
const STEPS = whole("FISSION_TIMELINE_STEPS", 500);
const seconds = Number(process.env.FISSION_FUZZ_SECONDS ?? "60");
const out = process.env.FISSION_FUZZ_OUT;
const first = process.env.FISSION_SEED;
if (first !== undefined && !/^\d+$/.test(first.trim())) throw new Error("FISSION_SEED is a decimal number");
let seed = first !== undefined ? BigInt(first.trim()) : randomBytes(8).readBigUInt64LE();

const kernel = nodeKernel();
if (out) mkdirSync(out, { recursive: true });
const start = Date.now();
let found = 0;
let sessions = 0;
do {
  const t = Date.now();
  // A failing session may shrink for up to a quarter of the time left, so the round still ends near the deadline.
  const shrinkMs = Math.max(60_000, (seconds * 1000 - (Date.now() - start)) / 4);
  const { failures } = await timelineRound(kernel, seed, { sessions: SESSIONS, steps: STEPS, shrinkMs });
  sessions += SESSIONS;
  for (const f of failures) {
    const report = timelineReport(f);
    process.stdout.write(report);
    if (!out) continue;
    const dir = join(out, `seed-${f.seed}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "fuzz-report.txt"), report);
    writeFileSync(join(dir, "steps.json"), JSON.stringify({ seed: String(f.seed), check: f.check, steps: f.shrunk }, null, 1) + "\n");
  }
  console.log(`round ${seed}: ${SESSIONS} sessions × ${STEPS} steps, ${failures.length} failed, ${((Date.now() - t) / 1000).toFixed(0)} s`);
  if (out) {
    const log = join(out, "log.csv");
    if (!existsSync(log)) writeFileSync(log, "target,seed,cases,failures,seconds\n");
    appendFileSync(log, `timeline,${seed},${SESSIONS * STEPS},${failures.length},${((Date.now() - t) / 1000).toFixed(1)}\n`);
  }
  found += failures.length;
  seed = splitmix64(seed)[0];
} while ((Date.now() - start) / 1000 < seconds);
console.log(`${sessions} timeline sessions of ${STEPS} steps, ${found} failing`);
process.exitCode = found ? 1 : 0;
