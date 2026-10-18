// The guide's 3D scenes, one per chapter (chapters.ts names them). Each is
// driven by the scroll: `update(p)` with p from 0 (the chapter just
// arrived) to 1 (scrolled through), so the picture follows the reader and
// scrolling back plays it backwards. The maths each picture shows (how far
// apart, how many triangles, which mode) is in small exported functions
// the tests check by hand. Labels are `anchors`: points in the scene the
// guide pins words to on screen.

import * as THREE from "three";
import { cameraDistance, stageLayout, type SceneId } from "./chapters.ts";
import { bracket, explodeAmount, segmentPoints, holeCircle, D, H1, H2, HOLE_R, HOLE_Z, W, type Vec3 } from "./bracket.ts";

export interface Anchor {
  text: string;
  /** In the scene's own space (the guide turns it with the scene). */
  point: THREE.Vector3;
  /** 0 hidden … 1 shown. */
  opacity: number;
}

export interface GuideScene {
  root: THREE.Group;
  /** A ball round the scene's centre that holds everything it draws, for framing. */
  radius: number;
  update(p: number): void;
  anchors(): Anchor[];
  dispose(): void;
}

const INK = 0xffffff;
const SKIN = 0xc9d2e6;
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const ease = (x: number) => {
  const s = clamp01(x);
  return s * s * (3 - 2 * s);
};
const v3 = (p: Vec3) => new THREE.Vector3(p[0], p[1], p[2]);

function line(points: THREE.Vector3[], colour = INK, opacity = 1): THREE.Line {
  const material = new THREE.LineBasicMaterial({ color: colour, transparent: opacity < 1, opacity });
  return new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), material);
}

function dot(at: THREE.Vector3, colour = INK, size = 0.05): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.SphereGeometry(size, 14, 10), new THREE.MeshBasicMaterial({ color: colour }));
  m.position.copy(at);
  return m;
}

function skin(colour = SKIN, opacity = 1): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color: colour, roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide, transparent: opacity < 1, opacity, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
}

/** Frees every geometry and material under `root` (each scene is built fresh when its chapter comes up). */
export function disposeAll(root: THREE.Object3D): void {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    m.geometry?.dispose();
    const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
    for (const mat of mats) mat.dispose();
  });
}

function scene(root: THREE.Group, radius: number, update: (p: number) => void, anchors: () => Anchor[] = () => []): GuideScene {
  return { root, radius, update, anchors, dispose: () => disposeAll(root) };
}

// ---------------------------------------------------------------- bracket

/**
 * A flat face through `outline` (and `holes`), drawn by projecting onto two
 * directions in its plane (u, v), triangulating there, and lifting back.
 */
function planarFace(outline: Vec3[], holes: Vec3[][], u: THREE.Vector3, v: THREE.Vector3, material: THREE.Material): THREE.Mesh {
  const n = new THREE.Vector3().crossVectors(u, v);
  const d = n.dot(v3(outline[0]));
  const to2 = (p: Vec3) => new THREE.Vector2(v3(p).dot(u), v3(p).dot(v));
  const shape = new THREE.Shape(outline.map(to2));
  for (const h of holes) shape.holes.push(new THREE.Path(h.map(to2)));
  const geometry = new THREE.ShapeGeometry(shape, 24);
  const pos = geometry.getAttribute("position") as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const w = u.clone().multiplyScalar(pos.getX(i)).addScaledVector(v, pos.getY(i)).addScaledVector(n, d);
    pos.setXYZ(i, w.x, w.y, w.z);
  }
  geometry.computeVertexNormals();
  return new THREE.Mesh(geometry, material);
}

/** A strip between two matching rows of points (the rounded corner). */
function stripFace(a: Vec3[], b: Vec3[], material: THREE.Material): THREE.Mesh {
  const positions: number[] = [];
  const index: number[] = [];
  for (const p of [...a, ...b]) positions.push(...p);
  for (let i = 0; i + 1 < a.length; i++) {
    const j = a.length + i;
    index.push(i, i + 1, j, i + 1, j + 1, j);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  return new THREE.Mesh(g, material);
}

/** The bracket as face groups, each with its own surface, edges and vertices, so it can come apart. */
function bracketModel() {
  const b = bracket();
  const centre = new THREE.Vector3(0, -H2 / 2, -D / 2);
  const model = new THREE.Group();
  model.position.copy(centre);
  const faceGroups: THREE.Group[] = [];
  const materials: THREE.MeshStandardMaterial[] = [];
  const edgeLines: THREE.Line[] = [];
  const X = new THREE.Vector3(1, 0, 0);
  b.faces.forEach((f, fi) => {
    const g = new THREE.Group();
    const material = skin();
    materials.push(material);
    if (fi < 2) {
      const x = fi === 0 ? -W : W;
      const outline: Vec3[] = [];
      for (let k = 0; k < 7; k++) outline.push(...segmentPoints(x, k).slice(0, -1));
      g.add(planarFace(outline, [], new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0), material));
    } else if (f.name === "rounded corner") {
      g.add(stripFace(segmentPoints(-W, 3), segmentPoints(W, 3), material));
    } else if (f.name === "hole") {
      const c = new THREE.Mesh(new THREE.CylinderGeometry(HOLE_R, HOLE_R, H1, 48, 1, true), material);
      c.position.set(0, H1 / 2, HOLE_Z);
      g.add(c);
    } else {
      const k = fi - 2;
      const [l0, l1] = segmentPoints(-W, k);
      const [r0, r1] = segmentPoints(W, k);
      const along = v3(l1).sub(v3(l0)).normalize();
      const holes = f.loops.slice(1).map((loop) => b.edges[loop[0]].points.slice(0, -1));
      g.add(planarFace([l0, l1, r1, r0], holes, X, along, material));
    }
    const seen = new Set<number>();
    for (const loop of f.loops)
      for (const e of loop) {
        const edge = b.edges[e];
        const l = line(edge.points.map(v3));
        edgeLines.push(l);
        g.add(l);
        for (const vtx of [edge.start, edge.end])
          if (!seen.has(vtx)) {
            seen.add(vtx);
            g.add(dot(v3(b.vertices[vtx])));
          }
      }
    faceGroups.push(g);
    model.add(g);
  });
  const setApart = (amount: number) => b.faces.forEach((f, i) => faceGroups[i].position.copy(v3(f.explode).multiplyScalar(1.5 * amount)));
  return { b, model, faceGroups, materials, edgeLines, setApart };
}

/** The opening picture: the bracket a little apart, closing up as the reader starts to scroll. */
export function heroApart(p: number): number {
  return 0.45 * (1 - ease(p / 0.5));
}

function hero(): GuideScene {
  const root = new THREE.Group();
  const { model, setApart } = bracketModel();
  root.add(model);
  return scene(root, 3, (p) => setApart(heroApart(p)));
}

function brep(): GuideScene {
  const root = new THREE.Group();
  const { b, model, faceGroups, setApart } = bracketModel();
  root.add(model);
  let amount = 0;
  // Pinned to points that travel with their face: a top corner, an edge of the upright, the left side's middle.
  const pinned = (face: number, p: Vec3) => {
    const out = v3(p).add(faceGroups[face].position).add(model.position);
    return out;
  };
  const top = b.faces.findIndex((f) => f.name === "top");
  const upright = b.faces.findIndex((f) => f.name === "upright front");
  return scene(
    root,
    3.4,
    (p) => {
      amount = explodeAmount(p);
      setApart(amount);
    },
    () => {
      const shown = clamp01((amount - 0.55) / 0.35);
      return [
        { text: "VERTEX", point: pinned(top, b.vertices[5]), opacity: shown },
        { text: "EDGE", point: pinned(upright, [0, H2, 0.8]), opacity: shown },
        { text: "FACE", point: pinned(0, [-W, 0.55, 1.25]), opacity: shown },
      ];
    },
  );
}

