import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyProject, projectToJson, type Project } from "@fission/core";
import { memoryKeyValue, projectStore, startAutosave, type AutosaveStatus, type ProjectStore, type Timers } from "../src/index.ts";

/** A fake clock: timers run only when the test moves time on with `advance`. */
function fakeTimers() {
  let now = 0;
  let next = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const timers: Timers = {
    setTimeout(fn, ms) {
      pending.set(next, { at: now + ms, fn });
      return next++;
    },
    clearTimeout(h) {
      pending.delete(h as number);
    },
  };
  /** Moves time on by `ms`, running each timer that comes due (in order), then lets saves settle. */
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
  return { timers, advance, pendingCount: () => pending.size };
}

/** Lets promise callbacks (a memory store's save) run to the end. */
const settle = () => new Promise<void>((r) => setImmediate(r));

const part = (width: number): Project => ({ ...emptyProject("Box"), workspaces: { design: { version: 1, width } } });

/** A memory store that records the width of every project it is asked to save. */
function recordingStore() {
  const store = projectStore(memoryKeyValue(), []);
  const saved: number[] = [];
  const save = store.save;
  store.save = async (id, p) => {
    saved.push((p.workspaces.design as { width: number }).width);
    return save(id, p);
  };
  return { store, saved };
}

/** A store whose saves wait until the test lets each one finish. */
function heldStore() {
  const saved: number[] = [];
  const waiting: (() => void)[] = [];
  const store: ProjectStore = {
    list: async () => [],
    open: async () => emptyProject(),
    remove: async () => {},
    save: (_id, p) =>
      new Promise<void>((resolve) => {
        saved.push((p.workspaces.design as { width: number }).width);
        waiting.push(resolve);
      }),
  };
  return { store, saved, finishOne: async () => (waiting.shift()!(), settle()) };
}

function setup(store: ProjectStore, quietMs = 1000) {
  let project = part(10);
  const statuses: AutosaveStatus[] = [];
  const clock = fakeTimers();
  const autosave = startAutosave(store, "p", () => project, (s) => statuses.push(s), { quietMs, timers: clock.timers });
  const edit = (width: number) => {
    project = part(width);
    autosave.changed();
  };
  return { autosave, edit, statuses, clock, last: () => statuses.at(-1) };
}

test("a burst of ten changes gives one save, holding the last state", async () => {
  const { store, saved } = recordingStore();
  const { edit, clock, last } = setup(store);
  for (let w = 1; w <= 10; w++) {
    edit(w);
    await clock.advance(100); // each change comes before the 1000 ms quiet moment is up
  }
  assert.deepEqual(saved, []);
  await clock.advance(1000);
  assert.deepEqual(saved, [10]);
  assert.deepEqual(last(), { state: "saved" });
  assert.deepEqual((await store.open("p")).workspaces.design, { version: 1, width: 10 });
});

test("the save comes one quiet moment after the last change (worked by hand)", async () => {
  // Changes at t = 0, 400 and 800 ms, quiet moment 1000 ms. Each change
  // restarts the wait, so the save is due at 800 + 1000 = 1800 ms: nothing
  // has been saved at 1799 ms, and one save has at 1800 ms.
  const { store, saved } = recordingStore();
  const { edit, clock } = setup(store);
  edit(1);
  await clock.advance(400);
  edit(2);
  await clock.advance(400);
  edit(3);
  await clock.advance(999); // t = 1799
  assert.deepEqual(saved, []);
  await clock.advance(1); // t = 1800
  assert.deepEqual(saved, [3]);
});

test("boundary: nothing is saved at 0.9× the quiet moment, and it is saved by 1.1×", async () => {
  const { store, saved } = recordingStore();
  const { edit, clock } = setup(store, 1000);
  edit(7);
  await clock.advance(900); // 0.9 × 1000 ms
  assert.deepEqual(saved, []);
  await clock.advance(200); // 1.1 × 1000 ms in all
  assert.deepEqual(saved, [7]);
});

