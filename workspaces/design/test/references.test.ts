import { test } from "node:test";
import assert from "node:assert/strict";
import { designReference } from "../src/references.ts";

test("references for a body, a face and an edge of feature #1 (placeholder ids until step 32)", () => {
  // Worked by hand from the scheme in references.ts: "<kind>:<feature>" for the
  // body, "<kind>:<feature>/<kernel index>" for faces and edges.
  assert.deepEqual(designReference("body", "feature-1"), { kind: "body", id: "body:feature-1" });
  assert.deepEqual(designReference("face", "feature-1", 3), { kind: "face", id: "face:feature-1/3" });
  assert.deepEqual(designReference("edge", "feature-1", 0), { kind: "edge", id: "edge:feature-1/0" });
});

test("a face and an edge with the same index are different references", () => {
  assert.notEqual(designReference("face", "feature-1", 2).id, designReference("edge", "feature-1", 2).id);
});

test("bad input is refused, not turned into an id", () => {
  assert.throws(() => designReference("face", "feature-1"), /needs a kernel index/);
  assert.throws(() => designReference("face", "feature-1", -1), /needs a kernel index/);
  assert.throws(() => designReference("edge", "feature-1", 1.5), /needs a kernel index/);
  assert.throws(() => designReference("edge", "feature-1", Number.NaN), /needs a kernel index/);
  assert.throws(() => designReference("body", "feature-1", 0), /takes no index/);
  assert.throws(() => designReference("body", ""), /invalid feature id/);
  // A ":" or "/" in the feature id would make "face:a/1/2" ambiguous.
  assert.throws(() => designReference("face", "a/1", 2), /invalid feature id/);
});