function validate(): GuideScene {
  const root = new THREE.Group();
  const { model, faceGroups, materials, edgeLines } = bracketModel();
  root.add(model);
  model.updateMatrixWorld(true);
  // Each face is checked when the plane passes its middle.
  const middles = faceGroups.map((g) => new THREE.Box3().setFromObject(g).getCenter(new THREE.Vector3()).y);
  const scan = new THREE.Mesh(new THREE.PlaneGeometry(4.4, 3.6), new THREE.MeshBasicMaterial({ color: 0x86efac, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false }));
  scan.rotation.x = -Math.PI / 2;
  const rim = line([new THREE.Vector3(-2.2, 0, -1.8), new THREE.Vector3(2.2, 0, -1.8), new THREE.Vector3(2.2, 0, 1.8), new THREE.Vector3(-2.2, 0, 1.8), new THREE.Vector3(-2.2, 0, -1.8)], 0xbbf7d0);
  root.add(scan, rim);
  let n = 0;
  let y = -1.6;
  const green = new THREE.Color(0x86efac);
  const plain = new THREE.Color(SKIN);
  return scene(
    root,
    2.8,
    (p) => {
      y = scanHeight(p);
      scan.position.y = rim.position.y = y;
      n = middles.filter((m) => m < y).length;
      materials.forEach((m, i) => m.color.copy(middles[i] < y ? green : plain));
      for (const l of edgeLines) (l.material as THREE.LineBasicMaterial).color.set(n === materials.length ? 0x14532d : INK);
    },
    () => [{ text: n === materials.length ? "all 10 faces pass: valid" : `${n} of ${materials.length} faces checked`, point: new THREE.Vector3(2.2, y, 1.8), opacity: 1 }],
  );
}

/** The validation chapter's scanning plane: its height at scroll p, from below the bracket (−1.6) to above it (1.6) by 80%. */
export function scanHeight(p: number): number {
  return -1.6 + 3.2 * clamp01(p / 0.8);
}

// ---------------------------------------------------------------- Design

/** The width the parametric chapter shows at scroll p, in mm: 40 growing to 80. */
export function parametricWidth(p: number): number {
  return 40 + 40 * clamp01(p);
}

function parametric(): GuideScene {
  const root = new THREE.Group();
  const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), skin());
  box.add(new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), new THREE.LineBasicMaterial({ color: INK })));
  root.add(box);
  // A hole that stays in the middle however wide the box gets: built on the width, it follows it.
  const hole = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 1.24, 40), new THREE.MeshStandardMaterial({ color: 0x1e2550, roughness: 0.8 }));
  const holeRim = line(Array.from({ length: 49 }, (_, i) => new THREE.Vector3(0.3 * Math.cos((i / 48) * Math.PI * 2), 0.61, 0.3 * Math.sin((i / 48) * Math.PI * 2))), INK);
  root.add(hole, holeRim);
  const dim = new THREE.Group();
  const bar = line([new THREE.Vector3(-1, 0, 0), new THREE.Vector3(1, 0, 0)], 0xfde68a);
  const ends = [-1, 1].map((x) => line([new THREE.Vector3(x, -0.12, 0), new THREE.Vector3(x, 0.12, 0)], 0xfde68a));
  dim.add(bar, ...ends);
  root.add(dim);
  let mm = 40;
  return scene(
    root,
    2.8,
    (p) => {
      mm = parametricWidth(p);
      const w = mm / 25;
      box.scale.set(w, 1.2, 1.6);
      bar.scale.set(w / 2, 1, 1);
      ends[0].position.x = -w / 2 + 1;
      ends[1].position.x = w / 2 - 1;
      dim.position.set(0, -0.6, 1.1);
    },
    () => [
      { text: `width ${Math.round(mm)} mm`, point: new THREE.Vector3(0, -0.6, 1.1), opacity: 1 },
      { text: "the hole stays in the middle", point: new THREE.Vector3(0, 0.61, 0.3), opacity: clamp01(mm / 4 - 11) },
    ],
  );
}

/** A slot: a 3 × 1.2 bar with round ends, as a closed outline. */
function slotShape(): THREE.Shape {
  const s = new THREE.Shape();
  s.moveTo(-0.9, -0.6);
  s.lineTo(0.9, -0.6);
  s.absarc(0.9, 0, 0.6, -Math.PI / 2, Math.PI / 2, false);
  s.lineTo(-0.9, 0.6);
  s.absarc(-0.9, 0, 0.6, Math.PI / 2, (3 * Math.PI) / 2, false);
  return s;
}

/** How many of an outline's `n` points are drawn at scroll p: all of them by 70%. */
export function pointsDrawn(p: number, n: number): number {
  return Math.min(n, Math.floor((clamp01(p) / 0.7) * n));
}

function sketch(): GuideScene {
  const root = new THREE.Group();
  const grid = new THREE.GridHelper(4.8, 24, 0xffffff, 0xffffff);
  (grid.material as THREE.Material).transparent = true;
  (grid.material as THREE.Material).opacity = 0.16;
  root.add(grid);
  const pts = slotShape().getPoints(24).map((q) => new THREE.Vector3(q.x, 0.01, -q.y));
  pts.push(pts[0].clone());
  const outline = line(pts, 0xfde68a);
  root.add(outline);
  // Where the lines meet the arcs: each gets a dot and a ring that pops as the pen snaps there.
  const corners = [new THREE.Vector3(0.9, 0.01, 0.6), new THREE.Vector3(0.9, 0.01, -0.6), new THREE.Vector3(-0.9, 0.01, -0.6), new THREE.Vector3(-0.9, 0.01, 0.6)];
  const reachedAt = corners.map((c) => {
    let best = 0;
    pts.forEach((q, i) => {
      if (q.distanceTo(c) < pts[best].distanceTo(c)) best = i;
    });
    return best;
  });
  const dots = corners.map((c) => dot(c, INK, 0.06));
  const rings = corners.map((c) => {
    const r = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.012, 8, 40), new THREE.MeshBasicMaterial({ color: 0xfde68a, transparent: true, opacity: 0 }));
    r.rotation.x = Math.PI / 2;
    r.position.copy(c);
    return r;
  });
  const pen = dot(new THREE.Vector3(), 0xffffff, 0.08);
  const halo = new THREE.Mesh(new THREE.SphereGeometry(0.2, 20, 14), new THREE.MeshBasicMaterial({ color: 0xfde68a, transparent: true, opacity: 0.3, depthWrite: false }));
  root.add(...dots, ...rings, pen, halo);
  const fillMat = skin(0xfde68a, 0.01);
  const fill = new THREE.Mesh(new THREE.ShapeGeometry(slotShape(), 24), fillMat);
  fill.rotation.x = -Math.PI / 2;
  root.add(fill);
  let closed = 0;
  return scene(
    root,
    2.2,
    (p) => {
      const n = pointsDrawn(p, pts.length);
      outline.geometry.setDrawRange(0, n);
      const tip = pts[Math.max(0, n - 1)];
      pen.position.copy(tip);
      halo.position.copy(tip);
      pen.visible = halo.visible = n > 0 && n < pts.length;
      corners.forEach((_, i) => {
        const since = n - 1 - reachedAt[i];
        dots[i].visible = since >= 0;
        const k = clamp01(since / 6);
        rings[i].scale.setScalar(0.6 + 1.6 * k);
        (rings[i].material as THREE.MeshBasicMaterial).opacity = since >= 0 ? 0.9 * (1 - k) : 0;
      });
      closed = clamp01((p - 0.7) / 0.15);
      fillMat.opacity = 0.4 * closed;
    },
    () => [
      { text: "PROFILE: a closed loop", point: new THREE.Vector3(0, 0, 0.6), opacity: closed },
    ],
  );
}

