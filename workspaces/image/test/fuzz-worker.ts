// Runs one file's fuzz cases off the main thread, so fuzz.test.ts can stop
// a reader that hangs (or crawls through a huge length) and report it.

import { parentPort, workerData } from "node:worker_threads";
import { readFileSync } from "node:fs";
import { checkOne, mutate, random } from "./fuzz-check.ts";

const { path, seed, cases } = workerData as { path: string; seed: number; cases: number };
const original = new Uint8Array(readFileSync(path));
const rnd = random(seed);
for (let i = 0; i < cases; i++) {
  const input = mutate(original, rnd);
  // Announce each case first: if it hangs, the main thread still has it.
  parentPort!.postMessage({ kind: "case", i, input });
  const problem = checkOne(input);
  if (problem) {
    parentPort!.postMessage({ kind: "problem", i, problem });
    break;
  }
}
parentPort!.postMessage({ kind: "done" });
