import { test } from "node:test";
import assert from "node:assert/strict";
import type { CommandSpec } from "@fission/core";
import { askForCommands, type AIProvider, type AIRequest } from "../src/index.ts";

const specs: CommandSpec[] = [{ op: "set_part", summary: "s", params: { width: { type: "length", description: "w" } } }];
const good = JSON.stringify({ commands: [{ op: "set_part", width: 40 }] });

/** A provider stand-in that answers from a script and records what it was asked. */
function scripted(answers: (string | Error)[], structuredOutput = false) {
  const asked: AIRequest[] = [];
  const provider: AIProvider = {
    kind: "ollama",
    structuredOutput,
    check: async () => ({ ok: true }),
    complete: async (r) => {
      asked.push(r);
      const a = answers.shift()!;
      if (a instanceof Error) throw a;
      return a;
    },
  };
  return { provider, asked };
}

const request = { system: "You edit a CAD part.", messages: [{ role: "user" as const, content: "make it 40 wide" }] };

test("a good answer is used as is", async () => {
  const { provider } = scripted([good]);
  assert.deepEqual(await askForCommands(provider, request, specs), { ok: true, commands: [{ op: "set_part", width: 40 }], attempts: 1 });
});

test("providers with structured output get the schema; others get it in the instructions", async () => {
  const a = scripted([good], true);
  await askForCommands(a.provider, request, specs);
  assert.ok(a.asked[0].jsonSchema);
  const b = scripted([good], false);
  await askForCommands(b.provider, request, specs);
  assert.equal(b.asked[0].jsonSchema, undefined);
  assert.match(b.asked[0].system, /Answer only with JSON matching this schema/);
});

test("a bad answer is retried once, telling the model what was wrong", async () => {
  const { provider, asked } = scripted(['{"commands":[{"op":"set_part","width":-1}]}', good]);
  const r = await askForCommands(provider, request, specs);
  assert.deepEqual(r, { ok: true, commands: [{ op: "set_part", width: 40 }], attempts: 2 });
  assert.match(asked[1].messages.at(-1)!.content, /width must be a length in mm greater than 0, got -1/);
});

test("two bad answers fail clearly and change nothing", async () => {
  const { provider, asked } = scripted(["no", "still no", good]);
  assert.deepEqual(await askForCommands(provider, request, specs), {
    ok: false,
    error: "The AI's answer couldn't be used, even after one retry: the answer is not JSON. Nothing was changed.",
  });
  assert.equal(asked.length, 2, "only one retry");
});

test("a provider error is reported, not thrown", async () => {
  const { provider } = scripted([new Error("connection refused")]);
  assert.deepEqual(await askForCommands(provider, request, specs), { ok: false, error: "the AI provider failed: connection refused" });
});