/** The extrude chapter's distance at scroll p, in mm: 0 until 10%, 20 by 80%. */
export function extrudeDistance(p: number): number {
  return 20 * ease((p - 0.1) / 0.7);
}

function extrude(): GuideScene {
  const root = new THREE.Group();
  const outlinePts = slotShape().getPoints(24).map((q) => new THREE.Vector3(q.x, 0, -q.y));
  outlinePts.push(outlinePts[0].clone());
  root.add(line(outlinePts, 0xfde68a));
  const solid = new THREE.Mesh(new THREE.ExtrudeGeometry(slotShape(), { depth: 1, bevelEnabled: false, curveSegments: 24 }), skin());
  solid.add(new THREE.LineSegments(new THREE.EdgesGeometry(solid.geometry, 30), new THREE.LineBasicMaterial({ color: INK })));
  solid.rotation.x = -Math.PI / 2;
  root.add(solid);
  // Copies of the outline left behind as it rises, like layers, and the four straight edges it sweeps.
  const layers = [0.25, 0.5, 0.75].map((f) => {
    const l = line(outlinePts, 0xfde68a, 0.5);
    root.add(l);
    return { l, f };
  });
  const rails = [new THREE.Vector3(0.9, 0, 0.6), new THREE.Vector3(0.9, 0, -0.6), new THREE.Vector3(-0.9, 0, -0.6), new THREE.Vector3(-0.9, 0, 0.6)].map((c) => {
    const l = line([c, c.clone().setY(1)], 0xfde68a, 0.8);
    root.add(l);
    return l;
  });
  const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.24, 16), new THREE.MeshBasicMaterial({ color: 0xfde68a }));
  root.add(arrow);
  root.position.y = -0.7;
  let mm = 0;
  const top = (mm: number) => mm / 13;
  return scene(
    root,
    2.4,
    (p) => {
      mm = extrudeDistance(p);
      const h = top(mm);
      solid.visible = mm > 0.05;
      solid.scale.z = Math.max(h, 0.003);
      for (const { l, f } of layers) {
        l.position.y = h * f;
        l.visible = mm > 0.05 && mm < 19.9;
      }
      for (const r of rails) r.scale.y = Math.max(h, 0.001);
      arrow.position.set(0, h + 0.3, 0);
      arrow.visible = mm < 19.9;
    },
    () => [{ text: `distance ${mm.toFixed(1)} mm`, point: new THREE.Vector3(1.5, top(mm), 0), opacity: clamp01(mm / 2) }],
  );
}

/** The timeline chapter: which feature is being replayed at scroll p (0 to count − 1). */
export function replayIndex(p: number, count: number): number {
  return Math.min(count - 1, Math.floor(clamp01(p) * count));
}

const FEATURES = ["Sketch 1", "Extrude 1", "Sketch 2", "Extrude 2"];
function timeline(): GuideScene {
  const root = new THREE.Group();
  const blocks = FEATURES.map((name, i) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(1, 0.3, 0.6), skin(name.startsWith("Sketch") ? 0x99f6e4 : 0xbfdbfe));
    m.position.set(-1.95 + i * 1.3, -0.8, 0);
    root.add(m);
    return m;
  });
  root.add(line([new THREE.Vector3(-2.6, -0.97, 0), new THREE.Vector3(2.6, -0.97, 0)], INK, 0.6));
  // What each feature has built so far, above it: a slot drawn, the slot as a bar, a circle drawn on it, the hole cut through.
  const slot = slotShape();
  const holed = slotShape();
  holed.holes.push(new THREE.Path().absarc(0, 0, 0.32, 0, Math.PI * 2, false));
  const flat = (shape: THREE.Shape, colour: number) => {
    const pts = shape.getPoints(24).map((q) => new THREE.Vector3(q.x, 0, -q.y));
    return line([...pts, pts[0].clone()], colour);
  };
  const solidOf = (shape: THREE.Shape) => {
    const m = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: 0.5, bevelEnabled: false, curveSegments: 24 }), skin());
    m.add(new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry, 30), new THREE.LineBasicMaterial({ color: INK })));
    m.rotation.x = -Math.PI / 2;
    return m;
  };
  const circle = line(Array.from({ length: 49 }, (_, i) => new THREE.Vector3(0.32 * Math.cos((i / 48) * Math.PI * 2), 0.51, 0.32 * Math.sin((i / 48) * Math.PI * 2))), 0xfde68a);
  const sketch2 = new THREE.Group();
  sketch2.add(solidOf(slot), circle);
  const results = [flat(slot, 0xfde68a), solidOf(slot), sketch2, solidOf(holed)].map((r, i) => {
    const g = new THREE.Group();
    g.add(r);
    g.scale.setScalar(0.42);
    g.position.set(blocks[i].position.x, 0.1, 0);
    root.add(g);
    return g;
  });
  const marker = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.03, 8, 48), new THREE.MeshBasicMaterial({ color: 0xfde68a }));
  marker.rotation.x = Math.PI / 2;
  root.add(marker);
  let at = 0;
  return scene(
    root,
    2.9,
    (p) => {
      at = replayIndex(p, FEATURES.length);
      blocks.forEach((b, i) => {
        b.position.y = i <= at ? -0.72 : -0.8;
        (b.material as THREE.MeshStandardMaterial).emissive.set(i === at ? 0x3a3a00 : 0x000000);
      });
      results.forEach((r, i) => {
        const k = i < at ? 1 : i === at ? clamp01((p * FEATURES.length - at) * 3) : 0;
        r.visible = k > 0;
        r.position.y = 0.1 + 0.4 * (1 - k);
      });
      marker.position.set(blocks[at].position.x, 0.1, 0);
    },
    () => FEATURES.map((text, i) => ({ text, point: blocks[i].position.clone().add(new THREE.Vector3(0, -0.15, 0.3)), opacity: 1 })),
  );
}

/** The undo chapter: how many steps back at scroll p (0 to max). */
export function stepsBack(p: number, max: number): number {
  return Math.round(clamp01(p) * max);
}

