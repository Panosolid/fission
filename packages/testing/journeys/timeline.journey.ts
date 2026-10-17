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
import { applyOp, createModel, faceKey, rebuild, shoelace, type FaceName, type ModelFace, type ModelShape, type PresetKind } from "../src/timeline-model.ts";
import { close, randomShape } from "../src/timeline-session.ts";

const pending = (name: string, substep: string) => test(name, { todo: `waits for ${substep}` });

const rebuildOf = (m: ReturnType<typeof createModel>) => rebuild(m.doc).results;

// ---------------------------------------------------------------- 24b

// The kernel's face roles (step 24b) checked against the model: a shape is
// drawn as sketch curves (lines shuffled and some drawn backwards, by seed),
// its outline found and extruded by the real kernel, and each face named as
// Design will name it (24c): the feature, the kernel's role and, for a
// side, the curve its outline piece came from (`pieces`). Names, areas and
// centroids must be the model's, to MATCH_REL.

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

/** A view's faces named as Design will name them: feature, role and, for an extrude's side, the curve its piece came from. */
function named(feature: string, view: BodyView, curveOf?: (piece: number) => string): ModelFace[] {
  return view.face_roles.map((role, f) => {
    assert.ok(role !== null, `face ${f} has no role`);
    const name: FaceName = { feature, role: role.role };
    if (role.role === "side" && role.piece !== undefined) {
      assert.equal(role.boundary, 0, "a sketch's outline is one loop");
      assert.ok(curveOf !== undefined, "only an extrude's sides name a piece");
      name.curve = curveOf(role.piece);
    }
    return { name, area: view.face_areas[f], centroid: view.face_centroids[f] };
  });
}

