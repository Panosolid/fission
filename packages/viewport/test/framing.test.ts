import { test } from "node:test";
import assert from "node:assert/strict";
import { needsRefit, selectionFraming } from "../src/framing.ts";

test("camera re-frames when the body stops fitting or becomes a speck", () => {
  const at = (x: number, y: number, z: number, radius: number) => ({ centre: [x, y, z] as [number, number, number], radius });
  assert.equal(needsRefit(null, at(0, 0, 0, 25)), true); // first body
  // 40×30×20 box (r = √2900/2 ≈ 26.93, centre (20, 15, 10)) widened to 45:
  // r = √3325/2 ≈ 28.83, centre moves 2.5; 2.5 + 28.83 < 1.5 × 26.93.
  assert.equal(needsRefit(at(20, 15, 10, Math.sqrt(2900) / 2), at(22.5, 15, 10, Math.sqrt(3325) / 2)), false);
  // Boundary on the fit rule, framed r = 10: reach 15 is kept, just past re-frames.
  assert.equal(needsRefit(at(0, 0, 0, 10), at(3, 4, 0, 10)), false); // 5 + 10 = 15
  assert.equal(needsRefit(at(0, 0, 0, 10), at(3, 4, 0, 10.0001)), true);
  assert.equal(needsRefit(at(0, 0, 0, 10), at(0, 0, 0, 15)), false); // grew 1.5×
  assert.equal(needsRefit(at(0, 0, 0, 10), at(0, 0, 0, 15.0001)), true);
  // Boundary on shrinking: a tenth is kept, just under re-frames.
  assert.equal(needsRefit(at(0, 0, 0, 1), at(0, 0, 0, 0.1)), false);
  assert.equal(needsRefit(at(0, 0, 0, 1), at(0, 0, 0, 0.0999)), true);
  // 40 mm box → 1 µm box: radius ratio ~3e-5.
  assert.equal(needsRefit(at(20, 15, 10, 29), at(0.0005, 0.0005, 0.0005, 0.00087)), true);
  assert.equal(needsRefit(at(0, 0, 0, 5), at(0, 0, 0, 0)), false); // nothing to frame
});

test("the selection is framed by a sphere around its own triangles and segments", () => {
  // A hand-built mesh of the 40 × 30 × 20 box's top face (face 1, z = 20,
  // two triangles) and bottom face (face 0, z = 0), and two edges: edge 4
  // from (0, 0, 20) to (40, 0, 20), edge 9 from (40, 30, 0) to (40, 30, 20).
  const mesh = {
    positions: [0, 0, 20, 40, 0, 20, 40, 30, 20, 0, 30, 20, 0, 0, 0, 40, 0, 0, 40, 30, 0, 0, 30, 0],
    indices: [0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6],
    triangle_faces: [1, 1, 0, 0],
    edge_lines: [0, 0, 20, 40, 0, 20, 40, 30, 0, 40, 30, 20],
    edge_line_edges: [4, 9],
  };
  // Top face alone: box 0..40 × 0..30 × 20..20, centre (20, 15, 20),
  // radius = √(40² + 30²)/2 = 50/2 = 25.
  assert.deepEqual(selectionFraming(mesh, [1], []), { centre: [20, 15, 20], radius: 25 });
  // Edge 4 alone: centre (20, 0, 20), radius 40/2 = 20.
  assert.deepEqual(selectionFraming(mesh, [], [4]), { centre: [20, 0, 20], radius: 20 });
  // Top face and edge 9: box 0..40 × 0..30 × 0..20, the whole box,
  // centre (20, 15, 10), radius √2900/2 (as fit() frames it).
  assert.deepEqual(selectionFraming(mesh, [1], [9]), { centre: [20, 15, 10], radius: Math.sqrt(2900) / 2 });
  // The bottom face does not leak into the top face's framing, and an
  // index the mesh does not have frames nothing.
  assert.equal(selectionFraming(mesh, [0], []).centre[2], 0);
  assert.deepEqual(selectionFraming(mesh, [7], [3]), { centre: [0, 0, 0], radius: 0 });
  assert.deepEqual(selectionFraming(mesh, [], []), { centre: [0, 0, 0], radius: 0 });
});
