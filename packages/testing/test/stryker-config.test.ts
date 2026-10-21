// Keeps stryker/design.json honest (as planted.test.ts keeps the planted
// bugs'): its mutate range is a pair of line numbers in Design's
// document.ts, which every edit above it moves. It must still run from
// shapeOf's first line to readDesignDocument's closing brace, the reading
// and upgrading of Design's data, and every test file its command names
// must exist. Until 24f4 the range had drifted to the middle of shapeOf and
// of readDesignDocument, and the kept shapes' checks were mutated with
// their tests (test/kept.test.ts) left out of the run: 23 survivors no one
// had explained.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const config = JSON.parse(readFileSync(join(root, "packages/testing/stryker/design.json"), "utf8")) as { mutate: string[]; commandRunner: { command: string } };

const FIRST = "export function shapeOf(";
const LAST_OF = "export function readDesignDocument(";

/** What is wrong with mutate entry `entry` ("src/document.ts:a-b") against `source`, or null: line a must open shapeOf, line b close readDesignDocument. */
function rangeProblem(source: string, entry: string): string | null {
  const m = /^src\/document\.ts:(\d+)-(\d+)$/.exec(entry);
  if (!m) return `"${entry}" is not src/document.ts:first-last`;
  const lines = source.split("\n");
  const [first, last] = [Number(m[1]), Number(m[2])];
  const start = lines.findIndex((l) => l.startsWith(FIRST)) + 1;
  const read = lines.findIndex((l) => l.startsWith(LAST_OF));
  const end = lines.findIndex((l, i) => i > read && l === "}") + 1;
  if (start === 0 || read < 0 || end === 0) return "document.ts no longer has shapeOf and readDesignDocument";
  if (first !== start) return `the range starts at line ${first}, but shapeOf starts at line ${start}`;
  if (last !== end) return `the range ends at line ${last}, but readDesignDocument ends at line ${end}`;
  return null;
}

test("design.json mutates from shapeOf's first line to readDesignDocument's last, and its tests exist", () => {
  const source = readFileSync(join(root, "workspaces/design/src/document.ts"), "utf8");
  assert.equal(config.mutate.length, 1);
  assert.equal(rangeProblem(source, config.mutate[0]), null);
  const files = config.commandRunner.command.split(" ").filter((w) => w.startsWith("test/"));
  assert.ok(files.length > 0);
  for (const f of files) assert.ok(existsSync(join(root, "workspaces/design", f)), `${f} is not in workspaces/design`);
  // The kept shapes' checks are in the range, so their tests must run.
  assert.ok(files.includes("test/kept.test.ts"));
  // So are a face sketch's pins' checks (26f).
  assert.ok(files.includes("test/face-edges.test.ts"));
});

test("a range one line off at either end is caught, with which end and where it should be", () => {
  // A made-up file, worked by hand: shapeOf on line 2, readDesignDocument on 4 to 6 (its "}" on 6).
  const source = ["// x", "export function shapeOf() {", "}", "export function readDesignDocument() {", "  if (x) {", "}", "export function builds() {", "}"].join("\n");
  assert.equal(rangeProblem(source, "src/document.ts:2-6"), null);
  assert.equal(rangeProblem(source, "src/document.ts:1-6"), "the range starts at line 1, but shapeOf starts at line 2");
  assert.equal(rangeProblem(source, "src/document.ts:3-6"), "the range starts at line 3, but shapeOf starts at line 2");
  assert.equal(rangeProblem(source, "src/document.ts:2-5"), "the range ends at line 5, but readDesignDocument ends at line 6");
  assert.equal(rangeProblem(source, "src/document.ts:2-7"), "the range ends at line 7, but readDesignDocument ends at line 6");
  assert.equal(rangeProblem(source, "src/document.ts"), '"src/document.ts" is not src/document.ts:first-last');
  assert.equal(rangeProblem("nothing", "src/document.ts:2-6"), "document.ts no longer has shapeOf and readDesignDocument");
});
