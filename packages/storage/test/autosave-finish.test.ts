// `finish()` (timeline hunt follow-up): opening a file, dropping one or
// starting a new project within autosave's quiet moment after an edit
// dropped that edit, because the app stopped the old project's autosave
// with `stop()`, which drops a waiting save. The app now finishes it: the
// project as it is at that moment goes to the journal at once and to the
// store after any save in flight, and nothing after it (the project that
// replaces it) is ever stored under its id. The browser check is
// leave-save.mjs's "Open within the quiet moment".

import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyProject, projectToJson, type Project } from "@fission/core";
import { startAutosave, unsavedKey, type AutosaveStatus, type JournalStorage, type ProjectStore, type Timers } from "../src/index.ts";

const part = (width: number): Project => ({ ...emptyProject("Box"), workspaces: { design: { version: 1, width } } });
const widthOf = (p: Project) => (p.workspaces.design as { width: number }).width;
const settle = () => new Promise<void>((r) => setImmediate(r));

/** Timers that run only when the test moves the clock. */
function fakeTimers() {
  let now = 0;
  let next = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const timers: Timers = {
    setTimeout: (fn, ms) => (pending.set(++next, { at: now + ms, fn }), next),
    clearTimeout: (h) => void pending.delete(h as number),
  };
  async function advance(ms: number) {
    const end = now + ms;
    for (;;) {
      const due = [...pending.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      pending.delete(due[0]);
      now = due[1].at;
      due[1].fn();
      await settle();
    }
    now = end;
    await settle();
  }
  return { timers, advance, pending: () => pending.size };
}

/** A store whose saves wait until the test lets each one finish, recording each width asked for. */
function heldStore() {
  const asked: number[] = [];
  const stored: number[] = [];
  const waiting: (() => void)[] = [];
  const store: ProjectStore = {
    list: async () => [],
    open: async () => emptyProject(),
    remove: async () => {},
    save: (_id, p) =>
      new Promise<void>((resolve) => {
        asked.push(widthOf(p));
        waiting.push(() => (stored.push(widthOf(p)), resolve()));
      }),
  };
  return { store, asked, stored, waiting, finishOne: async () => (waiting.shift()!(), settle()) };
}

/** A journal in memory; `full` makes every write throw, as a full localStorage does. */
function memoryJournal() {
  const items = new Map<string, string>();
  let full = false;
  const journal: JournalStorage = {
    get length() {
      return items.size;
    },
    key: (i) => [...items.keys()][i] ?? null,
    getItem: (k) => items.get(k) ?? null,
    setItem: (k, v) => {
      if (full) throw new Error("QuotaExceededError");
      items.set(k, v);
    },
    removeItem: (k) => void items.delete(k),
  };
  return { journal, items, fill: () => (full = true) };
}

function page(store: ProjectStore, journal: JournalStorage | null = null) {
  let project = part(10);
  const statuses: AutosaveStatus[] = [];
  const clock = fakeTimers();
  const autosave = startAutosave(store, "p", () => project, (s) => statuses.push(s), { quietMs: 1000, timers: clock.timers, journal });
  const edit = (width: number) => {
    project = part(width);
    autosave.changed();
  };
  /** Another project takes this one's place (what Open does after finishing the old autosave). */
  const replace = (width: number) => (project = part(width));
  return { autosave, edit, replace, clock, statuses };
}

test("an edit 0.9× the quiet moment before finish is stored, and is in the journal until it is (worked by hand)", async () => {
  // Edit to 20 at t = 0; its save would come at 1000. Finish at t = 900 (0.9 × 1000), then the project is replaced by
  // one 99 wide. The store is asked for 20 at once, never 99; the journal holds 20 until that save lands, then nothing.
  const h = heldStore();
  const j = memoryJournal();
  const { autosave, edit, replace, clock } = page(h.store, j.journal);
  edit(20);
  await clock.advance(900);
  assert.deepEqual(h.asked, [], "not yet: 0.9× the quiet moment");
  autosave.finish();
  replace(99);
  await settle();
  assert.deepEqual(h.asked, [20]);
  assert.equal(widthOf(JSON.parse(j.items.get(unsavedKey("p"))!)), 20, "journalled at once");
  await h.finishOne();
  assert.deepEqual(h.stored, [20]);
  assert.equal(j.items.size, 0, "the journal entry goes once the store holds it");
  await clock.advance(5000);
  assert.deepEqual(h.asked, [20], "nothing more: finished for good");
  assert.equal(clock.pending(), 0);
});

test("stop, unlike finish, drops that edit: the bug, kept as a contrast", async () => {
  const h = heldStore();
  const { autosave, edit, clock } = page(h.store);
  edit(20);
  await clock.advance(900);
  autosave.stop();
  await clock.advance(5000);
  assert.deepEqual(h.asked, []);
});

test("finish while a save is in flight stores the newest state after it, in order", async () => {
  // Edit to 20; its save starts at 1000 and is held. Edit to 30 at 1100, then finish at 1200 and replace with 99:
  // 30 is asked for only once 20 has landed, so the store ends with 30, not the older 20 over it.
  const h = heldStore();
  const { autosave, edit, replace, clock } = page(h.store);
  edit(20);
  await clock.advance(1000);
  assert.deepEqual(h.asked, [20]);
  await clock.advance(100);
  edit(30);
  await clock.advance(100);
  autosave.finish();
  replace(99);
  await settle();
  assert.deepEqual(h.asked, [20], "waits for the save in flight");
  await h.finishOne();
  assert.deepEqual(h.asked, [20, 30]);
  await h.finishOne();
  assert.deepEqual(h.stored, [20, 30]);
  await clock.advance(5000);
  assert.deepEqual(h.asked, [20, 30]);
});

test("finish with everything stored writes nothing", async () => {
  const h = heldStore();
  const j = memoryJournal();
  const { autosave, edit, clock } = page(h.store, j.journal);
  edit(20);
  await clock.advance(1000);
  await h.finishOne();
  autosave.finish();
  await settle();
  assert.deepEqual(h.asked, [20]);
  assert.equal(j.items.size, 0);
});

test("finish with the journal full still stores the edit; a failed store keeps the journalled one", async () => {
  const full = heldStore();
  const j = memoryJournal();
  j.fill();
  const a = page(full.store, j.journal);
  a.edit(20);
  a.autosave.finish();
  await settle();
  assert.deepEqual(full.asked, [20]);
  assert.equal(j.items.size, 0);

  const failing: ProjectStore = { list: async () => [], open: async () => emptyProject(), remove: async () => {}, save: async () => Promise.reject(new Error("disk")) };
  const k = memoryJournal();
  const b = page(failing, k.journal);
  b.edit(30);
  b.autosave.finish();
  await settle();
  await settle();
  assert.equal(k.items.get(unsavedKey("p")), projectToJson(part(30)), "put back on the next visit");
});

test("after finish, nothing is reported and a change starts nothing", async () => {
  const h = heldStore();
  const { autosave, edit, clock, statuses } = page(h.store);
  edit(20);
  const before = statuses.length;
  autosave.finish();
  await settle();
  await h.finishOne();
  edit(40);
  assert.equal(statuses.length, before);
  assert.equal(clock.pending(), 0);
  autosave.finish(); // a second finish does nothing
  await settle();
  assert.deepEqual(h.asked, [20]);
});

test("finish after stop does nothing: the change stop dropped stays dropped", async () => {
  // Kills finish()'s `if (stopped) return` => false.
  const h = heldStore();
  const { autosave, edit } = page(h.store);
  edit(20);
  autosave.stop();
  autosave.finish();
  await settle();
  assert.deepEqual(h.asked, []);
});

test("finish with nothing changed since autosave started asks the store for nothing", async () => {
  // Kills `if (storedVersion !== v)` => true: the project would be written although no change was made.
  const h = heldStore();
  const { autosave } = page(h.store);
  autosave.finish();
  await settle();
  assert.deepEqual(h.asked, []);
});

test("finish after changes that end where the store already is writes nothing", async () => {
  // Kills `if (text === written) return stored(v)` => false. 20 is stored; then 30 and back to 20 within the quiet
  // moment: the project is as stored, so nothing is asked and no journal entry is left.
  const h = heldStore();
  const j = memoryJournal();
  const { autosave, edit, clock } = page(h.store, j.journal);
  edit(20);
  await clock.advance(1000);
  await h.finishOne();
  edit(30);
  edit(20);
  autosave.finish();
  await settle();
  assert.deepEqual(h.asked, [20]);
  assert.equal(j.items.size, 0);
});
