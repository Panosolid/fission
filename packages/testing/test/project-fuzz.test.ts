// The project loader fuzzer (src/project-fuzz.ts): a quick seeded run as
// part of every `npm test`, the saved failing inputs replayed forever, the
// model checked by hand, and proof that each check can fail.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { emptyProject, projectToJson, type DataReader } from "@fission/core";
import { addSketch, deleteItem, designWorkspace, drawRectangle, extrudeSketch, insertPreset, isSketchItem, moveMarker, partDocument, suppressItem, type DesignDocument } from "@fission/design";
import { buildModel, checkText, DESIGN_RULES, fuzzRound, outerModel, READERS, shrink, type BuildRules } from "../src/project-fuzz.ts";

const SEEDS = [0x5eedn, 1n, 2n];
const CASES = 1500;

test("seeded fuzzing of the project loader finds nothing, and reaches every outcome", () => {
  for (const seed of SEEDS) {
    const { failures, counts } = fuzzRound(seed, CASES);
    assert.deepEqual(failures.map((f) => `${f.kind}: ${f.input.slice(0, 300)}`), [], `seed ${seed}`);
    // Every way a case can go comes up, or the fuzzer is blind to it.
    for (const [what, n] of Object.entries(counts)) assert.ok(n > 0, `seed ${seed}: no case was ${what}`);
  }
});

test("every saved failing input is handled", () => {
  const dir = join(import.meta.dirname, "regressions/project-fuzz");
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  assert.ok(files.length >= 6);
  for (const f of files) assert.equal(checkText(readFileSync(join(dir, f), "utf8")), null, f);
});

test("the outer model, by hand", () => {
  const p = emptyProject() as unknown as Record<string, unknown>;
  assert.equal(outerModel(p).refusal, null);
  assert.equal(outerModel([]).refusal, "expected an object");
  assert.equal(outerModel({ ...p, formatVersion: 2.5 }).refusal, "no format version");
  assert.equal(outerModel({ ...p, formatVersion: 3 }).refusal, "saved by a newer Panosolid");
  assert.equal(outerModel({ ...p, name: 1 }).refusal, '"name" must be text');
  assert.equal(outerModel({ ...p, units: { length: "ft" } }).refusal, '"units" must give a length unit');
  // A format 1 file has no links: they arrive, empty, with the upgrade.
  const { links: _, ...v1 } = { ...p, formatVersion: 1 };
  assert.deepEqual(outerModel(v1).upgraded, { ...p, formatVersion: 2, links: [] });
  // Nesting: the object is level 1, so [[...]] 256 levels inside a key is
  // 257 deep, one past MAX_NESTING (256).
  let deep: unknown = [];
  for (let i = 1; i < 256; i++) deep = [deep];
  assert.equal(outerModel({ ...p, deep }).refusal, "is nested more than 256 deep");
  assert.equal(outerModel({ ...p, deep: (deep as unknown[])[0] }).refusal, null);
  assert.equal(outerModel({ ...p, w: -Infinity }).refusal, "is too big a number");
});

/** A Design reader broken in one way, standing in for a bug in a real one. */
const broken = (readData: (d: unknown) => unknown): DataReader[] => [{ id: "design", readData }, ...READERS.filter((r) => r.id !== "design")];
const good = projectToJson({ ...emptyProject("P"), workspaces: { design: partDocument("box", 40, 30, 20) } });

test("each check can fail", () => {
  assert.equal(checkText(good), null);
  // A reader that crashes on bad data: the engine's message is caught.
  const crashes = broken((d) => (d as { profiles: { id: string }[] }).profiles.map((p) => p.id) && designWorkspace.readData!(d));
  const nullProfile = good.replace('"profiles": []', '"profiles": [null]');
  assert.match(checkText(nullProfile, crashes)!.kind, /^refused with an engine message: Cannot read properties of null/);
  // A reader that quietly changes the data: saving doesn't keep the file.
  const changes = broken((d) => ({ ...(d as object), added: true }));
  assert.equal(checkText(good, changes)!.kind, "saving lost or changed something the file had");
  // A reader that accepts what Design can't show.
  const accepts = broken((d) => d);
  assert.match(checkText(good.replace('"type": "box"', '"type": "cube"'), accepts)!.kind, /^showing the Design part threw: Error: unknown feature type cube/);
  // A reader refusing valid data: the loader's message is right, but the
  // fuzzer still reports nothing (refusing is allowed; accepting bad data is not).
  assert.equal(checkText(good, broken(() => { throw new Error("no"); })), null);
  // The checks the loader itself must pass (only Errors, its own messages,
  // invalid JSON refused as such, the outer model) are shown failing by
  // breaking project.ts on purpose; see the pull request that added this.
});

test("shrinking keeps the failure and makes the input smaller", () => {
  const drops = broken((d) => ({ ...(d as object), added: true }));
  const kind = checkText(good, drops)!.kind;
  const small = shrink(good, kind, drops);
  assert.ok(small.length < good.length / 2, `${small.length} of ${good.length}`);
  assert.equal(checkText(small, drops)?.kind, kind);
});

/**
 * A timeline built by hand with Design's edits (25b): a box, then four
 * rectangles each extruded, then a cylinder.
 * - Sketch 2 suppressed: Extrude 2 fails (its sketch doesn't build).
 * - Sketch 3 deleted, Extrude 3 keeping its last shape: builds from it.
 * - Sketch 4 deleted with nothing kept: Extrude 4 fails.
 * - The marker on Extrude 4: the cylinder after it is rolled back.
 */
