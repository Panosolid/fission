// The timeline (steps 24-25) on the real kernel: PENDING until the
// substeps that build it land. Each check below is marked todo with the
// substep it waits for (docs/progress/cad.md, "Timeline test plan"), so the
// list shows what is still unchecked and none of it can pass by accident.
// When a substep lands, its checks get bodies here (or in the kernel's own
// tests, for the kernel ones) the same day, and leave the todo list.
//
// The harness they use already exists and is tested against planted bugs:
// src/timeline-model.ts (the model) and src/timeline-session.ts (the
// seeded sessions; Design's timeline plugs in as a TimelineSubject).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { BodyView, KernelCalls, SketchArc, SketchCircle, SketchLine } from "@fission/core";
import { nodeKernel } from "../src/node-kernel.ts";
import { seeded, type SeededRandom } from "../src/index.ts";
import {
  addSketch,
  buildSpec,
  deleteCurve,
  designReference,
  droppedNote,
  extrudeSketch,
  featureNames,
  featureSpec,
  highlightOf,
  lastFeature,
  movePoint,
  nameBody,
  partDocument,
  pointAt,
  resolveReference,
  survivors,
  drawLine,
  drawRectangle,
  type DesignDocument,
} from "@fission/design";
import { applyOp, createModel, edgeKey, faceKey, rebuild, shoelace, type ModelBody, type ModelShape, type PresetKind } from "../src/timeline-model.ts";
import { close, randomShape } from "../src/timeline-session.ts";

const pending = (name: string, substep: string) => test(name, { todo: `waits for ${substep}` });

const rebuildOf = (m: ReturnType<typeof createModel>) => rebuild(m.doc).results;

// ---------------------------------------------------------------- 24b

// The kernel's face roles (step 24b) and Design's names (24c) checked
// against the model: a shape is drawn as sketch curves (lines shuffled and
// some drawn backwards, by seed), its outline found and extruded by the
// real kernel, and each face and edge named by Design's own `nameBody`
// (workspaces/design/src/naming.ts): a face by the feature, the kernel's
// role and, for a side, the curve its outline piece came from (`pieces`);
// an edge by the two faces it joins (`edge_faces`). Names must be the
// model's exactly; faces' areas and centroids to MATCH_REL; each edge's
// length and centroid, measured on the display mesh's edge lines, to
// EDGE_SLACK.

interface Drawn {
  lines: SketchLine[];
  arcs: SketchArc[];
  circles: SketchCircle[];
  /** The model's curve id of each line, arc and circle, by list index. */
  ids: { line: string[]; arc: string[]; circle: string[] };
}

