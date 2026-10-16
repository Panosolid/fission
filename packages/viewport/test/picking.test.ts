import { test } from "node:test";
import assert from "node:assert/strict";
import { CLICK_SLOP_PX, EDGE_DEPTH_SLACK, EDGE_PICK_PX, edgeOfSegment, faceOfTriangle, isClick, segmentsNear, unhidden } from "../src/picking.ts";

test("a press and release under the slop is a click, over it is a camera drag", () => {
  const at = { x: 100, y: 200 };
  assert.equal(isClick(at, at), true);
  // A 3-4-5 triangle scaled to the slop: moved (0.6, 0.8) × slop is exactly the slop away.
  const moved = (f: number) => ({ x: 100 + 0.6 * CLICK_SLOP_PX * f, y: 200 + 0.8 * CLICK_SLOP_PX * f });
  assert.equal(isClick(at, moved(0.9)), true); // 0.9 × slop: a click
  assert.equal(isClick(at, moved(1.1)), false); // 1.1 × slop: a drag
  assert.equal(isClick(at, { x: 100 + CLICK_SLOP_PX, y: 200 }), false); // exactly the slop counts as a drag
  assert.equal(isClick(at, { x: 100, y: 200 - 0.9 * CLICK_SLOP_PX }), true); // any direction
  assert.equal(isClick(at, { x: 100 - 1.1 * CLICK_SLOP_PX, y: 200 }), false);
});

test("a hit triangle maps to its kernel face, a miss or a stale index to nothing", () => {
  // A box face is two triangles: six faces, twelve triangles, face k owning triangles 2k and 2k+1.
  const triangleFaces = [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5];
  assert.equal(faceOfTriangle(triangleFaces, 2), 1);
  assert.equal(faceOfTriangle(triangleFaces, 3), 1);
  assert.equal(faceOfTriangle(triangleFaces, 11), 5);
  assert.equal(faceOfTriangle(triangleFaces, 0), 0);
  assert.equal(faceOfTriangle(triangleFaces, undefined), null); // missed the body
  assert.equal(faceOfTriangle(triangleFaces, null), null);
  assert.equal(faceOfTriangle(triangleFaces, 12), null); // one past the end
  assert.equal(faceOfTriangle(triangleFaces, -1), null);
  assert.equal(faceOfTriangle(triangleFaces, 1.5), null);
  assert.equal(faceOfTriangle([], 0), null);
});

test("segments near the pointer: distance to the closest point, nearest first, within the pick radius", () => {
  // Segment 0 runs along y = 100 from x = 0 to x = 100; segment 1 runs
  // down x = 200 from y = 0 to y = 100; segment 2 has an end behind the camera.
  const screen = [0, 100, 100, 100, 200, 0, 200, 100, NaN, 0, 50, 50];
  // (40, 103): straight above segment 0 at t = 40/100 = 0.4, 3 px away.
  assert.deepEqual(segmentsNear(screen, { x: 40, y: 103 }), [{ segment: 0, t: 0.4, distance: 3 }]);
  // (104, 103): past segment 0's end (t clamps to 1), so the distance is to
  // the end (100, 100): √(4² + 3²) = 5, exactly the radius: a miss.
  assert.deepEqual(segmentsNear(screen, { x: 104, y: 103 }), []);
  // 0.9× and 1.1× the radius straight off segment 1's middle (200, 50).
  assert.deepEqual(segmentsNear(screen, { x: 200 + 0.9 * EDGE_PICK_PX, y: 50 }), [{ segment: 1, t: 0.5, distance: 0.9 * EDGE_PICK_PX }]);
  assert.deepEqual(segmentsNear(screen, { x: 200 - 1.1 * EDGE_PICK_PX, y: 50 }), []);
  // Between both with a big radius: (150, 100) is 50 from segment 0's end and
  // 50 from segment 1's lower end; the tie keeps segment order. Segment 2 is skipped.
  assert.deepEqual(
    segmentsNear(screen, { x: 150, y: 100 }, 60).map((n) => n.segment),
    [0, 1],
  );
  // (190, 30) is 10 from segment 1 and further from segment 0: nearest first.
  assert.deepEqual(
    segmentsNear(screen, { x: 190, y: 30 }, 1000).map((n) => n.segment),
    [1, 0],
  );
  // A segment squashed to a point (seen end on) is still near its point.
  assert.deepEqual(segmentsNear([10, 10, 10, 10], { x: 13, y: 14 }), []); // 3-4-5: exactly 5 px, a miss
  assert.deepEqual(segmentsNear([10, 10, 10, 10], { x: 12, y: 10 }), [{ segment: 0, t: 0, distance: 2 }]);
  assert.deepEqual(segmentsNear([], { x: 0, y: 0 }), []);
});

test("a segment maps to its kernel edge, a stale index to nothing", () => {
  // A cube's 12 edges drawn as one segment each, here in reverse order.
  const segmentEdges = [11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0];
  assert.equal(edgeOfSegment(segmentEdges, 0), 11);
  assert.equal(edgeOfSegment(segmentEdges, 4), 7);
  assert.equal(edgeOfSegment(segmentEdges, 12), null);
  assert.equal(edgeOfSegment(segmentEdges, -1), null);
});

test("an edge point is hidden only by a face clearly in front of it", () => {
  // An edge point 100 mm from the camera: the face it lies on is met at 100.
  assert.equal(unhidden(100, null), true); // nothing in the way
  assert.equal(unhidden(100, 100), true); // its own face
  assert.equal(unhidden(100, 150), true); // a face behind it
  // 0.9× and 1.1× the slack in front: 0.09 mm and 0.11 mm closer at 100 mm.
  assert.equal(unhidden(100, 100 * (1 - 0.9 * EDGE_DEPTH_SLACK)), true);
  assert.equal(unhidden(100, 100 * (1 - 1.1 * EDGE_DEPTH_SLACK)), false);
  assert.equal(unhidden(100, 40), false); // the box's near side in front of a back edge
});
