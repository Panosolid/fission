// The naming harness (src/naming-session.ts) on the model as a subject:
// Ben's Fusion answers (25a's 1 to 7, step 26's Q1 to Q4) pass, every planted bug is caught (by a hand-worked
// case and by the random sessions), the comparer sits on MATCH_REL, and
// failures shrink to a minimal list. Step 26 runs the same cases on Design's
// sketch on a face (no cuts), booleans' 44/48 on Design's cut.
//
// When a seed fails: the assertion prints the shrunk session; save it as
// test/regressions/naming/<seed>.json and it replays here forever.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { MATCH_REL } from "../src/timeline-session.ts";
import { NAMING_FAULTS, type NamingFault, type NamingRebuild } from "../src/naming-model.ts";
import {
  FUSION_CASES,
  namingDiff,
  namingFailureOf,
  namingModelSubject,
  NamingFailure,
  randomNamingSession,
  runFusionCase,
  runNamingSession,
  shrinkNaming,
  type NamingCounts,
  type NamingSession,
  type NamingSubject,
} from "../src/naming-session.ts";

const SEEDS = Array.from({ length: 12 }, (_, k) => BigInt(2500 + k));
const STEPS = 150;
/** Where the planted-bug hunt looks: the sessions' seeds first, then on; it stops at the first catch, so a common bug costs no more. */
const HUNT_SEEDS = Array.from({ length: 100 }, (_, k) => BigInt(2500 + k));

async function caseFailure(make: () => NamingSubject, c: (typeof FUSION_CASES)[number]): Promise<NamingFailure | null> {
  try {
    await runFusionCase(make(), c);
    return null;
  } catch (e) {
    if (e instanceof NamingFailure) return e;
    throw e;
  }
}

test("Ben's Fusion answers (1 to 7, and Q1 to Q4 of step 26) hold on the model, with the cut and with a new body", async () => {
  for (const c of FUSION_CASES) {
    const f = await caseFailure(() => namingModelSubject([], c.cuts), c);
    assert.equal(f, null, `answer ${c.answer} (${c.title}): ${f?.message}`);
  }
  // Every answer has a case, and every case a cut or a new-body subject runs.
  assert.deepEqual([...new Set(FUSION_CASES.filter((c) => c.cuts).map((c) => c.answer))].sort(), ["1", "2", "3", "4", "5", "6", "7", "Q3", "Q4"]);
  // Q1 is answer 4 with a new body; Q2 (sides) has no cut until booleans.
  assert.deepEqual([...new Set(FUSION_CASES.filter((c) => !c.cuts).map((c) => c.answer))].sort(), ["1", "2", "5", "7", "Q1", "Q2", "Q3", "Q4"]);
});

/** For each planted bug, the answers whose cases must catch it (none for the guess between two faces, which this part never makes: test/naming-model.test.ts catches it). */
const CAUGHT_BY: Record<NamingFault, string[]> = {
  "frame-follows-face": ["1", "3"],
  "plane-stays-put": ["2", "5"],
  "normal-follows-face": ["2"],
  "bite-fails": ["3"],
  "empty-cut-builds": ["2", "6"],
  "delete-keeps-dependents": ["4"],
  "delete-takes-sketch": ["4", "Q1"],
  "delete-no-ask": ["4", "Q1"],
  "lost-plane-silent": ["4", "Q1"],
  "lost-plane-moves": ["4", "Q1"],
  "ambiguous-picks-first": [],
  "reorder-ignores-plane": ["7"],
  "frame-not-turned": ["Q2"],
  "origin-at-corner": ["Q2"],
  "source-lost-silent": ["Q1", "Q2"],
  "extrude-ignores-side": ["Q2"],
  "side-by-index": ["Q2"],
  "suppress-keeps-dependents": ["Q3"],
  "suppress-greys-all-after": ["Q3"],
  "greyed-loses-hold": ["Q3"],
  "pin-stays-put": ["Q4"],
  "lost-pin-silent": ["Q4"],
  "lost-pin-moves": ["Q4"],
  "pin-wrong-end": ["Q4"],
  "pin-survives-move": ["Q4"],
};

