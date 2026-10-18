// Bugs planted in typed-entry.ts's arc sizes, one at a time, each of which
// the seeded arc sessions (arc-typed-session.ts) must catch, by the check
// recorded for it. Each plant is a text edit of the real source, loaded as
// a copy from a temporary folder (its imports pointed back at src/), so
// src/ is never touched.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runArcSession, type Entry } from "./arc-typed-session.ts";

const SOURCE = new URL("../src/typed-entry.ts", import.meta.url);

interface Plant {
  name: string;
  find: string;
  replace: string;
  /** The start of the session's failure message: which check caught it. */
  caught: string;
}

const PLANTS: Plant[] = [
  { name: "end-turned-the-wrong-way", find: "const [cos, sin] = direction(deg);", replace: "const [cos, sin] = direction(-deg);", caught: "end" },
  { name: "typed-sweep-always-counter-clockwise", find: "swept: (wayRound(tool, pointer) * locks.sweep * Math.PI) / 180", replace: "swept: (locks.sweep * Math.PI) / 180", caught: "end" },
  { name: "typed-sweep-left-to-the-click", find: "if (tool.kind !== \"centre\" || tool.start === null || locks.sweep === undefined) return tool;", replace: "return tool;", caught: "end" },
  { name: "tap-ignores-the-pointer", find: "const swept = p && tool.centre && tool.start ? sweep(tool.centre, tool.start, tool.swept, p) : tool.swept;", replace: "const swept = tool.swept;", caught: "end" },
  { name: "radius-read-from-the-length-box", find: "lineEnd(anchor, pointer, { length: locks.radius, angle: locks.angle })", replace: "lineEnd(anchor, pointer, { length: locks.length, angle: locks.angle })", caught: "start" },
  { name: "boxes-on-the-point-on-the-arc", find: "if (tool.kind === \"arc\" && tool.start !== null && tool.end === null) return [\"length\", \"angle\"];", replace: "if (tool.kind === \"arc\" && tool.start !== null) return [\"length\", \"angle\"];", caught: "fields" },
  { name: "live-sweep-ignores-the-way", find: "const turn = way * (angleOf(anchor, aim) - angleOf(anchor, tool.start));", replace: "const turn = angleOf(anchor, aim) - angleOf(anchor, tool.start);", caught: "live" },
  { name: "tangent-end-not-typed", find: "if ((tool.kind === \"line\" || tool.kind === \"tangent\") && tool.from !== null) return [\"length\", \"angle\"];", replace: "if (tool.kind === \"line\" && tool.from !== null) return [\"length\", \"angle\"];", caught: "fields" },
];

/** typed-entry.ts with `plant` made, loaded from a temporary copy whose relative imports point at src/. */
async function planted(plant: Plant, dir: string): Promise<Entry> {
  const text = readFileSync(SOURCE, "utf8");
  const at = text.indexOf(plant.find);
  assert.ok(at >= 0 && text.indexOf(plant.find, at + 1) < 0, `${plant.name}: the text to replace must be in typed-entry.ts exactly once: ${plant.find}`);
  const copy = (text.slice(0, at) + plant.replace + text.slice(at + plant.find.length)).replace(/from "\.\/([^"]+)"/g, (_, f) => `from "${new URL(f, SOURCE).href}"`);
  const file = join(dir, `typed-entry-${plant.name}.ts`);
  writeFileSync(file, copy);
  return import(pathToFileURL(file).href);
}

test("each bug planted in the arcs' typed sizes is caught by the seeded sessions, by the check recorded for it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arc-typed-planted-"));
  try {
    // The copy unplanted must pass, so a catch below is the plant's and not the copying's.
    const clean = await planted({ name: "none", find: "export const MIN_TYPED = 1e-3;", replace: "export const MIN_TYPED = 1e-3;", caught: "" }, dir);
    for (let seed = 1; seed <= 3; seed++) assert.equal(runArcSession(clean, seed, 500), null, `the unplanted copy fails seed ${seed}`);
    const report: string[] = [];
    for (const plant of PLANTS) {
      const te = await planted(plant, dir);
      let caught: string | null = null;
      for (let seed = 1; seed <= 3 && caught === null; seed++) caught = runArcSession(te, seed, 500)?.message ?? null;
      report.push(`${plant.name}: ${caught?.slice(0, 160) ?? "NOT CAUGHT"}`);
      assert.ok(caught !== null, `${plant.name} was not caught by 3 seeds × 500 arcs`);
      assert.match(caught, new RegExp(`^seed \\d+ episode \\d+: ${plant.caught}:`), `${plant.name} was caught by another check than "${plant.caught}": ${caught}`);
    }
    if (process.env.FISSION_PLANTED_REPORT) console.log(report.join("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
