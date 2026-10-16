// The one undo/redo history (step 20a), on a tiny stand-in project: a box
// width held in `doc`, captured as JSON. Every expected value is worked out
// by hand in the comment beside it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHistory, MERGE_MS, UNDO_LIMIT, type HistoryOptions } from "../src/model/history.ts";

/** A history over one number, a fake clock and a log of restores and change calls. */
function rig(extra: Partial<HistoryOptions> = {}) {
  const doc = { w: 40 };
  let t = 0;
  const restores: number[] = [];
  const h = createHistory({
    capture: () => JSON.stringify(doc),
    restore: (s) => {
      doc.w = JSON.parse(s).w;
      restores.push(doc.w);
    },
    now: () => t,
    ...extra,
  });
  let changes = 0;
  h.onChange(() => changes++);
  /** The user sets the width and the workspace records it. */
  const edit = (w: number, label = `Width ${w}`, key?: string) => {
    doc.w = w;
    return h.record(label, key);
  };
  return { h, doc, edit, restores, tick: (ms: number) => (t += ms), changes: () => changes };
}

test("a new history has nothing to undo or redo", () => {
  const { h } = rig();
  assert.equal(h.canUndo(), false);
  assert.equal(h.canRedo(), false);
  assert.equal(h.undoLabel(), null);
  assert.equal(h.redoLabel(), null);
  assert.equal(h.undo(), null);
  assert.equal(h.redo(), null);
});

test("hand-worked: three edits, undo twice, redo once, then a new edit drops the redo", () => {
  const { h, doc, edit, restores } = rig();
  // States: 40 (start) → 50 → 60 → 70.
  edit(50);
  edit(60);
  edit(70);
  assert.equal(h.undoLabel(), "Width 70");
  // Undo takes back "Width 70": back to 60. Undo again takes back "Width 60": back to 50.
  assert.equal(h.undo(), "Width 70");
  assert.equal(doc.w, 60);
  assert.equal(h.undo(), "Width 60");
  assert.equal(doc.w, 50);
  // Now Undo would take back "Width 50" (to 40) and Redo would redo "Width 60".
  assert.equal(h.undoLabel(), "Width 50");
  assert.equal(h.redoLabel(), "Width 60");
  assert.equal(h.redo(), "Width 60");
  assert.equal(doc.w, 60);
  // 70 can still be redone, until a new edit (65) replaces it.
  assert.equal(h.redoLabel(), "Width 70");
  edit(65);
  assert.equal(h.canRedo(), false);
  // Undo from 65 goes to 60, then 50, then 40, then nothing: four states, three undos.
  assert.equal(h.undo(), "Width 65");
  assert.equal(h.undo(), "Width 60");
  assert.equal(h.undo(), "Width 50");
  assert.equal(h.undo(), null);
  assert.equal(doc.w, 40);
  assert.deepEqual(restores, [60, 50, 60, 60, 50, 40]);
});

test("recording the same project as the present records nothing", () => {
  const { h, edit, changes } = rig();
  assert.equal(edit(40), false); // 40 is the start: no step
  assert.equal(h.canUndo(), false);
  assert.equal(changes(), 0);
  assert.equal(edit(50), true);
  assert.equal(edit(50), false);
  assert.equal(changes(), 1);
});

test("a change reported while a snapshot is being put back is not recorded", () => {
  // The shell's restore remounts Design, which reports the project changed:
  // that report must not become a new step (it would wipe the redo).
  let h!: ReturnType<typeof createHistory>;
  const doc = { w: 40 };
  const results: boolean[] = [];
  h = createHistory({
    capture: () => JSON.stringify(doc),
    restore: (s) => {
      doc.w = JSON.parse(s).w;
      results.push(h.record("remount"));
    },
  });
  doc.w = 50;
  h.record("Width 50");
  h.undo();
  assert.deepEqual(results, [false]);
  assert.equal(h.canRedo(), true);
  assert.equal(h.redoLabel(), "Width 50");
});

