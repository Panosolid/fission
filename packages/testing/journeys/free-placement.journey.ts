// Journey: free placement (sketch feel SF1) through the real WASM kernel,
// the same calls the sketcher makes on every click: the kernel rounds the
// pointer (snap.ts `rounding`: place_freely with grid snap off, the
// default), snap.ts snaps it to nearby points, the tool draws. Checked
// against a simple model of where a click may land, on seeded polygons
// closed by clicking back near their first point, and seeded free arcs
// the kernel must accept. Run with `npm run journeys` after the app build.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SketchXY } from "@fission/core";
import { addSketch, askOutline, clickAt, partDocument, rounding, sketchCurves, SNAP_PIXELS, snapOnSketch, startTool, type DesignDocument, type SketchTool } from "@fission/design";
import { nodeKernel } from "../src/node-kernel.ts";
import { seeded, type SeededRandom } from "../src/index.ts";

const kernel = nodeKernel();

/** What the sketcher does with a click at `raw`: round it in the kernel, snap it, click there. */
async function click(doc: DesignDocument, tool: SketchTool, raw: SketchXY, pixel: number, gridSnap = false) {
  const r = rounding(raw, 10, gridSnap, pixel);
  const rounded = r.op === "snap_to_grid" ? await kernel.call("snap_to_grid", ...r.args) : await kernel.call("place_freely", ...r.args);
  const snap = snapOnSketch(doc, tool, raw, rounded, pixel);
  return { ...clickAt(doc, tool, snap.at), snap, rounded };
}

/** Model of the free spacing: 10^k for k the decimal exponent of the pixel as JavaScript writes it ("1.5e-1"), within −3..6. */
const modelSpacing = (pixel: number) => Number(`1e${Math.min(6, Math.max(-3, Number(pixel.toExponential().split("e")[1])))}`);

/** Shoelace area: ½ |Σ x_i y_{i+1} − x_{i+1} y_i|. */
const area = (pts: SketchXY[]) => Math.abs(pts.reduce((s, [x, y], i) => s + x * pts[(i + 1) % pts.length][1] - pts[(i + 1) % pts.length][0] * y, 0)) / 2;

const pointsOf = (doc: DesignDocument, id: string): SketchXY[] => doc.sketches.find((s) => s.id === id)!.points.map((p) => [p.x, p.y]);

test("free placement worked by hand: a click lands where it is to the pixel's power of ten, and grid snap still works", async () => {
  const s = addSketch(partDocument("box", 40, 30, 20));
  // A pixel of 0.05 mm rounds to 0.01: 12.3681944 → 1236.8 hundredths → 12.37; −7.0449 → −704.49 → −7.04.
  let step = await click(s.doc, startTool("line", s.id), [12.3681944, -7.0449], 0.05);
  assert.deepEqual(step.tool.kind === "line" && step.tool.from, [12.37, -7.04]);
  // Grid snap on (10 mm): (12.37, −7.04) → (10, −10).
  step = await click(s.doc, startTool("line", s.id), [12.3681944, -7.0449], 0.05, true);
  assert.deepEqual(step.tool.kind === "line" && step.tool.from, [10, -10]);
  // A bad pixel size is the kernel's to refuse, never a point placed somewhere.
  await assert.rejects(kernel.call("place_freely", 1, 1, 0), /size of a pixel/);
});

/** A star-shaped polygon round a centre (corners at increasing angles), as raw pointer positions. */
function pointerPolygon(r: SeededRandom, size: number): SketchXY[] {
  const n = 3 + Math.floor(r.next() * 8);
  const angles = Array.from({ length: n }, () => r.next() * 2 * Math.PI).sort((a, b) => a - b);
  const [cx, cy] = [(r.next() - 0.5) * 20 * size, (r.next() - 0.5) * 20 * size];
  return angles.map((t) => {
    const radius = size * (0.3 + r.next());
    return [cx + radius * Math.cos(t), cy + radius * Math.sin(t)];
  });
}

