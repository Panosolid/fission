// Splits `npm run e2e` across CI's parallel e2e jobs: `node e2e/shard.mjs 2 3`
// runs the second of three shares. package.json's "e2e" script stays the one
// list of browser checks; this reads it, so a check added there runs in some
// shard without touching CI. Each share runs every one of its checks, even
// after a failure, and fails if any did.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** Seconds each check took on its own (all 26 in a row, 2026-10-18), to even out the shares; a check not listed counts as `UNKNOWN`.
 * Only the balance depends on them: a wrong or missing entry makes one share slower, never skips a check. */
export const SECONDS = {
  "smoke.mjs": 60,
  "dump-viewer.mjs": 53,
  "storage.mjs": 2,
  "image.mjs": 23,
  "styles.mjs": 1,
  "files.mjs": 7,
  "copy-svg.mjs": 4,
  "switching.mjs": 7,
  "shortcuts.mjs": 5,
  "undo.mjs": 21,
  "sketch.mjs": 7,
  "sketch-tool.mjs": 46,
  "snap.mjs": 11,
  "sketch-session.mjs": 109,
  "sketch-pixels.mjs": 5,
  "free-placement.mjs": 10,
  "sketch-view.mjs": 15,
  "navigation.mjs": 32,
  "sketch-toolbar.mjs": 20,
  "centre-arc.mjs": 11,
  "extrude.mjs": 12,
  "assistant.mjs": 25,
  "guide.mjs": 262,
  "layout.mjs": 4,
  "typed-entry.mjs": 37,
  "journeys.mjs": 9,
  "framing.mjs": 14,
  "leave-save.mjs": 23,
  "monkey.mjs": 120,
};
export const UNKNOWN = 30;

/** The commands of an "a && b && c" script, refusing any other shape so no check can be lost in the split. */
export function commands(script) {
  if (/\|\||;|(^|[^&])&([^&]|$)|\|/.test(script)) throw new Error(`the e2e script must be a plain "a && b" chain: ${script}`);
  const parts = script.split("&&").map((s) => s.trim());
  for (const p of parts) {
    if (!/^node( --[a-z-]+)* e2e\/[a-z0-9-]+\.mjs$/.test(p)) throw new Error(`not a browser check: "${p}"`);
  }
  return parts;
}

/** The file a command runs, e.g. "smoke.mjs". */
export const fileOf = (command) => command.slice(command.lastIndexOf("/") + 1);

/** `cmds` dealt into `n` shares, longest first onto the lightest share; every command lands in exactly one, in its original order. */
export function shares(cmds, n, seconds = SECONDS) {
  if (!Number.isInteger(n) || n < 1) throw new Error(`shard count must be a whole number from 1: ${n}`);
  const cost = (c) => seconds[fileOf(c)] ?? UNKNOWN;
  const order = cmds.map((c, i) => i).sort((a, b) => cost(cmds[b]) - cost(cmds[a]) || a - b);
  const load = Array(n).fill(0);
  const owner = [];
  for (const i of order) {
    let k = 0;
    for (let j = 1; j < n; j++) if (load[j] < load[k]) k = j;
    owner[i] = k;
    load[k] += cost(cmds[i]);
  }
  return load.map((_, k) => cmds.filter((_, i) => owner[i] === k));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [k, n] = process.argv.slice(2).map(Number);
  const script = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).scripts.e2e;
  const all = shares(commands(script), n);
  if (!Number.isInteger(k) || k < 1 || k > n) throw new Error(`usage: node e2e/shard.mjs <1..n> <n>, got ${k} ${n}`);
  const mine = all[k - 1];
  console.log(`e2e share ${k} of ${n}: ${mine.map(fileOf).join(", ")}`);
  const failed = [];
  const took = [];
  for (const c of mine) {
    console.log(`\n=== ${c}`);
    const start = Date.now();
    const r = spawnSync(c, { shell: true, stdio: "inherit" });
    took.push(`${fileOf(c)} ${Math.round((Date.now() - start) / 1000)} s`);
    if (r.status !== 0) failed.push(fileOf(c));
  }
  console.log(`\n${took.join(", ")}`);
  if (failed.length) {
    console.log(`FAILED: ${failed.join(", ")}`);
    process.exit(1);
  }
}