test("a restore that throws leaves the history where it was", () => {
  let fail = false;
  const doc = { w: 40 };
  const h = createHistory({
    capture: () => JSON.stringify(doc),
    restore: (s) => {
      if (fail) throw new Error("the kernel is busy");
      doc.w = JSON.parse(s).w;
    },
  });
  doc.w = 50;
  h.record("Width 50");
  fail = true;
  assert.throws(() => h.undo(), /the kernel is busy/);
  assert.equal(doc.w, 50);
  assert.equal(h.undoLabel(), "Width 50");
  assert.equal(h.canRedo(), false);
  // And the guard against recording during a restore is lifted again.
  doc.w = 60;
  assert.equal(h.record("Width 60"), true);
});

test("edits with one merge key are one step within the merge time: 0.9× merges, 1.1× does not", () => {
  // Typing "4" then "0" in the width box: two records 0.9 × 1000 = 900 ms apart, one step.
  const a = rig();
  a.edit(4, "Width", "width");
  a.tick(0.9 * MERGE_MS);
  a.edit(40.5, "Width", "width");
  a.h.undo();
  assert.equal(a.doc.w, 40); // one undo goes all the way back to the start
  assert.equal(a.h.canUndo(), false);
  // 1.1 × 1000 = 1100 ms apart: two steps, so one undo goes back to 4.
  const b = rig();
  b.edit(4, "Width", "width");
  b.tick(1.1 * MERGE_MS);
  b.edit(40.5, "Width", "width");
  b.h.undo();
  assert.equal(b.doc.w, 4);
  assert.equal(b.h.canUndo(), true);
});

test("the merge time runs from the last edit, so steady typing stays one step", () => {
  // Five keys 900 ms apart: 3.6 s in all, but never 1 s between two of them.
  const { h, doc, edit, tick } = rig();
  for (const w of [1, 12, 123, 12, 120]) {
    edit(w, "Width", "width");
    tick(900);
  }
  h.undo();
  assert.equal(doc.w, 40);
});

test("different merge keys, no key, or an undo in between keep steps apart", () => {
  const a = rig();
  a.edit(50, "Width", "width");
  a.edit(20, "Height", "height");
  a.h.undo();
  assert.equal(a.doc.w, 50); // height and width are separate steps
  const b = rig();
  b.edit(50, "Width");
  b.edit(60, "Width");
  b.h.undo();
  assert.equal(b.doc.w, 50); // no key: never merged
  const c = rig();
  c.edit(50, "Width", "width");
  c.edit(60, "Width", "width"); // merged: 40 → 60 is one step
  c.h.undo(); // back to 40
  c.h.redo(); // forward to 60
  c.edit(70, "Width", "width"); // after a redo: a new step, not merged into 40 → 60
  c.h.undo();
  assert.equal(c.doc.w, 60);
});

test("typing back to where a merged step started removes the step", () => {
  // 40 → 4 → 40 in one box: nothing changed, so nothing to undo.
  const { h, edit } = rig();
  edit(50, "Height", "height");
  edit(4, "Width", "width");
  edit(50, "Width", "width");
  assert.equal(h.undoLabel(), "Height");
  // ...and the next width key starts a new step rather than reviving the old one.
  edit(55, "Width", "width");
  h.undo();
  assert.equal(h.undoLabel(), "Height");
});

test("the undo limit keeps the newest steps: limit steps undo, the one before is gone", () => {
  // Limit 3: edits 41, 42, 43, 44 from 40. The oldest step (40 → 41) is dropped,
  // so undo stops at 41 after three undos.
  const { h, doc, edit } = rig({ limit: 3 });
  for (const w of [41, 42, 43]) edit(w);
  assert.equal([h.undo(), h.undo(), h.undo(), h.undo()].filter(Boolean).length, 3);
  assert.equal(doc.w, 40); // exactly at the limit nothing is lost
  for (let i = 0; i < 3; i++) h.redo();
  edit(44);
  for (let i = 0; i < 5; i++) h.undo();
  assert.equal(doc.w, 41);
  assert.equal(UNDO_LIMIT, 100);
});

