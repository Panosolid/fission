// Long seeded sketch-and-extrude sessions for the nightly fuzzing workflow
// (.github/workflows/fuzz.yml): rounds of 50 sessions × 40 steps
// (src/sketch-extrude-session.ts), a new seed each, until
// FISSION_FUZZ_SECONDS have passed. Needs the WASM build. The first seed is
// FISSION_SEED (decimal) or a fresh random one. With FISSION_FUZZ_OUT=<dir>,
// each round is a line of <dir>/log.csv, a failing session writes
// <dir>/seed-<seed>/fuzz-report.txt (what failed, every step, and how to
// replay it), and up to 20,000 built extrudes go to <dir>/oracle.jsonl for
// prototypes/oracle/sketch_extrude.py, each with its body's STEP file (step
// 29b3), which FISSION_STEP_FAULT=1 writes with its first face flipped
// (src/step-fault.ts) for the oracle to catch. Exits 1 if anything failed.
// Replay a session: FISSION_SEED=<session seed> FISSION_SESSIONS=1
// FISSION_SESSION_STEPS=40 npm run journeys (the sketch-extrude-sessions
// journey).
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { splitmix64 } from "../src/index.ts";
import { nodeKernel } from "../src/node-kernel.ts";
import { runSession, sessionSeed, type OracleLine } from "../src/sketch-extrude-session.ts";
import { flipFirstFace } from "../src/step-fault.ts";

const SESSIONS = 50;
const STEPS = 40;
const ORACLE_LINES = 20000;
const seconds = Number(process.env.FISSION_FUZZ_SECONDS ?? "60");
const out = process.env.FISSION_FUZZ_OUT;
const first = process.env.FISSION_SEED;
if (first !== undefined && !/^\d+$/.test(first.trim())) throw new Error("FISSION_SEED is a decimal number");
let seed = first !== undefined ? BigInt(first.trim()) : randomBytes(8).readBigUInt64LE();

const kernel = nodeKernel();
let oracleLines = 0;
const stepFault = process.env.FISSION_STEP_FAULT !== undefined;
const oracle = out
  ? (line: OracleLine) => {
      if (oracleLines >= ORACLE_LINES) return;
      oracleLines++;
      const written = stepFault && line.step !== null ? { ...line, step: flipFirstFace(line.step) } : line;
      appendFileSync(join(out, "oracle.jsonl"), JSON.stringify(written) + "\n");
    }
  : undefined;
if (out) mkdirSync(out, { recursive: true });

const start = Date.now();
let found = 0;
let parts = 0;
do {
  const t = Date.now();
  let failures = 0;
  for (let i = 0; i < SESSIONS; i++) {
    const s = sessionSeed(seed, i);
    const r = await runSession(kernel, { seed: s, steps: STEPS, oracle });
    parts += r.built + r.refused;
    if (!r.failure) continue;
    failures++;
    // The format file_issues.py reads: a first line naming the target, then
    // "failure: <kind> | <example>", the kind with its numbers taken out there.
    const report = [
      `Sketch-extrude sessions, seed ${s}, ${STEPS} steps: 1 kind(s) of failure`,
      `failure: ${r.problem} | ${r.failure} | replay: FISSION_SEED=${s} FISSION_SESSIONS=1 FISSION_SESSION_STEPS=${STEPS} npm run journeys`,
      "steps:",
      ...r.ops.map((o, k) => `  ${k}. ${o}`),
    ].join("\n") + "\n";
    process.stdout.write(report);
    if (out) {
      const dir = join(out, `seed-${s}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "fuzz-report.txt"), report);
    }
  }
  console.log(`round ${seed}: ${SESSIONS} sessions × ${STEPS} steps, ${failures} failed`);
  if (out) {
    const log = join(out, "log.csv");
    if (!existsSync(log)) writeFileSync(log, "target,seed,cases,failures,seconds\n");
    appendFileSync(log, `sessions,${seed},${SESSIONS * STEPS},${failures},${((Date.now() - t) / 1000).toFixed(1)}\n`);
  }
  found += failures;
  seed = splitmix64(seed)[0];
} while ((Date.now() - start) / 1000 < seconds);
console.log(`${parts} parts checked, ${found} failing session(s), ${oracleLines} extrudes written for the oracle`);
process.exitCode = found ? 1 : 0;