function history(): GuideScene {
  const root = new THREE.Group();
  const n = 6;
  // Six saved moments of the project, newest in front; each holds the part as it was then (a box getting wider).
  const cards = Array.from({ length: n }, (_, i) => {
    const g = new THREE.Group();
    const card = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.4, 0.03), skin(0xe0e7ff, 0.5));
    const part = new THREE.Mesh(new THREE.BoxGeometry(0.5 + 0.22 * (n - 1 - i), 0.5, 0.3), skin(0x93c5fd));
    part.position.z = 0.17;
    g.add(card, part);
    g.position.set(0, 0, 1.4 - i * 0.55);
    root.add(g);
    return g;
  });
  let back = 0;
  let p = 0;
  return scene(
    root,
    2.8,
    (q) => {
      p = q;
      back = stepsBack(q, n - 1);
      cards.forEach((c, i) => {
        // Undone moments lift away and fade; the one you're on comes forward.
        const undone = i < back;
        c.position.y = undone ? 1.2 + 0.1 * (back - i) : i === back ? 0.15 : 0;
        c.rotation.x = undone ? -0.5 : 0;
        c.traverse((o) => {
          const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
          if (m) m.opacity = undone ? 0.12 : i === back ? 0.95 : 0.35;
        });
      });
    },
    () => [{ text: back === 0 ? "now" : `${back} undo${back === 1 ? "" : "s"} back (Redo brings them back)`, point: cards[back].position.clone().add(new THREE.Vector3(1.1, 0.7, 0)), opacity: p >= 0 ? 1 : 0 }],
  );
}

/** The constraints chapter: the rough sketch's corners and the rectangle the solver settles them into (x, z). */
export const ROUGH: [number, number][] = [
  [-1.0, -0.9],
  [1.35, -0.55],
  [1.05, 0.8],
  [-1.3, 0.6],
];
export const SOLVED: [number, number][] = [
  [-1.2, -0.7],
  [1.2, -0.7],
  [1.2, 0.7],
  [-1.2, 0.7],
];
/** The corners at scroll p: the rough ones until 10%, the solved ones from 80%. */
export function constraintCorners(p: number): [number, number][] {
  const s = ease((p - 0.1) / 0.7);
  return ROUGH.map(([x, z], i) => [x + (SOLVED[i][0] - x) * s, z + (SOLVED[i][1] - z) * s]);
}

function constraints(): GuideScene {
  const root = new THREE.Group();
  const grid = new THREE.GridHelper(4.4, 16, 0xffffff, 0xffffff);
  (grid.material as THREE.Material).transparent = true;
  (grid.material as THREE.Material).opacity = 0.15;
  root.add(grid);
  const outline = line([0, 1, 2, 3, 4].map(() => new THREE.Vector3()), 0xfde68a);
  root.add(outline);
  const dots = [0, 1, 2, 3].map(() => dot(new THREE.Vector3(), INK, 0.07));
  root.add(...dots);
  // The marks a solved sketch shows: a square corner, and a tick on each of two equal sides.
  const marks = [
    line([new THREE.Vector3(1.0, 0.01, -0.7), new THREE.Vector3(1.0, 0.01, -0.5), new THREE.Vector3(1.2, 0.01, -0.5)], 0x86efac),
    line([new THREE.Vector3(-1.3, 0.01, 0), new THREE.Vector3(-1.1, 0.01, 0)], 0x86efac),
    line([new THREE.Vector3(1.1, 0.01, 0), new THREE.Vector3(1.3, 0.01, 0)], 0x86efac),
  ];
  root.add(...marks);
  let done = 0;
  return scene(
    root,
    2.2,
    (p) => {
      const c = constraintCorners(p);
      const pts = [...c, c[0]].map(([x, z]) => new THREE.Vector3(x, 0.01, z));
      outline.geometry.setFromPoints(pts);
      dots.forEach((d, i) => d.position.copy(pts[i]));
      done = clamp01((p - 0.8) / 0.1);
      (outline.material as THREE.LineBasicMaterial).color.set(done >= 1 ? 0x86efac : 0xfde68a);
      for (const m of marks) m.visible = done >= 1;
    },
    () => [
      { text: "level", point: new THREE.Vector3(0, 0, -0.7), opacity: done },
      { text: "same length", point: new THREE.Vector3(1.2, 0, 0), opacity: done },
      { text: "48 mm", point: new THREE.Vector3(0, 0, 0.7), opacity: done },
    ],
  );
}

// ---------------------------------------------------------------- inside

export const LAYERS = [
  { text: "The app (TypeScript): buttons, screen, project", colour: 0x93c5fd },
  { text: "The bridge: a background worker", colour: 0xc4b5fd },
  { text: "WebAssembly", colour: 0xa78bfa },
  { text: "The Rust kernel: build, check, measure", colour: 0xfdba74 },
] as const;

/** Where the request ball is at scroll p: from the top layer (0) down to the kernel (3) by halfway, then back up. */
export function requestLayer(p: number): number {
  const s = clamp01(p);
  return s <= 0.5 ? 6 * s : 6 * (1 - s);
}

function stack(highlight: number | null): GuideScene {
  const root = new THREE.Group();
  const y = (i: number) => 1.5 - i;
  const slabs = LAYERS.map((l, i) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(3, 0.22, 2), skin(l.colour, highlight === null || highlight === i ? 0.95 : 0.22));
    m.add(new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(3, 0.22, 2)), new THREE.LineBasicMaterial({ color: INK, transparent: true, opacity: highlight === null || highlight === i ? 0.9 : 0.25 })));
    m.position.y = y(i);
    root.add(m);
    return m;
  });
  // The request and its trail: a few fading copies a moment behind it.
  const ball = dot(new THREE.Vector3(), 0xffffff, 0.13);
  const trail = Array.from({ length: 8 }, (_, k) => {
    const d = new THREE.Mesh(new THREE.SphereGeometry(0.1 - k * 0.009, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5 - k * 0.055 }));
    root.add(d);
    return d;
  });
  const wire = line([new THREE.Vector3(0.9, 1.75, 0.6), new THREE.Vector3(0.9, -1.75, 0.6)], INK, 0.25);
  root.add(ball, wire);
  let p = 0;
  let spread = 1;
  const at = (q: number) => new THREE.Vector3(0.9, (1.5 - requestLayer(q)) * spread + 0.25, 0.6);
  return scene(
    root,
    2.8,
    (q) => {
      p = q;
      spread = 1 + 0.25 * ease(q / 0.3);
      slabs.forEach((s, i) => (s.position.y = y(i) * spread));
      ball.position.copy(at(q));
      trail.forEach((d, k) => d.position.copy(at(Math.max(0, q - (k + 1) * 0.008))));
      const colour = q > 0.5 ? 0xfde68a : 0xffffff;
      for (const o of [ball, ...trail]) (o.material as THREE.MeshBasicMaterial).color.set(colour);
      for (const o of [ball, wire, ...trail]) o.visible = highlight === null;
    },
    () => [
      ...LAYERS.map((l, i) => ({ text: l.text, point: slabs[i].position.clone().add(new THREE.Vector3(-1.5, 0, 1)), opacity: highlight === null || highlight === i ? 1 : 0.45 })),
      ...(highlight === null ? [{ text: p <= 0.5 ? "sends: the profile, 20 mm" : "returns: the solid, its volume, triangles", point: ball.position.clone(), opacity: 1 }] : []),
    ],
  );
}

/**
 * The topology chapter's two faces meeting at a convex corner edge: A on
 * top (outward +y), B on the side (outward −x). Each loop runs
 * anticlockwise seen from outside, so the shared edge is run +z by A and
 * −z by B.
 */
export const LOOP_A: Vec3[] = [
  [0, 0, 1],
  [2, 0, 1],
  [2, 0, -1],
  [0, 0, -1],
];
export const LOOP_B: Vec3[] = [
  [0, 0, -1],
  [0, -2, -1],
  [0, -2, 1],
  [0, 0, 1],
];

/** How far the topology chapter's side face has folded down at scroll p: flat (0) until 10%, a right angle (1) by 60%. */
export function foldAmount(p: number): number {
  return ease((p - 0.1) / 0.5);
}

