// Random edit/undo/redo sessions on the one history (step 20a), on a real
// project: Design's real part document, captured with projectToJson and put
// back with projectFromJson and Design's own reader, as the shell does. Each
// step is checked against a simple model of the rules kept as two stacks
// (what undo would put back, what redo would), written independently of the
// history's one-list-and-a-pointer code. Seeded: the same seed gives the
// same session.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHistory, emptyProject, projectFromJson, projectToJson, type Project } from "@fission/core";
import { designWorkspace, partDocument, partOf, type DesignDocument } from "@fission/design";
import { seeded, type SeededRandom } from "../src/index.ts";

const SEEDS = [0x5eedn, 1n, 2n, 3n, 0xdeadbeefn];
const LIMIT = 8; // small, so the oldest steps are dropped often
const MERGE = 1000;
const KEYS = ["width", "depth", undefined] as const;

const pick = <T>(r: SeededRandom, xs: readonly T[]): T => xs[Math.floor(r.next() * xs.length)];
const projectWith = (w: number): Project => ({ ...emptyProject(), workspaces: { design: partDocument("box", w, 30, 20) } });
const widthOf = (p: Project) => partOf(p.workspaces.design as DesignDocument).sizes.width;

interface Undo {
  before: number;
  label: string;
  key: string | undefined;
  at: number;
}

function session(seed: bigint, steps: number) {
  const r = seeded(seed);
  let project = projectWith(40);
  let t = 0;
  let failRestore = false;
  const h = createHistory({
    capture: () => projectToJson(project),
    restore: (text) => {
      if (failRestore) throw new Error("restore failed");
      project = projectFromJson(text, [designWorkspace]);
      // The remounted workspace reports a change: never a step.
      assert.equal(h.record("remount", "width"), false);
    },
    limit: LIMIT,
    mergeMs: MERGE,
    now: () => t,
  });

  // The model.
  let present = 40;
  let undos: Undo[] = [];
  let redos: { after: number; label: string }[] = [];
  let lastWasRecord = false;
  const counts = { edits: 0, merged: 0, foldedAway: 0, same: 0, dropped: 0, undos: 0, redos: 0, empty: 0, failed: 0, nasty: 0, resets: 0, walks: 0, amends: 0, amendedAway: 0 };

  for (let i = 0; i < steps; i++) {
    const at = `seed ${seed} step ${i}`;
    t += Math.floor(r.next() * 2 * MERGE);
    const n = r.next();
    if (n < 0.46) {
      // An edit: mostly a new width, sometimes the same, sometimes back to the one before.
      const key = pick(r, KEYS);
      const label = key ? `Change ${key}` : "Change shape";
      const w = r.next() < 0.1 ? present : r.next() < 0.3 && undos.length ? undos[undos.length - 1].before : 1 + Math.floor(r.next() * 20);
      project = projectWith(w);
      const recorded = h.record(label, key);
      if (w === present) {
        assert.equal(recorded, false, at);
        counts.same++;
      } else {
        assert.equal(recorded, true, at);
        redos = [];
        const top = undos[undos.length - 1];
        if (lastWasRecord && top && key !== undefined && top.key === key && t - top.at < MERGE) {
          if (w === top.before) {
            undos.pop();
            lastWasRecord = false;
            counts.foldedAway++;
          } else {
            Object.assign(top, { label, at: t });
            counts.merged++;
          }
        } else {
          undos.push({ before: present, label, key, at: t });
          if (undos.length > LIMIT) {
            undos.shift();
            counts.dropped++;
          }
          lastWasRecord = true;
          counts.edits++;
        }
        present = w;
      }
    } else if (n < 0.5) {
      // A change nobody made (a workspace filling in a default when first
      // shown): taken into the present, not a step; back to the state before
      // the present step, that step goes. The redo stays.
      const w = r.next() < 0.1 ? present : r.next() < 0.3 && undos.length ? undos[undos.length - 1].before : 1 + Math.floor(r.next() * 20);
      project = projectWith(w);
      assert.equal(h.amend(), w !== present, at);
      if (w !== present) {
        if (undos.length && undos[undos.length - 1].before === w) {
          undos.pop();
          counts.amendedAway++;
        } else counts.amends++;
        present = w;
        lastWasRecord = false;
      }
    } else if (n < 0.53) {
      // A width a file can't hold: refused while capturing, nothing moves.
      const keep = project;
      project = projectWith(NaN);
      assert.throws(() => h.record("Change width", "width"), /can't save/, at);
      project = keep;
      counts.nasty++;
    } else if (n < 0.75) {
      failRestore = r.next() < 0.1;
      const expected = undos.length ? undos[undos.length - 1] : null;
      if (failRestore && expected) {
        assert.throws(() => h.undo(), /restore failed/, at);
        counts.failed++;
      } else {
        assert.equal(h.undo(), expected?.label ?? null, at);
        if (expected) {
          undos.pop();
          redos.push({ after: present, label: expected.label });
          present = expected.before;
          lastWasRecord = false;
          counts.undos++;
        } else counts.empty++;
      }
      failRestore = false;
    } else if (n < 0.97) {
      const expected = redos.length ? redos[redos.length - 1] : null;
      assert.equal(h.redo(), expected?.label ?? null, at);
      if (expected) {
        redos.pop();
        undos.push({ before: present, label: expected.label, key: undefined, at: t });
        present = expected.after;
        lastWasRecord = false;
        counts.redos++;
      } else counts.empty++;
    } else if (n < 0.985) {
      // Undo all the way back and redo all the way forward: exactly as many steps as the model holds.
      let back = 0;
      while (h.undo() !== null) back++;
      assert.equal(back, undos.length, `${at}: undo depth`);
      let fwd = 0;
      while (h.redo() !== null) fwd++;
      assert.equal(fwd, undos.length + redos.length, `${at}: redo depth`);
      // Now everything is undoable and nothing redoable; the newest step is the last redone.
      for (let d = redos.pop(); d; d = redos.pop()) {
        undos.push({ before: present, label: d.label, key: undefined, at: t });
        present = d.after;
      }
      lastWasRecord = false;
      counts.walks++;
    } else {
      // A file opened: a fresh start.
      present = 1 + Math.floor(r.next() * 20);
      project = projectWith(present);
      h.reset();
      undos = [];
      redos = [];
      lastWasRecord = false;
      counts.resets++;
    }
    // After every step: the project is the model's, and so is what undo and redo would do.
    assert.equal(widthOf(project), present, at);
    assert.equal(h.canUndo(), undos.length > 0, at);
    assert.equal(h.canRedo(), redos.length > 0, at);
    assert.equal(h.undoLabel(), undos.length ? undos[undos.length - 1].label : null, at);
    assert.equal(h.redoLabel(), redos.length ? redos[redos.length - 1].label : null, at);
  }
  return counts;
}

test("random edit/undo/redo sessions on a real project match the model at every step", () => {
  for (const seed of SEEDS) {
    const c = session(seed, 2_000);
    // Every path must be reached, or the test proves nothing.
    for (const [k, n] of Object.entries(c)) assert.ok(n > 5, `seed ${seed}: only ${n} ${k}`);
  }
});

test("the same seed gives the same session", () => {
  assert.deepEqual(session(7n, 500), session(7n, 500));
});
