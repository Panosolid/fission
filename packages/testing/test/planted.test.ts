// The table of bugs planted by hand in the real code (planted/model-faults.ts,
// step 24e3) stays honest without the WASM build: every one of the model's
// planted bugs has a plant, every plant records the check that caught it,
// and every text a plant replaces is still in its file exactly once, so a
// plant can't stop applying unnoticed when the code changes. Running the
// plants themselves (planted/run.ts) needs the real kernel.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MODEL_FAULTS } from "../src/timeline-model.ts";
import { PLANTS, type Plant } from "../planted/model-faults.ts";
import { planted } from "../planted/run.ts";

const ROOT = new URL("../../../", import.meta.url);
const read = (file: string) => readFileSync(new URL(file, ROOT), "utf8");

test("every one of the model's planted bugs has a plant in the real code, recording what caught it", () => {
  assert.deepEqual(Object.keys(PLANTS).sort(), [...MODEL_FAULTS].sort());
  for (const [fault, p] of Object.entries(PLANTS)) {
    assert.ok(p.edits.length > 0, fault);
    assert.ok(p.caught.length > 0, `${fault}: no check recorded`);
  }
});

test("every plant still applies: each text it replaces is in its file exactly once, and planting changes the file", () => {
  for (const [fault, p] of Object.entries(PLANTS))
    for (const file of new Set(p.edits.map((e) => e.file))) {
      const text = read(file);
      assert.notEqual(planted(text, p, file), text, `${fault} changes nothing in ${file}`);
    }
});

test("a plant whose text is gone, or is there twice, is refused rather than applied", () => {
  const plant = (find: string): Plant => ({ what: "", edits: [{ file: "x.ts", find, replace: "y" }], run: "timeline", caught: "z" });
  assert.equal(planted("a b c", plant("b"), "x.ts"), "a y c");
  assert.throws(() => planted("a c", plant("b"), "x.ts"), /no time/);
  assert.throws(() => planted("b a b", plant("b"), "x.ts"), /more than one time/);
  // Only the plant's edits for that file are made.
  assert.equal(planted("a b c", plant("b"), "other.ts"), "a b c");
});
