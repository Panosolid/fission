import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCommand, type CommandSpec } from "@fission/core";
import { DESIGN_COMMANDS, SHAPES } from "../src/commands.ts";
import { SHAPE_LABELS, toolbarGroups } from "../src/toolbar.ts";

test("the toolbar has Export with STL and no shape buttons (U0d: the shapes are in Insert ▾ and the panel's Shape choice)", () => {
  // Written out by hand: set_part makes no button any more; export_stl is the one export.
  assert.deepEqual(
    toolbarGroups().map((g) => [g.name, g.buttons.map((b) => b.label)]),
    [["Export", ["STL"]]],
  );
});

test("every button issues a real Design command, and every shape set_part offers has a name", () => {
  for (const b of toolbarGroups().flatMap((g) => g.buttons)) {
    const parsed = parseCommand(b.command, DESIGN_COMMANDS);
    assert.ok(parsed.ok, `${b.label}: ${JSON.stringify(parsed)}`);
  }
  const shape = DESIGN_COMMANDS.find((c) => c.op === "set_part")!.params.shape;
  assert.ok(shape.type === "choice");
  assert.deepEqual(shape.values, SHAPES);
  // Written out by hand from the roadmap's 16b: Box, Cylinder, Sphere, then the four extruded outlines of profiles.ts.
  assert.deepEqual(SHAPES.map((k) => SHAPE_LABELS[k]), ["Box", "Cylinder", "Sphere", "L-bracket", "Plate", "Slot", "Star"]);
});

test("the toolbar follows the commands: a set_part makes no button, an unknown command none, an export its own", () => {
  const specs: CommandSpec[] = [
    { op: "set_part", summary: "s", params: { shape: { type: "choice", values: ["box", "torus"], description: "d" } } },
    { op: "hole", summary: "h", params: {} },
  ];
  assert.deepEqual(toolbarGroups(specs), []);
  assert.deepEqual(toolbarGroups([...specs, { op: "export_stl", summary: "e", params: {} }]).map((g) => [g.name, g.buttons.map((b) => [b.label, b.command, b.title])]), [["Export", [["STL", { op: "export_stl" }, "e"]]]]);
});
