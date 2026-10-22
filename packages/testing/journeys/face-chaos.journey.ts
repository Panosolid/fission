// Journey: the step-26 bug hunt's seeded sessions (26g), in the real
// Design workspace on the real WASM kernel (design-app.ts). Sketches on
// faces, mixed as a careless user would: Create sketch on a face the view
// offers, a circle or rectangle drawn there (often snapped onto the face's
// corners, so pinned), extruded or not, flipped or not; Edit feature on any
// solid (sizes, Flip); the panel's shape buttons and size boxes; suppress,
// the marker and deletes; Edit Sketch; Undo, Redo, another workspace, and
// the file saved and opened again. After every step, against rules written
// here apart from Design's own code:
//   - settled: the file is what Design's own `settleKept` makes of it
//     (`settleKept(file, file)` changes nothing): every edit the app
//     records has had the same settling the naming harness gives Design
//     after every edit (held placements, kept shapes, followed pins), so
//     the app is the subject the harness checked against the model;
//   - stays where it was: a sketch on a face that was drawn found before
//     an edit (not Undo, Redo or an opened file) and is drawn lost after
//     it is drawn exactly where it was (Q1, Q6: Fusion keeps its last
//     place, never where it was first drawn);
//   - the file reads back the same, Undo then Redo gives back the same
//     file, opening the saved file shows the same view (volume, sketches
//     and their places, which are lost), nothing throws, and every body is
//     freed at the end.
// Planted bugs, each caught by the check that should. Sessions:
// `FISSION_SESSIONS` × `FISSION_SESSION_STEPS` (default 6 × 40); a failure
// prints its seed and the steps before it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { emptyProject, projectFromJson, projectToJson, type DisplayMesh, type Plane, type SketchDrawing } from "@fission/core";
import { addSketch, designWorkspace, drawRectangle, extrudeSketch, partDocument, settleKept, type DesignDocument } from "@fission/design";
import { app, close, kernel } from "./design-app.ts";

const SEEDS = Number(process.env.FISSION_SESSIONS ?? 6);
const STEPS = Number(process.env.FISSION_SESSION_STEPS ?? 40);

type App = Awaited<ReturnType<typeof app>>;

/** Mulberry32, so a failing session replays from its seed. */
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

/**
 * The start of a session: a 40 × 30 × 20 box, and on odd seeds a 40 × 30
 * rectangle at x 100 to 140 extruded 20 after it (then the part the panel
 * edits; on even seeds the box is, and stays: those sessions extrude
 * nothing, so the shape buttons change the box whose faces sketches are
 * on, losing them, after Edit feature and typed sizes have moved them).
 */
export function start(seed = 1): DesignDocument {
  const box = partDocument("box", 40, 30, 20);
  if (seed % 2 === 0) return box;
  const made = addSketch(box);
  return extrudeSketch(drawRectangle(made.doc, made.id, [100, 0], [140, 30]).doc, made.id, 20).doc;
}

/** JSON with every object's keys sorted: the file writer sorts them, so their order is no change. */
const canonical = (v: unknown): string => JSON.stringify(v, (_, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));

/** The file saved and read back, as opening it would. */
const reopened = (doc: DesignDocument) => projectFromJson(projectToJson({ ...emptyProject("Face chaos"), workspaces: { design: doc } }), [designWorkspace]).workspaces.design as DesignDocument;

