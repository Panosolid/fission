// The command layer's fuzz test, through to the real kernel: every random
// command that passes parseCommand is built. Each must give a valid body
// or a clean kernel error (e.g. out of the modelling range), never an
// invalid body and never a crash.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCommand } from "@fission/core";
import { buildSpec, DESIGN_COMMANDS, documentFor, lastFeature, specOf } from "@fission/design";
import { seeded } from "../src/index.ts";
import { randomCommand } from "../src/fuzz.ts";
import { nodeKernel } from "../src/node-kernel.ts";

const SEED = 0xa1n;

test("random AI commands build a valid part or fail cleanly", async () => {
  const kernel = nodeKernel();
  const r = seeded(SEED);
  let built = 0;
  let refused = 0;
  for (let i = 0; i < 3_000; i++) {
    const parsed = parseCommand(randomCommand(r), DESIGN_COMMANDS);
    if (!parsed.ok) continue;
    const doc = documentFor(parsed.command);
    try {
      const view = await buildSpec(kernel, specOf(doc, lastFeature(doc)));
      assert.deepEqual(view.errors, [], `seed ${SEED} case ${i}: ${JSON.stringify(parsed.command)}`);
      built++;
    } catch (e) {
      assert.ok(e instanceof Error && e.message.length > 0, `seed ${SEED} case ${i}: not a clean error: ${String(e)}`);
      refused++;
    }
  }
  // Both outcomes must occur, or the test isn't testing much.
  assert.ok(built > 50 && refused > 50, `${built} built, ${refused} refused`);
});
