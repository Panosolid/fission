// The planted STEP fault (src/step-fault.ts) on the hand-checked unit cube
// file (kernel/tests/step/unit_cube.step).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { flipFirstFace } from "../src/step-fault.ts";

const cube = readFileSync(new URL("../../../kernel/tests/step/unit_cube.step", import.meta.url), "utf8");

test("the planted fault flips the first face's same_sense and changes nothing else", () => {
  // By hand: the cube's first face in the file is #101, on plane
  // #94 with same_sense .T.; the fault is that line with .F., as
  // prototypes/oracle/test_compare.py plants it and the kernel's
  // flip_first_face writes it.
  const line = "#101 = ADVANCED_FACE('',(#100),#94,.T.);";
  assert.equal(cube.split(line).length, 2);
  assert.equal(flipFirstFace(cube), cube.replace(line, "#101 = ADVANCED_FACE('',(#100),#94,.F.);"));
  // Flipping again gives the file back.
  assert.equal(flipFirstFace(flipFirstFace(cube)), cube);
});

test("a file it can't flip is refused, never passed on unchanged", () => {
  assert.throws(() => flipFirstFace("ISO-10303-21;\nDATA;\nENDSEC;\n"), /no face to flip/);
  assert.throws(() => flipFirstFace("#1 = ADVANCED_FACE('',(#2),#3,.U.);\n"), /an ADVANCED_FACE line the writer doesn't write/);
});
