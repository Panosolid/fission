// Random edit/undo/redo sessions on the one history (step 20a), on a real
// project: Design's real part document, captured with projectToJson and put
// back with projectFromJson and Design's own reader, as the shell does. Each
// step is checked against a simple model of the rules kept as two stacks
// (what undo would put back, what redo would), written independently of the
// history's one-list-and-a-pointer code. Seeded: the same seed gives the
// same session.
//
// The part has a sketch (step 21b): its edits (draw a line, delete one,
// move a point) are steps of their own. The model keeps the sketch as its
// lines' end coordinates only, no point ids: every point is at its own
// place (new points never land on a used one), so a coordinate names a
// point, and moving one moves every line end there.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHistory, emptyProject, projectFromJson, projectToJson, type Project } from "@fission/core";
import { addSketch, deleteCurve, designWorkspace, drawLine, movePoint, partDocument, partOf, SKETCH_STEPS, withPart, type DesignDocument } from "@fission/design";
import { seeded, type SeededRandom } from "../src/index.ts";

const SEEDS = [0x5eedn, 1n, 2n, 3n, 0xdeadbeefn];
const LIMIT = 8; // small, so the oldest steps are dropped often
const MERGE = 1000;
const KEYS = ["width", "depth", undefined] as const;

const pick = <T>(r: SeededRandom, xs: readonly T[]): T => xs[Math.floor(r.next() * xs.length)];
/** A fresh project: a w × 30 × 20 box and an empty Sketch 1. */
const projectWith = (w: number): Project => ({ ...emptyProject(), workspaces: { design: addSketch(partDocument("box", w, 30, 20)).doc } });
const designOf = (p: Project) => p.workspaces.design as DesignDocument;
/** The same project with the box's width changed, its sketch kept. */
const withWidth = (p: Project, w: number): Project => ({ ...p, workspaces: { design: withPart(designOf(p), "box", w, 30, 20) } });

/** The model's state: the width, and each line as [id, x1, y1, x2, y2] in drawing order. As text, so states compare with ===. */
type Line = [string, number, number, number, number];
const state = (width: number, lines: readonly Line[]) => JSON.stringify({ width, lines });
const parse = (s: string): { width: number; lines: Line[] } => JSON.parse(s);

/** The project's state, read the same way: what the model must match. */
function stateOf(p: Project): string {
  const doc = designOf(p);
  const sketch = doc.sketches[0];
  const at = new Map(sketch.points.map((q) => [q.id, [q.x, q.y]]));
  const lines = sketch.curves.map((c): Line => [c.id, ...at.get(c.start)!, ...at.get(c.end)!] as Line);
  // No point is left that no line uses, and no two points share a place.
  const ends = new Set(sketch.curves.flatMap((c) => [c.start, c.end]));
  assert.deepEqual(new Set(sketch.points.map((q) => q.id)), ends, "a point no line uses");
  assert.equal(new Set(sketch.points.map((q) => `${q.x},${q.y}`)).size, sketch.points.length, "two points at one place");
  return state(partOf(doc).sizes.width!, lines);
}

