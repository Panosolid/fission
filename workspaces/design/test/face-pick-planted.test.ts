// Step 26d, proof the checks can fail: bugs planted one at a time in where
// Create sketch puts a new sketch (face-pick.ts) and the frame a face gives
// it (face-sketch.ts), each of which the seeded sessions against the model
// (face-pick-session.ts) must catch, with the check that catches it. Each
// plant is a text edit of the real source loaded as a copy from a
// temporary folder (its imports pointed back at src/, refind-planted's way),
// so src/ is never touched.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { REAL, runFacePickSession, type Subject } from "./face-pick-session.ts";

interface Plant {
  name: string;
  file: "face-pick" | "face-sketch";
  find: string;
  replace: string;
  /** Text in the session's failure message: which check caught it. */
  caught: string;
}

export const FACE_PICK_PLANTS: Plant[] = [
  // Q5: a curved face sketched on as if flat (with a frame made up from the ground plane).
  { name: "curved-taken", file: "face-pick", find: '  if (drawn === null) return { kind: "refused", message: CURVED_FACE };\n', replace: '  if (drawn === null) return { kind: "face", face: { plane: designReference("face", body.names, hit.index)!.id, feature: body.feature }, drawn: { plane: { origin: [0, 0, 0], xAxis: [1, 0, 0], normal: [0, 0, 1] }, side: 1 } };\n', caught: "differs from the model" },
  // A face whose name two faces share sketched on: the guess 25a4 rules out.
  {
    name: "shared-name-taken",
    file: "face-pick",
    find: '  const ref = designReference("face", body.names, hit.index);',
    replace: '  const ref = designReference("face", body.names, hit.index) ?? { kind: "face" as const, id: `face:${body.names.feature}/${body.view.face_roles[hit.index]?.role}` as never };',
    caught: "differs from the model",
  },
  // The pick's joined number read as the body's own (the second body's faces land on the first's).
  { name: "joined-index-as-own", file: "face-pick", find: "  const drawn = drawnOnFace(body.view, hit.index);", replace: "  const drawn = drawnOnFace(body.view, pick.face);", caught: "differs from the model" },
  // Every plane id taken, not only the origin planes.
  { name: "any-plane", file: "face-pick", find: "  if (pick.plane != null) return (SKETCH_PLANES as readonly string[]).includes(pick.plane) ? { kind: \"plane\", plane: pick.plane as SketchPlane } : null;", replace: "  if (pick.plane != null) return { kind: \"plane\", plane: pick.plane as SketchPlane };", caught: "sketchSpot differs from the model" },
  // The faces offered to light include the curved ones.
  { name: "lights-curved", file: "face-pick", find: '?.kind === "face") faces.push', replace: '?.kind !== undefined) faces.push', caught: "sketchableFaces differs from the model" },
  // The faces offered counted from the wrong body start.
  { name: "lights-own-numbers", file: "face-pick", find: "faces.push(scene.faceStart[b] + i);", replace: "faces.push(i);", caught: "sketchableFaces differs from the model" },
  // Rule 8's ties: the last origin plane wins a tie instead of the first.
  { name: "tie-to-last", file: "face-sketch", find: "  for (const f of ORIGIN_FRAMES) if (Math.abs(dot(outward, f.normal)) > Math.abs(dot(outward, best.normal))) best = f;", replace: "  for (const f of ORIGIN_FRAMES) if (Math.abs(dot(outward, f.normal)) >= Math.abs(dot(outward, best.normal))) best = f;", caught: "the frame differs from the model" },
  // The side forgotten: a bottom face's sketch faces into the body.
  { name: "side-always-out", file: "face-sketch", find: "  const side = sign(dot(outward, best.normal));\n  const normal", replace: "  const side = 1;\n  const normal", caught: "differs from the model" },
  // The frame's normal made the outward one: a back face's x and y no longer the world's.
  { name: "normal-outward", file: "face-sketch", find: "  const normal = scale(unit(outward), side);", replace: "  const normal = unit(outward);", caught: "the frame differs from the model" },
  // The origin left at the face's centroid rather than the plane's point nearest the world's origin.
  { name: "origin-at-centroid", file: "face-sketch", find: "origin: scale(normal, dot(point, normal)), xAxis: turned(best.x, best.normal, normal), normal })!;\n  return { plane, side };", replace: "origin: [...point], xAxis: turned(best.x, best.normal, normal), normal })!;\n  return { plane, side };", caught: "the frame differs from the model" },
];

/** The subject with `plant` made in its file, loaded from a temporary copy whose relative imports point at src/ (face-pick.ts's import of face-sketch.ts pointed at the planted copy when that is the file). */
async function plantedSubject(plant: Plant, dir: string): Promise<Subject> {
  const source = new URL(`../src/${plant.file}.ts`, import.meta.url);
  const text = readFileSync(source, "utf8");
  const at = text.indexOf(plant.find);
  assert.ok(at >= 0 && text.indexOf(plant.find, at + 1) < 0, `${plant.name}: the text to replace must be in ${plant.file}.ts exactly once: ${plant.find}`);
  const point = (t: string, src: URL, own: Record<string, string> = {}) => t.replace(/from "\.\/([^"]+)"/g, (_, f) => `from "${own[f] ?? new URL(f, src).href}"`);
  const planted = point(text.slice(0, at) + plant.replace + text.slice(at + plant.find.length), source);
  const file = join(dir, `${plant.file}-${plant.name}.ts`);
  writeFileSync(file, planted);
  if (plant.file === "face-pick") return { ...REAL, ...(await import(pathToFileURL(file).href)) };
  // A plant in face-sketch.ts reaches the session through a copy of face-pick.ts that imports it.
  const pickSource = new URL("../src/face-pick.ts", import.meta.url);
  const pickFile = join(dir, `face-pick-${plant.name}.ts`);
  writeFileSync(pickFile, point(readFileSync(pickSource, "utf8"), pickSource, { "face-sketch.ts": pathToFileURL(file).href }));
  return { ...REAL, ...(await import(pathToFileURL(pickFile).href)) };
}

test("each bug planted in picking a sketch's face is caught by the seeded sessions, by the check that should catch it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "face-pick-plants-"));
  try {
    for (const plant of FACE_PICK_PLANTS) {
      const s = await plantedSubject(plant, dir);
      let caught: string | null = null;
      for (let seed = 1; seed <= 12 && caught === null; seed++) {
        try {
          runFacePickSession(s, seed);
        } catch (e) {
          caught = (e as Error).message;
        }
      }
      assert.ok(caught !== null, `${plant.name} was not caught in 12 seeds`);
      assert.ok(caught.includes(plant.caught), `${plant.name} was caught by another check: ${caught.split("\n")[0]}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the real code passes the same sessions (so a plant's failure is the plant's)", () => {
  for (let seed = 1; seed <= 12; seed++) runFacePickSession(REAL, seed);
});
