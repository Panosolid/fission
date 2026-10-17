// set_part's sizes a shape ignores are optional (AI4): a left-out size keeps
// the current one when Design runs the command, and documentFor, which has
// no current part, refuses only a size the shape needs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCommand } from "@fission/core";
import { DESIGN_COMMANDS, documentFor } from "../src/index.ts";

const params = (c: unknown) => {
  const parsed = parseCommand(c, DESIGN_COMMANDS);
  assert.ok(parsed.ok, JSON.stringify(c));
  return documentFor(parsed.command).timeline.features[0].intent.parameters;
};

test("a sphere needs only its width, a cylinder its width and height", () => {
  // A sphere of width 30 is diameter 30; nothing else is read.
  assert.deepEqual(params({ op: "set_part", shape: "sphere", width: 30 }), { diameter: 30 });
  // A cylinder 25 across and 60 tall: diameter 25, height 60; no depth needed.
  assert.deepEqual(params({ op: "set_part", shape: "cylinder", width: 25, height: 60 }), { diameter: 25, height: 60 });
  // A box still takes all three.
  assert.deepEqual(params({ op: "set_part", shape: "box", width: 40, depth: 30, height: 20 }), { width: 40, depth: 30, height: 20 });
});

test("a size the shape needs, left out, is a clear error", () => {
  const doc = (c: object) => () => documentFor({ op: "set_part", ...c });
  assert.throws(doc({ shape: "cylinder", width: 25 }), /a cylinder needs its height/);
  assert.throws(doc({ shape: "box", width: 40, height: 20 }), /a box needs its depth/);
  assert.throws(doc({ shape: "star", width: 40, depth: 30 }), /a star needs its height/);
});

test("a size given as 0 is still refused, optional or not", () => {
  const parsed = parseCommand({ op: "set_part", shape: "sphere", width: 30, depth: 0 }, DESIGN_COMMANDS);
  assert.deepEqual(parsed, { ok: false, error: "set_part: depth must be a length in mm greater than 0, got 0" });
  assert.equal(parseCommand({ op: "set_part", shape: "sphere" }, DESIGN_COMMANDS).ok, false, "width is still required");
});