function handTimeline() {
  let doc: DesignDocument = partDocument("box", 40, 30, 20);
  const box = doc.timeline.features[0].id;
  const sketches: string[] = [];
  const extrudes: string[] = [];
  for (let i = 0; i < 4; i++) {
    const s = addSketch(doc);
    doc = drawRectangle(s.doc, s.id, [0, 0], [10 + i, 5]).doc;
    const e = extrudeSketch(doc, s.id, 10);
    doc = e.doc;
    sketches.push(s.id);
    extrudes.push(e.id);
  }
  const cylinder = insertPreset(doc, "cylinder", 10, 10, 10);
  doc = suppressItem(cylinder.doc, sketches[1], true);
  const third = doc.sketches.find((s) => s.id === sketches[2])!;
  doc = { ...deleteItem(doc, sketches[2]), kept: { [extrudes[2]]: { points: third.points, curves: third.curves } } };
  doc = deleteItem(doc, sketches[3]);
  doc = moveMarker(doc, extrudes[3]);
  return { doc, box, sketches, extrudes, cylinder: cylinder.id };
}
const asText = (doc: DesignDocument) => projectToJson({ ...emptyProject("T"), workspaces: { design: doc } });

test("the build model, by hand, agrees with Design", () => {
  const { doc, box, sketches, extrudes, cylinder } = handTimeline();
  // Built: the box; Sketch 1 and Extrude 1; Extrude 3 from its kept shape.
  // Not built: Sketch 2 (suppressed), so Extrude 2; Extrude 4 (sketch gone, nothing kept); the cylinder (after the marker).
  // The part is the last solid that builds: Extrude 3.
  const want = { building: [box, sketches[0], extrudes[0], extrudes[2]], part: extrudes[2] };
  assert.deepEqual(buildModel(doc), want);
  assert.deepEqual([...DESIGN_RULES.buildingItems(doc)].map((f) => f.id), want.building);
  assert.equal(checkText(asText(doc)), null);
  // The marker taken away: the cylinder builds too and is the part.
  assert.deepEqual(buildModel(moveMarker(doc, null)), { building: [...want.building, cylinder], part: cylinder });
  // The marker at the start: nothing builds.
  assert.deepEqual(buildModel(moveMarker(doc, "start")), { building: [], part: null });
  // Extrude 3's kept shape gone: it fails too, and Extrude 1 is the part.
  const { kept: _, ...noKept } = doc;
  assert.deepEqual(buildModel(noKept), { building: [box, sketches[0], extrudes[0]], part: extrudes[0] });
  // Sketch 2 unsuppressed: Sketch 2 and Extrude 2 build, and Extrude 3 is still the part.
  assert.deepEqual(buildModel(suppressItem(doc, sketches[1], false)), { building: [box, sketches[0], extrudes[0], sketches[1], extrudes[1], extrudes[2]], part: extrudes[2] });
});

/** Design's build rules with one bug planted, each standing in for a bug in document.ts. */
const PLANTED: Record<string, { rules: BuildRules; kind: string }> = {
  "buildingItems ignores kept shapes": {
    rules: { ...DESIGN_RULES, buildingItems: (d) => DESIGN_RULES.buildingItems({ ...d, kept: undefined }) },
    kind: "Design's buildingItems is not the build model's",
  },
  "builds ignores the marker": {
    rules: { ...DESIGN_RULES, builds: (d, f) => DESIGN_RULES.builds({ ...d, timeline: { features: d.timeline.features } }, f) },
    kind: "Design's builds is not the build model's",
  },
  "builds forgets an extrude needs its sketch": {
    // A sketch's own flag still counts for the sketch, but an extrude asks about its sketch as if unsuppressed.
    rules: {
      ...DESIGN_RULES,
      builds: (d, f) => {
        const features = d.timeline.features.map((x) => (isSketchItem(x) ? { ...x, suppressed: false } : x));
        return !f.suppressed && DESIGN_RULES.builds({ ...d, timeline: { ...d.timeline, features } }, features[d.timeline.features.indexOf(f)]);
      },
    },
    kind: "Design's builds is not the build model's",
  },
  "the part is the last solid, built or not": {
    rules: { ...DESIGN_RULES, partFeature: (d) => d.timeline.features.findLast((f) => !isSketchItem(f)) ?? null },
    kind: "Design's part is not the build model's",
  },
};

test("each build check can fail: on the hand-made timeline, and found by the fuzzer", () => {
  const text = asText(handTimeline().doc);
  for (const [name, { rules, kind }] of Object.entries(PLANTED)) {
    // The hand case catches it: the kept shape (Extrude 3), the marker (the cylinder), suppressed Sketch 2 (Extrude 2), the cylinder as the part.
    assert.equal(checkText(text, READERS, rules)?.kind, kind, name);
    // The fuzzer finds it in a short round, and shrinks it to a smaller file that still fails the same way.
    const { failures } = fuzzRound(1n, 400, READERS, rules);
    const found = failures.find((f) => f.kind === kind);
    assert.ok(found, `${name}: the fuzzer did not find it (${failures.map((f) => f.kind).join("; ")})`);
    assert.equal(checkText(found.input, READERS, rules)?.kind, kind, name);
  }
});
