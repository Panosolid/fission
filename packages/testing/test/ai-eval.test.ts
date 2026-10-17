import { test } from "node:test";
import assert from "node:assert/strict";
import type { AIProvider } from "@fission/ai";
import { parseCommand } from "@fission/core";
import { DESIGN_COMMANDS } from "@fission/design";
import { EVAL_CASES, HELD_OUT_CASES, matches, runEval, successRates } from "../src/ai-eval.ts";

test("every ready case's expected answer is itself a valid command", () => {
  for (const c of [...EVAL_CASES, ...HELD_OUT_CASES].filter((c) => !c.waitsFor))
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

test("the held-out cases are new: no id or sentence shared with the original cases", () => {
  const ids = new Set(EVAL_CASES.map((c) => c.id));
  const prompts = new Set(EVAL_CASES.map((c) => c.prompt.toLowerCase()));
  for (const c of HELD_OUT_CASES) {
    assert.ok(!ids.has(c.id) && !prompts.has(c.prompt.toLowerCase()), c.id);
    assert.ok(c.id.startsWith("held-"), `${c.id}: held-out ids start with "held-" so a report can't mix them up`);
  }
  assert.equal(new Set(HELD_OUT_CASES.map((c) => c.id)).size, HELD_OUT_CASES.length, "ids are unique");
});

test("the held-out cases catch the first run's mistakes", () => {
  const byId = (id: string) => HELD_OUT_CASES.find((c) => c.id === id)!;
  // Radius 9 read as the diameter gives width 9; right is 2 × 9 = 18.
  assert.equal(matches([{ op: "set_part", shape: "cylinder", width: 9, depth: 1, height: 40 }], byId("held-cylinder-radius").expected), false);
  assert.equal(matches([{ op: "set_part", shape: "cylinder", width: 18, depth: 1, height: 40 }], byId("held-cylinder-radius").expected), true);
  // The opposite mistake: a diameter doubled as if it were a radius (80 instead of 40).
  assert.equal(matches([{ op: "set_part", shape: "cylinder", width: 80, depth: 1, height: 10 }], byId("held-cylinder-diameter").expected), false);
  // A cube made as a cylinder.
  assert.equal(matches([{ op: "set_part", shape: "cylinder", width: 18, depth: 18, height: 18 }], byId("held-cube-sides").expected), false);
  // Centimetres left unconverted (5 instead of 50), and inches (2 instead of 50.8).
  assert.equal(matches([{ op: "set_part", shape: "sphere", width: 5, depth: 1, height: 1 }], byId("held-sphere-cm").expected), false);
  assert.equal(matches([{ op: "set_part", shape: "box", width: 2, depth: 1, height: 1 }], byId("held-box-inches").expected), false);
});

test("the suite scores a provider on the held-out cases", async () => {
  // A stand-in provider that always answers "cylinder, width 18, height 40".
  const provider: AIProvider = {
    kind: "ollama",
    structuredOutput: true,
    check: async () => ({ ok: true }),
    complete: async () => JSON.stringify({ commands: [{ op: "set_part", shape: "cylinder", width: 18, depth: 30, height: 40 }] }),
  };
  const results = await runEval(provider, HELD_OUT_CASES, DESIGN_COMMANDS);
  // Worked by hand: only "held-cylinder-radius" expects a cylinder 18 wide and 40 tall, so create 1 of 8
  // and edit 0 of 6.
  assert.equal(results.length, 14);
  assert.deepEqual(successRates(results), { create: 1 / 8, "edit-parameter": 0 });
  assert.deepEqual(results.filter((r) => r.passed).map((r) => r.id), ["held-cylinder-radius"]);
});
