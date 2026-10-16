import { test } from "node:test";
import assert from "node:assert/strict";
import type { AIProvider } from "@fission/ai";
import { parseCommand } from "@fission/core";
import { DESIGN_COMMANDS } from "@fission/design";
import { EVAL_CASES, matches, runEval, successRates } from "../src/ai-eval.ts";

test("every ready case's expected answer is itself a valid command", () => {
  for (const c of EVAL_CASES.filter((c) => !c.waitsFor))
    for (const e of c.expected) {
      // Fill parameters the case doesn't care about with a valid length.
      const full = { depth: 1, height: 1, ...e };
      assert.ok(parseCommand(full, DESIGN_COMMANDS).ok, `${c.id}: ${JSON.stringify(full)}`);
    }
  assert.ok(EVAL_CASES.some((c) => c.waitsFor), "the hole case from the spec is listed, waiting for its command");
});

test("matching looks only at the expected parameters, in order", () => {
  const box = { op: "set_part", shape: "box", width: 40, depth: 30, height: 20 };
  assert.equal(matches([box], [{ op: "set_part", width: 40 }]), true);
  assert.equal(matches([box], [{ op: "set_part", width: 40.1 }]), false);
  assert.equal(matches([box], [{ width: 40 }, { width: 40 }]), false);
  assert.equal(matches([], []), true);
});

test("the suite scores a provider per task type", async () => {
  // A stand-in provider that always answers "box 40 × 30 × 20".
  const provider: AIProvider = {
    kind: "ollama",
    structuredOutput: true,
    check: async () => ({ ok: true }),
    complete: async () => JSON.stringify({ commands: [{ op: "set_part", shape: "box", width: 40, depth: 30, height: 20 }] }),
  };
  const results = await runEval(provider, EVAL_CASES, DESIGN_COMMANDS);
  // Worked by hand: 40 × 30 × 20 is right for "box-by-sizes" and "box-in-cm" (4 cm × 3 cm × 2 cm) only,
  // so create 2 of 7 and edit 0 of 5; the hole case is skipped. Every answer was usable first time.
  assert.deepEqual(successRates(results), { create: 2 / 7, "edit-parameter": 0 });
  assert.equal(results.length, 12);
  assert.deepEqual(results.filter((r) => r.passed).map((r) => r.id), ["box-by-sizes", "box-in-cm"]);
  assert.ok(results.every((r) => r.attempts === 1));
});