test("each planted bug breaks the Fusion answers it should, and no other bug goes unnoticed by them", async () => {
  assert.deepEqual(Object.keys(CAUGHT_BY).sort(), [...NAMING_FAULTS].sort());
  for (const fault of NAMING_FAULTS) {
    const broken = new Set<string>();
    for (const c of FUSION_CASES) if ((await caseFailure(() => namingModelSubject([fault], c.cuts), c)) !== null) broken.add(c.answer);
    for (const a of CAUGHT_BY[fault]) assert.ok(broken.has(a), `${fault}: answer ${a} still passes (broken: ${[...broken]})`);
    if (CAUGHT_BY[fault].length === 0) assert.equal(broken.size, 0, `${fault} breaks answers ${[...broken]}`);
  }
});

test(`${SEEDS.length} seeds × ${STEPS} random steps pass on the model and reach every case`, async () => {
  const total: NamingCounts = {};
  for (const cuts of [true, false])
    for (const seed of SEEDS) {
      const s = randomNamingSession(seed, STEPS, cuts);
      let counts: NamingCounts;
      try {
        counts = await runNamingSession(namingModelSubject([], cuts), s);
      } catch (e) {
        if (!(e instanceof NamingFailure)) throw e;
        const shrunk = await shrinkNaming(() => namingModelSubject([], cuts), s);
        assert.fail(`seed ${seed}: ${e.message}\nminimal session (save in test/regressions/naming/${seed}.json):\n${JSON.stringify({ seed: String(seed), cuts, ...shrunk })}`);
      }
      for (const [k, v] of Object.entries(counts)) total[k] = (total[k] ?? 0) + v;
    }
  const reached = [
    "sketch:followed",
    "sketch:plane-lost",
    "sketch:side",
    "sketch:turned",
    "sketch:facing-in",
    "solid:source-lost",
    "off:suppressed",
    "off:greyed",
    "op:suppress:done",
    "cut:whole",
    "cut:bite",
    "cut:no-target-height",
    "cut:no-target-outside",
    "cut:kept",
    "solid:kept",
    "extrude:flipped",
    "delete:ask",
    "delete:quiet",
    "plan:ask",
    "plan:quiet",
    "op:reorder:before-dependency",
    "op:reorder:after-dependent",
    "op:reorder:unchanged",
    "op:reorder:done",
    "op:set-corners:done",
    "op:move-corner:done",
    "op:set-distance:done",
    "op:set-circle:done",
    "op:set-depth:done",
    "op:undo:done",
    "op:redo:done",
    "save-open",
    "pin:corner",
    "pin:middle",
    "pin:moved",
    "sketch:point-lost",
  ];
  for (const k of reached) assert.ok((total[k] ?? 0) >= 3, `${k} reached ${total[k] ?? 0} times: ${JSON.stringify(total)}`);
  // Most steps are used, not skipped for lack of a target or a clear cut.
  assert.ok(total.skipped < 0.4 * 2 * SEEDS.length * STEPS, `skipped ${total.skipped}`);
});

test("each planted bug a session can reach is caught by the random sessions, and shrinks to a short list", async () => {
  for (const fault of NAMING_FAULTS) {
    if (fault === "ambiguous-picks-first") continue; // this part never names two faces alike (see above)
    let found: { cuts: boolean; s: NamingSession; f: NamingFailure } | null = null;
    // With the cut first; the side faces' bugs only show without it, where setups go on sides too.
    // A rare one (a face redrawn away while greyed, then back on: 1 session in 18) may take more seeds than the 12 above.
    for (const cuts of [true, false])
      for (const seed of HUNT_SEEDS) {
        if (found) break;
        const s = randomNamingSession(seed, STEPS, cuts);
        const f = await namingFailureOf(() => namingModelSubject([fault], cuts), s);
        if (f) found = { cuts, s, f };
      }
    assert.ok(found, `${fault} was never caught`);
    const make = () => namingModelSubject([fault], found.cuts);
    const shrunk = await shrinkNaming(make, found.s);
    const again = await namingFailureOf(make, shrunk);
    assert.equal(again?.check, found.f.check, `${fault}: the shrunk session fails differently`);
    assert.ok(shrunk.steps.length <= 6, `${fault}: shrunk to ${shrunk.steps.length} steps`);
    // 1-minimal: dropping any one step makes it pass, or fail some other way.
    for (let k = 0; k < shrunk.steps.length; k++) {
      const fewer = { setup: shrunk.setup, steps: shrunk.steps.filter((_, j) => j !== k) };
      assert.notEqual((await namingFailureOf(make, fewer))?.check, found.f.check, `${fault}: step ${k} isn't needed`);
    }
  }
});

