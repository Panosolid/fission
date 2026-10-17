import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { bracket, edgeUses, eulerPoincare, explodeAmount, HOLE_R, type Vec3 } from "../src/guide/bracket.ts";
import { CHAPTERS } from "../src/guide/chapters.ts";
import {
  LOOP_A,
  LOOP_B,
  SCENE_IDS,
  SOLVED,
  TOLERANCE_NM,
  WORKSPACES,
  bezier,
  booleanMode,
  buildScene,
  aimCamera,
  bezierCurvature,
  foldAmount,
  heroApart,
  landed,
  pyramidVolume,
  scanHeight,
  shatter,
  constraintCorners,
  controlPoints,
  cubeVolumeFromFaces,
  cylinderTriangles,
  digitsCancelled,
  extrudeDistance,
  gapNm,
  meshSides,
  parametricWidth,
  placementTurn,
  pointsDrawn,
  replayIndex,
  requestLayer,
  stepsBack,
  surfacePoints,
  tileAngle,
  touching,
} from "../src/guide/scenes.ts";

const near = (a: number, b: number, eps = 1e-12) => Math.abs(a - b) <= eps;
const dist = (a: Vec3, b: Vec3) => Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);

// ------------------------------------------------------------ the bracket

test("the bracket's counts, by hand: 16 vertices, 24 edges, 10 faces", () => {
  // The side profile has 7 corners, on both sides: 14; plus one seam vertex on each of the hole's two circles: 16.
  // Edges: 7 round each side (14), 7 running across, the hole's 2 circles and its seam: 24.
  // Faces: 2 sides, 7 round the profile (one is the rounded corner), the hole: 10.
  const b = bracket();
  assert.equal(b.vertices.length, 16);
  assert.equal(b.edges.length, 24);
  assert.equal(b.faces.length, 10);
});

test("Euler–Poincaré, as the kernel's validation counts it: 16 − 24 + 10 − 2 = 0, one hole through", () => {
  // V − E + F − R = 2(S − G): one shell (S = 1), R = 2 inner loops (the hole in the bottom and in the base top),
  // so 0 = 2(1 − G) gives G = 1: exactly one hole through the part.
  assert.equal(eulerPoincare(bracket()), 0);
});

test("a closed skin: every edge is used exactly twice", () => {
  assert.deepEqual(edgeUses(bracket()), new Array(24).fill(2));
});

test("breaking the bracket is caught: a missing face, or a face missing its hole", () => {
  const noFront = bracket();
  noFront.faces.splice(3, 1); // the front
  assert.ok(edgeUses(noFront).some((n) => n !== 2), "a gap in the skin must leave edges used once");
  assert.notEqual(eulerPoincare(noFront), 0);
  const noHoleLoop = bracket();
  noHoleLoop.faces[2].loops.pop(); // the bottom forgets its hole
  assert.equal(edgeUses(noHoleLoop)[21], 1);
});

test("every edge runs from its start vertex to its end vertex, and every loop closes", () => {
  const b = bracket();
  for (const e of b.edges) {
    assert.ok(dist(e.points[0], b.vertices[e.start]) < 1e-12, `${e.name} doesn't start at its vertex`);
    assert.ok(dist(e.points.at(-1)!, b.vertices[e.end]) < 1e-12, `${e.name} doesn't end at its vertex`);
  }
  // The hole's circles are closed edges: start = end, at the seam, and every point is the hole's radius from its axis.
  for (const e of b.edges.filter((e) => e.name.startsWith("hole ") && e.start === e.end))
    for (const p of e.points) assert.ok(near(Math.sqrt(p[0] ** 2 + (p[2] - 1.5) ** 2), HOLE_R, 1e-12));
  // Each loop of each face: consecutive edges share a vertex (either way round).
  for (const f of b.faces)
    for (const loop of f.loops) {
      if (loop.length === 1) continue;
      for (let i = 0; i < loop.length; i++) {
        const a = b.edges[loop[i]];
        const c = b.edges[loop[(i + 1) % loop.length]];
        assert.ok([a.start, a.end].some((v) => v === c.start || v === c.end), `${f.name}: edges ${a.name} and ${c.name} don't meet`);
      }
    }
});

