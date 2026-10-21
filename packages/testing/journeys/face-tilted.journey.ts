// Chains of sketches on slanted faces (26g's hunt), on the real kernel: a
// seeded 3- to 5-sided outline extruded, then 1 to 4 sketches each on a
// random flat face of the body before (often slanted, often an end cap
// flipped), each a small triangle with one corner on a corner of its face,
// pinned there (26f), and extruded. Then 12 seeded edits upstream (a corner
// of the outline moved, a distance, a flip), each settled as the app
// settles every edit, and after each one:
//   - no sketch's frame is refused (a frame turned with its face must stay
//     square and unit, however slanted);
//   - following the pins is a fixed point (follow, build, follow again:
//     nothing moves);
//   - every pinned corner is a corner of the body extruded from its sketch,
//     in the world, to 1e-7 mm: the pin's world point (the face's vertex)
//     and the child's vertex are worked out by different code (the face's
//     own corner from the kernel against the sketch point carried through
//     the turned frame and extruded), so a frame that drifts shows.
// An edit whose outline the kernel refuses (a moved corner crossing an
// edge, or a triangle followed thinner than a micrometre: 6 in 1000
// seeds) is a fair failure and skipped; any other refusal fails. Planting a frame origin 1e-6 off
// (frameNow's `dot(point, n)` times 1 + 1e-6) is caught at seed 2.
// FISSION_TILTED_SEEDS (30) sets the seeds. Run with `npm run journeys`.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { BodyView } from "@fission/core";
import { addFaceSketch, addSketch, BodyCache, drawLine, drawnOnFace, extrudeSketch, facePlane, followedDoc, joinBodies, movePoint, pinNewPoints, rebuildTimeline, vertexNames, setExtrudeDistance, setExtrudeFlip, settleKept, shownBodies, sketchEdgeTargets, type DesignDocument } from "@fission/design";
import { kernel } from "./design-app.ts";

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function polygon(doc: DesignDocument, id: string, corners: [number, number][]) {
  const pts: string[] = [];
  for (let k = 0; k < corners.length; k++) {
    const from = pts[k] ?? corners[k];
    const to = k + 1 === corners.length ? pts[0] : corners[k + 1];
    const d = drawLine(doc, id, from as never, to as never);
    doc = d.doc;
    const line = doc.sketches.find((s) => s.id === id)!.curves.find((c) => c.id === d.id)! as { start: string; end: string };
    pts[k] = line.start;
    if (k + 1 < corners.length) pts[k + 1] = line.end;
  }
  return { doc, pts };
}

async function sceneOf(doc: DesignDocument, cache: BodyCache) {
  const b = await rebuildTimeline(doc, cache, kernel);
  return { b, scene: joinBodies(await shownBodies(doc, b, cache)) };
}

const stats: Record<string, number> = {};
const bump = (k: string) => void (stats[k] = (stats[k] ?? 0) + 1);

