// Proof that the monkey tester (monkey.mjs) catches bugs before its clean
// runs are trusted: each plant below is a deliberate mistake in the real
// app's code, one or more for each of the monkey's checks, plus three of the
// timeline model's plants (packages/testing/planted/model-faults.ts). For
// each, this edits the source in place, builds the app into a folder of its
// own (vite only; the kernel's WASM is already built) and puts the file
// back; then it runs the monkey on each build, seeds 1, 2, 3… until one
// fails (MONKEY_WORKERS builds at once, default 3), and prints which check
// caught it and after how many actions. A plant nothing catches is
// reported as missed.
// `monkey.test.mjs` (in `npm test`) checks every plant still applies: each
// text it replaces is in its file exactly once.
//
// Run after `npm run build`, from apps/fission:
//   node --experimental-strip-types --no-warnings e2e/monkey-plants.mjs [plant…]
// MONKEY_PLANT_SEEDS (default 6; a plant's own `seeds` raises it for that
// plant) and MONKEY_STEPS (default 120) bound each hunt.
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SKETCHBAR = "workspaces/design/src/styles/sketchbar.css";

/** What each plant breaks, and the monkey check that should catch it. */
export const MONKEY_PLANTS = {
  "throw-on-empty-length": {
    what: "a length box left empty throws instead of saying what to type",
    expect: "no errors",
    edits: [{ file: "workspaces/design/src/typed-entry.ts", find: '  const t = text.trim().replace(/\\s*mm$/i, "");', replace: '  const t = text.trim().replace(/\\s*mm$/i, "");\n  if (t === "") throw new Error("planted: an empty length");' }],
  },
  "bar-forgets-suppressed": {
    what: "the timeline bar draws a suppressed item as if it were built",
    expect: "timeline bar matches the file",
    edits: [{ file: "workspaces/design/src/timeline-bar.ts", find: '    if (item.suppressed) li.dataset.suppressed = "true";', replace: "" }],
  },
  "bodies-ignore-builds": {
    what: "the Bodies group lists every solid, built or not",
    expect: "Bodies group matches the file",
    edits: [{ file: "workspaces/design/src/browser.ts", find: "  return document.timeline.features.filter((f) => !isSketchItem(f) && building.has(f));", replace: "  return document.timeline.features.filter((f) => !isSketchItem(f) && (building.has(f) || true));" }],
  },
  "redo-does-nothing": {
    what: "Redo says it redid the step but puts nothing back",
    expect: "undo then redo gives the same file",
    edits: [{ file: "packages/core/src/model/history.ts", find: "      go(index + 1);", replace: "      index++;" }],
  },
  "escape-keeps-delete-ask": {
    what: "Escape no longer closes the delete-ask box",
    expect: "never stuck",
    edits: [{ file: "workspaces/design/src/delete-ask.ts", find: "        e.preventDefault();\n        shut(d);", replace: "        e.preventDefault();" }],
  },
  "no-finish-on-phone": {
    what: "at phone width the sketch has no Finish Sketch on screen",
    expect: "never stuck",
    // Missed in seeds 1-6 on main and with 25a3's double-clicks; with them the first seed to catch it at 120 steps is 29 (1-40 hunted 2026-10-19).
    seeds: 40,
    edits: [{ file: SKETCHBAR, find: ".sketchbar.sketchbar-finish:not(#none) { margin-left: auto; }", replace: ".sketchbar.sketchbar-finish:not(#none) { margin-left: auto; }\n@media (max-width: 640px) { #finish-sketch, .sketch .sketch-finish, #sketch-cancel { display: none !important; } }" }],
  },
  "body-row-off-by-one": {
    what: "a Bodies row selects the next body",
    expect: "selection agrees",
    // Since #192 (no Body rows for failed features) the first seed to catch it at 120 steps is 31 (then 36, 38; 1-40 hunted 2026-10-19).
    seeds: 40,
    edits: [{ file: "workspaces/design/src/browser.ts", find: "  const rows = new Map(bodyRows(doc, failed).map((r) => [r.id, r.feature.id]));", replace: "  const rows = new Map(bodyRows(doc, failed).map((r, i, all) => [r.id, all[(i + 1) % all.length].feature.id]));" }],
  },
  "failed-body-rows": {
    what: "a feature the kernel refused still gets a Body row (bug hunt 2026-10-19, finding 5)",
    expect: "Bodies group matches the file",
    edits: [{ file: "workspaces/design/src/browser.ts", find: "(failed.has(f.id) ? [] :", replace: "(false ? [] :" }],
  },
  "top-bar-spills-on-phone": {
    what: "at phone width the top bar is wider than the window",
    expect: "no sideways scrolling",
    // The timeline bar and the toolbar scroll inside their own boxes, so a wide one never widens the page; the top bar does.
    edits: [{ file: "packages/ui/src/theme.css", find: "#topbar h1 { font-size: 16px; margin: 0; white-space: nowrap; }", replace: "#topbar h1 { font-size: 16px; margin: 0; white-space: nowrap; }\n@media (max-width: 400px) { #topbar { min-width: 420px; } }" }],
  },
};