test("the rounded corner is a quarter circle of radius 0.35 round (z, y) = (1.15, 1.35)", () => {
  const corner = bracket().edges.find((e) => e.name === "left rounded corner")!;
  for (const p of corner.points) assert.ok(near(Math.sqrt((p[2] - 1.15) ** 2 + (p[1] - 1.35) ** 2), 0.35, 1e-12));
});

test("explodeAmount: together until 15%, apart by 60%, eased in between", () => {
  assert.equal(explodeAmount(0), 0);
  assert.equal(explodeAmount(0.15), 0);
  // Halfway through 0.15–0.6 is 0.375: smoothstep(½) = ¼ · (3 − 1) = ½.
  assert.ok(near(explodeAmount(0.375), 0.5));
  assert.equal(explodeAmount(0.6), 1);
  assert.equal(explodeAmount(1), 1);
});

// ------------------------------------------------------------ the pictures' maths

test("parametric width: 40 mm, 60 mm halfway, 80 mm", () => {
  assert.equal(parametricWidth(0), 40);
  assert.equal(parametricWidth(0.5), 60);
  assert.equal(parametricWidth(1), 80);
});

test("sketch: points drawn grow with the scroll and are all there by 70%", () => {
  assert.equal(pointsDrawn(0, 50), 0);
  assert.equal(pointsDrawn(0.35, 50), 25);
  assert.equal(pointsDrawn(0.7, 50), 50);
  assert.equal(pointsDrawn(1, 50), 50);
});

test("extrude: 0 mm until 10%, 10 mm halfway through 10–80% (45%), 20 mm by 80%", () => {
  assert.equal(extrudeDistance(0.1), 0);
  assert.ok(near(extrudeDistance(0.45), 10));
  assert.equal(extrudeDistance(0.8), 20);
});

test("timeline and undo: which step at which scroll", () => {
  assert.equal(replayIndex(0, 4), 0);
  assert.equal(replayIndex(0.26, 4), 1);
  assert.equal(replayIndex(1, 4), 3);
  assert.equal(stepsBack(0, 5), 0);
  assert.equal(stepsBack(0.5, 5), 3); // 2.5 rounds up
  assert.equal(stepsBack(1, 5), 5);
});

test("constraints: the solved corners make a level rectangle 2.4 × 1.4", () => {
  const c = constraintCorners(1);
  assert.deepEqual(c, SOLVED);
  // Level: top and bottom edges have the same z at both ends; square corners: the sides are along z.
  assert.equal(c[0][1], c[1][1]);
  assert.equal(c[2][1], c[3][1]);
  assert.equal(c[1][0], c[2][0]);
  assert.ok(near(c[1][0] - c[0][0], 2.4) && near(c[3][1] - c[0][1], 1.4));
  assert.notDeepEqual(constraintCorners(0), SOLVED);
});

test("the request travels down to the kernel by halfway and back up", () => {
  assert.equal(requestLayer(0), 0);
  assert.equal(requestLayer(0.25), 1.5);
  assert.equal(requestLayer(0.5), 3);
  assert.equal(requestLayer(1), 0);
});

