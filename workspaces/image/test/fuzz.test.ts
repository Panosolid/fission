// Seeded fuzzing of the file readers (GT1): cut-off, bit-flipped and
// spliced versions of real files must either read to a size inside the
// limits or be refused with an ImageError; never another exception, never
// a hang. Same seed, same files, same result. A failing input is saved to
// test/regressions/ (replayed by regressions.test.ts) and its seed printed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

const SEED = 0x1ae5;
const CASES_PER_FILE = 3000;
/** A healthy run of one file takes well under a second. */
const TIME_LIMIT_MS = 20000;

const fixtures = new URL("./fixtures/", import.meta.url);
const files = readdirSync(fixtures).filter((f) => /\.(png|jpg)$/.test(f)).sort();

test("there are files to fuzz", () => assert.ok(files.length >= 6));

for (const [n, file] of files.entries()) {
  test(`fuzzing ${file} (seed ${SEED + n})`, async () => {
    const seed = SEED + n;
    const worker = new Worker(new URL("./fuzz-worker.ts", import.meta.url), { workerData: { path: fileURLToPath(new URL(file, fixtures)), seed, cases: CASES_PER_FILE } });
    let last: { i: number; input: Uint8Array } | null = null;
    const problem = await new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => resolve(`still running after ${TIME_LIMIT_MS / 1000} s: a reader hangs or crawls`), TIME_LIMIT_MS);
      worker.on("message", (m: { kind: string; i: number; input: Uint8Array; problem: string }) => {
        if (m.kind === "case") last = { i: m.i, input: m.input };
        else {
          clearTimeout(timer);
          resolve(m.kind === "problem" ? m.problem : null);
        }
      });
      worker.on("error", (e) => {
        clearTimeout(timer);
        resolve(`the worker failed: ${e.message}`);
      });
    });
    await worker.terminate();
    if (problem && last) {
      const { i, input } = last as { i: number; input: Uint8Array };
      const dir = new URL("./regressions/", import.meta.url);
      mkdirSync(dir, { recursive: true });
      const name = `${file}-seed${seed}-case${i}.bin`;
      writeFileSync(new URL(name, dir), input);
      assert.fail(`${file}, seed ${seed}, case ${i}: ${problem} (saved as test/regressions/${name})`);
    }
    assert.equal(problem, null);
  });
}