/** A sketch point in world space: origin + x · xAxis + y · (normal × xAxis). */
const cross = (a: readonly number[], b: readonly number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
/** World point `p` in the sketch's (x, y) through `plane`. */
export const toSketch = (p: readonly number[], plane: Plane): [number, number] => {
  const d = [p[0] - plane.origin[0], p[1] - plane.origin[1], p[2] - plane.origin[2]];
  return [dot(d, plane.xAxis), dot(d, cross(plane.normal, plane.xAxis))];
};

/** The points of mesh face `face` (joined index), each once: a flat face's corners are among them. */
function facePoints(mesh: DisplayMesh, face: number): number[][] {
  const seen = new Set<number>();
  mesh.triangle_faces.forEach((f, t) => {
    if (f === face) for (let k = 0; k < 3; k++) seen.add(mesh.indices[3 * t + k]);
  });
  return [...seen].map((i) => [mesh.positions[3 * i], mesh.positions[3 * i + 1], mesh.positions[3 * i + 2]]);
}

/** Each finished sketch as drawn, by the order the view lists them: its frame, side and whether drawn lost. The sketch being edited is left out. */
interface Drawn {
  plane: Plane;
  side: number;
  lost: boolean;
  lines: string;
}
const drawnOf = (d: SketchDrawing): Drawn => ({ plane: d.plane, side: d.side ?? 1, lost: d.lost === true, lines: canonical(d.lines) });

/**
 * The finished sketches as drawn, by sketch id: the view hands them over in
 * the order of the file's sketches, leaving out those not shown (suppressed,
 * greyed or after the marker, as the reference app hides them), so they are
 * matched to `shown`; none when the counts differ.
 */
function drawnById(a: App, shown: readonly string[]): Map<string, Drawn> {
  const finished = a.drawings().filter((d) => !d.editing);
  const out = new Map<string, Drawn>();
  if (finished.length !== shown.length) return out;
  shown.forEach((id, i) => out.set(id, drawnOf(finished[i])));
  return out;
}

/** The sketches the app draws as finished ones, in the file's order: before the marker, not suppressed, not built on anything suppressed or after the marker. */
function shownSketches(doc: DesignDocument, editing: string | null): string[] {
  const items = doc.timeline.features;
  const marker = doc.timeline.marker;
  const stop = marker === undefined ? items.length : marker === "start" ? 0 : items.findIndex((f) => f.id === marker) + 1;
  const off = new Set<string>();
  items.forEach((f, i) => {
    if (i >= stop || f.suppressed || f.dependsOn.some((d) => off.has(d))) off.add(f.id);
  });
  return doc.sketches.map((s) => s.id).filter((id) => !off.has(id) && id !== editing);
}

/** The part's preset shape ("box", "cylinder", "sphere") when the part is one with a sketch on one of its faces, else null: the last solid in range and on. */
function sketchedPart(doc: DesignDocument): string | null {
  const items = doc.timeline.features;
  const marker = doc.timeline.marker;
  const stop = marker === undefined ? items.length : marker === "start" ? 0 : items.findIndex((f) => f.id === marker) + 1;
  const part = items.slice(0, stop).filter((f) => f.intent.type !== "sketch" && !f.suppressed).at(-1);
  if (!part || part.intent.type === "extrude") return null;
  return items.some((g) => g.intent.type === "sketch" && g.dependsOn.includes(part.id)) ? part.intent.type : null;
}

const samePlane = (p: Plane, q: Plane) => canonical(p) === canonical(q);

// ---------------------------------------------------------------- the session

export const REACHED: Record<string, number> = {};
const reach = (k: string) => void (REACHED[k] = (REACHED[k] ?? 0) + 1);

/** One seeded session on Design (or a planted copy): null when every check held, else what failed, with the seed and the steps before it. */
export async function faceSession(seed: number, steps: number, plugin = designWorkspace): Promise<string | null> {
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
  let a = await app(start(seed), plugin);
  const errors: string[] = [];
  const onError = (e: Event) => errors.push(String((e as ErrorEvent).error?.stack ?? (e as ErrorEvent).message));
  const watch = (x: App) => x.window.addEventListener("error", onError as never);
  watch(a);
  const onRejection = (e: unknown) => errors.push(`unhandled: ${(e as Error)?.stack ?? e}`);
  process.on("unhandledRejection", onRejection);
  const done: string[] = [];
  const fail = (what: string) => `seed ${seed} step ${done.length} (faceSession(${seed}, ${steps})): ${what}\n  after: ${done.slice(-10).join("\n         ")}`;
  /** The sketch Edit Sketch or Create sketch left open, if any. */
  let editing: string | null = null;
  try {
    for (let k = 0; k < steps; k++) {
      const before = a.doc();
      const drawnBefore = drawnById(a, shownSketches(before, editing));
      const solids = before.timeline.features.filter((f) => f.intent.type !== "sketch");
      const roll = r();
      /** Undo, Redo and an opened file put back what was: "stays where it was" is not theirs to keep. */
      let restores = false;
      if (editing !== null) {
        // A sketch is open: draw on it or finish it.
        if (r() < 0.6) await drawOnFace(a, r, pick, done);
        await a.finish();
        done.push("finish sketch");
        editing = null;
      } else if (roll < 0.08 && sketchedPart(before)) {
        // The part is a preset with a sketch on it: another shape, which loses some or all of its faces (Edit feature never does).
        const now = sketchedPart(before)!;
        const shape = pick(["Box", "Cylinder", "Sphere"].filter((x) => x.toLowerCase() !== now));
        const button = [...a.window.document.querySelectorAll("button")].find((b) => b.textContent === shape) as unknown as HTMLButtonElement;
        button.click();
        await a.settle();
        done.push(`shape ${shape} (the part, a ${now}, has a sketch on it)`);
        reach("shape-lose");
      } else if (roll < 0.22) {
        // Create sketch on a face the view offers, something drawn, often extruded.
        a.$("#create-sketch")!.click();
        await a.settle();
        const faces = a.planes().faces;
        if (seed % 2 === 1 && (faces.length === 0 || r() < 0.15)) {
          // An origin plane: a rectangle extruded, a new body with flat faces to sketch on.
          const plane = pick(["XY", "XZ", "YZ"]);
          await a.pick({ plane });
          const [x, y, w] = [Math.floor(r() * 200) - 100, Math.floor(r() * 60), 5 + Math.floor(r() * 30)];
          await a.key("sketch-rectangle");
          await a.click(x, y);
          await a.click(x + w, y + w);
          await a.key("clear-selection");
          a.$("#sketch-extrude")!.click();
          await a.settle();
          (a.$("#extrude-distance") as HTMLInputElement).value = String(w);
          (a.$("#extrude-ok") as HTMLButtonElement).click();
          await a.settle();
          if (a.sketching()) await a.finish();
          done.push(`sketch on ${plane}: ${w} square at ${x},${y}, extruded ${w}`);
          reach("origin-sketch");
        } else if (faces.length === 0) {
          await a.key("clear-selection");
          done.push("create sketch: no face offered");
        } else {
          const face = pick(faces);
          await a.pick({ face });
          const made = a.doc().sketches.at(-1)!;
          done.push(`create sketch on face ${face} (${a.doc().timeline.features.find((f) => f.id === made.id)?.intent.parameters.plane})`);
          reach("face-sketch");
          await drawOnFace(a, r, pick, done, face);
          if (seed % 2 === 1 && r() < 0.4 && a.sketching()) {
            a.$("#sketch-extrude")!.click();
            await a.settle();
            const flip = r() < 0.3;
            const distance = String(1 + Math.floor(r() * 25));
            (a.$("#extrude-distance") as HTMLInputElement).value = distance;
            const box = a.$("#extrude-flip") as HTMLInputElement | null;
            if (box && box.checked !== flip) box.click();
            (a.$("#extrude-ok") as HTMLButtonElement).click();
            await a.settle();
            done.push(`  extrude ${distance}${flip ? " flipped" : ""}`);
            reach("face-extrude");
          }
          if (a.sketching()) {
            if (r() < 0.8) {
              await a.finish();
              done.push("  finish");
            } else editing = made.id;
          }
        }
      } else if (roll < 0.4 && solids.length > 0) {
        // Edit feature: new sizes (and Flip, for an extrude of a sketch); mostly a solid a sketch is on, so its faces move.
        const under = solids.filter((x) => before.timeline.features.some((g) => g.dependsOn.includes(x.id) && g.intent.type === "sketch"));
        const f = under.length > 0 && r() < 0.6 ? pick(under) : pick(solids);
        const off = await a.menu(f.id, "edit");
        if (off !== null) done.push(`edit ${f.id}: off (${off})`);
        else {
          const typed: string[] = [];
          for (const key of ["width", "depth", "height"]) {
            const b = a.$(`#edit-${key}`) as HTMLInputElement | null;
            if (b && !b.closest("[hidden]")) {
              b.value = String(5 + Math.floor(r() * 55));
              typed.push(`${key} ${b.value}`);
            }
          }
          const flip = a.$("#edit-flip") as HTMLInputElement | null;
          if (flip && !flip.closest("[hidden]") && r() < 0.3) {
            flip.click();
            typed.push("flip");
          }
          a.$("#feature-edit-ok")!.click();
          await a.settle();
          if (!a.$("#feature-edit")!.hidden) {
            a.$("#feature-edit-cancel")!.click();
            await a.settle();
            typed.push("(refused, cancelled)");
          }
          done.push(`edit ${f.id}: ${typed.join(", ")}`);
          reach("edit-feature");
        }
      } else if (roll < 0.54) {
        // The panel: a shape button (it changes the part when that is a box, cylinder or sphere, losing faces), or a size typed (one box).
        if (r() < 0.6) {
          const shape = pick(["Box", "Cylinder", "Sphere"]);
          const button = [...a.window.document.querySelectorAll("button")].find((b) => b.textContent === shape) as unknown as HTMLButtonElement | undefined;
          button?.click();
          await a.settle();
          done.push(`shape ${shape}`);
          reach("shape");
        } else {
          const key = pick(["width", "depth", "height"]);
          const box = a.$(`#${key}`) as HTMLInputElement;
          box.value = String(5 + Math.floor(r() * 55));
          box.dispatchEvent(new a.window.Event("input") as unknown as Event);
          await a.settle();
          done.push(`type ${key} ${box.value}`);
          reach("type");
        }
      } else if (roll < 0.66 && before.timeline.features.length > 0) {
        const f = pick(before.timeline.features);
        const entry = pick([f.suppressed ? "unsuppress" : "suppress", f.suppressed ? "unsuppress" : "suppress", "marker", "delete"]);
        const off = await a.menu(f.id, entry);
        done.push(`${entry} ${f.id}${off !== null ? ` off (${off})` : ""}`);
        if (off === null && entry === "delete" && (a.$("#delete-ask") as HTMLDialogElement | null)?.open) {
          const go = r() < 0.8;
          a.$(go ? "#delete-ask-confirm" : "#delete-ask-cancel")!.click();
          await a.settle();
          done.push(go ? "  asked: Delete" : "  asked: Cancel");
        }
        if (off === null) reach(entry);
      } else if (roll < 0.69) {
        const b = pick(["start", "back", "forward", "end"]);
        const button = a.$(`[data-button="${b}"]`) as HTMLButtonElement | null;
        if (button && !button.disabled) {
          button.click();
          await a.settle();
          reach("playback");
        }
        done.push(`playback ${b}${button?.disabled ? " (off)" : ""}`);
      } else if (roll < 0.76 && before.sketches.some((s) => s.face)) {
        // Edit Sketch on a face sketch: more drawn on it, often snapped onto its face's corners.
        const s = pick(before.sketches.filter((x) => x.face));
        await a.menu(s.id, "edit-sketch");
        if (a.sketching()) {
          done.push(`edit sketch ${s.id}`);
          reach("edit-sketch");
          editing = s.id;
        } else done.push(`edit sketch ${s.id}: not opened`);
      } else if (roll < 0.86) {
        restores = true;
        const label = await a.undo();
        done.push(`undo (${label})`);
        if (label !== null) {
          reach("undo");
          if (r() < 0.5) {
            const again = await a.redo();
            done.push(`redo (${again})`);
            if (again !== label) return fail(`Undo undid ${JSON.stringify(label)} but Redo redid ${JSON.stringify(again)}`);
            if (canonical(a.doc()) !== canonical(before)) return fail(`Undo then Redo of ${label} gave another file:\n${canonical(a.doc()).slice(0, 400)}\nvs\n${canonical(before).slice(0, 400)}`);
            reach("undo-redo");
          }
        }
      } else if (roll < 0.9) {
        restores = true;
        const label = await a.redo();
        done.push(`redo (${label})`);
      } else if (roll < 0.94) {
        await a.away();
        done.push("another workspace and back");
      } else {
        // Saved and opened again: the same view.
        restores = true;
        const doc = a.doc();
        const was = { volume: a.volume(), drawn: drawnById(a, shownSketches(doc, null)) };
        if (!(await a.close())) return fail("a body was not freed when the file was put away");
        a = await app(reopened(doc), plugin);
        watch(a);
        done.push("saved and opened");
        reach("reopen");
        if (canonical(a.doc()) !== canonical(reopened(doc))) return fail(`opening the file changed it:\n${canonical(a.doc()).slice(0, 400)}`);
        if (!close(a.volume(), was.volume)) return fail(`the opened file shows ${a.volume()} mm³, the app showed ${was.volume}`);
        const now = drawnById(a, shownSketches(doc, null));
        for (const [id, d] of was.drawn) {
          const n = now.get(id);
          if (!n || canonical(n) !== canonical(d)) return fail(`the opened file draws ${id} as ${canonical(n)}, the app drew it ${canonical(d)}`);
        }
      }

      if (process.env.FISSION_TRACE) console.log(done.at(-1), JSON.stringify(drawnById(a, shownSketches(a.doc(), editing)).entries().map(([id, d]) => `${id}${d.lost ? " lost" : ""}`).toArray()), a.doc().timeline.features.map((f) => f.intent.type + (f.suppressed ? "-off" : "")).join(","));
      // ---- the checks
      if (errors.length) return fail(`thrown: ${errors.join(" | ")}`);
      const after = a.doc();
      const back = reopened(after);
      if (canonical(back) !== canonical(after)) return fail(`the file reads back differently`);
      if (editing !== null) continue;
      const settled = await settleKept(kernel, after, after);
      if (canonical(settled) !== canonical(after)) return fail(`the file is not settled: settleKept changes it:\n${diff(after, settled)}`);
      if (!restores) {
        const drawnAfter = drawnById(a, shownSketches(after, null));
        for (const [id, d] of drawnAfter) {
          const was = drawnBefore.get(id);
          if (d.lost && was && !was.lost) {
            reach("lost");
            // Lost after its face had moved from where it was drawn: where it was is not its frame as drawn.
            if (!samePlane(d.plane, before.sketches.find((s) => s.id === id)?.face?.frame ?? d.plane)) reach("lost-moved");
            if (!samePlane(d.plane, was.plane) || d.side !== was.side) return fail(`${id} lost its face and is drawn at ${canonical(d.plane)}, not where it was: ${canonical(was.plane)}`);
          }
        }
      }
    }
    if (a.sketching()) await a.finish();
    if (errors.length) return fail(`thrown: ${errors.join(" | ")}`);
    return (await a.close()) ? null : fail("a body was not freed at the end");
  } catch (e) {
    await a.close();
    return fail((e as Error).stack ?? String(e));
  } finally {
    process.off("unhandledRejection", onRejection);
  }
}

/** The first sketch whose content the two files hold differently, both ways, for a failure's words. */
function diff(a: DesignDocument, b: DesignDocument): string {
  for (const s of a.sketches) {
    const t = b.sketches.find((x) => x.id === s.id);
    if (canonical(s) !== canonical(t)) return `${s.id}: ${canonical(s).slice(0, 500)}\n  settled: ${canonical(t).slice(0, 500)}`;
  }
  return `kept: ${canonical(a.kept)}\n  settled: ${canonical(b.kept)}`;
}

/**
 * On the open sketch: a circle or a rectangle, its first click on one of
 * the face's corners (from the mesh drawn, a hair off, so it snaps there and
 * is pinned) more often than not; `face` is the mesh face it is on when
 * just picked (else any corner of the drawn mesh near the sketch's plane).
 */
async function drawOnFace(a: App, r: () => number, pick: <T>(xs: readonly T[]) => T, done: string[], face?: number) {
  const plane = a.drawings().find((d) => d.editing)?.plane;
  const mesh = a.mesh();
  if (!plane || !mesh) return;
  const all = face === undefined ? Array.from({ length: mesh.positions.length / 3 }, (_, i) => [mesh.positions[3 * i], mesh.positions[3 * i + 1], mesh.positions[3 * i + 2]]) : facePoints(mesh, face);
  const on = all.filter((p) => Math.abs(dot([p[0] - plane.origin[0], p[1] - plane.origin[1], p[2] - plane.origin[2]], plane.normal)) < 1e-3);
  const corner = on.length > 0 && r() < 0.7 ? toSketch(pick(on), plane) : null;
  const at: [number, number] = corner ? [corner[0] + 0.03, corner[1] - 0.02] : [Math.round(r() * 60) - 10, Math.round(r() * 40) - 5];
  const size = 2 + Math.floor(r() * 6);
  if (r() < 0.6) {
    await a.key("sketch-circle");
    await a.click(at[0], at[1]);
    await a.click(at[0] + size, at[1]);
    done.push(`  circle at ${at.map((v) => v.toFixed(2))}${corner ? " (corner)" : ""} r ${size}`);
  } else {
    await a.key("sketch-rectangle");
    await a.click(at[0], at[1]);
    await a.click(at[0] + size, at[1] + size);
    done.push(`  rectangle at ${at.map((v) => v.toFixed(2))}${corner ? " (corner)" : ""} size ${size}`);
  }
  await a.key("clear-selection");
}

// ---------------------------------------------------------------- the tests

test("the session's own rules, worked by hand", () => {
  // toSketch on the XY frame is the world's x and y: (3, 4, 5) → (3, 4).
  assert.deepEqual(toSketch([3, 4, 5], { origin: [0, 0, 0], xAxis: [1, 0, 0], normal: [0, 0, 1] }), [3, 4]);
  // On a right face (x = 40) drawn with YZ's frame (x along world y, normal +x): y = normal × x = (1,0,0) × (0,1,0) = (0,0,1), world z; (40, 7, 9) → (7, 9).
  assert.deepEqual(toSketch([40, 7, 9], { origin: [40, 0, 0], xAxis: [0, 1, 0], normal: [1, 0, 0] }), [7, 9]);
  // The start: Feature 1 the box, Sketch 1 and its extrude; only Sketch 1 drawn.
  const doc = start();
  assert.deepEqual(doc.timeline.features.map((f) => f.intent.type), ["box", "sketch", "extrude"]);
  assert.deepEqual(shownSketches(doc, null), [doc.timeline.features[1].id]);
  // Suppressed, it isn't drawn; nor is it after a marker on the box.
  const off = structuredClone(doc);
  off.timeline.features[1].suppressed = true;
  assert.deepEqual(shownSketches(off, null), []);
  const marked = structuredClone(doc);
  marked.timeline.marker = doc.timeline.features[0].id;
  assert.deepEqual(shownSketches(marked, null), []);
});

test(`seeded: ${SEEDS} sessions × ${STEPS} steps of face sketches, pins, Edit feature, shapes, timeline edits, Undo, Redo and opened files keep the file settled and lost sketches where they were`, async () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const failure = await faceSession(seed, STEPS);
    assert.equal(failure, null);
  }
  for (const k of ["face-sketch", "face-extrude", "origin-sketch", "edit-feature", "shape", "shape-lose", "type", "suppress", "marker", "delete", "edit-sketch", "undo", "undo-redo", "reopen", "lost", "lost-moved"])
    assert.ok((REACHED[k] ?? 0) >= 2, `${k} reached ${REACHED[k] ?? 0} times: ${JSON.stringify(REACHED)}`);
});

