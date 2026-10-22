// Reads the Stryker reports run.sh made and fails on any surviving mutant
// that explained.json does not explain, or that it explains but the tests
// now kill (so the list stays true). A mutant is matched by its file, kind,
// the code it changed and what it changed it to, not by line number.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../..");
const dirs = { core: "packages/core", design: "workspaces/design", storage: "packages/storage" };
const explained = JSON.parse(readFileSync(join(here, "explained.json"), "utf8"));
const key = (m) => `${m.file} | ${m.mutator} | ${m.original} => ${m.replacement}`;

/** The text between two Stryker locations (lines and columns count from 1). */
function slice(source, { start, end }) {
  const lines = source.split("\n").slice(start.line - 1, end.line);
  lines[lines.length - 1] = lines[lines.length - 1].slice(0, start.line === end.line ? end.column - 1 : end.column - 1);
  lines[0] = lines[0].slice(start.column - 1);
  return lines.join("\n").replace(/\s+/g, " ");
}

let bad = 0;
for (const target of process.argv.slice(2)) {
  const report = JSON.parse(readFileSync(join(root, "node_modules/.cache/stryker", `${target}.json`), "utf8"));
  const surviving = new Map();
  const checkedFiles = new Set();
  for (const [file, { source, mutants }] of Object.entries(report.files)) {
    const path = `${dirs[target]}/${file}`;
    checkedFiles.add(path);
    for (const m of mutants) {
      if (m.status !== "Survived" && m.status !== "NoCoverage") continue;
      const s = { file: path, mutator: m.mutatorName, original: slice(source, m.location), replacement: m.replacement.replace(/\s+/g, " ") };
      surviving.set(key(s), { ...s, line: m.location.start.line });
    }
  }
  const known = new Set(explained.filter((e) => checkedFiles.has(e.file)).map(key));
  for (const [k, s] of surviving)
    if (!known.has(k)) {
      bad++;
      console.log(`UNEXPLAINED survivor at ${s.file}:${s.line}: ${k}`);
    }
  for (const k of known)
    if (!surviving.has(k)) {
      bad++;
      console.log(`explained.json lists a mutant that no longer survives (remove it): ${k}`);
    }
  console.log(`${target}: ${surviving.size} survivors, all explained: ${[...surviving.keys()].every((k) => known.has(k))}`);
}
if (bad) {
  console.log(`${bad} problem(s): kill each survivor with a test, or explain in explained.json why no caller can tell`);
  process.exit(1);
}