test("reset forgets every step and starts from the project as it is", () => {
  const { h, doc, edit, changes } = rig();
  edit(50);
  h.undo();
  doc.w = 70; // an opened file
  h.reset();
  assert.equal(h.canUndo(), false);
  assert.equal(h.canRedo(), false);
  assert.equal(changes(), 3);
  assert.equal(edit(70), false); // 70 is the new start
});

test("hand-worked: amend takes a change nobody made into the present, not a new step", () => {
  // 40 → Width 50, then a workspace fills in a default (the box becomes 55
  // with no edit). Undo takes back Width 50 to 40, redo brings 55, the
  // amended present, not the 50 recorded before it.
  const { h, doc, edit, restores, changes } = rig();
  edit(50);
  doc.w = 55;
  assert.equal(h.amend(), true);
  assert.equal(changes(), 2); // the record and the amend
  assert.equal(h.undoLabel(), "Width 50");
  assert.equal(h.undo(), "Width 50");
  assert.equal(h.redo(), "Width 50");
  assert.deepEqual(restores, [40, 55]);
  // Nothing new to take in: false, and no change call.
  assert.equal(h.amend(), false);
  assert.equal(changes(), 4);
});

test("amend keeps the redo, and a present step amended back to the state before it is removed", () => {
  const { h, doc, edit, restores } = rig();
  edit(50);
  edit(60);
  h.undo(); // at Width 50, Width 60 to redo
  doc.w = 51;
  h.amend();
  assert.equal(h.redoLabel(), "Width 60");
  // 51 → 40 is the start's state: Width 50 has nothing left to undo.
  doc.w = 40;
  assert.equal(h.amend(), true);
  assert.equal(h.canUndo(), false);
  assert.equal(h.redoLabel(), "Width 60");
  assert.equal(h.redo(), "Width 60");
  assert.deepEqual(restores, [50, 60]);
});

test("amend ends a merge: the next edit with the same key is a step of its own", () => {
  // Typing 41 then 42 in one box within the merge time is one step; a
  // default filled in between them splits it, so undo goes 42 → 41 → 40.
  const { h, doc, edit, restores, tick } = rig();
  edit(41, "Change width", "width");
  (doc as { w: number; d?: number }).d = 30;
  h.amend();
  tick(MERGE_MS * 0.1);
  edit(42, "Change width", "width");
  h.undo();
  h.undo();
  assert.deepEqual(restores, [41, 40]);
});

test("amend during a restore does nothing", () => {
  let h!: ReturnType<typeof createHistory>;
  const doc = { w: 40 };
  const results: boolean[] = [];
  h = createHistory({
    capture: () => JSON.stringify(doc),
    restore: (s) => {
      doc.w = JSON.parse(s).w + 1; // the remount changed it again
      results.push(h.amend());
    },
  });
  doc.w = 50;
  h.record("Width 50");
  h.undo();
  assert.deepEqual(results, [false]);
  assert.equal(h.redoLabel(), "Width 50");
});

test("onChange is called once per change and can be unsubscribed", () => {
  const { h, edit, changes } = rig();
  edit(50);
  h.undo();
  h.undo(); // nothing to undo: no call
  h.redo();
  h.redo(); // nothing to redo: no call
  assert.equal(changes(), 3);
  let mine = 0;
  const off = h.onChange(() => mine++);
  edit(60);
  off();
  edit(70);
  assert.equal(mine, 1);
});

test("a nonsense limit or merge time is refused", () => {
  const capture = () => "";
  const restore = () => {};
  assert.throws(() => createHistory({ capture, restore, limit: 0 }), /undo limit/);
  assert.throws(() => createHistory({ capture, restore, limit: 2.5 }), /undo limit/);
  assert.throws(() => createHistory({ capture, restore, mergeMs: NaN }), /merge time/);
  assert.throws(() => createHistory({ capture, restore, mergeMs: -1 }), /merge time/);
});