/** The timeline model's plants the monkey should catch too (by name in model-faults.ts). */
const MODEL_PLANTS = { "reuse-ids": "document rules", "save-stamps": "save then open gives the same file", "ignore-marker": "timeline bar matches the file" };

export async function allPlants() {
  const { PLANTS } = await import("../../../packages/testing/planted/model-faults.ts");
  const out = { ...MONKEY_PLANTS };
  for (const [name, expect] of Object.entries(MODEL_PLANTS)) out[name] = { what: PLANTS[name].what, expect, edits: PLANTS[name].edits };
  return out;
}

const root = new URL("../../../", import.meta.url);
const app = new URL("../", import.meta.url);

/** Applies `edits`, each text found exactly once; returns the files as they were. */
function plant(edits) {
  const before = new Map();
  for (const e of edits) {
    const path = new URL(e.file, root);
    const text = before.has(e.file) ? readFileSync(path, "utf8") : (before.set(e.file, readFileSync(path, "utf8")), readFileSync(path, "utf8"));
    if (text.split(e.find).length !== 2) throw new Error(`${e.file}: the plant's text is not there exactly once: ${e.find}`);
    writeFileSync(path, text.replace(e.find, () => e.replace));
  }
  return before;
}
function restore(before) {
  for (const [file, text] of before) writeFileSync(new URL(file, root), text);
}
/** Builds the app as it is into `outDir` (vite only). */
const build = (outDir) => execFileSync("npx", ["vite", "build", "--logLevel", "error", "--emptyOutDir", "--outDir", outDir], { cwd: app, stdio: "inherit" });
/** One monkey seed on the build in `outDir`: the failing check, or null. */
function hunt(outDir, port, seed) {
  return new Promise((done) => {
    const env = { ...process.env, FISSION_SEED: String(seed), MONKEY_SHRINK: "0", MONKEY_STEPS: process.env.MONKEY_STEPS || "120", MONKEY_NO_REGRESSIONS: "1", MONKEY_OUT: outDir, MONKEY_PORT: String(port) };
    let out = "";
    const child = spawn("node", ["e2e/monkey.mjs"], { cwd: app, env });
    child.stdout.on("data", (d) => (out += d));
    child.on("close", () => {
      const m = /FAIL at action (\d+): ([^:]+): (.*)/.exec(out);
      done(m ? { seed, actions: Number(m[1]), caught: m[2], message: m[3].slice(0, 160) } : null);
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const plants = await allPlants();
  const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(plants);
  const seeds = Number(process.env.MONKEY_PLANT_SEEDS || 6);
  const workers = Number(process.env.MONKEY_WORKERS || 3);
  const base = mkdtempSync(join(tmpdir(), "monkey-plants-"));
  // Each plant is built into a folder of its own and its file put back at once, so the hunts can run side by side.
  for (const name of names) {
    const before = plant(plants[name].edits);
    try {
      build(join(base, name));
    } finally {
      restore(before);
    }
  }
  const rows = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: workers }, async (_, w) => {
      while (next < names.length) {
        const name = names[next++];
        const p = plants[name];
        let row = { name, what: p.what, expect: p.expect, caught: null };
        for (let seed = 1; seed <= Math.max(seeds, p.seeds ?? 0) && !row.caught; seed++) {
          const found = await hunt(join(base, name), 4230 + w, seed);
          if (found) row = { ...row, ...found };
        }
        rows.push(row);
        console.log(row.caught ? `${name}: caught by "${row.caught}" (seed ${row.seed}, action ${row.actions})${row.caught === row.expect ? "" : `, expected "${row.expect}"`}: ${row.message}` : `${name}: MISSED in ${Math.max(seeds, p.seeds ?? 0)} seeds (${p.what})`);
      }
    }),
  );
  rmSync(base, { recursive: true, force: true });
  const missed = rows.filter((r) => !r.caught);
  console.log(missed.length ? `plants: ${missed.length} of ${rows.length} missed` : `plants: all ${rows.length} caught`);
  process.exitCode = missed.length ? 1 : 0;
}