test("topology: each loop runs anticlockwise seen from outside, and the shared edge is run both ways", () => {
  // Newell's rule: the sum of (yᵢ − yᵢ₊₁)(zᵢ + zᵢ₊₁) etc. is twice the loop's area vector; anticlockwise from outside points it outwards.
  const newell = (loop: Vec3[]): Vec3 => {
    const n: Vec3 = [0, 0, 0];
    loop.forEach((a, i) => {
      const b = loop[(i + 1) % loop.length];
      n[0] += (a[1] - b[1]) * (a[2] + b[2]);
      n[1] += (a[2] - b[2]) * (a[0] + b[0]);
      n[2] += (a[0] - b[0]) * (a[1] + b[1]);
    });
    return n;
  };
  // A: a 2 × 2 square facing +y: area vector (0, 2·4, 0). B: facing −x: (−2·4, 0, 0).
  assert.deepEqual(newell(LOOP_A), [0, 8, 0]);
  assert.deepEqual(newell(LOOP_B), [-8, 0, 0]);
  // The shared edge (x = y = 0): A runs it from z = −1 to 1, B from 1 to −1.
  const along = (loop: Vec3[]) => {
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i];
      const b = loop[(i + 1) % loop.length];
      if (a[0] === 0 && a[1] === 0 && b[0] === 0 && b[1] === 0) return b[2] - a[2];
    }
    return 0;
  };
  assert.equal(along(LOOP_A), 2);
  assert.equal(along(LOOP_B), -2);
});

test("Bézier: through its first and last control points, and the middle by hand", () => {
  const c = controlPoints(0.5);
  assert.deepEqual(bezier(c, 0), c[0]);
  assert.deepEqual(bezier(c, 1), c[3]);
  // At s = ½ the weights are 1/8, 3/8, 3/8, 1/8. Control points (−2, 0.3), (−0.8, 0.3), (0.8, −1.2), (2, 0.4) at p = ½:
  // x = (−2 − 2.4 + 2.4 + 2)/8 = 0; y = (0 + 0.9 − 3.6 + 0.4)/8 = −2.3/8 = −0.2875.
  const m = bezier(c, 0.5);
  assert.ok(near(m[0], 0) && near(m[1], -0.2875));
});

test("placement: a quarter turn about (1, 1, 0)/√2 is the quaternion (½, ½, 0, √½)", () => {
  // Half the angle is 45°: w = cos 45° = √½, and (x, y, z) = sin 45° · (1, 1, 0)/√2 = (½, ½, 0).
  const [x, y, z, w] = placementTurn(1);
  assert.ok(near(x, 0.5) && near(y, 0.5) && near(z, 0) && near(w, Math.SQRT1_2));
  assert.deepEqual(placementTurn(0), [0, 0, 0, 1]);
  // A unit quaternion: x² + y² + z² + w² = 1 all the way.
  for (const p of [0.1, 0.37, 0.8]) assert.ok(near(placementTurn(p).reduce((s, q) => s + q * q, 0), 1));
});

test("tolerance: 10 nm; 0.9× (9 nm) is the same point, 1.1× (11 nm) is apart", () => {
  assert.equal(TOLERANCE_NM, 10);
  assert.equal(touching(0.9 * TOLERANCE_NM), true);
  assert.equal(touching(1.1 * TOLERANCE_NM), false);
  assert.equal(gapNm(0), 30);
  assert.equal(gapNm(1), 0);
  // The gap passes 11 nm and 9 nm on the way, as the words promise.
  assert.ok(gapNm(0.6) > 11 && gapNm(0.7) < 9.1);
});

test("mesh: a 12-sided cylinder is 48 triangles, by hand and by Three.js", () => {
  // 12 sides round the outside, each two triangles (24), and each flat end a fan of 12: 24 + 12 + 12 = 48.
  assert.equal(cylinderTriangles(12), 48);
  const g = new THREE.CylinderGeometry(1, 1, 2, 12, 1, false);
  assert.equal(g.index!.count / 3, 48);
  assert.equal(meshSides(0), 64);
  assert.equal(meshSides(1), 6);
});

test("volume from the skin: a 10 mm cube is 1000 mm³, and a 3 mm one 27", () => {
  assert.equal(cubeVolumeFromFaces(10), 1000);
  assert.equal(cubeVolumeFromFaces(3), 27);
});

test("precision: 14 of 16 digits cancel, or 28 of 32, all by 60%", () => {
  assert.equal(digitsCancelled(0, 14), 0);
  assert.equal(digitsCancelled(0.3, 14), 7); // smoothstep(½) = ½
  assert.equal(digitsCancelled(0.6, 14), 14);
  assert.equal(digitsCancelled(1, 28), 28);
});