async function session(seed: number): Promise<string | null> {
  const r = rng(seed);
  const cache = new BodyCache(kernel);
  // A design with nothing in it (as a file with no features reads).
  let doc: DesignDocument = { version: 3, nextId: 1, profiles: [], sketches: [], timeline: { features: [] } } as unknown as DesignDocument;
  const log: string[] = [];
  try {
    const base = addSketch(doc);
    const n = 3 + Math.floor(r() * 3);
    const corners: [number, number][] = Array.from({ length: n }, (_, k) => {
      const a = (2 * Math.PI * k) / n + r() * 0.5;
      const rad = 10 + r() * 30;
      return [Math.round(rad * Math.cos(a) * 1000) / 1000, Math.round(rad * Math.sin(a) * 1000) / 1000];
    });
    const p = polygon(base.doc, base.id, corners);
    doc = extrudeSketch(p.doc, base.id, 5 + Math.round(r() * 30), r() < 0.3).doc;
    log.push(`base ${JSON.stringify(corners)}`);
    const depth = 1 + Math.floor(r() * 4);
    for (let d = 0; d < depth; d++) {
      const { scene } = await sceneOf(doc, cache);
      const last = scene.bodies.at(-1)!;
      const flat = last.view.face_normals.flatMap((nrm, f) => (nrm && last.names.faces[f] ? [f] : []));
      if (flat.length === 0) return null;
      const f = flat[Math.floor(r() * flat.length)];
      const drawn = drawnOnFace(last.view, f)!;
      const plane = facePlane(last.names.feature, last.names.faces[f]!);
      const made = addFaceSketch(doc, { plane, feature: last.feature }, drawn);
      const targets = sketchEdgeTargets(made.doc, made.id, scene, drawn.plane).filter((t) => t.kind === "endpoint");
      if (targets.length === 0) return `no targets on ${plane}`;
      const t = targets[Math.floor(r() * targets.length)];
      // A small triangle from the corner into the face's middle direction (centroid in sketch coords).
      const c = last.view.face_centroids[f];
      const dd = [c[0] - drawn.plane.origin[0], c[1] - drawn.plane.origin[1], c[2] - drawn.plane.origin[2]];
      const y = [drawn.plane.normal[1] * drawn.plane.xAxis[2] - drawn.plane.normal[2] * drawn.plane.xAxis[1], drawn.plane.normal[2] * drawn.plane.xAxis[0] - drawn.plane.normal[0] * drawn.plane.xAxis[2], drawn.plane.normal[0] * drawn.plane.xAxis[1] - drawn.plane.normal[1] * drawn.plane.xAxis[0]];
      const cx = dd[0] * drawn.plane.xAxis[0] + dd[1] * drawn.plane.xAxis[1] + dd[2] * drawn.plane.xAxis[2];
      const cy = dd[0] * y[0] + dd[1] * y[1] + dd[2] * y[2];
      const s = 0.3 + r() * 0.4;
      const tri: [number, number][] = [t.at as [number, number], [t.at[0] + s * (cx - t.at[0]), t.at[1] + s * (cy - t.at[1])], [t.at[0] + s * (cx - t.at[0]) * 0.5 - 0.4 * s * (cy - t.at[1]), t.at[1] + s * (cy - t.at[1]) * 0.5 + 0.4 * s * (cx - t.at[0])]];
      const q = polygon(made.doc, made.id, tri);
      doc = pinNewPoints(made.doc, q.doc, made.id, targets);
      const pins = doc.sketches.find((x) => x.id === made.id)!.pins?.length ?? 0;
      if (pins === 0) return `nothing pinned on ${plane} at ${t.at}`;
      bump("pinned");
      doc = extrudeSketch(doc, made.id, 1 + Math.round(r() * 15), r() < 0.3).doc;
      log.push(`on ${plane} (${drawn.plane.normal.map((v) => v.toFixed(3))}) pinned ${t.name}`);
    }
    // Edits: the base's corners moved a little, distances and flips, each settled; every result built, followed points a fixed point.
    for (let k = 0; k < 12; k++) {
      const before = doc;
      const roll = r();
      const extrudes = doc.timeline.features.filter((x) => x.intent.type === "extrude");
      const e = extrudes[Math.floor(r() * extrudes.length)];
      if (roll < 0.5) {
        const pt = p.pts[Math.floor(r() * p.pts.length)];
        const was = doc.sketches[0].points.find((x) => x.id === pt)!;
        doc = movePoint(doc, base.id, pt, Math.round((was.x + (r() - 0.5) * 6) * 1000) / 1000, Math.round((was.y + (r() - 0.5) * 6) * 1000) / 1000);
        log.push(`move ${pt}`);
      } else if (roll < 0.8) {
        doc = setExtrudeDistance(doc, 2 + Math.round(r() * 30), e.id);
        log.push(`distance ${e.id}`);
      } else {
        doc = setExtrudeFlip(doc, e.intent.parameters.flip !== true, e.id);
        log.push(`flip ${e.id}`);
      }
      const edited = doc;
      doc = await settleKept(kernel, before, doc);
      // Pinned points the settling moved (it follows pins as the app does).
      for (const sk of doc.sketches) for (const pin of sk.pins ?? []) {
        const [a, b] = [edited, doc].map((d) => d.sketches.find((x) => x.id === sk.id)?.points.find((x) => x.id === pin.point));
        if (a && b && (a.x !== b.x || a.y !== b.y)) bump("pin-moved");
      }
      const { b } = await sceneOf(doc, cache);
      const failed = Object.entries(b.results).filter(([, x]) => x.status === "failed");
      if (failed.length > 0) {
        bump("failed");
        for (const [, x] of failed) bump(`fail: ${(x as { message: string }).message.replace(/[0-9.\-]+/g, "#").slice(0, 300)}`);
        const msgs = failed.map(([id, x]) => `${id}: ${(x as { message: string }).message}`);
        // Only an outline the edit spoiled is fair (a moved corner crossing an edge, or a pinned corner followed to within a
        // micrometre of its triangle's far side); a refused frame or anything else is a bug.
        if (msgs.some((m) => !/no closed outline|not a valid outline/i.test(m))) return `refused: ${msgs.join("; ")}\n${log.join("\n")}`;
        continue;
      }
      // Settled already: following again changes nothing, now or after another build.
      if (followedDoc(doc, b) !== doc) return `settling left pins to follow after ${log.at(-1)}\n${log.join("\n")}`;
      bump("fixed");
      const again = await sceneOf(doc, cache);
      if (followedDoc(doc, again.b) !== doc) return `following is not a fixed point after ${log.at(-1)}\n${log.join("\n")}`;
      for (const x of Object.values(again.b.results)) if (x.status === "built" && x.points) bump(`held-${x.points.cause}`);
      // Apart from frames: each face sketch's pinned corner is a corner of the body extruded from it, in the world, to 1e-7 mm.
      const bodies = new Map((await shownBodies(doc, again.b, cache)).map((x) => [x.feature, x]));
      for (const sk of doc.sketches) {
        if (!sk.face || !sk.pins) continue;
        const item = doc.timeline.features.find((x) => x.id === sk.id)!;
        const parent = bodies.get(decodeURIComponent((item.intent.parameters.plane as string).slice(5).split("/")[0]));
        const ext = doc.timeline.features.find((x) => x.intent.parameters.sketch === sk.id);
        const child = ext && bodies.get(ext.id);
        if (!parent || !child || again.b.results[sk.id].status !== "built" || (again.b.results[sk.id] as { plane?: unknown }).plane) continue;
        for (const pin of sk.pins) {
          const v = vertexNames(parent.view, parent.names).vertices.indexOf(pin.name);
          if (v < 0) continue;
          const w = parent.view.vertex_points[v];
          const near = child.view.vertex_points.some((q) => Math.hypot(q[0] - w[0], q[1] - w[1], q[2] - w[2]) < 1e-7);
          bump(near ? "corner-on-corner" : "corner-off");
          if (!near) return `${sk.id}'s pinned corner ${pin.name} at [${w}] is no corner of ${ext!.id}'s body after ${log.at(-1)}\n${log.join("\n")}`;
        }
      }
    }
    return null;
  } catch (e) {
    return `${(e as Error).stack}\n${log.join("\n")}`;
  } finally {
    await cache.clear();
  }
}

test("seeded chains of pinned sketches on slanted faces: only spoiled outlines refused, pins a fixed point, every pinned corner a corner of its extrude", async () => {
  const N = Number(process.env.FISSION_TILTED_SEEDS ?? 30);
  for (let s = 1; s <= N; s++) {
    const f = await session(s);
    assert.equal(f, null, `seed ${s}: ${f}`);
  }
  if (process.env.FISSION_TRACE) console.log(JSON.stringify(stats));
  // Reached: pins on slanted faces, pins that moved with an edit, and corners checked.
  for (const k of ["pinned", "pin-moved", "fixed", "corner-on-corner"]) assert.ok((stats[k] ?? 0) > 0, `${k} reached (${JSON.stringify(stats)})`);
  assert.ok(stats["corner-on-corner"] >= 10 * N, `corners checked: ${stats["corner-on-corner"]}`);
});
