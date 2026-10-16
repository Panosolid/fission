import { test } from "node:test";
import assert from "node:assert/strict";
import { SEVERITY_COLOURS, triangleColours, type AnalysisOverlay } from "../src/model/overlay.ts";

const { warning, error, info } = SEVERITY_COLOURS;

test("marks colour the triangles of their face, the most severe winning", () => {
  // Four triangles: two on face 0, one on face 1, one on face 2.
  const tris = [0, 0, 1, 2];
  const overlays: AnalysisOverlay[] = [
    { id: "a", label: "thin walls", marks: [{ target: { face: 0 }, severity: "warning" }, { target: { face: 1 }, severity: "info" }] },
    { id: "b", label: "clearance", marks: [{ target: { face: 1 }, severity: "error" }] },
  ];
  assert.deepEqual(triangleColours(tris, overlays), [warning, warning, error, null]);
});

test("a whole-body mark colours every triangle, but a worse face mark still shows", () => {
  const overlays: AnalysisOverlay[] = [
    { id: "a", label: "too big", marks: [{ target: { body: true }, severity: "warning" }] },
    { id: "b", label: "x", marks: [{ target: { face: 1 }, severity: "error" }, { target: { face: 0 }, severity: "info" }] },
  ];
  assert.deepEqual(triangleColours([0, 1, 2], overlays), [warning, error, warning]);
  assert.deepEqual(triangleColours([0], []), [null]);
  assert.notDeepEqual(info, warning);
});