const WORKSPACE = new URL("../../../workspaces/design/src/workspace.ts", import.meta.url);

/** Bugs planted in workspace.ts's settling of edits, each of which the sessions must catch, by the check named. */
const PLANTS = [
  // The edits outside a sketch never settled (26g's bug): a face lost by a shape change holds nothing.
  { name: "edits-unsettled", find: "    if (changed && label !== undefined && current) unsettled ??= current;", replace: "", caught: "the file is not settled" },
  // Settled against the design just recorded, not the one before the edit: a lost sketch holds where it was first drawn.
  { name: "settled-from-now", find: "    const from = unsettled;\n", replace: "    const from = unsettled && doc;\n", caught: "not where it was" },
];

/** Design with `plant` made: a copy of workspace.ts beside it (so its imports resolve), loaded, then deleted. */
async function planted(plant: { name: string; find: string; replace: string }): Promise<typeof designWorkspace> {
  const text = readFileSync(WORKSPACE, "utf8");
  const at = text.indexOf(plant.find);
  assert.ok(at >= 0 && text.indexOf(plant.find, at + 1) < 0, `${plant.name}: the text to replace must be in workspace.ts exactly once`);
  const file = new URL(`workspace.planted-face-chaos-${plant.name}.ts`, WORKSPACE);
  writeFileSync(file, text.slice(0, at) + plant.replace + text.slice(at + plant.find.length));
  try {
    return (await import(file.href)).designWorkspace;
  } finally {
    rmSync(file);
  }
}

test("each bug planted in workspace.ts's settling of edits is caught by the sessions, by the check that should catch it", async () => {
  for (const plant of PLANTS) {
    const design = await planted(plant);
    let caught: string | null = null;
    for (let seed = 1; seed <= Number(process.env.FISSION_PLANT_SEEDS ?? 3 * SEEDS) && caught === null; seed++) caught = await faceSession(seed, STEPS, design);
    assert.ok(caught !== null, `${plant.name} was not caught by ${3 * SEEDS} sessions`);
    assert.ok(caught.includes(plant.caught), `${plant.name} was caught by another check: ${caught}`);
    if (process.env.FISSION_PLANTED_REPORT) console.log(`${plant.name}: ${caught.split("\n")[0]}`);
  }
});