function coedges(): GuideScene {
  const root = new THREE.Group();
  root.position.set(-0.3, 0.6, 0);
  const faceA = new THREE.Group();
  const faceB = new THREE.Group(); // turns about the shared edge (the z axis)
  root.add(faceA, faceB);
  const arrows: { cone: THREE.Mesh; from: THREE.Vector3; to: THREE.Vector3; offset: number }[] = [];
  for (const [loop, colour, group] of [
    [LOOP_A, 0xbfdbfe, faceA],
    [LOOP_B, 0x99f6e4, faceB],
  ] as const) {
    const centre = loop.reduce((c, p) => c.add(v3(p)), new THREE.Vector3()).multiplyScalar(1 / loop.length);
    const inset = loop.map((p) => v3(p).lerp(centre, 0.14));
    const shape = loop.map(v3);
    const mesh = new THREE.Mesh(new THREE.BufferGeometry().setFromPoints([shape[0], shape[1], shape[2], shape[0], shape[2], shape[3]]), skin(colour, 0.5));
    mesh.geometry.computeVertexNormals();
    group.add(mesh, line([...shape, shape[0]], INK), line([...inset, inset[0]], colour, 0.5));
    // Two arrows on each coedge, marching round the loop as you scroll.
    for (let i = 0; i < inset.length; i++)
      for (const offset of [0, 0.5]) {
        const cone = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.2, 12), new THREE.MeshBasicMaterial({ color: colour }));
        group.add(cone);
        arrows.push({ cone, from: inset[i], to: inset[(i + 1) % inset.length], offset });
      }
  }
  const up = new THREE.Vector3(0, 1, 0);
  let fold = 0;
  return scene(
    root,
    2.6,
    (p) => {
      fold = foldAmount(p);
      faceB.rotation.z = -(Math.PI / 2) * (1 - fold);
      const march = p * 3;
      for (const a of arrows) {
        const f = 0.12 + 0.76 * ((march + a.offset) % 1);
        a.cone.position.copy(a.from).lerp(a.to, f);
        a.cone.quaternion.setFromUnitVectors(up, a.to.clone().sub(a.from).normalize());
      }
    },
    () => [
      { text: "one edge, two coedges, opposite ways", point: new THREE.Vector3(0, 0, 0.5), opacity: 1 },
      { text: "a loop of 4 coedges", point: new THREE.Vector3(1.75, 0, 0.85), opacity: 1 },
    ],
  );
}

/** A point on the cubic Bézier curve through control points c at s (0 to 1); a Bézier is the simplest NURBS. */
export function bezier(c: Vec3[], s: number): Vec3 {
  const u = 1 - s;
  const w = [u * u * u, 3 * u * u * s, 3 * u * s * s, s * s * s];
  return [0, 1, 2].map((k) => w[0] * c[0][k] + w[1] * c[1][k] + w[2] * c[2][k] + w[3] * c[3][k]) as Vec3;
}

/** The curves chapter's control points at scroll p: the second one is dragged up from −1 to 1.6. */
export function controlPoints(p: number): Vec3[] {
  return [
    [-2, 0, 0],
    [-0.8, -1 + 2.6 * clamp01(p), 0],
    [0.8, -1.2, 0],
    [2, 0.4, 0],
  ];
}

function curves(): GuideScene {
  const root = new THREE.Group();
  const polygon = line([0, 1, 2, 3].map(() => new THREE.Vector3()), INK, 0.45);
  const curve = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial({ color: 0xfde68a, roughness: 0.4 }));
  const dots = [0, 1, 2, 3].map(() => dot(new THREE.Vector3(), INK, 0.09));
  // The curvature comb: a spike out of the curve at each point, as long as the curve is sharply bent there.
  const SPIKES = 60;
  const comb = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xf9a8d4, transparent: true, opacity: 0.7 }));
  const envelope = line(Array.from({ length: SPIKES + 1 }, () => new THREE.Vector3()), 0xf9a8d4, 0.9);
  root.add(polygon, comb, envelope, curve, ...dots);
  let c = controlPoints(0);
  return scene(
    root,
    2.6,
    (p) => {
      c = controlPoints(p);
      polygon.geometry.setFromPoints(c.map(v3));
      dots.forEach((d, i) => d.position.copy(v3(c[i])));
      const path = new THREE.CatmullRomCurve3(Array.from({ length: 49 }, (_, i) => v3(bezier(c, i / 48))));
      curve.geometry.dispose();
      curve.geometry = new THREE.TubeGeometry(path, 96, 0.045, 10, false);
      const segs: THREE.Vector3[] = [];
      const tips: THREE.Vector3[] = [];
      for (let i = 0; i <= SPIKES; i++) {
        const s = i / SPIKES;
        const at = v3(bezier(c, s));
        const { curvature, normal } = bezierCurvature(c, s);
        const tip = at.clone().addScaledVector(v3(normal), -0.35 * curvature);
        segs.push(at, tip);
        tips.push(tip);
      }
      comb.geometry.setFromPoints(segs);
      envelope.geometry.setFromPoints(tips);
    },
    () => [
      { text: "CONTROL POINT", point: v3(c[1]), opacity: 1 },
      { text: "curvature comb: how sharply it bends", point: v3(bezier(c, 0.75)), opacity: 1 },
    ],
  );
}

/**
 * The curvature of a flat (z = 0) cubic Bézier at s, signed (positive when
 * it turns anticlockwise), and its unit normal (the tangent turned a
 * quarter anticlockwise): k = (x′y″ − y′x″) / |r′|³.
 */
export function bezierCurvature(c: Vec3[], s: number): { curvature: number; normal: Vec3 } {
  const u = 1 - s;
  const d1 = [0, 1].map((k) => 3 * (u * u * (c[1][k] - c[0][k]) + 2 * u * s * (c[2][k] - c[1][k]) + s * s * (c[3][k] - c[2][k])));
  const d2 = [0, 1].map((k) => 6 * (u * (c[2][k] - 2 * c[1][k] + c[0][k]) + s * (c[3][k] - 2 * c[2][k] + c[1][k])));
  const speed = Math.sqrt(d1[0] * d1[0] + d1[1] * d1[1]);
  return { curvature: (d1[0] * d2[1] - d1[1] * d2[0]) / (speed * speed * speed), normal: [-d1[1] / speed, d1[0] / speed, 0] };
}

/** The placement chapter's turn at scroll p: up to a quarter turn about (1, 1, 0)/√2, as a quaternion (x, y, z, w). */
export function placementTurn(p: number): [number, number, number, number] {
  const half = (Math.PI / 4) * clamp01(p);
  const k = Math.sin(half) / Math.sqrt(2);
  return [k, k, 0, Math.cos(half)];
}

