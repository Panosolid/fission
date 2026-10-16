import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCommand, type CommandSpec } from "@fission/core";
import { DESIGN_COMMANDS } from "../src/commands.ts";
import { toolbarGroups } from "../src/toolbar.ts";

test("the toolbar has Create with every shape and Export with STL, in the command list's order", () => {
  // Written out by hand from the roadmap's 16b: Box, Cylinder, Sphere, then
  // the four extruded outlines of profiles.ts; then STL.
  const groups = toolbarGroups();
  assert.deepEqual(
    groups.map((g) => [g.name, g.buttons.map((b) => b.label)]),
    [
      ["Create", ["Box", "Cylinder", "Sphere", "L-bracket", "Plate", "Slot", "Star"]],
      ["Export", ["STL"]],
    ],
  );
});

test("every button issues a real Design command: with sizes added, each parses", () => {
  const sizes = { width: 40, depth: 30, height: 20 };
  for (const b of toolbarGroups().flatMap((g) => g.buttons)) {
    const full = b.command.op === "set_part" ? { ...b.command, ...sizes } : b.command;
    const parsed = parseCommand(full, DESIGN_COMMANDS);
    assert.ok(parsed.ok, `${b.label}: ${JSON.stringify(parsed)}`);
  }
});

test("the toolbar follows the commands: a new shape gets a button, an unknown command none", () => {
  const specs: CommandSpec[] = [
    { op: "set_part", summary: "s", params: { shape: { type: "choice", values: ["box", "torus"], description: "d" } } },
    { op: "hole", summary: "h", params: {} },
  ];
  const groups = toolbarGroups(specs);
  assert.deepEqual(groups.map((g) => g.name), ["Create"]);
  assert.deepEqual(groups[0].buttons.map((b) => [b.label, b.command]), [
    ["Box", { op: "set_part", shape: "box" }],
    ["torus", { op: "set_part", shape: "torus" }],
  ]);
});
