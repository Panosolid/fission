import { test } from "node:test";
import assert from "node:assert/strict";
import { CLICK_SLOP_PX, EDGE_DEPTH_SLACK, EDGE_PICK_PX, clientToNdc, edgeOfSegment, faceOfTriangle, isClick, ndcToClient, planeOrFace, segmentsNear, unhidden } from "../src/picking.ts";

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

test("a point on screen is measured against the view it is in (hand-worked)", () => {
  // A view 400 × 200 px whose top-left corner is at (100, 50) on screen.
  const rect = { left: 100, top: 50, width: 400, height: 200 };
  // Its centre (100 + 200, 50 + 100) = (300, 150) is the middle of the view: (0, 0).
  assert.deepEqual(clientToNdc({ x: 300, y: 150 }, rect), { x: 0, y: 0 });
  // Top-left corner: left edge is x = −1, top edge is y = +1 (device y points up).
  assert.deepEqual(clientToNdc({ x: 100, y: 50 }, rect), { x: -1, y: 1 });
  // Bottom-right corner (500, 250): (1, −1).
  assert.deepEqual(clientToNdc({ x: 500, y: 250 }, rect), { x: 1, y: -1 });
  // (200, 100): a quarter across (100 of 400 px) is 0.25 × 2 − 1 = −0.5;
  // a quarter down (50 of 200 px) is −(0.25 × 2) + 1 = 0.5.
  assert.deepEqual(clientToNdc({ x: 200, y: 100 }, rect), { x: -0.5, y: 0.5 });
});

test("split view: the same screen point is the middle of the right view and off the left one", () => {
  // Two views side by side, each 400 × 300 px: the left from x = 0, the right from x = 400.
  const left = { left: 0, top: 0, width: 400, height: 300 };
  const right = { left: 400, top: 0, width: 400, height: 300 };
  // (600, 150) is the right view's centre (400 + 200, 150): (0, 0) there.
  assert.deepEqual(clientToNdc({ x: 600, y: 150 }, right), { x: 0, y: 0 });
  // Measured against the left view it is 600 / 400 × 2 − 1 = 2: outside (−1…1), so a
  // view that used the wrong rectangle would cast its ray past its own edge.
  assert.deepEqual(clientToNdc({ x: 600, y: 150 }, left), { x: 2, y: 0 });
});

test("a view with no size has no device coordinates", () => {
  assert.equal(clientToNdc({ x: 0, y: 0 }, { left: 0, top: 0, width: 0, height: 100 }), null);
  assert.equal(clientToNdc({ x: 0, y: 0 }, { left: 0, top: 0, width: 100, height: 0 }), null);
  assert.equal(clientToNdc({ x: 0, y: 0 }, { left: 0, top: 0, width: NaN, height: 100 }), null);
  assert.equal(clientToNdc({ x: 0, y: 0 }, { left: 0, top: 0, width: -5, height: 100 }), null);
});

test("device coordinates back to the screen undo clientToNdc (self-consistency)", () => {
  const rect = { left: 37, top: 12, width: 640, height: 360 };
  for (const p of [{ x: 37, y: 12 }, { x: 677, y: 372 }, { x: 100.5, y: 300.25 }, { x: -50, y: 900 }]) {
    const back = ndcToClient(clientToNdc(p, rect)!, rect);
    assert.ok(Math.abs(back.x - p.x) < 1e-9 && Math.abs(back.y - p.y) < 1e-9, `${p.x},${p.y} -> ${back.x},${back.y}`);
  }
  // Hand-worked: (0, 0) is the centre (37 + 320, 12 + 180) = (357, 192).
  assert.deepEqual(ndcToClient({ x: 0, y: 0 }, rect), { x: 357, y: 192 });
});

test("hand-worked (26d): picking a plane for a sketch takes a face under the pointer over any plane, else the plane", () => {
  // From the home view (in front, above) the front plane's square rises in front of the box's top: the top, a
  // face, is picked. Beside the box only the ground plane is hit: the plane. Nothing under the pointer: nothing.
  assert.equal(planeOrFace(true, true), "face");
  assert.equal(planeOrFace(false, true), "face");
  assert.equal(planeOrFace(true, false), "plane");
  assert.equal(planeOrFace(false, false), null);
});