function placement(): GuideScene {
  const root = new THREE.Group();
  const shape = (opacity: number) => {
    const g = new THREE.Group();
    const m = new THREE.Mesh(new THREE.ExtrudeGeometry(slotShape(), { depth: 0.5, bevelEnabled: false, curveSegments: 24 }), skin(SKIN, opacity));
    m.add(new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry, 30), new THREE.LineBasicMaterial({ color: INK, transparent: opacity < 1, opacity })));
    m.scale.setScalar(0.6);
    g.add(m);
    return g;
  };
  const ghost = shape(0.2);
  ghost.position.set(-1.2, 0, 0);
  const placed = shape(1);
  placed.add(new THREE.AxesHelper(0.9));
  // A trail of where it was on the way, fading: one turn and one shift, applied a bit at a time.
  const trail = [0.2, 0.4, 0.6, 0.8].map(() => shape(0.12));
  root.add(ghost, ...trail, placed);
  const put = (g: THREE.Group, p: number) => {
    g.position.set(-1.2 + 2.6 * clamp01(p), 0.6 * clamp01(p), 0);
    g.quaternion.set(...placementTurn(p));
  };
  return scene(
    root,
    2.8,
    (p) => {
      put(placed, p);
      trail.forEach((t, i) => put(t, p * (i + 1) * 0.2));
    },
    () => [
      { text: "the shape, in its own small world", point: ghost.position.clone(), opacity: 1 },
      { text: "placement: one turn + one shift", point: placed.position.clone(), opacity: 1 },
    ],
  );
}

/** Fission's tolerance in nanometres (kernel/src/tolerance.rs: LINEAR = 1e-5 mm). */
export const TOLERANCE_NM = 10;
/** The tolerance chapter's gap at scroll p, in nm: 30 closing to 0. */
export function gapNm(p: number): number {
  return 30 * (1 - clamp01(p));
}
/** Whether two ends this far apart count as the same point. */
export function touching(gap: number): boolean {
  return gap <= TOLERANCE_NM;
}

function tolerance(): GuideScene {
  const root = new THREE.Group();
  const inner = new THREE.Group(); // zooms in as the gap closes
  root.add(inner);
  const rod = () => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.4, 16), skin());
    m.rotation.z = Math.PI / 2;
    inner.add(m);
    return m;
  };
  const left = rod();
  const right = rod();
  const ends = [dot(new THREE.Vector3(), INK, 0.06), dot(new THREE.Vector3(), INK, 0.06)];
  inner.add(...ends);
  const unit = 0.02; // scene units per nm
  // The tolerance as a bubble 10 nm across, and a ruler with a tick every nanometre.
  const bubble = new THREE.Mesh(new THREE.SphereGeometry((TOLERANCE_NM * unit) / 2, 32, 20), new THREE.MeshBasicMaterial({ color: 0x86efac, transparent: true, opacity: 0.3, depthWrite: false }));
  const ticks: THREE.Vector3[] = [];
  for (let i = -20; i <= 20; i++) ticks.push(new THREE.Vector3(i * unit, -0.14, 0), new THREE.Vector3(i * unit, i % 5 === 0 ? -0.2 : -0.17, 0));
  const ruler = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(ticks), new THREE.LineBasicMaterial({ color: INK, transparent: true, opacity: 0.8 }));
  inner.add(bubble, ruler);
  let gap = 30;
  let zoom = 1;
  return scene(
    root,
    1.6,
    (p) => {
      gap = gapNm(p);
      zoom = 1 + 3 * ease(p / 0.6);
      inner.scale.setScalar(zoom);
      const half = (gap * unit) / 2;
      left.position.x = -half - 0.7;
      right.position.x = half + 0.7;
      ends[0].position.x = -half;
      ends[1].position.x = half;
      for (const e of ends) (e.material as THREE.MeshBasicMaterial).color.set(touching(gap) ? 0x22c55e : 0xf87171);
      (bubble.material as THREE.MeshBasicMaterial).opacity = touching(gap) ? 0.55 : 0.25;
    },
    () => [
      { text: touching(gap) ? `${gap.toFixed(1)} nm: the same point` : `${gap.toFixed(1)} nm: still apart`, point: new THREE.Vector3(0, 0.1 * zoom, 0), opacity: 1 },
      { text: "tolerance: 10 nm", point: new THREE.Vector3(0, -0.2 * zoom, 0), opacity: clamp01(zoom - 1.5) },
    ],
  );
}

/** The mesh chapter: how many flat sides the cylinder has at scroll p, 64 down to 6. */
export function meshSides(p: number): number {
  return Math.round(64 - 58 * clamp01(p));
}
/** Triangles in a closed n-sided cylinder: 2n round the side, n in each end. */
export function cylinderTriangles(n: number): number {
  return 4 * n;
}

/** How far the mesh chapter's triangles fly apart at scroll p: not at all until 55%, fully by 90%. */
export function shatter(p: number): number {
  return ease((p - 0.55) / 0.35);
}

function mesh(): GuideScene {
  const root = new THREE.Group();
  const solidMat = new THREE.MeshStandardMaterial({ color: SKIN, flatShading: true, roughness: 0.5, side: THREE.DoubleSide });
  const wireMat = new THREE.MeshBasicMaterial({ color: 0x0f172a, wireframe: true, transparent: true, opacity: 0.5 });
  const solid = new THREE.Mesh(new THREE.BufferGeometry(), solidMat);
  const wire = new THREE.Mesh(solid.geometry, wireMat);
  root.add(solid, wire);
  let n = 0;
  let base: Float32Array = new Float32Array(0);
  let normals: Float32Array = new Float32Array(0);
  return scene(
    root,
    2.2,
    (p) => {
      const next = meshSides(p);
      if (next !== n) {
        n = next;
        solid.geometry.dispose();
        // Every triangle with its own three corners, so each can move on its own.
        const g = new THREE.CylinderGeometry(1, 1, 2, n, 1, false).toNonIndexed();
        base = (g.getAttribute("position") as THREE.BufferAttribute).array.slice() as Float32Array;
        normals = new Float32Array(base.length);
        for (let t = 0; t < base.length; t += 9) {
          const a = new THREE.Vector3(base[t], base[t + 1], base[t + 2]);
          const b = new THREE.Vector3(base[t + 3], base[t + 4], base[t + 5]);
          const c = new THREE.Vector3(base[t + 6], base[t + 7], base[t + 8]);
          const nrm = b.sub(a).cross(c.sub(a)).normalize();
          for (let k = 0; k < 9; k += 3) normals.set([nrm.x, nrm.y, nrm.z], t + k);
        }
        solid.geometry = wire.geometry = g;
      }
      const apart = 0.45 * shatter(p);
      const pos = solid.geometry.getAttribute("position") as THREE.BufferAttribute;
      for (let i = 0; i < base.length; i++) (pos.array as Float32Array)[i] = base[i] + normals[i] * apart;
      pos.needsUpdate = true;
      solid.geometry.computeVertexNormals();
      wireMat.opacity = 0.15 + 0.6 * clamp01(p);
    },
    () => [{ text: `${n} sides · ${cylinderTriangles(n)} triangles`, point: new THREE.Vector3(0, 1.05, 0), opacity: 1 }],
  );
}

/**
 * The volume chapter's worked example: a cube of side a with a corner at
 * the fixed point. Each face adds (distance out × area) ÷ 3.
 */
export function cubeVolumeFromFaces(a: number): number {
  const faces = [
    { out: 0, area: a * a },
    { out: 0, area: a * a },
    { out: 0, area: a * a },
    { out: a, area: a * a },
    { out: a, area: a * a },
    { out: a, area: a * a },
  ];
  return faces.reduce((v, f) => v + f.out * f.area, 0) / 3;
}

/** A pyramid's volume: a third of its base area times its height. */
export function pyramidVolume(base: number, height: number): number {
  return (base * height) / 3;
}