interface Undo {
  before: string;
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
      // The remounted workspace reports a change: never a step. It can tell it is a restore.
      assert.equal(h.restoring(), true);
      assert.equal(h.record("remount", "width"), false);
    },
    limit: LIMIT,
    mergeMs: MERGE,
    now: () => t,
  });

  // The model.
  let present = state(40, []);
  let undos: Undo[] = [];
  let redos: { after: string; label: string }[] = [];
  let lastWasRecord = false;
  const width = () => parse(present).width;
  /** A place no point of the sketch is at, on a 0.1 mm grid. */
  const freePlace = (): [number, number] => {
    const used = new Set(parse(present).lines.flatMap(([, x1, y1, x2, y2]) => [`${x1},${y1}`, `${x2},${y2}`]));
    for (;;) {
      const xy: [number, number] = [Math.floor(r.next() * 1001 - 500) / 10, Math.floor(r.next() * 1001 - 500) / 10];
      if (!used.has(`${xy[0]},${xy[1]}`)) return xy;
    }
  };
  const counts = { draws: 0, chained: 0, deletes: 0, moves: 0, edits: 0, merged: 0, foldedAway: 0, same: 0, dropped: 0, undos: 0, redos: 0, empty: 0, failed: 0, nasty: 0, resets: 0, walks: 0, amends: 0, amendedAway: 0, steps: 0, stepsFailed: 0, stepsEmpty: 0 };

  for (let i = 0; i < steps; i++) {
    const at = `seed ${seed} step ${i}`;
    t += Math.floor(r.next() * 2 * MERGE);
    const n = r.next();
    if (n < 0.06) {
      // One labelled step with several changes inside (an ownership
      // hand-over, an accepted AI command, step 20c): 1–3 recorded edits,
      // sometimes back to where it started, sometimes failing part way.
      const label = pick(r, ["Hand Width to Laser", "AI: resize"]);
      const inner = 1 + Math.floor(r.next() * 3);
      const widths = Array.from({ length: inner }, () => 1 + Math.floor(r.next() * 20));
      if (r.next() < 0.2) widths.push(width()); // ends where it began
      const fails = r.next() < 0.2;
      const run = () => {
        for (const [j, w] of widths.entries()) {
          project = withWidth(project, w);
          assert.equal(h.record(`inner ${j}`, pick(r, KEYS)), false, `${at}: folded into the step`);
          if (fails && j === widths.length - 1) throw new Error("command refused");
        }
      };
      if (fails) {
        assert.throws(() => h.step(label, run), /command refused/, at);
        counts.stepsFailed++; // put back, nothing recorded, the model is unchanged
      } else {
        h.step(label, run);
        const after = state(widths[widths.length - 1], parse(present).lines);
        if (after === present) counts.stepsEmpty++; // nothing recorded, the redo kept
        else {
          redos = [];
          undos.push({ before: present, label, key: undefined, at: t });
          if (undos.length > LIMIT) {
            undos.shift();
            counts.dropped++;
          }
          present = after;
          lastWasRecord = false; // a step never merges with what follows
          counts.steps++;
        }
      }
    } else if (n < 0.18) {
      // A sketch edit, one undo step each, never merged: draw a line (from a
      // new place or chained from a point), delete one, or move a point.
      const doc = designOf(project);
      const sketch = doc.sketches[0];
      const { lines } = parse(present);
      const kind = lines.length === 0 ? "draw" : pick(r, ["draw", "draw", "delete", "move"] as const);
      let after: Line[];
      if (kind === "draw") {
        const chain = sketch.points.length > 0 && r.next() < 0.5;
        const start = chain ? pick(r, sketch.points) : null;
        const from = start ? start.id : freePlace();
        const fromXY = start ? [start.x, start.y] : (from as [number, number]);
        const others = sketch.points.filter((q) => q !== start);
        const end = others.length > 0 && r.next() < 0.2 ? pick(r, others) : null;
        const to = end ? end.id : freePlace();
        const toXY = end ? [end.x, end.y] : (to as [number, number]);
        const drawn = drawLine(doc, sketch.id, from, to);
        // A new id: not in the sketch now, nor in any state undo can go back to.
        for (const s of [present, ...undos.map((u) => u.before)])
          assert.ok(!parse(s).lines.some(([id]) => id === drawn.id), `${at}: ${drawn.id} was used before`);
        project = { ...project, workspaces: { design: drawn.doc } };
        after = [...lines, [drawn.id, fromXY[0], fromXY[1], toXY[0], toXY[1]]];
        counts.draws++;
        if (chain) counts.chained++;
      } else if (kind === "delete") {
        const [gone] = pick(r, lines);
        project = { ...project, workspaces: { design: deleteCurve(doc, sketch.id, gone) } };
        after = lines.filter(([id]) => id !== gone);
        counts.deletes++;
      } else {
        const p = pick(r, sketch.points);
        const [x, y] = freePlace();
        project = { ...project, workspaces: { design: movePoint(doc, sketch.id, p.id, x, y) } };
        const move = (a: number, b: number) => (a === p.x && b === p.y ? [x, y] : [a, b]);
        after = lines.map(([id, x1, y1, x2, y2]) => [id, ...move(x1, y1), ...move(x2, y2)] as Line);
        counts.moves++;
      }
      assert.equal(h.record(SKETCH_STEPS[kind]), true, at);
      redos = [];
      undos.push({ before: present, label: SKETCH_STEPS[kind], key: undefined, at: t });
      if (undos.length > LIMIT) {
        undos.shift();
        counts.dropped++;
      }
      present = state(width(), after);
      lastWasRecord = true;
    } else if (n < 0.58) {
      // An edit: mostly a new width, sometimes the same, sometimes back to the one before.
      const key = pick(r, KEYS);
      const label = key ? `Change ${key}` : "Change shape";
      const w = r.next() < 0.1 ? width() : r.next() < 0.3 && undos.length ? parse(undos[undos.length - 1].before).width : 1 + Math.floor(r.next() * 20);
      project = withWidth(project, w);
      const recorded = h.record(label, key);
      const next = state(w, parse(present).lines);
      if (next === present) {
        assert.equal(recorded, false, at);
        counts.same++;
      } else {
        assert.equal(recorded, true, at);
        redos = [];
        const top = undos[undos.length - 1];
        if (lastWasRecord && top && key !== undefined && top.key === key && t - top.at < MERGE) {
          if (next === top.before) {
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
        present = next;
      }
    } else if (n < 0.62) {
      // A change nobody made (a workspace filling in a default when first
      // shown): taken into the present, not a step; back to the state before
      // the present step, that step goes. The redo stays.
      const w = r.next() < 0.1 ? width() : r.next() < 0.3 && undos.length ? parse(undos[undos.length - 1].before).width : 1 + Math.floor(r.next() * 20);
      project = withWidth(project, w);
      const next = state(w, parse(present).lines);
      assert.equal(h.amend(), next !== present, at);
      if (next !== present) {
        if (undos.length && undos[undos.length - 1].before === next) {
          undos.pop();
          counts.amendedAway++;
        } else counts.amends++;
        present = next;
        lastWasRecord = false;
      }
    } else if (n < 0.65) {
      // A width a file can't hold: refused while capturing, nothing moves.
      const keep = project;
      project = withWidth(project, NaN);
      assert.throws(() => h.record("Change width", "width"), /can't save/, at);
      project = keep;
      counts.nasty++;
    } else if (n < 0.81) {
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
      const w = 1 + Math.floor(r.next() * 20);
      present = state(w, []);
      project = projectWith(w);
      h.reset();
      undos = [];
      redos = [];
      lastWasRecord = false;
      counts.resets++;
    }
    // After every step: the project is the model's, and so is what undo and redo would do.
    assert.equal(stateOf(project), present, at);
    assert.equal(h.canUndo(), undos.length > 0, at);
    assert.equal(h.canRedo(), redos.length > 0, at);
    assert.equal(h.undoLabel(), undos.length ? undos[undos.length - 1].label : null, at);
    assert.equal(h.redoLabel(), redos.length ? redos[redos.length - 1].label : null, at);
  }
  return counts;
}

test("random edit/undo/redo sessions on a real project match the model at every step", () => {
  for (const seed of SEEDS) {
    const c = session(seed, 3_000);
    // Every path must be reached, or the test proves nothing.
    for (const [k, n] of Object.entries(c)) assert.ok(n > 5, `seed ${seed}: only ${n} ${k}`);
  }
});

test("the same seed gives the same session", () => {
  assert.deepEqual(session(7n, 500), session(7n, 500));
});
