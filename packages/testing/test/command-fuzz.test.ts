// Fuzz the command layer: random and malformed AI output must always give
// a clean result (a command that passes every check, or an error message),
// never an exception. The journey suite then builds the commands that pass
// on the real kernel (journeys/command-fuzz.journey.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCommand, parseCommandList } from "@fission/core";
import { DESIGN_COMMANDS } from "@fission/design";
import { seeded, type SeededRandom } from "../src/index.ts";
import { randomCommand, randomText } from "../src/fuzz.ts";

const SEED = 0x5eedn;

test("10,000 random commands: each parses cleanly or fails with a message", () => {
  const r: SeededRandom = seeded(SEED);
  let passed = 0;
  for (let i = 0; i < 10_000; i++) {
    const raw = randomCommand(r);
    const parsed = parseCommand(raw, DESIGN_COMMANDS);
    if (parsed.ok) {
      passed++;
      // What passes really is a set_part with a shape, a good width, and good depth and height where given.
      const c = parsed.command as Record<string, unknown>;
      assert.equal(c.op, "set_part");
      for (const k of ["width", "depth", "height"])
        if (k === "width" || c[k] !== undefined) assert.ok(typeof c[k] === "number" && Number.isFinite(c[k]) && (c[k] as number) > 0, `seed ${SEED} case ${i}: ${k}`);
    } else assert.ok(parsed.error.length > 0);
  }
  // The generator must reach both sides, or this test proves nothing.
  assert.ok(passed > 100 && passed < 9_900, `${passed} passed`);
});

test("2,000 random answer texts: never throws", () => {
  const r = seeded(SEED + 1n);
  for (let i = 0; i < 2_000; i++) {
    const out = parseCommandList(randomText(r), DESIGN_COMMANDS);
    assert.ok(out.ok || out.error.length > 0);
  }
});