function volume(): GuideScene {
  const root = new THREE.Group();
  // The divergence theorem made visible: each face of the cube and the fixed point make a pyramid of
  // volume ⅓ × area × distance. The three faces through the point make flat pyramids (nothing);
  // the other three fit together into the whole cube.
  const o = new THREE.Vector3(-1, -1, -1);
  const faces: [THREE.Vector3, THREE.Vector3[], number][] = [
    [new THREE.Vector3(1, 0, 0), [new THREE.Vector3(1, -1, -1), new THREE.Vector3(1, 1, -1), new THREE.Vector3(1, 1, 1), new THREE.Vector3(1, -1, 1)], 0x93c5fd],
    [new THREE.Vector3(0, 1, 0), [new THREE.Vector3(-1, 1, -1), new THREE.Vector3(-1, 1, 1), new THREE.Vector3(1, 1, 1), new THREE.Vector3(1, 1, -1)], 0xc4b5fd],
    [new THREE.Vector3(0, 0, 1), [new THREE.Vector3(-1, -1, 1), new THREE.Vector3(1, -1, 1), new THREE.Vector3(1, 1, 1), new THREE.Vector3(-1, 1, 1)], 0xfdba74],
  ];
  const pyramids = faces.map(([out, base, colour]) => {
    const tris = [o, base[0], base[1], o, base[1], base[2], o, base[2], base[3], o, base[3], base[0], base[0], base[2], base[1], base[0], base[3], base[2]];
    const g = new THREE.BufferGeometry().setFromPoints(tris);
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, skin(colour, 0.9));
    m.add(new THREE.LineSegments(new THREE.EdgesGeometry(g), new THREE.LineBasicMaterial({ color: INK })));
    root.add(m);
    return { m, out };
  });
  root.add(new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(2, 2, 2)), new THREE.LineBasicMaterial({ color: INK, transparent: true, opacity: 0.35 })));
  root.add(dot(o, 0xfde68a, 0.1));
  let apart = 1;
  return scene(
    root,
    2.8,
    (p) => {
      apart = 1 - ease((p - 0.15) / 0.55);
      for (const { m, out } of pyramids) m.position.copy(out).multiplyScalar(0.9 * apart);
    },
    () => [
      { text: "the fixed point", point: o, opacity: 1 },
      ...pyramids.map(({ m, out }) => ({ text: `⅓ × 100 × 10 = ${pyramidVolume(100, 10).toFixed(1)}`, point: out.clone().add(m.position), opacity: clamp01(apart * 3 - 1) })),
      { text: `3 × 333⅓ = ${cubeVolumeFromFaces(10)} mm³`, point: new THREE.Vector3(1, 1, 1), opacity: clamp01(1 - apart * 4) },
    ],
  );
}

/** The precision chapter: how many of a tower's leading digits have cancelled at scroll p (all that will by 60%). */
export function digitsCancelled(p: number, cancel: number): number {
  return Math.floor(ease(p / 0.6) * cancel + 1e-9);
}

function precision(): GuideScene {
  // Two numbers subtracted, drawn as towers of digits (most significant at the bottom). An ordinary number
  // keeps 16; when two nearly equal ones are subtracted, 14 digits cancel and the 2 left are mostly rounding.
  // Double-double keeps 32: 28 cancel and 4 true digits survive.
  const root = new THREE.Group();
  const tower = (x: number, digits: number, cancel: number, keep: number) => {
    const h = 3 / digits;
    const slabs = Array.from({ length: digits }, (_, i) => {
      const colour = i < cancel ? 0x93c5fd : keep === 4 ? 0xfde68a : 0xf87171;
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.9, h * 0.82, 0.9), skin(colour, 1));
      m.position.set(x, -1.5 + h * (i + 0.5), 0);
      root.add(m);
      return m;
    });
    return { slabs, h, cancel, x };
  };
  const towers = [tower(-0.7, 16, 14, 2), tower(0.7, 32, 28, 4)];
  let p = 0;
  return scene(
    root,
    2.4,
    (q) => {
      p = q;
      for (const tw of towers) {
        const gone = digitsCancelled(q, tw.cancel);
        tw.slabs.forEach((m, i) => {
          const cancelled = i < gone;
          const mat = m.material as THREE.MeshStandardMaterial;
          mat.transparent = true;
          mat.opacity = cancelled ? 0 : 1;
          m.visible = !cancelled;
          // What's left drops to the floor; an ordinary number's leftovers jitter: they're mostly rounding.
          const restY = -1.5 + tw.h * (i - gone + 0.5);
          const jitter = tw.cancel === 14 && i >= tw.cancel && gone === tw.cancel ? 0.04 * Math.sin(37 * q + i * 2.1) : 0;
          m.position.set(tw.x + jitter, restY, 0);
        });
      }
    },
    () => {
      const done = clamp01((p - 0.6) / 0.1);
      return [
        { text: "two huge, almost equal numbers", point: new THREE.Vector3(0, 1.6, 0), opacity: 1 - clamp01(p / 0.3) },
        { text: "16 digits: 2 left, mostly rounding", point: new THREE.Vector3(-0.7, -1.2, 0.45), opacity: done },
        { text: "32 digits: 4 true digits survive", point: new THREE.Vector3(0.7, -1.2, 0.45), opacity: done },
      ];
    },
  );
}

/** The booleans chapter's mode at scroll p: join for the first third, then cut, then intersect. */
export function booleanMode(p: number): "join" | "cut" | "intersect" {
  return p < 1 / 3 ? "join" : p < 2 / 3 ? "cut" : "intersect";
}

function boolean(): GuideScene {
  const root = new THREE.Group();
  const boxMat = skin(0xbfdbfe);
  const cylMat = skin(0xfbcfe8);
  const edges = (g: THREE.BufferGeometry) => new THREE.LineSegments(new THREE.EdgesGeometry(g, 30), new THREE.LineBasicMaterial({ color: INK }));
  const box = new THREE.Mesh(new THREE.BoxGeometry(2.4, 1, 2.4), boxMat);
  box.add(edges(box.geometry));
  const cyl = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 2.4, 48), cylMat);
  cyl.add(edges(cyl.geometry));
  const square = new THREE.Shape([new THREE.Vector2(-1.2, -1.2), new THREE.Vector2(1.2, -1.2), new THREE.Vector2(1.2, 1.2), new THREE.Vector2(-1.2, 1.2)]);
  square.holes.push(new THREE.Path().absarc(0, 0, 0.6, 0, Math.PI * 2, false));
  const holed = new THREE.Mesh(new THREE.ExtrudeGeometry(square, { depth: 1, bevelEnabled: false, curveSegments: 48 }), boxMat);
  holed.add(edges(holed.geometry));
  holed.rotation.x = -Math.PI / 2;
  holed.position.y = -0.5;
  const shared = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 1, 48), cylMat);
  shared.add(edges(shared.geometry));
  const ghost = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 2.4, 32, 1, true), new THREE.MeshBasicMaterial({ color: INK, wireframe: true, transparent: true, opacity: 0.18 }));
  const ghostBox = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(2.4, 1, 2.4)), new THREE.LineBasicMaterial({ color: INK, transparent: true, opacity: 0.4 }));
  root.add(box, cyl, holed, shared, ghost, ghostBox);
  let mode: ReturnType<typeof booleanMode> = "join";
  return scene(
    root,
    2.4,
    (p) => {
      mode = booleanMode(p);
      box.visible = cyl.visible = mode === "join";
      holed.visible = mode === "cut";
      shared.visible = mode === "intersect";
      ghost.visible = mode !== "join";
      ghostBox.visible = mode === "intersect";
      // The rod drops in from above first.
      cyl.position.y = 1.4 * (1 - ease(p / 0.2));
    },
    () => [{ text: mode.toUpperCase(), point: new THREE.Vector3(0, mode === "join" ? 1.2 + cyl.position.y : 0.6, 0), opacity: 1 }],
  );
}

