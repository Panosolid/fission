import { test } from "node:test";
import assert from "node:assert/strict";
import { commandSchema, parseCommand, parseCommandList, type CommandSpec } from "../src/model/commands.ts";

const hole: CommandSpec = {
  op: "hole",
  summary: "Drill a hole",
  params: {
    face: { type: "reference", to: "face", description: "face to drill" },
    diameter: { type: "length", description: "diameter" },
    depth: { type: "choice", values: ["through", "blind"], description: "how deep" },
    note: { type: "text", maxLength: 20, description: "why", optional: true },
  },
};

test("the schema is generated from the command's description", () => {
  // Worked by hand from the spec above: op fixed, three required params,
  // the optional note left out of "required", nothing else allowed.
  assert.deepEqual(commandSchema(hole), {
    type: "object",
    description: "Drill a hole",
    properties: {
      op: { const: "hole" },
      face: { type: "string", description: "face to drill (stable id of a face; never coordinates)" },
      diameter: { type: "number", exclusiveMinimum: 0, description: "diameter (mm)" },
      depth: { type: "string", enum: ["through", "blind"], description: "how deep" },
      note: { type: "string", maxLength: 20, description: "why" },
    },
    required: ["op", "face", "diameter", "depth"],
    additionalProperties: false,
  });
});

test("the spec's own example parses", () => {
  const raw = { op: "hole", face: "f:feature-1/top", diameter: 5, depth: "through" };
  assert.deepEqual(parseCommand(raw, [hole]), { ok: true, command: raw });
});

test("each kind of malformed command gets its own clear error", () => {
  const bad: [unknown, RegExp][] = [
    [null, /must be an object, got null/],
    [[1], /must be an object/],
    [{ op: "explode" }, /unknown command "explode"; known: hole/],
    [{ op: "hole", face: "f", depth: "through" }, /hole needs diameter/],
    [{ op: "hole", face: "f", diameter: -5, depth: "through" }, /diameter must be a length in mm greater than 0, got -5/],
    [{ op: "hole", face: "f", diameter: Infinity, depth: "through" }, /greater than 0/],
    [{ op: "hole", face: "f", diameter: "5", depth: "through" }, /got "5"/],
    [{ op: "hole", face: "f", diameter: 5, depth: "deep" }, /depth must be one of through, blind, got "deep"/],
    [{ op: "hole", face: [10, 20, 0], diameter: 5, depth: "through" }, /face must be the stable id of a face, got \[10,20,0\]/],
    [{ op: "hole", face: "f", diameter: 5, depth: "through", x: 3 }, /hole has no parameter "x"/],
    [{ op: "hole", face: "f", diameter: 5, depth: "through", note: "x".repeat(21) }, /at most 20 characters/],
  ];
  for (const [raw, error] of bad) {
    const r = parseCommand(raw, [hole]);
    assert.equal(r.ok, false, JSON.stringify(raw));
    assert.match((r as { error: string }).error, error);
  }
});

test("a whole answer: JSON with a commands list, each checked", () => {
  const ok = JSON.stringify({ commands: [{ op: "hole", face: "f", diameter: 3, depth: "blind" }] });
  assert.equal(parseCommandList(ok, [hole]).ok, true);
  assert.deepEqual(parseCommandList("Sure! Here's a hole.", [hole]), { ok: false, error: "the answer is not JSON" });
  assert.match((parseCommandList("[]", [hole]) as { error: string }).error, /"commands" list/);
  assert.match((parseCommandList('{"commands":[{"op":"hole"}]}', [hole]) as { error: string }).error, /^command 1: hole needs face/);
  assert.match((parseCommandList(JSON.stringify({ commands: Array(51).fill({}) }), [hole]) as { error: string }).error, /at most 50/);
});
