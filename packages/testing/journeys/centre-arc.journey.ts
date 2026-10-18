// Journey: the centre arc tool on the real WASM kernel, through the calls
// Design makes (hoverTool and clickAt, then sketch_outline and the
// extrude). A pie slice closed with two lines from the arc's ends to its
// centre must extrude to ½·r²·θ·d, with θ the turn the hovers made the
// pointer take (added up here, never unwrapped), for arcs past half a turn
// as well as under it, either way round. Run with `npm run journeys`
// after the app build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { addSketch, buildSpec, clickAt, extrudeSketch, featureSpec, hoverTool, lastFeature, partDocument, sketchCurves, startTool, type DesignDocument, type SketchTool } from "@fission/design";
import { nodeKernel } from "../src/node-kernel.ts";
import { seeded } from "../src/index.ts";

const kernel = nodeKernel();
const D = 10; // every extrude here is 10 mm
type XY = [number, number];

/** A centre arc from hovers and a click (centre, start, then `path` with its last point clicked), closed by lines end → centre → start. */
function pie(c: XY, s: XY, path: XY[]): { doc: DesignDocument; sketch: string } {
  const made = addSketch(partDocument("box", 10, 10, 10));
  let doc = made.doc;
  let tool: SketchTool = startTool("centre", made.id);
  const click = (p: XY) => {
    const r = clickAt(doc, tool, p);
    ({ doc, tool } = r);
    return r;
  };
  click(c);
  click(s);
  path.slice(0, -1).forEach((p) => (tool = hoverTool(tool, p)));
  const drawn = click(path.at(-1)!);
  assert.equal(drawn.drew, true, `the arc is drawn: ${drawn.note ?? ""}`);
  const arc = sketchCurves(doc.sketches[0]).arcs[0];
  const ccwFromStart = arc.start[0] === s[0] && arc.start[1] === s[1];
  const end = (ccwFromStart ? arc.end : arc.start) as XY;
  tool = startTool("line", made.id);
  for (const p of [end, c, c, s]) click(p);
  return { doc, sketch: made.id };
}

async function volume(doc: DesignDocument, sketch: string, where: string): Promise<number> {
  const { lines, circles, arcs } = sketchCurves(doc.sketches[0]);
  const outline = await kernel.call("sketch_outline", lines, circles, arcs);
  assert.ok("closed" in outline, `${where}: ${JSON.stringify(outline).slice(0, 200)}`);
  const part = extrudeSketch(doc, sketch, D).doc;
  const body = await buildSpec(kernel, await featureSpec(kernel, part, lastFeature(part)));
  assert.deepEqual(body.errors, [], `${where}: the body is valid`);
  return body.volume;
}

test("hand-worked: a quarter of radius 10 by a tap is 250π mm³; swept the long way it is three quarters, 750π mm³", async () => {
  // Centre (0, 0), start (10, 0), a tap at (0, 5): the quarter to (0, 10),
  // area ¼·π·10² = 25π, × 10 mm = 250π. Hovering (0, −5) then (−5, 0)
  // first and clicking (0, 5) goes clockwise three quarters to (0, 10):
  // ¾·100π = 75π, × 10 = 750π.
  const q = pie([0, 0], [10, 0], [[0, 5]]);
  const v1 = await volume(q.doc, q.sketch, "quarter");
  assert.ok(Math.abs(v1 - 250 * Math.PI) <= 1e-9 * v1, `${v1}`);
  const t = pie([0, 0], [10, 0], [[0, -5], [-5, 0], [0, 5]]);
  const v2 = await volume(t.doc, t.sketch, "three quarters");
  assert.ok(Math.abs(v2 - 750 * Math.PI) <= 1e-9 * v2, `${v2}`);
});

test("seeded: 5 seeds × 30 pie slices from hovers that turn by known amounts extrude to ½·r²·θ·d", async () => {
  const TURN = 2 * Math.PI;
  for (const seed of [1n, 2n, 3n, 4n, 5n]) {
    const r = seeded(seed);
    for (let n = 0; n < 30; n++) {
      const c: XY = [Math.floor(r.next() * 1001) - 500, Math.floor(r.next() * 1001) - 500];
      const s: XY = [c[0] + 1 + Math.floor(r.next() * 100), c[1] + Math.floor(r.next() * 201) - 100];
      const rad = Math.sqrt((s[0] - c[0]) ** 2 + (s[1] - c[1]) ** 2);
      const a0 = Math.atan2(s[1] - c[1], s[0] - c[0]);
      // The total turn, between 0.05 and a whole turn less 0.05 either way, in hovers under half a turn each.
      const want = (0.05 + r.next() * (TURN - 0.1)) * (r.next() < 0.5 ? 1 : -1);
      const steps = Math.ceil(Math.abs(want) / 2.5);
      const path: XY[] = [];
      for (let k = 1; k <= steps; k++) {
        const a = a0 + (want * k) / steps;
        const rho = 0.5 + r.next() * 2 * rad;
        path.push([c[0] + rho * Math.cos(a), c[1] + rho * Math.sin(a)]);
      }
      const where = `seed ${seed}, slice ${n}: centre (${c}), start (${s}), turn ${want}`;
      const p = pie(c, s, path);
      const v = await volume(p.doc, p.sketch, where);
      const model = 0.5 * rad * rad * Math.abs(want) * D;
      assert.ok(Math.abs(v - model) <= 1e-9 * model, `${where}: volume ${v}, model ${model}`);
    }
  }
});