test("the comparer matches the kernel's promised accuracy: 0.9 × MATCH_REL passes, 1.1 × fails", () => {
  const base: NamingRebuild = {
    order: ["sketch-1", "extrude-2", "sketch-3", "cut-4"],
    results: {
      "sketch-1": { kind: "sketch", placement: { origin: [0, 0, 0], x: [1, 0, 0], normal: [0, 0, 1], side: 1 } },
      "extrude-2": { kind: "solid", volume: 24000, centroid: [20, 15, 10] },
      "sketch-3": { kind: "sketch", placement: { origin: [0, 0, 20], x: [1, 0, 0], normal: [0, 0, 1], side: 1 } },
      "cut-4": { kind: "cut", status: "built", removed: 250 * Math.PI },
    },
    bodies: { "extrude-2": 24000 - 250 * Math.PI },
  };
  const scaled = (f: number): NamingRebuild => {
    const r: NamingRebuild = JSON.parse(JSON.stringify(base));
    r.bodies["extrude-2"] *= 1 + f * MATCH_REL;
    return r;
  };
  assert.equal(namingDiff(base, scaled(0.9)), null);
  assert.match(namingDiff(base, scaled(1.1)) ?? "", /body extrude-2/);
  // A height off by 1.1 × MATCH_REL of the 1 mm floor fails too, and the same for a removed volume.
  const z = JSON.parse(JSON.stringify(base)) as NamingRebuild;
  (z.results["sketch-3"] as { placement: { origin: number[] } }).placement.origin[2] = 20 + 1.1 * MATCH_REL * 20;
  assert.match(namingDiff(base, z) ?? "", /sketch-3: origin/);
  const cut = JSON.parse(JSON.stringify(base)) as NamingRebuild;
  (cut.results["cut-4"] as { removed: number }).removed *= 1 + 1.1 * MATCH_REL;
  assert.match(namingDiff(base, cut) ?? "", /cut-4: removed/);
  // A frame's axis or a centroid off by 1.1 × MATCH_REL (of the 1 mm floor) fails; 0.9 × passes.
  const tilt = (f: number) => {
    const r = JSON.parse(JSON.stringify(base)) as NamingRebuild;
    (r.results["sketch-3"] as { placement: { x: number[] } }).placement.x[1] = f * MATCH_REL;
    return r;
  };
  assert.equal(namingDiff(base, tilt(0.9)), null);
  assert.match(namingDiff(base, tilt(1.1)) ?? "", /sketch-3: x axis/);
  const moved = (f: number) => {
    const r = JSON.parse(JSON.stringify(base)) as NamingRebuild;
    (r.results["extrude-2"] as { centroid: number[] }).centroid[0] = 20 * (1 + f * MATCH_REL);
    return r;
  };
  assert.equal(namingDiff(base, moved(0.9)), null);
  assert.match(namingDiff(base, moved(1.1)) ?? "", /extrude-2: centroid/);
});

test("a subject that answers differently when read twice, or loses its sketch's warning on save and open, is caught", async () => {
  const flaky = (): NamingSubject => {
    const inner = namingModelSubject();
    let n = 0;
    return { ...inner, read: async () => ({ ...(await inner.read()), order: n++ % 2 ? [] : (await inner.read()).order }) };
  };
  const s = randomNamingSession(2500n, 10);
  assert.equal((await namingFailureOf(flaky, s))?.check, "read twice");
  const forgetful = (): NamingSubject => {
    const inner = namingModelSubject();
    let saved = false;
    return {
      ...inner,
      saveOpen: () => {
        saved = true;
      },
      read: async () => {
        const r = await inner.read();
        if (saved) for (const res of Object.values(r.results)) delete (res as { warning?: unknown }).warning;
        return r;
      },
    };
  };
  const c = FUSION_CASES.find((x) => x.answer === "4" && x.cuts)!;
  const f = await caseFailure(forgetful, { ...c, steps: [...c.steps, { kind: "save-open" }] });
  assert.equal(f?.check, "save and open");
});

const REGRESSIONS = new URL("./regressions/naming/", import.meta.url);
test("saved naming regressions replay", { skip: !existsSync(REGRESSIONS) && "none saved yet" }, async () => {
  for (const file of readdirSync(REGRESSIONS).filter((f) => f.endsWith(".json"))) {
    const saved = JSON.parse(readFileSync(new URL(file, REGRESSIONS), "utf8"));
    await runNamingSession(namingModelSubject([], saved.cuts ?? true), { setup: saved.setup, steps: saved.steps });
  }
});
