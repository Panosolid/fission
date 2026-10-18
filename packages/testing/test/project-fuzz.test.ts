// The project loader fuzzer (src/project-fuzz.ts): a quick seeded run as
// part of every `npm test`, the saved failing inputs replayed forever, the
// model checked by hand, and proof that each check can fail.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { emptyProject, projectToJson, type DataReader } from "@fission/core";
import { designWorkspace, partDocument } from "@fission/design";
import { checkText, fuzzRound, outerModel, READERS, shrink } from "../src/project-fuzz.ts";

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
  assert.equal(outerModel({ ...p, formatVersion: 3 }).refusal, "saved by a newer Panoshape");
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