/** A small seeded random number generator (mulberry32): the same seed always gives the same numbers. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** n random points on the surface of the cube −1…1, from a seed. */
export function surfacePoints(seed: number, n: number): Vec3[] {
  const r = seeded(seed);
  const out: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const axis = Math.floor(r() * 3);
    const side = r() < 0.5 ? -1 : 1;
    const p: Vec3 = [r() * 2 - 1, r() * 2 - 1, r() * 2 - 1];
    p[axis] = side;
    out.push(p);
  }
  return out;
}

export const TEST_POINTS = 600;
/** When test point i of n lands at scroll p: 0 not yet started, then falling, 1 landed (each takes 6% of the scroll). */
export function landed(i: number, n: number, p: number): number {
  return clamp01((p - (i / n) * 0.8) / 0.06);
}

function testing(): GuideScene {
  const root = new THREE.Group();
  const cube = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), skin(SKIN, 0.35));
  cube.add(new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(2, 2, 2)), new THREE.LineBasicMaterial({ color: INK })));
  const target = surfacePoints(2026, TEST_POINTS).map((p) => v3(p).multiplyScalar(1.01));
  const geometry = new THREE.BufferGeometry().setFromPoints(target);
  const cloud = new THREE.Points(geometry, new THREE.PointsMaterial({ color: 0x4ade80, size: 5, sizeAttenuation: false }));
  root.add(cube, cloud);
  let n = 0;
  return scene(
    root,
    2.4,
    (p) => {
      // The checks rain down onto the cube, each landing on its own random spot.
      const pos = geometry.getAttribute("position") as THREE.BufferAttribute;
      n = 0;
      target.forEach((t, i) => {
        const k = landed(i, TEST_POINTS, p);
        if (k > 0) n = i + 1;
        pos.setXYZ(i, t.x, t.y + 1.5 * (1 - ease(k)), t.z);
      });
      pos.needsUpdate = true;
      geometry.setDrawRange(0, n);
    },
    () => [{ text: `${n} random checks, seed 2026`, point: new THREE.Vector3(1, 1, 1), opacity: 1 }],
  );
}

export const WORKSPACES = ["Design", "Render", "Simulate", "Manufacture", "Laser", "Slice", "Circuit", "Vector", "Image", "Layout"];
/** Where workspace tile i of n sits round the ring: the angle in degrees, Design at 0. */
export function tileAngle(i: number, n: number): number {
  return (360 * i) / n;
}

function workspaces(): GuideScene {
  const root = new THREE.Group();
  const { model } = bracketModel();
  model.scale.setScalar(0.45);
  model.position.multiplyScalar(0.45);
  root.add(model);
  const tiles = WORKSPACES.map((name, i) => {
    const colour = name === "Design" ? 0x93c5fd : name === "Image" ? 0xc4b5fd : 0x64748b;
    const t = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.36, 0.08), skin(colour, name === "Design" || name === "Image" ? 1 : 0.6));
    const a = (tileAngle(i, WORKSPACES.length) * Math.PI) / 180;
    t.position.set(2.4 * Math.sin(a), 0, 2.4 * Math.cos(a));
    t.up.set(0, 1, 0); // y-up here, whatever the app's default
    t.lookAt(0, 0, 0);
    root.add(t);
    root.add(line([new THREE.Vector3(), t.position.clone()], INK, 0.25));
    return t;
  });
  return scene(
    root,
    3,
    (p) => tiles.forEach((t, i) => (t.position.y = -1.6 + 1.6 * ease(p * 2 - i * 0.08))),
    () => tiles.map((t, i) => ({ text: WORKSPACES[i], point: t.position.clone().add(new THREE.Vector3(0, 0.28, 0)), opacity: clamp01(t.position.y + 1) })),
  );
}

function assistant(): GuideScene {
  const root = new THREE.Group();
  const part = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.2, 1.2), skin());
  part.add(new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1.6, 1.2, 1.2)), new THREE.LineBasicMaterial({ color: INK })));
  const previewMat = new THREE.MeshStandardMaterial({ color: 0xc4b5fd, transparent: true, opacity: 0, roughness: 0.4, depthWrite: false });
  const preview = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 2.4, 48), previewMat);
  const outline = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.CylinderGeometry(0.5, 0.5, 2.4, 48), 30), new THREE.LineBasicMaterial({ color: 0xede9fe, transparent: true, opacity: 0 }));
  preview.add(outline);
  root.add(part, preview);
  let shown = 0;
  return scene(
    root,
    2,
    (p) => {
      shown = clamp01(p / 0.6);
      previewMat.opacity = 0.4 * shown;
      (outline.material as THREE.LineBasicMaterial).opacity = shown;
      preview.position.x = 1.6 * (1 - ease(shown));
    },
    () => [
      { text: "your part, unchanged", point: new THREE.Vector3(-0.8, 0.6, 0.6), opacity: 1 },
      { text: "preview: Accept or Reject", point: new THREE.Vector3(preview.position.x, 1.2, 0), opacity: shown },
    ],
  );
}

/** The guide camera's field of view: narrow, so parts look close to the flat, even look of a technical drawing. */
export const GUIDE_FOV = 24;
/** How far the camera looks down: 0.5 rad, about 29°. */
export const GUIDE_TILT = 0.5;

/**
 * Points the guide's camera at a scene: from in front and above, far
 * enough back that the scene's ball fits the stage beside (or above) the
 * words, and shifted so the scene sits in that stage. Every scene is y-up;
 * the camera's own up is set here because the app makes z-up the default
 * for every new object (the guide once drew everything upside down).
 */
export function aimCamera(camera: THREE.PerspectiveCamera, radius: number, w: number, h: number, textTop?: number): void {
  const layout = stageLayout(w, h, textTop);
  const halfTan = Math.tan((camera.fov * Math.PI) / 360);
  const vfov = (360 / Math.PI) * Math.atan(layout.areaH * halfTan);
  const d = cameraDistance(radius, vfov, (layout.areaW * w) / (layout.areaH * h));
  camera.up.set(0, 1, 0);
  camera.position.set(0, Math.sin(GUIDE_TILT) * d, Math.cos(GUIDE_TILT) * d);
  camera.lookAt(0, 0, 0);
  camera.setViewOffset(w, h, w * (0.5 - layout.centreX), h * (0.5 - layout.centreY), w, h);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
}

const BUILDERS: Record<SceneId, () => GuideScene> = {
  hero,
  parametric,
  sketch,
  extrude,
  timeline,
  history,
  constraints,
  "stack-journey": () => stack(null),
  "stack-rust": () => stack(3),
  "stack-wasm": () => stack(2),
  brep,
  coedges,
  curves,
  placement,
  tolerance,
  validate,
  mesh,
  volume,
  precision,
  boolean,
  testing,
  workspaces,
  assistant,
};

export const SCENE_IDS = Object.keys(BUILDERS) as SceneId[];

/** Builds a chapter's scene, at its starting point (p = 0). */
export function buildScene(id: SceneId): GuideScene {
  const s = BUILDERS[id]();
  s.update(0);
  return s;
}

export { explodeAmount, holeCircle };
