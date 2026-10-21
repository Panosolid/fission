// Plants each of MODEL_FAULTS in the real code (model-faults.ts), one at a
// time, runs the check meant to catch it and reports which caught it
// (step 24e3); from step 26c NAMING_PLANTS too, Design's sketch on a face. Edits the source in place and always puts it back; refuses to
// start when a file it would edit has changes of its own.
//
//   node --experimental-strip-types --no-warnings planted/run.ts [fault ... | --naming]
//
// from packages/testing, after the WASM build (`npm run build` in
// apps/fission). With no faults named it first runs everything unplanted
// (which must pass), then every plant. Exits non-zero when a plant isn't caught,
// is caught by another check than `caught` records, or no longer applies.

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { MODEL_FAULTS, type ModelFault } from "../src/timeline-model.ts";
import { NAMING_PLANTS, PLANTS, type Plant } from "./model-faults.ts";

const ROOT = new URL("../../../", import.meta.url);
const TESTING = new URL("../", import.meta.url);
const node = ["--experimental-strip-types", "--no-warnings"];

/** The text of `file` with every edit of the plant made; throws when a find isn't there exactly once. */
export function planted(text: string, plant: Plant, file: string): string {
  for (const e of plant.edits.filter((x) => x.file === file)) {
    const at = text.indexOf(e.find);
    if (at < 0 || text.indexOf(e.find, at + 1) >= 0) throw new Error(`${file}: the text to replace is in it ${at < 0 ? "no" : "more than one"} time(s): ${e.find}`);
    text = text.slice(0, at) + e.replace + text.slice(at + e.find.length);
  }
  return text;
}

/** The check that failed: the timeline session's, or "history-fuzz: <first assertion line>"; null when it passed. */
function runCheck(run: Plant["run"][number]): string | null {
  if (run === "timeline") {
    const r = spawnSync(process.execPath, [...node, "planted/session.ts"], { cwd: TESTING, encoding: "utf8" });
    const line = r.stdout.trim().split("\n").pop() ?? "";
    if (r.status !== 0 || !line.startsWith("{")) return `threw: ${(r.stderr || line).trim().split("\n").slice(-3).join(" ")}`;
    return JSON.parse(line).check;
  }
  if (run === "naming") {
    // The naming journey (step 26c), saving no regression for a bug planted on purpose (FISSION_PLANTED).
    const r = spawnSync(process.execPath, [...node, "--test", "journeys/naming.journey.ts"], { cwd: TESTING, encoding: "utf8", env: { ...process.env, FISSION_PLANTED: "1" } });
    if (r.status === 0) return null;
    const title = /^not ok \d+ - (.*)$/m.exec(r.stdout)?.[1] ?? "failed";
    const words = /^\s+error: (.*)$/m.exec(r.stdout)?.[1] ?? "";
    return `naming: ${title}: ${words.slice(0, 200)}`;
  }
  const r = spawnSync(process.execPath, [...node, "--test", "test/history-fuzz.test.ts"], { cwd: TESTING, encoding: "utf8" });
  if (r.status === 0) return null;
  // Its assertions name the step ("seed 1 step 286: line-5 was used before"); the first one that failed is the record.
  const why = /seed \d+ step \d+[^'\n]*/.exec(r.stdout)?.[0] ?? "failed";
  return `history-fuzz: ${why.trim()}`;
}

/** A plant by name: one of MODEL_FAULTS, or of NAMING_PLANTS (step 26c). */
const plantOf = (name: string): Plant => (Object.hasOwn(PLANTS, name) ? PLANTS[name as ModelFault] : NAMING_PLANTS[name]);

function main(names: string[]) {
  // "--naming": every naming plant.
  if (names.length === 1 && names[0] === "--naming") names = Object.keys(NAMING_PLANTS);
  for (const n of names) if (!(MODEL_FAULTS as readonly string[]).includes(n) && !Object.hasOwn(NAMING_PLANTS, n)) throw new Error(`${n} is not one of MODEL_FAULTS or NAMING_PLANTS`);
  const faults: string[] = names.length ? names : [...MODEL_FAULTS, ...Object.keys(NAMING_PLANTS)];
  const files = [...new Set(faults.flatMap((f) => plantOf(f).edits.map((e) => e.file)))];
  const dirty = execFileSync("git", ["status", "--porcelain", "--", ...files], { cwd: ROOT, encoding: "utf8" }).trim();
  if (dirty) throw new Error(`these files have changes of their own; commit or stash them first:\n${dirty}`);

  let bad = 0;
  if (names.length === 0)
    for (const run of ["timeline", "history", "naming"] as const) {
      const got = runCheck(run);
      console.log(`unplanted ${run}: ${got === null ? "passes" : `FAILS (${got})`}`);
      if (got !== null) return 1;
    }
  for (const fault of faults) {
    const plant = plantOf(fault);
    const before = new Map(files.map((f) => [f, readFileSync(new URL(f, ROOT), "utf8")]));
    let got: string | null;
    try {
      for (const f of new Set(plant.edits.map((e) => e.file))) writeFileSync(new URL(f, ROOT), planted(before.get(f)!, plant, f));
      got = null;
      for (const run of plant.run) {
        got = runCheck(run);
        if (got !== null) break;
        console.log(`       ${fault}: not caught by the ${run} check`);
      }
    } catch (e) {
      got = `did not apply: ${e instanceof Error ? e.message : e}`;
    } finally {
      for (const [f, text] of before) writeFileSync(new URL(f, ROOT), text);
    }
    const ok = got !== null && !got.startsWith("did not apply") && !got.startsWith("threw") && got.includes(plant.caught) && plant.caught !== "";
    if (!ok) bad++;
    console.log(`${ok ? "caught" : "WRONG "} ${fault}: ${got ?? "NOT CAUGHT"}${got !== null && plant.caught && !got.includes(plant.caught) ? ` (recorded: ${plant.caught})` : ""}`);
  }
  console.log(bad === 0 ? `all ${faults.length} caught as recorded` : `${bad} of ${faults.length} not caught as recorded`);
  return bad === 0 ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = main(process.argv.slice(2));
