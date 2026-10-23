// Makes the golden models that today's Panosolid can build (step 28a),
// each through the Design app itself on the real WASM kernel (the app
// journeys' design-app.ts: Design mounted in happy-dom, picks and clicks
// handed to it as the viewport would), or for the gear, whose 96 sides
// no one would click, through the same document functions the sketch
// tools call. Each is saved as the app saves a project. The answers in
// each `<name>.expect.json` are worked out by hand, never by this script.
// Run from the repository root after the WASM build:
//   node --experimental-strip-types --no-warnings tests/golden/make.ts [name …]
import { writeFileSync } from "node:fs";
import { emptyProject, projectToJson, type DisplayMesh } from "@fission/core";
import { addSketch, designWorkspace, drawArc, drawLine, extrudeSketch, partDocument, type DesignDocument } from "@fission/design";
import { app, close } from "../../packages/testing/journeys/design-app.ts";

const DIR = new URL("./", import.meta.url);
const near = (a: number, b: number) => Math.abs(a - b) < 1e-4;

function save(file: string, title: string, doc: DesignDocument) {
  const p = emptyProject(title);
  p.workspaces.design = doc as never;
  writeFileSync(new URL(`${file}.panosolid.json`, DIR), projectToJson(p));
  console.log("saved", file);
}

/**
 * The joined face whose every drawn triangle corner passes `on` and which
 * has a corner at each of `reach` (one face: the make stops if none or two
 * do; a block's start cap lies on the base's top, so it takes both
 * corners of the top to tell them apart).
 */
function faceWhere(mesh: DisplayMesh, on: (p: number[]) => boolean, reach: number[][] = []): number {
  const all = new Map<number, boolean>();
  const reached = new Map<number, Set<number>>();
  mesh.triangle_faces.forEach((f, t) => {
    const corners = [0, 1, 2].map((k) => {
      const i = mesh.indices[3 * t + k];
      return [mesh.positions[3 * i], mesh.positions[3 * i + 1], mesh.positions[3 * i + 2]];
    });
    all.set(f, (all.get(f) ?? true) && corners.every(on));
    for (const p of corners) reach.forEach((q, j) => q.every((c, n) => near(c, p[n])) && reached.set(f, (reached.get(f) ?? new Set()).add(j)));
  });
  const found = [...all].filter(([f, ok]) => ok && (reached.get(f)?.size ?? 0) === reach.length).map(([f]) => f);
  if (found.length !== 1) throw new Error(`${found.length} faces match`);
  return found[0];
}

type App = Awaited<ReturnType<typeof app>>;

async function sketchOnFace(a: App, on: (p: number[]) => boolean, reach: number[][] = []) {
  a.$("#create-sketch")!.click();
  await a.settle();
  await a.pick({ face: faceWhere(a.mesh()!, on, reach) });
}

async function extrude(a: App, distance: number) {
  a.$("#sketch-extrude")!.click();
  await a.settle();
  (a.$("#extrude-distance") as HTMLInputElement).value = String(distance);
  (a.$("#extrude-ok") as HTMLButtonElement).click();
  await a.settle();
  if (a.sketching()) await a.finish();
}

async function circle(a: App, centre: [number, number], radius: number) {
  await a.key("sketch-circle");
  await a.click(...centre);
  await a.click(centre[0] + radius, centre[1]);
}

async function rectangle(a: App, from: [number, number], to: [number, number]) {
  await a.key("sketch-rectangle");
  await a.click(...from);
  await a.click(...to);
}

