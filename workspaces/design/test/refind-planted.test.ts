// Step 25a4, proof the checks can fail: bugs planted one at a time in the
// code that re-finds references, each of which the seeded sessions against
// the model (refind-session.ts) must catch, with the check that catches it.
// The guesses among them (a shared name picked as the first face, a link
// delivering a solid for a shared face) are the mistakes 25a4 rules out.
// Each plant is a text edit of the real source, loaded as a copy from a
// temporary folder (its imports pointed back at src/), so src/ is never
// touched; the copy's exports stand in for the real file's in the subject.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { REAL, runRefindSession, type Subject } from "./refind-session.ts";

interface Plant {
  name: string;
  file: "naming" | "references" | "scene" | "selection" | "representations";
  find: string;
  replace: string;
  /** Text in the session's failure message: which check caught it. */
  caught: string;
}

export const REFIND_PLANTS: Plant[] = [
  // The guess 25a4 rules out: two faces with one name, the first one taken.
  { name: "shared-name-guessed", file: "naming", find: "  return names.map((n) => (n !== null && seen.get(n) === 1 ? n : null));", replace: "  return names;", caught: "findInScene differs from the model" },
  {
    name: "shared-not-recorded",
    file: "naming",
    find: "shared: { faces: repeated(given), edges: repeated(edgeNames(given)) }",
    replace: "shared: { faces: new Map(), edges: new Map() }",
    caught: "findInScene differs from the model",
  },
  { name: "edge-ignores-its-faces", file: "references", find: "  return Math.max(0, ...r.part!.split(/[+>]/).map((face) => names.shared.faces.get(face) ?? 0));", replace: "  return 0;", caught: "sharedBy differs from the model" },
  { name: "shared-as-gone", file: "scene", find: '  return count > 1 ? { status: "shared", count } : { status: "gone" };', replace: '  return { status: "gone" };', caught: "findInScene differs from the model" },
  {
    name: "shared-moved-to-a-face",
    file: "scene",
    find: '  return count > 1 ? { status: "shared", count } : { status: "gone" };',
    replace: '  return count > 1 ? { status: "found", index: (ref.kind === "face" ? scene.faceStart[b] : scene.edgeStart[b]) + (ref.kind === "face" ? names.faces : names.edges).indexOf(null) } : { status: "gone" };',
    caught: "findInScene differs from the model",
  },
  { name: "selection-keeps-shared", file: "selection", find: '      keep = found.status === "found";', replace: '      keep = found.status !== "gone";', caught: "survivors differ from the model" },
  { name: "note-forgets-shared", file: "selection", find: "  const twice = dropped.filter(isShared);", replace: "  const twice: GeometryReference[] = [];", caught: "the note differs from the model" },
  { name: "row-hides-shared", file: "selection", find: "    if (type === undefined && sharedBy(item, shown?.names ?? null) > 1)", replace: "    if (false)", caught: "the selection row differs from the model" },
  {
    name: "link-shared-as-gone",
    file: "representations",
    find: '    if (found.status === "shared") return { unresolved: `now matches more than one ${ref.kind} after the last edit, so it was not moved to any of them` };',
    replace: "",
    caught: "the link lookup differs from the model",
  },
  { name: "link-guesses", file: "representations", find: '    return found.status === "found" ? solidOf(scene.bodies[b].feature) : null;', replace: "    return solidOf(scene.bodies[b].feature);", caught: "the link lookup differs from the model" },
];

/** The subject with `plant` made in its file, loaded from a temporary copy whose relative imports point at src/. */
async function plantedSubject(plant: Plant, dir: string): Promise<Subject> {
  const source = new URL(`../src/${plant.file}.ts`, import.meta.url);
  const text = readFileSync(source, "utf8");
  const at = text.indexOf(plant.find);
  assert.ok(at >= 0 && text.indexOf(plant.find, at + 1) < 0, `${plant.name}: the text to replace must be in ${plant.file}.ts exactly once: ${plant.find}`);
  const planted = (text.slice(0, at) + plant.replace + text.slice(at + plant.find.length)).replace(/from "\.\/([^"]+)"/g, (_, f) => `from "${new URL(f, source).href}"`);
  const file = join(dir, `${plant.file}-${plant.name}.ts`);
  writeFileSync(file, planted);
  return { ...REAL, ...(await import(pathToFileURL(file).href)) };
}

test("each bug planted in the re-finding code is caught by the seeded sessions, by the check that should catch it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "refind-plants-"));
  try {
    for (const plant of REFIND_PLANTS) {
      const s = await plantedSubject(plant, dir);
      let caught: string | null = null;
      for (let seed = 1; seed <= 12 && caught === null; seed++) {
        try {
          runRefindSession(s, seed);
        } catch (e) {
          caught = (e as Error).message;
        }
      }
      assert.ok(caught !== null, `${plant.name} was not caught in 12 seeds`);
      assert.ok(caught.includes(plant.caught), `${plant.name} was caught by another check: ${caught}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the real code passes the same sessions (so a plant's failure is the plant's)", () => {
  for (let seed = 1; seed <= 12; seed++) runRefindSession(REAL, seed);
});