test("a change during a save gives exactly one more save, of the latest state", async () => {
  const { store, saved, finishOne } = heldStore();
  const { edit, clock, last } = setup(store);
  edit(1);
  await clock.advance(1000); // the first save starts and is held
  assert.deepEqual(saved, [1]);
  edit(2);
  edit(3);
  await clock.advance(1000); // due while the first save is still in flight: it waits
  assert.deepEqual(saved, [1]);
  edit(4); // another change, still during the first save
  await clock.advance(1000);
  assert.deepEqual(saved, [1]);
  await finishOne(); // the first save ends: exactly one more starts, with width 4
  assert.deepEqual(saved, [1, 4]);
  assert.deepEqual(last(), { state: "saving" });
  await finishOne();
  await clock.advance(10_000);
  assert.deepEqual(saved, [1, 4]);
  assert.deepEqual(last(), { state: "saved" });
});

test("only one save is ever in flight", async () => {
  const { store, saved, finishOne } = heldStore();
  const { edit, clock } = setup(store);
  for (let i = 1; i <= 5; i++) {
    edit(i);
    await clock.advance(1000); // each one comes due during the held first save
  }
  assert.deepEqual(saved, [1]);
  await finishOne();
  assert.deepEqual(saved, [1, 5]);
});

test("the status reads saving after a change and saved once stored", async () => {
  const { store } = recordingStore();
  const { edit, clock, statuses } = setup(store);
  edit(1);
  assert.deepEqual(statuses, [{ state: "saving" }]);
  await clock.advance(1000);
  assert.deepEqual(statuses, [{ state: "saving" }, { state: "saved" }]);
});

test("a failing store reports its message, and the next change retries", async () => {
  const { store, saved } = recordingStore();
  const save = store.save;
  let full = true;
  store.save = async (id, p) => {
    if (full) throw new Error("browser storage is full");
    return save(id, p);
  };
  const { edit, clock, last } = setup(store);
  edit(1);
  await clock.advance(1000);
  assert.deepEqual(last(), { state: "error", message: "browser storage is full" });
  await clock.advance(60_000); // nothing retries on its own
  assert.deepEqual(last(), { state: "error", message: "browser storage is full" });
  full = false;
  edit(2);
  await clock.advance(1000);
  assert.deepEqual(saved, [2]);
  assert.deepEqual(last(), { state: "saved" });
});

test("a project that can't be written (NaN) is reported, not stored", async () => {
  const { store, saved } = recordingStore();
  const { edit, clock, last } = setup(store);
  edit(NaN);
  await clock.advance(1000);
  assert.deepEqual(saved, []);
  assert.equal(last()?.state, "error");
  assert.match((last() as { message: string }).message, /NaN|not a finite number/);
});

test("an unchanged project is not written again", async () => {
  const { store, saved } = recordingStore();
  const { edit, clock, last } = setup(store);
  edit(5);
  await clock.advance(1000);
  edit(5); // the same state again (a re-mount writes the same document)
  await clock.advance(1000);
  assert.deepEqual(saved, [5]);
  assert.deepEqual(last(), { state: "saved" });
  edit(6); // and a real change still is
  await clock.advance(1000);
  assert.deepEqual(saved, [5, 6]);
});

test("what autosave stores is exactly the project's file text", async () => {
  const kv = memoryKeyValue();
  const store = projectStore(kv, []);
  const { edit, clock } = setup(store);
  edit(42);
  await clock.advance(1000);
  assert.equal(kv.entries.get("project/p"), projectToJson(part(42)));
});

test("stop drops a waiting save and reports nothing more", async () => {
  const { store, saved } = recordingStore();
  const { autosave, edit, clock, statuses } = setup(store);
  edit(1);
  autosave.stop();
  await clock.advance(5000);
  edit(2);
  await clock.advance(5000);
  assert.deepEqual(saved, []);
  assert.deepEqual(statuses, [{ state: "saving" }]);
  assert.equal(clock.pendingCount(), 0);
});