/** The kernel's faces for the model's extrude of `shape`, or the kernel's reason the outline is open. */
async function kernelExtrude(kernel: KernelCalls, feature: string, shape: ModelShape, curves: readonly string[], distance: number, r?: SeededRandom): Promise<ModelFace[] | string> {
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

async function kernelPreset(kernel: KernelCalls, feature: string, kind: PresetKind, sizes: number[]): Promise<ModelFace[]> {
  const view =
    kind === "box" ? await kernel.call("make_box", sizes[0], sizes[1], sizes[2]) : kind === "cylinder" ? await kernel.call("make_cylinder", sizes[0] / 2, sizes[1]) : await kernel.call("make_sphere", sizes[0] / 2);
  return named(feature, view);
}

/** The same names, each face's area and centroid within MATCH_REL. */
function sameFaces(got: ModelFace[], want: ModelFace[], what: string): void {
  const keys = (fs: ModelFace[]) => fs.map((f) => faceKey(f.name)).sort();
  assert.deepEqual(keys(got), keys(want), `${what}: face names`);
  for (const w of want) {
    const g = got.find((f) => faceKey(f.name) === faceKey(w.name))!;
    assert.ok(close(g.area, w.area), `${what} ${faceKey(w.name)}: area ${g.area} vs ${w.area}`);
    assert.ok(
      g.centroid.every((x, k) => close(x, w.centroid[k])),
      `${what} ${faceKey(w.name)}: centroid (${g.centroid.join(", ")}) vs (${w.centroid.join(", ")})`,
    );
  }
}

/** The model's faces for an extrude of `shape` by `distance`, with its ids. */
function modelExtrude(shape: ModelShape, distance: number): { feature: string; curves: string[]; faces: ModelFace[] | null } {
  const m = createModel();
  const sketch = applyOp(m, { op: "add-sketch", shape });
  assert.equal(sketch.kind, "done");
  const [sketchId, ...curves] = sketch.kind === "done" ? sketch.ids : [];
  const extrude = applyOp(m, { op: "add-extrude", sketch: sketchId, distance });
  const feature = extrude.kind === "done" ? extrude.ids[0] : "";
  const result = rebuildOf(m)[feature];
  return { feature, curves, faces: result.status === "built" && result.body !== undefined ? result.body.faces : null };
}

function modelPreset(kind: PresetKind, sizes: number[]): { feature: string; faces: ModelFace[] } {
  const m = createModel();
  const made = applyOp(m, { op: "add-preset", kind, sizes });
  const feature = made.kind === "done" ? made.ids[0] : "";
  const result = rebuildOf(m)[feature];
  assert.ok(result.status === "built" && result.body !== undefined);
  return { feature, faces: result.body.faces };
}

test("the kernel reports each face's role (an extrude's start, end and the side of each outline piece; a box's six directions; a cylinder's bottom, top and side; a sphere's halves) with its area and centroid, hand-worked for a 40 × 30 × 10 rectangle, a slot and a clockwise outline", async () => {
  const kernel = nodeKernel();
  const face = (fs: ModelFace[], key: string) => fs.find((f) => faceKey(f.name) === key)!;
  // A 40 × 30 rectangle extruded by 10, its lines drawn in order: caps
  // 1200 mm² at (20, 15), the side of curve k its length × 10 at its
  // midpoint, half way up (the bottom side, 0 → 40 along y = 0: 400 at
  // (20, 0, 5)).
  const rect: ModelShape = { kind: "polygon", corners: [[0, 0], [40, 0], [40, 30], [0, 30]] };
  const r1 = modelExtrude(rect, 10);
  const k1 = await kernelExtrude(kernel, r1.feature, rect, r1.curves, 10);
  assert.ok(typeof k1 !== "string" && r1.faces !== null);
  const end = face(k1, `${r1.feature}/end`);
  assert.ok(close(end.area, 1200) && close(end.centroid[0], 20) && close(end.centroid[1], 15) && close(end.centroid[2], 10));
  const bottom = face(k1, `${r1.feature}/side:${r1.curves[0]}`);
  assert.ok(close(bottom.area, 400) && close(bottom.centroid[0], 20) && close(bottom.centroid[1], 0) && close(bottom.centroid[2], 5));
  sameFaces(k1, r1.faces, "rectangle");
  // The same rectangle clockwise, its lines shuffled and some backwards:
  // curve 0 is now the left side (0,0) → (0,30), 300 mm² at (0, 15, 5).
  const cw: ModelShape = { kind: "polygon", corners: [[0, 0], [0, 30], [40, 30], [40, 0]] };
  const r2 = modelExtrude(cw, 10);
  const k2 = await kernelExtrude(kernel, r2.feature, cw, r2.curves, 10, seeded(24n));
  assert.ok(typeof k2 !== "string" && r2.faces !== null);
  const left = face(k2, `${r2.feature}/side:${r2.curves[0]}`);
  assert.ok(close(left.area, 300) && close(left.centroid[0], 0) && close(left.centroid[1], 15));
  sameFaces(k2, r2.faces, "clockwise rectangle");
  // A slot, centres (0, 0) and (20, 0), radius 5, by 10: the right half
  // circle's wall is π·5·10 = 50π, its centroid 2r/π = 10/π beyond (20, 0).
  const slot: ModelShape = { kind: "slot", at: [0, 0], length: 20, radius: 5 };
  const r3 = modelExtrude(slot, 10);
  const k3 = await kernelExtrude(kernel, r3.feature, slot, r3.curves, 10, seeded(5n));
  assert.ok(typeof k3 !== "string" && r3.faces !== null);
  const right = face(k3, `${r3.feature}/side:${r3.curves[1]}`);
  assert.ok(close(right.area, 50 * Math.PI) && close(right.centroid[0], 20 + 10 / Math.PI) && close(right.centroid[1], 0));
  sameFaces(k3, r3.faces, "slot");
  // A circle of radius 5 by 2: caps 25π, the side 20π on the axis.
  const circle: ModelShape = { kind: "circle", centre: [3, -4], radius: 5 };
  const r4 = modelExtrude(circle, 2);
  const k4 = await kernelExtrude(kernel, r4.feature, circle, r4.curves, 2);
  assert.ok(typeof k4 !== "string" && r4.faces !== null);
  sameFaces(k4, r4.faces, "circle");
  // Presets: a 40 × 30 × 20 box (its front, −Y, is 40 × 20 = 800 at
  // (20, 0, 10)), a cylinder of diameter 20 and height 10, a sphere of
  // diameter 10 (each half 2πr² = 50π at r/2 = 2.5 from the centre).
  for (const [kind, sizes] of [["box", [40, 30, 20]], ["cylinder", [20, 10]], ["sphere", [10]]] as [PresetKind, number[]][]) {
    const want = modelPreset(kind, sizes);
    sameFaces(await kernelPreset(kernel, want.feature, kind, sizes), want.faces, kind);
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
      if (model.faces === null) {
        // The model refuses only a polygon that crosses itself; the kernel says why in words.
        assert.equal(typeof got, "string", `${what}: the model refuses it but the kernel built it`);
        reached.refused++;
        continue;
      }
      assert.ok(typeof got !== "string", `${what}: the kernel refused it: ${got}`);
      sameFaces(got, model.faces, what);
      reached.built++;
      if (shape.kind === "polygon" && shoelace(shape.corners) < 0) reached.clockwise++;
      if (shape.kind === "slot") reached.slot++;
      if (shape.kind === "circle") reached.circle++;
    }
  }
  // Every kind of case is reached, not just the easy ones.
  for (const [kind, n] of Object.entries(reached)) assert.ok(n >= 3, `only ${n} ${kind} cases: ${JSON.stringify(reached)}`);
});

pending("Design names every face from its feature id, role and sketch curve id, the model's names exactly, for every case in test/timeline-model.test.ts", "24c");
pending("a selected face keeps its name through an edit that renumbers the kernel's faces (a corner moved, a side deleted and redrawn elsewhere), and a face that is gone is dropped with a note", "24c");
pending("the model's hand-worked rebuilds give the same volumes, names, areas and centroids on the real kernel", "24d");
pending("presets are ordinary features with counter ids; every solid feature is its own body; a version 2 file migrates to the timeline's version and opens byte-identical after one save", "24d");
pending("seeded sessions: Design's timeline as a TimelineSubject passes runSession for 12 seeds × 150 steps, reaching every kind of outcome", "24d");
pending("delete, reorder, suppress and the marker on the real document, each one undo step; refused reorders give their exact messages", "24e");
pending("each planted bug of MODEL_FAULTS, planted by hand once in Design's code, is caught by its check (recorded in the substep's line)", "24e");
pending("the timeline in the browser at 1280 and 375 px in Chromium, Firefox and WebKit: rows in build order, the marker dragged and tapped, suppress and delete from a row, failed items marked; pixel probes for each body drawn", "24f");
pending("editing an early feature rebuilds everything after it; references re-resolve through their names; one that can't shows a warning on the item holding it", "25a");
pending("project-fuzz with timelines (items, marker, suppressed, failed items) opens, shows and saves byte-identical; history-fuzz with timeline edits", "25b");
pending("naming success rate (references the model says survive, resolved to the right face) in tests/baseline.json at 100%, with the owner's OK", "25b");
