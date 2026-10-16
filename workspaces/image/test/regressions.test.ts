// Replays every input the fuzzer ever caught (test/regressions/*.bin):
// each must now read cleanly or be refused with an ImageError. Kept forever.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { checkOne } from "./fuzz-check.ts";

const dir = new URL("./regressions/", import.meta.url);
const saved = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".bin")) : [];

for (const file of saved) {
  test(`regression ${file}`, () => assert.equal(checkOne(new Uint8Array(readFileSync(new URL(file, dir)))), null));
}
