// The assistant's instructions (AI4): what each offered command's
// parameters mean, written out because constrained output never shows the
// model the schema's descriptions, and the size rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CommandSpec } from "@fission/core";
import { CUBE_RULE, RADIUS_RULE, systemPrompt, UNIT_RULE } from "../src/index.ts";

// A stand-in for Design's set_part, worded the same way.
const SET_PART: CommandSpec = {
  op: "set_part",
  summary: "Make the part a shape of these sizes.",
  params: {
    shape: { type: "choice", values: ["box", "cylinder", "sphere"], description: "which shape" },
    width: { type: "length", description: "width, or diameter for a cylinder or sphere" },
  },
};
const EXPORT: CommandSpec = { op: "export_stl", summary: "Save the part as STL.", params: {} };

test("the prompt lists each offered command with what its parameters mean", () => {
  const p = systemPrompt([], [SET_PART]).split("\n");
  // Worked by hand from SET_PART: one line for the command, one per parameter, lengths marked in millimetres and above 0.
  const at = p.indexOf("- set_part: Make the part a shape of these sizes.");
  assert.ok(at >= 0, p.join("\n"));
  assert.equal(p[at + 1], "  shape: which shape (one of: box, cylinder, sphere)");
  assert.equal(p[at + 2], "  width: width, or diameter for a cylinder or sphere (millimetres, more than 0)");
});

test("commands not offered are not mentioned", () => {
  const p = systemPrompt([], [SET_PART]);
  assert.doesNotMatch(p, /export_stl/);
  assert.match(systemPrompt([], [SET_PART, EXPORT]), /^- export_stl: Save the part as STL\.$/m);
  assert.doesNotMatch(systemPrompt([], []), /^- /m, "no commands, no command lines");
});

test("the size rules are in the prompt, after the part and before the request", () => {
  const p = systemPrompt([{ op: "set_part", shape: "box", width: 40 }], [SET_PART]);
  const part = p.indexOf("The part now is made by these commands:");
  for (const rule of [UNIT_RULE, RADIUS_RULE, CUBE_RULE]) assert.ok(p.indexOf(rule) > part, rule);
  assert.ok(p.indexOf("Keep every size the user doesn't mention") > p.indexOf(CUBE_RULE));
});

test("the unit rule's factors are the units' definitions", () => {
  // By definition: 1 cm = 10 mm, 1 m = 1000 mm, and the international inch is exactly 25.4 mm (1959).
  const factors = Object.fromEntries([...UNIT_RULE.matchAll(/1 (cm|m|inch) = ([\d.]+) mm/g)].map((m) => [m[1], Number(m[2])]));
  assert.deepEqual(factors, { cm: 10, m: 1000, inch: 25.4 });
  // So the evaluation's "2 inches" is 2 × 25.4 = 50.8 mm and "0.5 m" is 500 mm.
  assert.equal(2 * factors.inch, 50.8);
  assert.equal(0.5 * factors.m, 500);
});

test("the radius rule doubles a radius and keeps a diameter", () => {
  assert.match(RADIUS_RULE, /diameter is twice the radius/);
  assert.match(RADIUS_RULE, /"across" is a diameter/);
  assert.match(CUBE_RULE, /box whose width, depth and height are all the same/);
});

test("an optional parameter is marked so", () => {
  const withDepth: CommandSpec = { ...SET_PART, params: { ...SET_PART.params, depth: { type: "length", optional: true, description: "depth; leave it out for a sphere" } } };
  // Worked by hand: a length that may be left out reads "(millimetres, more than 0; optional)".
  assert.match(systemPrompt([], [withDepth]), /^ {2}depth: depth; leave it out for a sphere \(millimetres, more than 0; optional\)$/m);
  assert.doesNotMatch(systemPrompt([], [SET_PART]), /optional/, "nothing in SET_PART is optional");
});
