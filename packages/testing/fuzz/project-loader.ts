// Long fuzzing of the project loader for the nightly fuzzing workflow
// (.github/workflows/fuzz.yml): rounds of 2,000 cases (src/project-fuzz.ts),
// a new seed each, until FISSION_FUZZ_SECONDS have passed. The first seed is
// FISSION_SEED (decimal) or a fresh random one. With FISSION_FUZZ_OUT=<dir>,
// each round is a line of <dir>/log.csv and a round that failed writes
// <dir>/seed-<seed>/fuzz-report.txt and each shrunk failing input.
// Exits 1 if anything failed. Replay a round: FISSION_SEED=<seed>
// FISSION_FUZZ_SECONDS=1 npm run fuzz -w @fission/testing
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { splitmix64 } from "../src/index.ts";
import { fuzzReport, fuzzRound } from "../src/project-fuzz.ts";

const CASES = 2000;
const seconds = Number(process.env.FISSION_FUZZ_SECONDS ?? "60");
const out = process.env.FISSION_FUZZ_OUT;
const first = process.env.FISSION_SEED;
if (first !== undefined && !/^\d+$/.test(first.trim())) throw new Error("FISSION_SEED is a decimal number");
let seed = first !== undefined ? BigInt(first.trim()) : randomBytes(8).readBigUInt64LE();

const start = Date.now();
let found = 0;
do {
  const t = Date.now();
  const { failures } = fuzzRound(seed, CASES);
  const report = fuzzReport(seed, CASES, failures);
  process.stdout.write(report);
  if (out) {
    mkdirSync(out, { recursive: true });
    const log = join(out, "log.csv");
    if (!existsSync(log)) writeFileSync(log, "target,seed,cases,failures,seconds\n");
    appendFileSync(log, `project,${seed},${CASES},${failures.length},${((Date.now() - t) / 1000).toFixed(1)}\n`);
    if (failures.length) {
      const dir = join(out, `seed-${seed}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "fuzz-report.txt"), report);
      for (const f of failures) writeFileSync(join(dir, `input-${f.index}.json`), f.input);
    }
  }
  found += failures.length;
  seed = splitmix64(seed)[0];
} while ((Date.now() - start) / 1000 < seconds);
process.exitCode = found ? 1 : 0;
