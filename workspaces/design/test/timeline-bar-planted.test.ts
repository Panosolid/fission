// Step 24f2, test plan point 3: bugs planted in timeline-bar.ts, one at a
// time, each of which the seeded sessions against the plain model
// (timeline-bar-session.ts) must catch, with the check that catches it.
// Each plant is a text edit of the real source, loaded as a copy from a
// temporary folder (its imports pointed back at src/), so src/ is never
// touched. "Suppress recorded as two undo steps" is the wiring's (24f3):
// here an edit is one returned document, so there is nothing to plant.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomSteps, runBarSession, shrink, type Bar } from "./timeline-bar-session.ts";

const SOURCE = new URL("../src/timeline-bar.ts", import.meta.url);

interface Plant {
  name: string;
  find: string;
  replace: string;
  /** Text in the session's failure message: which check caught it. */
  caught: string;
}

export const BAR_PLANTS: Plant[] = [
  { name: "drop-off-by-one", find: "if ((e.left + e.right) / 2 < at) place++;", replace: "if ((e.left + e.right) / 2 <= at) place++;", caught: "landed at" },
  { name: "item-drop-off-by-one", find: "reorderItem(doc, a.id, a.place > k ? a.place - 1 : a.place)", replace: "reorderItem(doc, a.id, Math.min(a.place, count - 1))", caught: "the bar gave" },
  {
    name: "drag-ignores-scroll",
    find: "export function dropIndex(edges: readonly ItemEdges[], x: number, scroll = 0): number {\n  const at = x + scroll;",
    replace: "export function dropIndex(edges: readonly ItemEdges[], x: number, scroll = 0): number {\n  const at = x;",
    caught: "landed at",
  },
  // From 24f5 the playback buttons' check sees it first: Step back is on at the start.
  { name: "back-past-start", find: "return Math.max(0, marker - 1);", replace: "return marker - 1;", caught: "the buttons are" },
  { name: "delete-while-sketching", find: '{ action: "delete", label: "Delete", off: busy }', replace: '{ action: "delete", label: "Delete", off: null }', caught: "the bar gave" },
  { name: "refused-reorder-recorded", find: 'if ("refused" in moved) return { kind: "refused", message: moved.message };', replace: 'if ("refused" in moved) return { kind: "edit", step: TIMELINE_STEPS.reorder(name), doc };', caught: "the bar gave" },
  // 24f5: the playback buttons ignoring the sketch being edited (on where barEdit refuses), and the end's words given to the start.
  { name: "buttons-ignore-editing", find: 'const r = barEdit(doc, { kind: "button", button }, editing);', replace: 'const r = barEdit(doc, { kind: "button", button }, null);', caught: "the buttons are" },
  { name: "buttons-ends-swapped", find: "stepTarget(button, marker, count) === 0 ?", replace: "stepTarget(button, marker, count) === count ?", caught: "the buttons are" },
  { name: "delete-never-asks", find: "ask: features.some((f) => f.dependsOn.includes(a.id))", replace: "ask: false", caught: "the bar gave" },
];

/** timeline-bar.ts with `plant` made, loaded from a temporary copy whose relative imports point at src/. */
async function plantedBar(plant: Plant, dir: string): Promise<Bar> {
  const text = readFileSync(SOURCE, "utf8");
  const at = text.indexOf(plant.find);
  assert.ok(at >= 0 && text.indexOf(plant.find, at + 1) < 0, `${plant.name}: the text to replace must be in timeline-bar.ts exactly once: ${plant.find}`);
  const planted = (text.slice(0, at) + plant.replace + text.slice(at + plant.find.length)).replace(/from "\.\/([^"]+)"/g, (_, f) => `from "${new URL(f, SOURCE).href}"`);
  const file = join(dir, `timeline-bar-${plant.name}.ts`);
  writeFileSync(file, planted);
  return import(pathToFileURL(file).href);
}

test("each bug planted in the bar is caught by the seeded sessions, by the check recorded for it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "timeline-bar-planted-"));
  try {
    // The copy unplanted must pass, so a catch below is the plant's and not the copying's.
    const clean = await plantedBar({ name: "none", find: "export const DRAG_PIXELS = 5;", replace: "export const DRAG_PIXELS = 5;", caught: "" }, dir);
    for (let seed = 241; seed < 253; seed++) assert.equal(runBarSession(clean, randomSteps(seed, 150)), null, `the unplanted copy fails seed ${seed}`);
    const report: string[] = [];
    for (const plant of BAR_PLANTS) {
      const bar = await plantedBar(plant, dir);
      let caught: string | null = null;
      for (let seed = 241; seed < 253 && caught === null; seed++) {
        const failure = runBarSession(bar, randomSteps(seed, 150));
        if (failure) caught = `seed ${seed} ${failure.message}`;
      }
      report.push(`${plant.name}: ${caught ?? "NOT CAUGHT"}`);
      assert.ok(caught !== null, `${plant.name} was not caught by 12 seeds × 150 steps`);
      assert.ok(caught.includes(plant.caught), `${plant.name} was caught by another check than "${plant.caught}": ${caught}`);
    }
    if (process.env.FISSION_PLANTED_REPORT) console.log(report.join("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a planted failure shrinks to a short list that still fails, and fails no more with any one step dropped", async () => {
  const dir = mkdtempSync(join(tmpdir(), "timeline-bar-shrink-"));
  try {
    const bar = await plantedBar(BAR_PLANTS.find((p) => p.name === "refused-reorder-recorded")!, dir);
    const steps = randomSteps(241, 150);
    assert.ok(runBarSession(bar, steps));
    const small = shrink(bar, steps);
    assert.ok(runBarSession(bar, small), "the shrunk list still fails");
    assert.ok(small.length < 20, `shrunk to ${small.length} steps`);
    for (let i = 0; i < small.length; i++) assert.equal(runBarSession(bar, small.filter((_, j) => j !== i)), null, `step ${i} could be dropped`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