test("seeded free polygons: every click lands within half a pixel unless it snapped, and a click near the start closes the outline", async () => {
  let closed = 0;
  let cases = 0;
  for (const seed of [21n, 22n, 23n, 24n, 25n]) {
    const r = seeded(seed);
    for (let c = 0; c < 40; c++) {
      // Pixels from 1 µm to 1 mm on screen; shapes of about 100 to 1000 pixels.
      const pixel = 10 ** (-3 + 3 * r.next());
      const size = pixel * (100 + 900 * r.next());
      const s = addSketch(partDocument("box", 40, 30, 20));
      let doc = s.doc;
      let tool: SketchTool = startTool("line", s.id);
      const context = `seed ${seed} case ${c} pixel ${pixel}`;
      for (const raw of pointerPolygon(r, size)) {
        const step = await click(doc, tool, raw, pixel);
        const spacing = modelSpacing(pixel);
        // Model: the kernel moved the pointer by at most half the spacing (≤ half a pixel), onto a whole number of spacings.
        for (const k of [0, 1]) {
          assert.ok(Math.abs(step.rounded[k] - raw[k]) <= spacing / 2 + 1e-12 * Math.abs(raw[k]), `${context}: ${raw} → ${step.rounded}`);
          assert.ok(Math.abs(step.rounded[k] / spacing - Math.round(step.rounded[k] / spacing)) < 1e-6, `${context}: ${step.rounded[k]} not on ${spacing}`);
        }
        // Where it landed: that rounded point, or a snap within SNAP_PIXELS of the pointer.
        if (step.snap.kind === "grid") assert.deepEqual(step.snap.at, step.rounded, context);
        else for (const k of [0, 1]) assert.ok(Math.abs(step.snap.at[k] - raw[k]) <= SNAP_PIXELS * pixel * (1 + 1e-9), `${context}: ${step.snap.kind} ${step.snap.at} from ${raw}`);
        [doc, tool] = [step.doc, step.tool];
      }
      const placed = pointsOf(doc, s.id);
      if (placed.length < 3) continue;
      // Back near the first point, a third of the reach off: it lands on it exactly and the chain ends.
      const [fx, fy] = placed[0];
      const back = await click(doc, tool, [fx + (SNAP_PIXELS / 3) * pixel, fy - (SNAP_PIXELS / 3) * pixel], pixel);
      // Unless a nearer target (another point or a midpoint) took the click: then the chain goes on and the case is skipped.
      if (back.snap.at[0] !== fx || back.snap.at[1] !== fy) continue;
      assert.equal(back.tool.kind === "line" && back.tool.from, null, `${context}: the chain did not end on its first point`);
      cases++;
      doc = back.doc;
      const sketch = doc.sketches.find((x) => x.id === s.id)!;
      assert.equal(sketch.points.length, placed.length, `${context}: closing made a new point`);
      const out = await askOutline(kernel, sketchCurves(sketch));
      if ("open" in out) {
        // A random star can fold into a sliver or cross itself after snapping; nothing else may open it.
        assert.match(out.open, /not a valid outline|ends meet/, `${context}: ${out.open}`);
        continue;
      }
      closed++;
      const body = await kernel.call("make_extrude", out.closed, size);
      const want = area(placed) * size;
      assert.ok(Math.abs(body.volume - want) <= 1e-9 * want, `${context}: volume ${body.volume} vs ${want}`);
      // Break it: the last line's end moved one spacing off the first point opens the sketch.
      const curves = sketchCurves(sketch);
      const last = curves.lines[curves.lines.length - 1];
      const broken = { ...curves, lines: [...curves.lines.slice(0, -1), { a: last.a, b: [last.b[0] + modelSpacing(pixel), last.b[1]] as SketchXY }] };
      assert.ok("open" in (await askOutline(kernel, broken)), `${context}: still closed with an end moved`);
    }
  }
  // Must not pass by skipping or opening everything.
  assert.ok(cases >= 150, `only ${cases} cases closed their chain`);
  assert.ok(closed >= 0.8 * cases, `only ${closed} of ${cases} closed`);
});

test("seeded free arcs: three free clicks make an arc the kernel accepts, or a note saying why not", async () => {
  let drawn = 0;
  for (const seed of [31n, 32n, 33n]) {
    const r = seeded(seed);
    for (let c = 0; c < 100; c++) {
      const pixel = 10 ** (-3 + 3 * r.next());
      const size = pixel * (50 + 950 * r.next());
      const s = addSketch(partDocument("box", 40, 30, 20));
      let doc = s.doc;
      let tool: SketchTool = startTool("arc", s.id);
      const at = (): SketchXY => [(r.next() - 0.5) * size, (r.next() - 0.5) * size];
      let last: Awaited<ReturnType<typeof click>> | null = null;
      for (let k = 0; k < 3; k++) {
        last = await click(doc, tool, at(), pixel);
        [doc, tool] = [last.doc, last.tool];
      }
      const context = `seed ${seed} case ${c} pixel ${pixel}`;
      if (!last!.drew) {
        assert.ok(last!.note, `${context}: nothing drawn and no note`);
        continue;
      }
      drawn++;
      const sketch = doc.sketches.find((x) => x.id === s.id)!;
      // One arc alone is open (its ends are loose), never refused as a bad arc.
      const out = await askOutline(kernel, sketchCurves(sketch));
      assert.ok("open" in out && /not joined/.test(out.open), `${context}: ${JSON.stringify(out)}`);
    }
  }
  assert.ok(drawn >= 250, `only ${drawn} of 300 arcs drawn`);
});
