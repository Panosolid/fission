// The first ten examples of seed 1, each checked by hand from its words
// (the working is beside each). This also pins the generator: the same
// seed must give these same examples. When a recipe changes on purpose,
// check the new ten by hand again before changing this list.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DESIGN_COMMANDS } from "@fission/design";
import { generate, RECIPES, RULES } from "../src/index.ts";
import { fakeKernel } from "./fakes.ts";

const part = (shape: string, width: number, depth: number, height: number) => ({ op: "set_part", shape, width, depth, height });
const exportStl = { op: "export_stl" };

const HAND_CHECKED = [
  // Half its size: every size halved. 156 / 2 = 78, 13 / 2 = 6.5, 20 / 2 = 10.
  [[part("slot", 156, 13, 20)], "Scale it down to half its size.", [part("slot", 78, 6.5, 10)]],
  // Only the height named: 17 millimetres; width 21 and depth 3 kept.
  [[part("plate", 21, 3, 105)], "Change the height to 17 millimetres.", [part("plate", 21, 3, 17)]],
  // A slot is long × wide, then thick: width 296, depth 12, height 22.
  [[], "Make a rounded slot shape 296mm × 12 millimetres, 22mm thick.", [part("slot", 296, 12, 22)]],
  // A new shape keeps every size.
  [[part("star", 6, 6, 6)], "Turn it into a box.", [part("box", 6, 6, 6)]],
  // Wide, deep, tall are width, depth, height; then the export.
  [[], "I need a block 2mm wide, 1mm deep and 5 millimetres tall and give me the STL file.", [part("box", 2, 1, 5), exportStl]],
  // Inches: 3 × 25.4 = 76.2, 1.25 × 25.4 = 31.75, 9.5 × 25.4 = 241.3.
  [[], "Can you make a 3×1.25×9.5 inches box. Then export it as an STL.", [part("box", 76.2, 31.75, 241.3), exportStl]],
  // 8.5 in = 8.5 × 25.4 = 215.9 mm; depth and height kept.
  [[part("slot", 44, 14, 39)], "Make the width 8.5 in.", [part("slot", 215.9, 14, 39)]],
  // A new shape keeps every size, the cylinder's leftover depth 15 too.
  [[part("cylinder", 281, 15, 52)], "Make it a star instead.", [part("star", 281, 15, 52)]],
  // Wider is the width (a cylinder's diameter): 9.5 + 43.5 = 53.
  [[part("cylinder", 9.5, 6, 19)], "Can you make it 43.5 millimetres wider?", [part("cylinder", 53, 6, 19)]],
  // Only the export; the part stays.
  [[part("plate", 176, 110, 115)], "Download it as an STL file.", [exportStl]],
];

test("the first ten examples of seed 1, checked by hand", async () => {
  const g = await generate({ seed: 1n, count: 10, specs: DESIGN_COMMANDS, rules: RULES, recipes: RECIPES, kernel: fakeKernel(), heldOut: [] });
  assert.ok(g.ok);
  assert.deepEqual(
    g.examples.map((e) => [e.setup, e.prompt, e.commands]),
    HAND_CHECKED,
  );
});