test("booleans: join, cut, intersect in thirds", () => {
  assert.equal(booleanMode(0), "join");
  assert.equal(booleanMode(0.34), "cut");
  assert.equal(booleanMode(0.67), "intersect");
  assert.equal(booleanMode(1), "intersect");
});

test("testing: seeded points replay exactly and all lie on the cube's surface", () => {
  const a = surfacePoints(2026, 300);
  assert.deepEqual(a, surfacePoints(2026, 300));
  assert.notDeepEqual(a, surfacePoints(2027, 300));
  for (const p of a) {
    assert.ok(p.some((c) => Math.abs(c) === 1), "on a face");
    assert.ok(p.every((c) => Math.abs(c) <= 1), "inside the cube's box");
  }
});

test("validation: the scanning plane rises from below the bracket to above it by 80%", () => {
  assert.equal(scanHeight(0), -1.6);
  assert.ok(near(scanHeight(0.4), 0));
  assert.equal(scanHeight(0.8), 1.6);
  assert.equal(scanHeight(1), 1.6);
});

test("validation scene: no face checked before the plane, all 10 after", () => {
  const s = buildScene("validate");
  s.update(0);
  assert.equal(s.anchors()[0].text, "0 of 10 faces checked");
  s.update(1);
  assert.equal(s.anchors()[0].text, "all 10 faces pass: valid");
  s.dispose();
});

test("the opening bracket starts a little apart and is together by halfway", () => {
  assert.equal(heroApart(0), 0.45);
  assert.equal(heroApart(0.5), 0);
  assert.equal(heroApart(1), 0);
});

test("topology: the side face folds from flat to a right angle", () => {
  assert.equal(foldAmount(0.1), 0);
  assert.ok(near(foldAmount(0.35), 0.5));
  assert.equal(foldAmount(0.6), 1);
});

test("curvature comb, by hand: (0,0) (1,1) (2,1) (3,0) at s = ½ bends at −2/3", () => {
  // r′(½) = 3[¼(1,1) + ½(1,0) + ¼(1,−1)] = (3, 0); r″(½) = 6[½(0,−1) + ½(0,−1)] = (0, −6);
  // k = (x′y″ − y′x″)/|r′|³ = (3·−6 − 0)/27 = −2/3 (turning clockwise); the normal is the tangent turned left: (0, 1).
  const c: Vec3[] = [[0, 0, 0], [1, 1, 0], [2, 1, 0], [3, 0, 0]];
  const { curvature, normal } = bezierCurvature(c, 0.5);
  assert.ok(near(curvature, -2 / 3));
  assert.ok(near(normal[0], 0) && near(normal[1], 1));
  // Evenly spaced points on a line make a straight curve: no curvature anywhere.
  const straight: Vec3[] = [[0, 0, 0], [1, 2, 0], [2, 4, 0], [3, 6, 0]];
  for (const s of [0, 0.3, 1]) assert.ok(near(bezierCurvature(straight, s).curvature, 0));
});

test("mesh: the triangles fly apart only after 55%", () => {
  assert.equal(shatter(0.55), 0);
  assert.equal(shatter(0.9), 1);
});

test("volume: three pyramids of ⅓ × 100 × 10 fill the 1000 mm³ cube", () => {
  assert.ok(near(3 * pyramidVolume(100, 10), 1000, 1e-9));
  assert.equal(pyramidVolume(100, 0), 0); // the faces through the fixed point add nothing
});

test("testing: the first point lands at 6%, the last by 80% + 6%", () => {
  assert.equal(landed(0, 600, 0), 0);
  assert.ok(near(landed(0, 600, 0.03), 0.5));
  assert.equal(landed(0, 600, 0.06), 1);
  assert.equal(landed(599, 600, 0.79), 0);
  assert.equal(landed(599, 600, 0.86), 1);
});

test("workspaces: ten tiles, 36° apart", () => {
  assert.equal(WORKSPACES.length, 10);
  assert.equal(tileAngle(1, 10), 36);
  assert.equal(tileAngle(9, 10), 324);
});

