// Compares answer files line by line (check.sh): every file must list the
// same inputs in the same order with the same answers. Prints how many
// inputs each build disagrees on, which fields differ, and the first few
// differing lines; exits 1 on any difference or if fewer than 2,000 inputs
// ran (so a check that quietly replayed nothing cannot pass).
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const MIN_INPUTS = 2000;
const [first, ...others] = process.argv.slice(2);
const read = (f) => readFileSync(f, "utf8").trimEnd().split("\n");
const want = read(first);
const fields = (line) => new Map((line.split("\t")[2] ?? "").split(" ").map((w) => w.split(/=(.*)/s)));
let failed = false;
if (want.length < MIN_INPUTS) {
  console.log(`only ${want.length} inputs ran, want at least ${MIN_INPUTS}`);
  failed = true;
}
for (const f of others) {
  const got = read(f);
  const differ = [];
  for (let i = 0; i < Math.max(want.length, got.length); i++) {
    if (want[i] !== got[i]) differ.push(i);
  }
  if (!differ.length) {
    console.log(`${basename(f)}: all ${got.length} answers match ${basename(first)} exactly`);
    continue;
  }
  failed = true;
  const which = new Map();
  for (const i of differ) {
    const [a, b] = [fields(want[i] ?? ""), fields(got[i] ?? "")];
    const keys = [...new Set([...a.keys(), ...b.keys()])].filter((k) => a.get(k) !== b.get(k)).join(",");
    which.set(keys, (which.get(keys) ?? 0) + 1);
  }
  console.log(`${basename(f)}: ${differ.length} of ${want.length} answers differ from ${basename(first)}`);
  for (const [keys, n] of which) console.log(`  ${n} differ in: ${keys}`);
  for (const i of differ.slice(0, 5)) console.log(`  ${basename(first)}: ${want[i]}\n  ${basename(f)}: ${got[i]}`);
}
process.exit(failed ? 1 : 0);
