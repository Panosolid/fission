// Journey: the sketch maths through the real WASM kernel (step 21a), the
// same calls the sketcher will make: snap pointer positions to the grid,
// find the outline the lines make, extrude it. Run with `npm run journeys`
// after the app build.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Outline, SketchLine } from "@fission/core";
import { nodeKernel } from "../src/node-kernel.ts";
import { seeded, type SeededRandom } from "../src/index.ts";

const kernel = nodeKernel();

const corners = (o: Outline) => {
  assert.ok("path" in o.outer);
  const c = o.outer.path.corners;
  return Array.from({ length: c.length / 2 }, (_, i) => [c[2 * i], c[2 * i + 1]] as [number, number]);
};

/** Shoelace area: ½ |Σ x_i y_{i+1} − x_{i+1} y_i|. */
const area = (pts: [number, number][]) =>
  Math.abs(pts.reduce((s, [x, y], i) => s + x * pts[(i + 1) % pts.length][1] - pts[(i + 1) % pts.length][0] * y, 0)) / 2;

const ring = (pts: [number, number][]): SketchLine[] => pts.map((a, i) => ({ a, b: pts[(i + 1) % pts.length] }));

test("snapping and a triangle's outline, worked by hand", async () => {
  // Grid 5: (12.4, −7.6) / 5 = (2.48, −1.52) → (2, −2) → (10, −10).
  assert.deepEqual(await kernel.call("snap_to_grid", 12.4, -7.6, 5), [10, -10]);
  // Grid 0.1: 0.31 → 3/10 and 0.69 → 7/10, the decimals as typed (not 0.30000000000000004).
  assert.deepEqual(await kernel.call("snap_to_grid", 0.31, 0.69, 0.1), [0.3, 0.7]);
  await assert.rejects(kernel.call("snap_to_grid", 1, 1, 0), /grid spacing must be between/);

  // A 3-4-5 right triangle, its last line drawn backwards: corners in walking
  // order, and ½·4·3 = 6 mm² extruded 2 mm is 12 mm³.
  const lines: SketchLine[] = [{ a: [0, 0], b: [4, 0] }, { a: [4, 0], b: [0, 3] }, { a: [0, 0], b: [0, 3] }];
  const out = await kernel.call("sketch_outline", lines);
  assert.ok("closed" in out, JSON.stringify(out));
  assert.deepEqual(corners(out.closed), [[0, 0], [4, 0], [0, 3]]);
  const body = await kernel.call("make_extrude", out.closed, 2);
  assert.ok(Math.abs(body.volume - 12) <= 1e-12 * 12, `${body.volume}`);

  // Two lines are open, and say why; a zero-length line is refused.
  assert.deepEqual(await kernel.call("sketch_outline", lines.slice(0, 2)), { open: "the line end at (0, 0) is not joined to another line" });
  await assert.rejects(kernel.call("sketch_outline", [{ a: [1, 1], b: [1, 1] }]), /line 1 must be between/);
});

/** Is `got` the loop `want`, starting anywhere, in either direction? */
function sameLoop(got: [number, number][], want: [number, number][]) {
  if (got.length !== want.length) return false;
  const n = want.length;
  const eq = (p: [number, number], q: [number, number]) => p[0] === q[0] && p[1] === q[1];
  for (let start = 0; start < n; start++)
    for (const step of [1, n - 1])
      if (got.every((p, i) => eq(p, want[(start + i * step) % n]))) return true;
  return false;
}

/** A star-shaped polygon (corners at increasing angles round a centre), as raw pointer positions. */
function pointerPolygon(r: SeededRandom): [number, number][] {
  const n = 3 + Math.floor(r.next() * 10);
  const angles = Array.from({ length: n }, () => r.next() * 2 * Math.PI).sort((a, b) => a - b);
  const [cx, cy] = [(r.next() - 0.5) * 200, (r.next() - 0.5) * 200];
  return angles.map((t) => {
    const radius = 5 + r.next() * 45;
    return [cx + radius * Math.cos(t), cy + radius * Math.sin(t)];
  });
}

function shuffle<T>(r: SeededRandom, xs: T[]): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r.next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

test("seeded sketches: snapped polygons in any order and direction close into the loop drawn", async () => {
  let closed = 0;
  let cases = 0;
  for (const seed of [1n, 2n, 3n, 4n, 5n]) {
    const r = seeded(seed);
    for (let c = 0; c < 40; c++) {
      const spacing = [0.1, 0.5, 1, 5][Math.floor(r.next() * 4)];
      const snapped: [number, number][] = [];
      for (const [x, y] of pointerPolygon(r)) {
        const p = await kernel.call("snap_to_grid", x, y, spacing);
        // Model of the grid: every node is a whole number of spacings, within half a spacing of the pointer.
        assert.ok(Math.abs(p[0] - x) <= spacing / 2 + 1e-9 && Math.abs(p[1] - y) <= spacing / 2 + 1e-9, `seed ${seed}: ${x},${y} → ${p}`);
        assert.ok(Math.abs(p[0] / spacing - Math.round(p[0] / spacing)) < 1e-9, `seed ${seed}: ${p[0]} on grid ${spacing}`);
        const last = snapped[snapped.length - 1];
        if (!last || last[0] !== p[0] || last[1] !== p[1]) snapped.push(p);
      }
      if (snapped.length > 1 && snapped[0][0] === snapped[snapped.length - 1][0] && snapped[0][1] === snapped[snapped.length - 1][1]) snapped.pop();
      if (snapped.length < 3) continue;
      cases++;
      const lines = shuffle(r, ring(snapped)).map((l) => (r.next() < 0.5 ? { a: l.b, b: l.a } : l));
      const out = await kernel.call("sketch_outline", lines);
      const context = `seed ${seed} case ${c}: ${JSON.stringify(lines)} → ${JSON.stringify(out)}`;
      if ("open" in out) {
        // Snapping can fold a star into a sliver or make two corners meet; nothing else may open it.
        assert.match(out.open, /not a valid outline|line ends meet/, context);
        continue;
      }
      closed++;
      assert.ok(sameLoop(corners(out.closed), snapped), context);
      const h = 1 + Math.floor(r.next() * 20);
      const body = await kernel.call("make_extrude", out.closed, h);
      const want = area(snapped) * h;
      assert.ok(Math.abs(body.volume - want) <= 1e-9 * want, `${context}: volume ${body.volume} vs ${want}`);

      // Break it: move one line's end by one grid step; the sketch opens.
      const broken = lines.map((l, i) => (i === 0 ? { a: l.a, b: [l.b[0] + spacing, l.b[1]] as [number, number] } : l));
      const again = await kernel.call("sketch_outline", broken);
      assert.ok("open" in again, `${context}: still closed after moving an end`);
    }
  }
  // Must not pass by opening everything.
  assert.ok(closed >= 0.8 * cases, `only ${closed} of ${cases} closed`);
});