// ------------------------------------------------------------ every scene

test("every chapter's scene builds, plays from 0 to 1 and back, stays finite, and frees what it made", () => {
  for (const id of SCENE_IDS) {
    const s = buildScene(id);
    const geometries = new Set<THREE.BufferGeometry>();
    for (const p of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1, 0.3, 0]) {
      s.update(p);
      for (const a of s.anchors()) {
        assert.ok([a.point.x, a.point.y, a.point.z, a.opacity].every(Number.isFinite), `${id}: an anchor is not finite at ${p}`);
        assert.ok(a.text.length > 0);
      }
    }
    // Everything it draws sits inside its framing ball (so nothing is cut off the screen).
    s.root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(s.root);
    const corner = Math.max(...[box.min, box.max].map((v) => v.length()));
    assert.ok(corner <= s.radius * 1.6, `${id}: reaches ${corner.toFixed(2)}, framed for ${s.radius}`);
    const freed = new Set<THREE.BufferGeometry>();
    s.root.traverse((o) => {
      const g = (o as THREE.Mesh).geometry;
      if (g && !geometries.has(g)) {
        geometries.add(g);
        g.addEventListener("dispose", () => freed.add(g));
      }
    });
    s.dispose();
    assert.equal(freed.size, geometries.size, `${id}: not every geometry was freed`);
  }
});

test("the B-rep scene comes apart with the scroll and its labels appear once apart", () => {
  const s = buildScene("brep");
  const spread = () => new THREE.Box3().setFromObject(s.root).getSize(new THREE.Vector3()).length();
  s.update(0);
  const together = spread();
  assert.ok(s.anchors().every((a) => a.opacity === 0), "no labels while assembled");
  s.update(1);
  assert.ok(spread() > together * 1.3, "the faces move apart");
  assert.deepEqual(s.anchors().map((a) => [a.text, a.opacity]), [["VERTEX", 1], ["EDGE", 1], ["FACE", 1]]);
  s.dispose();
});

test("every scene a chapter names exists", () => {
  for (const c of CHAPTERS) assert.ok(SCENE_IDS.includes(c.scene));
});

test("the camera looks down on the scene even when the app makes z-up the default (regression: everything was upside down)", () => {
  const saved = THREE.Object3D.DEFAULT_UP.clone();
  THREE.Object3D.DEFAULT_UP.set(0, 0, 1); // what the app does
  try {
    for (const [w, h] of [
      [1280, 800],
      [375, 800],
    ]) {
      const camera = new THREE.PerspectiveCamera(24, 1, 0.05, 200);
      aimCamera(camera, 2, w, h);
      const top = new THREE.Vector3(0, 1, 0).project(camera);
      const bottom = new THREE.Vector3(0, -1, 0).project(camera);
      assert.ok(top.y > bottom.y, `${w} px: +y must be up the screen`);
      assert.ok(camera.position.y > 0, "the camera is above");
      // The scene's centre lands where stageLayout puts it: 62% across when wide (NDC 0.24), 30% down when narrow (NDC 0.4).
      const centre = new THREE.Vector3(0, 0, 0).project(camera);
      if (w > h) assert.ok(near(centre.x, 0.24, 1e-9) && near(centre.y, 0, 1e-9));
      else assert.ok(near(centre.x, 0, 1e-9) && near(centre.y, 0.4, 1e-9));
      // The framing ball fits: its edge points stay on screen.
      for (const p of [new THREE.Vector3(2, 0, 0), new THREE.Vector3(-2, 0, 0), new THREE.Vector3(0, 2, 0), new THREE.Vector3(0, -2, 0)]) {
        const q = p.project(camera);
        assert.ok(Math.abs(q.x) <= 1 && Math.abs(q.y) <= 1, `${w} px: ${p.toArray()} is off screen`);
      }
    }
  } finally {
    THREE.Object3D.DEFAULT_UP.copy(saved);
  }
});