/** Fisher–Yates, seeded. */
function shuffle<T>(items: T[], r: SeededRandom | undefined): T[] {
  if (r === undefined) return items;
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(r.next() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

/** The shape as sketch curves, curve k carrying the model's id `curves[k]` (timeline-model.ts: a polygon's side k from corner k; a slot's bottom line, right half circle, top line, left half circle). */
function draw(shape: ModelShape, curves: readonly string[], r?: SeededRandom): Drawn {
  if (shape.kind === "circle") return { lines: [], arcs: [], circles: [{ centre: [...shape.centre], radius: shape.radius }], ids: { line: [], arc: [], circle: [curves[0]] } };
  type Line = { line: SketchLine; id: string };
  type Arc = { arc: SketchArc; id: string };
  let lines: Line[] = [];
  let arcs: Arc[] = [];
  const line = (a: readonly [number, number], b: readonly [number, number], id: string): Line =>
    r !== undefined && r.next() < 0.5 ? { line: { a: [...b], b: [...a] }, id } : { line: { a: [...a], b: [...b] }, id };
  if (shape.kind === "polygon") {
    const n = shape.corners.length;
    lines = shape.corners.map((c, k) => line(c, shape.corners[(k + 1) % n], curves[k]));
  } else {
    const [x, y, L, rad] = [shape.at[0], shape.at[1], shape.length, shape.radius];
    lines = [line([x, y - rad], [x + L, y - rad], curves[0]), line([x + L, y + rad], [x, y + rad], curves[2])];
    // Arcs run counter-clockwise round their centre, so they can't be drawn backwards.
    arcs = [
      { arc: { start: [x + L, y - rad], end: [x + L, y + rad], centre: [x + L, y] }, id: curves[1] },
      { arc: { start: [x, y + rad], end: [x, y - rad], centre: [x, y] }, id: curves[3] },
    ];
  }
  lines = shuffle(lines, r);
  arcs = shuffle(arcs, r);
  return { lines: lines.map((l) => l.line), arcs: arcs.map((a) => a.arc), circles: [], ids: { line: lines.map((l) => l.id), arc: arcs.map((a) => a.id), circle: [] } };
}

/** A face or an edge as the kernel built it, under the name Design gives it ("item-6/side:curve-3"). */
interface Got {
  key: string;
  /** A face's area, or an edge's length (mm², mm). */
  size: number;
  centroid: number[];
}

interface Named {
  faces: Got[];
  edges: Got[];
}

/**
 * Each edge's length and centroid from the display mesh's edge lines (f32
 * points, one pair per segment): the sum of its segments, and the mean of
 * their midpoints weighted by length.
 */
export function edgeGeometry(view: BodyView): { length: number; centroid: number[] }[] {
  const out = Array.from({ length: view.edges }, () => ({ length: 0, sum: [0, 0, 0] }));
  const at = view.mesh.edge_lines;
  view.mesh.edge_line_edges.forEach((e, s) => {
    const p = at.slice(6 * s, 6 * s + 3);
    const q = at.slice(6 * s + 3, 6 * s + 6);
    const len = Math.sqrt((q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 + (q[2] - p[2]) ** 2);
    out[e].length += len;
    for (let k = 0; k < 3; k++) out[e].sum[k] += (len * (p[k] + q[k])) / 2;
  });
  return out.map((o) => ({ length: o.length, centroid: o.sum.map((x) => x / o.length) }));
}

/** A view's faces and edges under Design's names: feature, role and, for an extrude's side, the curve its piece came from. */
function named(feature: string, view: BodyView, curveOf?: (piece: number) => string): Named {
  for (const [f, role] of view.face_roles.entries()) {
    assert.ok(role !== null, `face ${f} has no role`);
    if (role.role === "side" && role.piece !== undefined) {
      assert.equal(role.boundary, 0, "a sketch's outline is one loop");
      assert.ok(curveOf !== undefined, "only an extrude's sides name a piece");
    }
  }
  const names = nameBody(feature, view, (_, piece) => (curveOf ? curveOf(piece) : null));
  const edges = edgeGeometry(view);
  const key = (part: string | null, what: string) => {
    assert.ok(part !== null, `${what} has no name`);
    return `${names.feature}/${part}`;
  };
  return {
    faces: names.faces.map((part, f) => ({ key: key(part, `face ${f}`), size: view.face_areas[f], centroid: view.face_centroids[f] })),
    edges: names.edges.map((part, e) => ({ key: key(part, `edge ${e}`), size: edges[e].length, centroid: edges[e].centroid })),
  };
}

/** The kernel's faces and edges for the model's extrude of `shape`, or the kernel's reason the outline is open. */
async function kernelExtrude(kernel: KernelCalls, feature: string, shape: ModelShape, curves: readonly string[], distance: number, r?: SeededRandom): Promise<Named | string> {
  const drawn = draw(shape, curves, r);
  // A side of length 0 (two corners rounded onto one) is a line the kernel refuses outright.
  const out = await kernel.call("sketch_outline", drawn.lines, drawn.circles, drawn.arcs).catch((e: Error) => ({ open: e.message }));
  if ("open" in out) return out.open;
  const pieces = out.closed.pieces ?? [];
  const view = await kernel.call("make_extrude", out.closed, distance);
  return named(feature, view, (i) => {
    const p = pieces[i];
    assert.ok(p !== undefined, `side of piece ${i}, but the outline has ${pieces.length}`);
    return drawn.ids[p.curve][p.index];
  });
}

async function kernelPreset(kernel: KernelCalls, feature: string, kind: PresetKind, sizes: number[]): Promise<Named> {
  const view =
    kind === "box" ? await kernel.call("make_box", sizes[0], sizes[1], sizes[2]) : kind === "cylinder" ? await kernel.call("make_cylinder", sizes[0] / 2, sizes[1]) : await kernel.call("make_sphere", sizes[0] / 2);
  return named(feature, view);
}

/**
 * How far an edge measured on the display mesh may be from the model's:
 * its chords sag inside a curve by at most DISPLAY_CHORD (0.01 mm,
 * kernel/src/tolerance.rs; the cap of 256 chords a turn sags less below a
 * radius of 133 mm, more than any shape here), which moves the centroid by
 * at most that, plus the f32 rounding of each point (2⁻²⁴ of 100 mm, ~6e-6
 * mm). Each chord is shorter than its arc by (θ/3) × its sag, θ the chord's
 * turn, so over a whole circle (2π) the length falls short by at most
 * 2π/3 × 0.01 ≈ 0.021 mm.
 */
export const EDGE_SLACK = { centroid: 0.0101, length: 0.022 };

/** Whether a mesh-measured edge matches the model's within EDGE_SLACK. */
export function edgeMatches(got: { size: number; centroid: number[] }, want: { length: number; centroid: readonly number[] }): boolean {
  const off = Math.sqrt(got.centroid.reduce((s, x, k) => s + (x - want.centroid[k]) ** 2, 0));
  return Math.abs(got.size - want.length) <= EDGE_SLACK.length && off <= EDGE_SLACK.centroid;
}

/** The same names, each face's area and centroid within MATCH_REL, each edge's length and centroid within EDGE_SLACK. */
function sameBody(got: Named, want: Pick<ModelBody, "faces" | "edges">, what: string): void {
  assert.deepEqual(got.faces.map((f) => f.key).sort(), want.faces.map((f) => faceKey(f.name)).sort(), `${what}: face names`);
  for (const w of want.faces) {
    const g = got.faces.find((f) => f.key === faceKey(w.name))!;
    assert.ok(close(g.size, w.area), `${what} ${faceKey(w.name)}: area ${g.size} vs ${w.area}`);
    assert.ok(
      g.centroid.every((x, k) => close(x, w.centroid[k])),
      `${what} ${faceKey(w.name)}: centroid (${g.centroid.join(", ")}) vs (${w.centroid.join(", ")})`,
    );
  }
  assert.deepEqual(got.edges.map((e) => e.key).sort(), want.edges.map((e) => edgeKey(e.name)).sort(), `${what}: edge names`);
  for (const w of want.edges) {
    const g = got.edges.find((e) => e.key === edgeKey(w.name))!;
    assert.ok(edgeMatches(g, w), `${what} ${edgeKey(w.name)}: length ${g.size} vs ${w.length}, centroid (${g.centroid.join(", ")}) vs (${w.centroid.join(", ")})`);
  }
}

/** The model's faces for an extrude of `shape` by `distance`, with its ids. */
function modelExtrude(shape: ModelShape, distance: number): { feature: string; curves: string[]; body: ModelBody | null } {
  const m = createModel();
  const sketch = applyOp(m, { op: "add-sketch", shape });
  assert.equal(sketch.kind, "done");
  const [sketchId, ...curves] = sketch.kind === "done" ? sketch.ids : [];
  const extrude = applyOp(m, { op: "add-extrude", sketch: sketchId, distance });
  const feature = extrude.kind === "done" ? extrude.ids[0] : "";
  const result = rebuildOf(m)[feature];
  return { feature, curves, body: result.status === "built" && result.body !== undefined ? result.body : null };
}

function modelPreset(kind: PresetKind, sizes: number[]): { feature: string; body: ModelBody } {
  const m = createModel();
  const made = applyOp(m, { op: "add-preset", kind, sizes });
  const feature = made.kind === "done" ? made.ids[0] : "";
  const result = rebuildOf(m)[feature];
  assert.ok(result.status === "built" && result.body !== undefined);
  return { feature, body: result.body };
}

test("the kernel reports each face's role (an extrude's start, end and the side of each outline piece; a box's six directions; a cylinder's bottom, top and side; a sphere's halves) with its area and centroid, hand-worked for a 40 × 30 × 10 rectangle, a slot and a clockwise outline", async () => {
  const kernel = nodeKernel();
  const face = (n: Named, key: string) => {
    const f = n.faces.find((x) => x.key === key)!;
    return { area: f.size, centroid: f.centroid };
  };
  // A 40 × 30 rectangle extruded by 10, its lines drawn in order: caps
  // 1200 mm² at (20, 15), the side of curve k its length × 10 at its
  // midpoint, half way up (the bottom side, 0 → 40 along y = 0: 400 at
  // (20, 0, 5)).
  const rect: ModelShape = { kind: "polygon", corners: [[0, 0], [40, 0], [40, 30], [0, 30]] };
  const r1 = modelExtrude(rect, 10);
  const k1 = await kernelExtrude(kernel, r1.feature, rect, r1.curves, 10);
  assert.ok(typeof k1 !== "string" && r1.body !== null);
  const end = face(k1, `${r1.feature}/end`);
  assert.ok(close(end.area, 1200) && close(end.centroid[0], 20) && close(end.centroid[1], 15) && close(end.centroid[2], 10));
  const bottom = face(k1, `${r1.feature}/side:${r1.curves[0]}`);
  assert.ok(close(bottom.area, 400) && close(bottom.centroid[0], 20) && close(bottom.centroid[1], 0) && close(bottom.centroid[2], 5));
  sameBody(k1, r1.body, "rectangle");
  // The same rectangle clockwise, its lines shuffled and some backwards:
  // curve 0 is now the left side (0,0) → (0,30), 300 mm² at (0, 15, 5).
  const cw: ModelShape = { kind: "polygon", corners: [[0, 0], [0, 30], [40, 30], [40, 0]] };
  const r2 = modelExtrude(cw, 10);
  const k2 = await kernelExtrude(kernel, r2.feature, cw, r2.curves, 10, seeded(24n));
  assert.ok(typeof k2 !== "string" && r2.body !== null);
  const left = face(k2, `${r2.feature}/side:${r2.curves[0]}`);
  assert.ok(close(left.area, 300) && close(left.centroid[0], 0) && close(left.centroid[1], 15));
  sameBody(k2, r2.body, "clockwise rectangle");
  // A slot, centres (0, 0) and (20, 0), radius 5, by 10: the right half
  // circle's wall is π·5·10 = 50π, its centroid 2r/π = 10/π beyond (20, 0).
  const slot: ModelShape = { kind: "slot", at: [0, 0], length: 20, radius: 5 };
  const r3 = modelExtrude(slot, 10);
  const k3 = await kernelExtrude(kernel, r3.feature, slot, r3.curves, 10, seeded(5n));
  assert.ok(typeof k3 !== "string" && r3.body !== null);
  const right = face(k3, `${r3.feature}/side:${r3.curves[1]}`);
  assert.ok(close(right.area, 50 * Math.PI) && close(right.centroid[0], 20 + 10 / Math.PI) && close(right.centroid[1], 0));
  sameBody(k3, r3.body, "slot");
  // A circle of radius 5 by 2: caps 25π, the side 20π on the axis.
  const circle: ModelShape = { kind: "circle", centre: [3, -4], radius: 5 };
  const r4 = modelExtrude(circle, 2);
  const k4 = await kernelExtrude(kernel, r4.feature, circle, r4.curves, 2);
  assert.ok(typeof k4 !== "string" && r4.body !== null);
  sameBody(k4, r4.body, "circle");
  // Presets: a 40 × 30 × 20 box (its front, −Y, is 40 × 20 = 800 at
  // (20, 0, 10)), a cylinder of diameter 20 and height 10, a sphere of
  // diameter 10 (each half 2πr² = 50π at r/2 = 2.5 from the centre).
  for (const [kind, sizes] of [["box", [40, 30, 20]], ["cylinder", [20, 10]], ["sphere", [10]]] as [PresetKind, number[]][]) {
    const want = modelPreset(kind, sizes);
    sameBody(await kernelPreset(kernel, want.feature, kind, sizes), want.body, kind);
  }
  const box = await kernelPreset(kernel, "b", "box", [40, 30, 20]);
  const front = face(box, "b/front");
  assert.ok(close(front.area, 800) && close(front.centroid[0], 20) && close(front.centroid[1], 0) && close(front.centroid[2], 10));
  const upper = face(await kernelPreset(kernel, "s", "sphere", [10]), "s/upper");
  assert.ok(close(upper.area, 50 * Math.PI) && close(upper.centroid[2], 2.5));
});

test("seeded: 5 seeds × 40 random sketches drawn shuffled and backwards, extruded on the real kernel, name, measure and place every face as the model does", async () => {
  const kernel = nodeKernel();
  const reached = { built: 0, refused: 0, clockwise: 0, slot: 0, circle: 0 };
  for (const seed of [1n, 2n, 3n, 4n, 5n]) {
    const r = seeded(seed * 7919n);
    for (let i = 0; i < 40; i++) {
      const shape = randomShape(r);
      const distance = 1 + Math.floor(r.next() * 30);
      const model = modelExtrude(shape, distance);
      const got = await kernelExtrude(kernel, model.feature, shape, model.curves, distance, r);
      const what = `seed ${seed} sketch ${i} ${JSON.stringify(shape)} by ${distance}`;
      if (model.body === null) {
        // The model refuses only a polygon that crosses itself; the kernel says why in words.
        assert.equal(typeof got, "string", `${what}: the model refuses it but the kernel built it`);
        reached.refused++;
        continue;
      }
      assert.ok(typeof got !== "string", `${what}: the kernel refused it: ${got}`);
      sameBody(got, model.body, what);
      reached.built++;
      if (shape.kind === "polygon" && shoelace(shape.corners) < 0) reached.clockwise++;
      if (shape.kind === "slot") reached.slot++;
      if (shape.kind === "circle") reached.circle++;
    }
  }
  // Every kind of case is reached, not just the easy ones.
  for (const [kind, n] of Object.entries(reached)) assert.ok(n >= 3, `only ${n} ${kind} cases: ${JSON.stringify(reached)}`);
});

// ---------------------------------------------------------------- 24c

test("Design names edges by the two faces they join, the uprights in order round the outline, hand-worked on the real kernel, and the edge comparer and planted bugs fail", async () => {
  const kernel = nodeKernel();
  // A 40 × 30 rectangle by 10, its lines drawn in order: curve 0 runs
  // (0, 0) → (40, 0) and curve 1 up the right, so counter-clockwise the
  // corner (40, 0) ends curve 0 and starts curve 1: its upright, 10 long,
  // centred (40, 0, 5). Curve 0's edge in the start cap: 40 long at (20, 0, 0).
  const rect: ModelShape = { kind: "polygon", corners: [[0, 0], [40, 0], [40, 30], [0, 30]] };
  const m = modelExtrude(rect, 10);
  const k = await kernelExtrude(kernel, m.feature, rect, m.curves, 10);
  assert.ok(typeof k !== "string" && m.body !== null);
  const edge = (n: Named, key: string) => n.edges.find((e) => e.key === key);
  const upright = edge(k, `${m.feature}/side:${m.curves[0]}>side:${m.curves[1]}`);
  assert.ok(upright && edgeMatches(upright, { length: 10, centroid: [40, 0, 5] }), JSON.stringify(upright));
  const bottom = edge(k, `${m.feature}/side:${m.curves[0]}+start`);
  assert.ok(bottom && edgeMatches(bottom, { length: 40, centroid: [20, 0, 0] }), JSON.stringify(bottom));
  assert.equal(k.edges.length, 12);

  // A half disc of radius 5: line L from (−5, 0) to (5, 0), arc A from
  // (5, 0) counter-clockwise round (0, 0) back to (−5, 0). Its two sides
  // meet at both ends, and only the order tells the uprights apart:
  // counter-clockwise (5, 0) ends L and starts A, (−5, 0) ends A and starts L.
  const out = await kernel.call("sketch_outline", [{ a: [-5, 0], b: [5, 0] }], [], [{ start: [5, 0], end: [-5, 0], centre: [0, 0] }]);
  assert.ok("closed" in out);
  const ids = { line: ["L"], arc: ["A"], circle: [] as string[] };
  const disc = named("d", await kernel.call("make_extrude", out.closed, 4), (i) => ids[out.closed.pieces![i].curve][out.closed.pieces![i].index]);
  assert.deepEqual(disc.edges.map((e) => e.key).sort(), ["d/end+side:A", "d/end+side:L", "d/side:A+start", "d/side:A>side:L", "d/side:L+start", "d/side:L>side:A"]);
  assert.ok(edgeMatches(edge(disc, "d/side:L>side:A")!, { length: 4, centroid: [5, 0, 2] }));
  assert.ok(edgeMatches(edge(disc, "d/side:A>side:L")!, { length: 4, centroid: [-5, 0, 2] }));
  // The arc's edge in the end cap: 5π long; an arc's centroid is r sin(α)/α from its centre, α = π/2, so 10/π up the y axis.
  assert.ok(edgeMatches(edge(disc, "d/end+side:A")!, { length: 5 * Math.PI, centroid: [0, 10 / Math.PI, 4] }));

  // The edge comparer at 0.9× and 1.1× of its slack, in length and in place.
  const at = { size: 10, centroid: [40, 0, 5] };
  assert.ok(edgeMatches({ ...at, size: 10 + 0.9 * EDGE_SLACK.length }, { length: 10, centroid: [40, 0, 5] }));
  assert.ok(!edgeMatches({ ...at, size: 10 + 1.1 * EDGE_SLACK.length }, { length: 10, centroid: [40, 0, 5] }));
  assert.ok(edgeMatches(at, { length: 10, centroid: [40, 0.9 * EDGE_SLACK.centroid, 5] }));
  assert.ok(!edgeMatches(at, { length: 10, centroid: [40, 1.1 * EDGE_SLACK.centroid, 5] }));

  // Planted bugs, each caught by sameBody against the model:
  const view = await kernel.call("make_extrude", (await kernel.call("sketch_outline", [{ a: [0, 0], b: [40, 0] }, { a: [40, 0], b: [40, 30] }, { a: [40, 30], b: [0, 30] }, { a: [0, 30], b: [0, 0] }], [], [])).closed!, 10);
  const curveOf = (i: number) => m.curves[i];
  assert.doesNotThrow(() => sameBody(named(m.feature, view, curveOf), m.body!, "as built"));
  // the faces of every edge given the other way round (uprights then name the wrong corner);
  const flipped = { ...view, edge_faces: view.edge_faces.map((p) => p && ([p[1], p[0]] as [number, number])) };
  assert.throws(() => sameBody(named(m.feature, flipped, curveOf), m.body!, "flipped"), /edge names/);
  // two edges' lines on the mesh swapped (the right names on the wrong edges);
  const [e0, e1] = [view.edge_faces.findIndex(Boolean), view.edge_faces.length - 1];
  const swapped = { ...view, mesh: { ...view.mesh, edge_line_edges: view.mesh.edge_line_edges.map((e) => (e === e0 ? e1 : e === e1 ? e0 : e)) } };
  assert.throws(() => sameBody(named(m.feature, swapped, curveOf), m.body!, "swapped"), /length|centroid/);
  // and each side named after the next curve.
  assert.throws(() => sameBody(named(m.feature, view, (i) => m.curves[(i + 1) % 4]), m.body!, "shifted"), /area|centroid/);
});

/** Builds the part of a Design document on the real kernel and names it, as Design's workspace does. */
async function builtNames(kernel: KernelCalls, doc: DesignDocument) {
  const feature = lastFeature(doc);
  const spec = await featureSpec(kernel, doc, feature);
  const view = await buildSpec(kernel, spec);
  return { view, names: featureNames(doc, feature, spec, view) };
}

test("a selected face keeps its name through an edit that renumbers the kernel's faces (a side deleted and redrawn, a corner moved), and a face that is gone is dropped with a note", async () => {
  const kernel = nodeKernel();
  // A 40 × 30 rectangle sketched with Design's rectangle tool, lines in order bottom, right, top, left, extruded by 10.
  const sketch = addSketch(partDocument("box", 40, 30, 20));
  const rect = drawRectangle(sketch.doc, sketch.id, [0, 0], [40, 30]);
  const [bottom, right, top] = rect.ids;
  let doc = extrudeSketch(rect.doc, sketch.id, 10).doc;
  const feature = lastFeature(doc).id;
  const before = await builtNames(kernel, doc);
  const ref = (kind: "face" | "edge", part: string) => {
    const i = (kind === "face" ? before.names.faces : before.names.edges).indexOf(part);
    assert.ok(i >= 0, `no ${kind} ${part} in ${JSON.stringify(before.names)}`);
    return designReference(kind, before.names, i)!;
  };
  // Selected: the right side, the top's side, the upright where the bottom meets the right, and the right's edge in the end cap.
  const rightFace = ref("face", `side:${right}`);
  const topFace = ref("face", `side:${top}`);
  const corner = ref("edge", `side:${bottom}>side:${right}`);
  const rim = ref("edge", `end+side:${right}`);
  const items = [rightFace, topFace, corner, rim];
  assert.equal(rightFace.id, `face:${feature}/side:${right}`);

  // The bottom deleted and drawn again between the same corners: a new
  // line at the end of the sketch's list, so the kernel walks the outline
  // from another line and numbers its faces afresh.
  const s = doc.sketches[0];
  doc = deleteCurve(doc, sketch.id, bottom);
  const again = drawLine(doc, sketch.id, pointAt(s, [0, 0])!, pointAt(s, [40, 0])!);
  doc = again.doc;
  const after = await builtNames(kernel, doc);
  const index = (r: typeof rightFace, n: typeof before.names) => resolveReference(r, n);
  // Renumbered: the right side's kernel index changed (else this proves nothing).
  assert.notEqual(index(rightFace, after.names), index(rightFace, before.names), "the edit did not renumber the faces");
  // The right side still resolves, to the face with the same area and centroid: 30 × 10 = 300 mm² at (40, 15, 5).
  const f = index(rightFace, after.names)!;
  assert.ok(close(after.view.face_areas[f], 300) && after.view.face_centroids[f].every((x, k) => close(x, [40, 15, 5][k])));
  // The bottom is a new line: the upright named after the old one is gone; the right's rim and the top stay.
  const kept = survivors(items, after.names);
  assert.deepEqual(kept, { kept: [rightFace, topFace, rim], dropped: [corner] });
  assert.equal(droppedNote(kept.dropped), `Taken out of the selection: Edge of Side of ${bottom} and Side of ${right}. The edit took them off the body, so they could not be followed.`);
  // The highlight finds each kept item where the kernel put it now.
  const lit = highlightOf(kept.kept, feature, after.names);
  assert.deepEqual(lit.faces, [index(rightFace, after.names), index(topFace, after.names)]);
  assert.deepEqual(lit.edges, [index(rim, after.names)]);
  // The new upright is named after the new line.
  assert.ok(after.names.edges.includes(`side:${again.id}>side:${right}`));

  // A corner moved: (40, 30) to (50, 30). Same lines, same names; the right side is now (40, 0) → (50, 30),
  // √(10² + 30²) = √1000 long, so √1000 × 10 mm², centred half way up its middle (45, 15, 5).
  const moved = movePoint(doc, sketch.id, pointAt(doc.sketches[0], [40, 30])!, 50, 30);
  const third = await builtNames(kernel, moved);
  assert.deepEqual(survivors(kept.kept, third.names), { kept: kept.kept, dropped: [] });
  const g = index(rightFace, third.names)!;
  assert.ok(close(third.view.face_areas[g], Math.sqrt(1000) * 10) && third.view.face_centroids[g].every((x, k) => close(x, [45, 15, 5][k])));

  // The right side deleted: its face and its edges leave the selection, the top's stays.
  const gone = await builtNames(kernel, drawLine(deleteCurve(doc, sketch.id, right), sketch.id, pointAt(s, [40, 0])!, pointAt(s, [40, 30])!).doc);
  assert.deepEqual(survivors(kept.kept, gone.names), { kept: [topFace], dropped: [rightFace, rim] });
  // Nothing on the new body is ever named like the deleted side's face.
  assert.ok(!gone.names.faces.includes(`side:${right}`));
});

pending("the model's hand-worked rebuilds give the same volumes, names, areas and centroids on the real kernel", "24d");
pending("presets are ordinary features with counter ids; every solid feature is its own body; a version 2 file migrates to the timeline's version and opens byte-identical after one save", "24d");
pending("seeded sessions: Design's timeline as a TimelineSubject passes runSession for 12 seeds × 150 steps, reaching every kind of outcome", "24d");
pending("delete, reorder, suppress and the marker on the real document, each one undo step; refused reorders give their exact messages", "24e");
pending("each planted bug of MODEL_FAULTS, planted by hand once in Design's code, is caught by its check (recorded in the substep's line)", "24e");
pending("the timeline in the browser at 1280 and 375 px in Chromium, Firefox and WebKit: rows in build order, the marker dragged and tapped, suppress and delete from a row, failed items marked; pixel probes for each body drawn", "24f");
pending("editing an early feature rebuilds everything after it; references re-resolve through their names; one that can't shows a warning on the item holding it", "25a");
pending("project-fuzz with timelines (items, marker, suppressed, failed items) opens, shows and saves byte-identical; history-fuzz with timeline edits", "25b");
pending("naming success rate (references the model says survive, resolved to the right face) in tests/baseline.json at 100%, with the owner's OK", "25b");