const MODELS: Record<string, () => Promise<void>> = {
  // A 60 × 40 × 10 plate, a boss r 10 tall 8 on its top round (30, 20), a step r 5 tall 6 on the boss's top.
  async "stepped-boss"() {
    const a = await app(partDocument("box", 60, 40, 10), designWorkspace);
    await sketchOnFace(a, (p) => near(p[2], 10));
    await circle(a, [30, 20], 10);
    await extrude(a, 8);
    await sketchOnFace(a, (p) => near(p[2], 18));
    await circle(a, [30, 20], 5);
    await extrude(a, 6);
    save("stepped-boss", "Stepped boss", a.doc());
    await close(a);
  },
  // An L drawn on the front plane XZ, 60 along and 40 up, 6 thick, extruded 30.
  async "l-bracket"() {
    const a = await app(partDocument("box", 40, 30, 20), designWorkspace);
    // Start from an empty timeline: the starting box deleted first, as a user would.
    const [box] = a.doc().timeline.features.map((f) => f.id);
    await a.menu(box, "delete");
    a.$("#delete-ask-confirm")?.click();
    await a.settle();
    a.$("#create-sketch")!.click();
    await a.settle();
    await a.pick({ plane: "XZ" });
    for (const [x, y] of [[0, 0], [60, 0], [60, 6], [6, 6], [6, 40], [0, 40], [0, 0]]) await a.click(x, y);
    await a.key("clear-selection");
    await extrude(a, 30);
    save("l-bracket", "L bracket", a.doc());
    await close(a);
  },
  // The ready-made plate, 80 × 40 × 6: two holes through it as holes in its profile.
  async "bracket-two-holes"() {
    const a = await app(partDocument("plate", 80, 40, 6), designWorkspace);
    save("bracket-two-holes", "Bracket with two holes", a.doc());
    await close(a);
  },
  // A gear-like outline, 10 thick: 24 teeth, each tip an arc on r 50 over half a pitch (π/24), each root an arc on r 44 over the other
  // half, joined by radial lines; every arc round the origin.
  async gear() {
    const N = 24;
    const [R, r] = [50, 44];
    let doc = partDocument("box", 40, 30, 20);
    doc = { ...doc, timeline: { ...doc.timeline, features: [] } };
    const made = addSketch(doc, "XY");
    doc = made.doc;
    const at = (radius: number, k: number): [number, number] => [radius * Math.cos((Math.PI * k) / N), radius * Math.sin((Math.PI * k) / N)];
    // Corners round the circle in half-pitch steps k = 0 … 2N − 1: out at even k's tip start, then tip arc, down, root arc, up.
    let first: string | null = null;
    let last: string | null = null;
    for (let k = 0; k < 2 * N; k += 2) {
      const tipStart: [number, number] | string = last ?? at(R, k);
      const tip = drawArc(doc, made.id, tipStart, at(R, k + 1), [0, 0]);
      doc = tip.doc;
      const arc = doc.sketches.find((s) => s.id === made.id)!.curves.find((c) => c.id === tip.id)! as { start: string; end: string; centre: string };
      first ??= arc.start;
      const down = drawLine(doc, made.id, arc.end, at(r, k + 1));
      doc = down.doc;
      const line = doc.sketches.find((s) => s.id === made.id)!.curves.find((c) => c.id === down.id)! as { end: string };
      const rootEnd = k + 2 === 2 * N ? null : at(r, k + 2);
      const root = drawArc(doc, made.id, line.end, rootEnd ?? at(r, 0), [0, 0]);
      doc = root.doc;
      const rootArc = doc.sketches.find((s) => s.id === made.id)!.curves.find((c) => c.id === root.id)! as { end: string };
      const up = drawLine(doc, made.id, rootArc.end, k + 2 === 2 * N ? first : at(R, k + 2));
      doc = up.doc;
      const upLine = doc.sketches.find((s) => s.id === made.id)!.curves.find((c) => c.id === up.id)! as { end: string };
      last = upLine.end;
    }
    doc = extrudeSketch(doc, made.id, 10).doc;
    // Opened in the app and saved from there, so the file is what the app writes after its own rebuild.
    const a = await app(doc, designWorkspace);
    save("gear", "Gear", a.doc());
    await close(a);
  },
  // An open box: an 80 × 60 × 3 floor and four walls 3 thick and 40 tall, each a rectangle sketched on the floor's top.
  async enclosure() {
    const a = await app(partDocument("box", 80, 60, 3), designWorkspace);
    const walls: [[number, number], [number, number]][] = [[[0, 0], [80, 3]], [[0, 57], [80, 60]], [[0, 3], [3, 57]], [[77, 3], [80, 57]]];
    for (const [from, to] of walls) {
      await sketchOnFace(a, (p) => near(p[2], 3), [[0, 0, 3], [80, 60, 3]]);
      await rectangle(a, from, to);
      await extrude(a, 40);
    }
    save("enclosure", "Enclosure", a.doc());
    await close(a);
  },
  // About 30 features (31 items): a 200 × 150 × 10 base, 14 blocks and posts on its top, one more post on the first block.
  async "thirty-features"() {
    const a = await app(partDocument("box", 200, 150, 10), designWorkspace);
    for (let i = 0; i < 14; i++) {
      const [cx, cy] = [20 + 40 * (i % 5), 25 + 50 * Math.floor(i / 5)];
      await sketchOnFace(a, (p) => near(p[2], 10), [[0, 0, 10], [200, 150, 10]]);
      if (i % 2 === 0) await rectangle(a, [cx - 10, cy - 10], [cx + 10, cy + 10]);
      else await circle(a, [cx, cy], 8);
      await extrude(a, 5 + i);
    }
    await sketchOnFace(a, (p) => near(p[2], 15));
    await circle(a, [20, 25], 5);
    await extrude(a, 3);
    save("thirty-features", "Thirty features", a.doc());
    await close(a);
  },
};

const wanted = process.argv.slice(2);
for (const [name, make] of Object.entries(MODELS)) if (wanted.length === 0 || wanted.includes(name)) await make();
