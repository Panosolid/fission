// Changes kept when the page goes before autosave has stored them (timeline
// bug hunt, finding 1): `leaving()` writes the journal at once and starts
// the store's save, `recoverUnsaved` puts the journal back on the next
// visit. Pages are played out on a fake clock, a store whose saves the test
// finishes, fails or abandons (a page that has gone never finishes one),
// and a fake localStorage that outlives each page, as the browser's does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyProject, projectToJson, type Project } from "@fission/core";
import {
  memoryKeyValue,
  projectStore,
  recoverUnsaved,
  startAutosave,
  unsavedKey,
  UNSAVED_PREFIX,
  type AutosaveStatus,
  type JournalStorage,
  type ProjectStore,
  type Timers,
} from "../src/index.ts";

/** A fake clock for one page: timers run only when the test moves time on. */
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
  return { timers, advance };
}

const settle = () => new Promise<void>((r) => setImmediate(r));

const part = (width: number): Project => ({ ...emptyProject("Box"), workspaces: { design: { version: 1, width } } });
const widthOf = (p: Project) => (p.workspaces.design as { width: number }).width;

/** localStorage as a Map, with its key(i) and length; `full` makes every write throw as a full one does. */
function fakeStorage() {
  const items = new Map<string, string>();
  const s = {
    items,
    full: false,
    get length() {
      return items.size;
    },
    key: (i: number) => [...items.keys()][i] ?? null,
    getItem: (k: string) => items.get(k) ?? null,
    setItem(k: string, v: string) {
      if (s.full) throw new DOMException("the quota has been exceeded", "QuotaExceededError");
      items.set(k, v);
    },
    removeItem: (k: string) => void items.delete(k),
  };
  return s satisfies JournalStorage;
}

/**
 * A store over a memory KeyValue that outlives the page, whose saves wait
 * until the test finishes or fails them. A save still waiting when the
 * page goes is abandoned: it never reaches the KeyValue.
 */
function heldStore(kv = memoryKeyValue()) {
  const inner = projectStore(kv, []);
  const waiting: { width: number; finish: () => Promise<void>; fail: () => void }[] = [];
  const store: ProjectStore = {
    ...inner,
    save: (id, p) =>
      new Promise<void>((resolve, reject) => {
        waiting.push({
          width: widthOf(p),
          finish: () => inner.save(id, p).then(resolve),
          fail: () => reject(new Error("browser storage is full")),
        });
      }),
  };
  return {
    kv,
    store,
    waiting,
    finishOne: async () => (await waiting.shift()!.finish(), settle()),
    failOne: async () => (waiting.shift()!.fail(), settle()),
    /** What a later visit's store reads, with no saves of this page's still to come. */
    stored: async () => widthOf(await inner.open("p")),
  };
}

function page(store: ProjectStore, journal: JournalStorage | null, first = 10) {
  let project = part(first);
  const statuses: AutosaveStatus[] = [];
  const clock = fakeTimers();
  const autosave = startAutosave(store, "p", () => project, (s) => statuses.push(s), { timers: clock.timers, journal });
  const edit = (width: number) => {
    project = part(width);
    autosave.changed();
  };
  return { autosave, edit, clock, last: () => statuses.at(-1) };
}

/** The next visit: what is stored once the journal has been put back. */
async function nextVisit(kv: ReturnType<typeof memoryKeyValue>, journal: JournalStorage) {
  const store = projectStore(kv, []);
  const problems = await recoverUnsaved(store, journal, []);
  return { problems, width: widthOf(await store.open("p")) };
}

test("the hunt's case: a page reloaded 100 ms after a change keeps it (worked by hand)", async () => {
  // Stored at width 10. A change to 20 at t = 0 is due to be saved at
  // t = 1000 ms; the page is reloaded at t = 100. leaving() must write
  // exactly 20's file text to the journal before it returns, and start the
  // store's save at once (it starts with no time passing). The save never
  // finishes (the page has gone), so the store still reads 10; the next
  // visit puts 20 back from the journal and the entry is gone.
  const journal = fakeStorage();
  const h = heldStore();
  await h.kv.set("project/p", projectToJson(part(10)));
  const { autosave, edit, clock } = page(h.store, journal);
  edit(20);
  await clock.advance(100);
  assert.equal(h.waiting.length, 0, "no save before the quiet moment");
  assert.equal(autosave.leaving(), true);
  assert.equal(journal.items.get(unsavedKey("p")), projectToJson(part(20)));
  assert.deepEqual(
    h.waiting.map((w) => w.width),
    [20],
    "the store's save started straight away",
  );
  assert.equal(await h.stored(), 10);
  const after = await nextVisit(h.kv, journal);
  assert.deepEqual(after, { problems: [], width: 20 });
  assert.equal(journal.items.size, 0);
});

test("without leaving() the same reload loses the change (the bug, so the test above can fail)", async () => {
  const journal = fakeStorage();
  const h = heldStore();
  await h.kv.set("project/p", projectToJson(part(10)));
  const { edit, clock } = page(h.store, journal);
  edit(20);
  await clock.advance(100);
  assert.equal((await nextVisit(h.kv, journal)).width, 10);
});

test("nothing waiting: leaving() writes nothing and says all is kept", async () => {
  const journal = fakeStorage();
  const h = heldStore();
  const { autosave, edit, clock } = page(h.store, journal);
  assert.equal(autosave.leaving(), true, "a project with no changes");
  edit(20);
  await clock.advance(1000);
  await h.finishOne();
  assert.equal(autosave.leaving(), true, "every change stored");
  assert.equal(journal.items.size, 0);
  assert.equal(h.waiting.length, 0, "no save started for nothing");
});

test("the journal entry goes once the store holds that state", async () => {
  const journal = fakeStorage();
  const h = heldStore();
  const { autosave, edit, last } = page(h.store, journal);
  edit(20);
  autosave.leaving(); // the tab is hidden, say, and comes back
  assert.ok(journal.items.has(unsavedKey("p")));
  await h.finishOne();
  assert.equal(journal.items.size, 0);
  assert.deepEqual(last(), { state: "saved" });
});

test("an older save finishing never removes a newer journal entry", async () => {
  // 20 is being stored when 30 is made; the page goes. The journal holds
  // 30; 20's save finishing must leave it, or the next visit reads 20.
  const journal = fakeStorage();
  const h = heldStore();
  const { autosave, edit, clock } = page(h.store, journal);
  edit(20);
  await clock.advance(1000); // 20's save starts and is held
  edit(30);
  assert.equal(autosave.leaving(), true);
  assert.equal(journal.items.get(unsavedKey("p")), projectToJson(part(30)));
  await h.finishOne(); // 20 stored; 30's save starts straight after it
  assert.equal(journal.items.get(unsavedKey("p")), projectToJson(part(30)), "the newer entry is kept");
  assert.deepEqual(
    h.waiting.map((w) => w.width),
    [30],
  );
  // The page goes now, 30's save abandoned: the next visit reads 30.
  assert.deepEqual(await nextVisit(h.kv, journal), { problems: [], width: 30 });
});

test("a journal entry from an earlier hide never puts back an older state over a newer stored one", async () => {
  // Hidden at 20 (journal 20), back, 30 made and stored. The entry must be
  // gone, or the next visit would put 20 back over 30.
  const journal = fakeStorage();
  const h = heldStore();
  const { autosave, edit, clock } = page(h.store, journal);
  edit(20);
  autosave.leaving();
  edit(30); // before 20's save finishes
  await h.finishOne(); // 20 stored: the entry (20) is no newer, so it goes
  assert.equal(journal.items.size, 0);
  await clock.advance(1000);
  await h.finishOne(); // 30 stored
  assert.equal(journal.items.size, 0);
  assert.deepEqual(await nextVisit(h.kv, journal), { problems: [], width: 30 });
});

test("storage full: leaving() says a change would be lost, and all is kept again once stored", async () => {
  const journal = fakeStorage();
  journal.full = true;
  const h = heldStore();
  const { autosave, edit } = page(h.store, journal);
  edit(20);
  assert.equal(autosave.leaving(), false);
  assert.equal(journal.items.size, 0);
  await h.finishOne();
  assert.equal(autosave.leaving(), true);
});

test("no localStorage at all: leaving() still starts the save and says a change would be lost", async () => {
  const h = heldStore();
  const { autosave, edit } = page(h.store, null);
  edit(20);
  assert.equal(autosave.leaving(), false);
  assert.deepEqual(
    h.waiting.map((w) => w.width),
    [20],
  );
});

test("a project that can't be written (NaN) is not journaled, and leaving() says so", async () => {
  const journal = fakeStorage();
  const h = heldStore();
  const { autosave, edit } = page(h.store, journal);
  edit(NaN);
  assert.equal(autosave.leaving(), false);
  assert.equal(journal.items.size, 0);
});

test("after a failed save, leaving() journals the change and tries the store once more", async () => {
  const journal = fakeStorage();
  const h = heldStore();
  const { autosave, edit, clock, last } = page(h.store, journal);
  edit(20);
  await clock.advance(1000);
  await h.failOne();
  assert.deepEqual(last(), { state: "error", message: "browser storage is full" });
  assert.equal(autosave.leaving(), true);
  assert.equal(journal.items.get(unsavedKey("p")), projectToJson(part(20)));
  assert.deepEqual(
    h.waiting.map((w) => w.width),
    [20],
  );
});

test("leaving() twice writes the journal once and starts one save", async () => {
  const journal = fakeStorage();
  let writes = 0;
  const set = journal.setItem;
  journal.setItem = (k, v) => (writes++, set(k, v));
  const h = heldStore();
  const { autosave, edit } = page(h.store, journal);
  edit(20);
  autosave.leaving(); // beforeunload
  autosave.leaving(); // then pagehide
  assert.equal(writes, 1);
  assert.equal(h.waiting.length, 1);
});

test("a stopped autosave keeps nothing more", async () => {
  const journal = fakeStorage();
  const h = heldStore();
  const { autosave, edit } = page(h.store, journal);
  edit(20);
  autosave.stop();
  assert.equal(autosave.leaving(), true);
  assert.equal(journal.items.size, 0);
});

test("an entry left by a page whose put-back failed is removed once this page stores the project", async () => {
  const journal = fakeStorage();
  journal.setItem(unsavedKey("p"), projectToJson(part(20)));
  const h = heldStore();
  const { edit, clock } = page(h.store, journal);
  edit(30);
  await clock.advance(1000);
  assert.ok(journal.items.has(unsavedKey("p")), "kept while nothing newer is stored");
  await h.finishOne();
  assert.equal(journal.items.size, 0);
});

test("recoverUnsaved: puts each entry back through projectFromJson and leaves other keys alone", async () => {
  const journal = fakeStorage();
  journal.setItem(unsavedKey("a"), projectToJson(part(1)));
  journal.setItem(unsavedKey("b"), projectToJson(part(2)));
  journal.setItem("panoshape.opening", "a");
  journal.setItem(UNSAVED_PREFIX, "no id"); // not an entry
  const kv = memoryKeyValue();
  const store = projectStore(kv, []);
  assert.deepEqual(await recoverUnsaved(store, journal, []), []);
  assert.equal(widthOf(await store.open("a")), 1);
  assert.equal(widthOf(await store.open("b")), 2);
  assert.equal(kv.entries.get("project/a"), projectToJson(part(1)), "the exact file text");
  assert.deepEqual([...journal.items.keys()].sort(), ["panoshape.opening", UNSAVED_PREFIX]);
});

test("recoverUnsaved: an entry that doesn't read is reported and removed; the stored project stays as it was", async () => {
  const journal = fakeStorage();
  journal.setItem(unsavedKey("p"), "{ not json");
  const kv = memoryKeyValue();
  const store = projectStore(kv, []);
  await store.save("p", part(10));
  const problems = await recoverUnsaved(store, journal, []);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^unsaved changes from your last visit couldn't be read, so the project is as it was last saved \(/);
  assert.equal(widthOf(await store.open("p")), 10);
  assert.equal(journal.items.size, 0);
});

test("recoverUnsaved: a store that refuses keeps the entry for the next visit, with a message", async () => {
  const journal = fakeStorage();
  journal.setItem(unsavedKey("p"), projectToJson(part(20)));
  const store = projectStore(memoryKeyValue(), []);
  store.save = async () => {
    throw new Error("browser storage is full");
  };
  assert.deepEqual(await recoverUnsaved(store, journal, []), [
    "unsaved changes from your last visit couldn't be stored (browser storage is full); they are kept in this browser for the next visit",
  ]);
  assert.ok(journal.items.has(unsavedKey("p")));
});

test("recoverUnsaved: no localStorage, or one that throws, gives no problems and no changes", async () => {
  const store = projectStore(memoryKeyValue(), []);
  assert.deepEqual(await recoverUnsaved(store, null, []), []);
  const broken = {
    get length(): number {
      throw new DOMException("denied", "SecurityError");
    },
    key: () => null,
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  };
  assert.deepEqual(await recoverUnsaved(store, broken, []), []);
  assert.deepEqual(await store.list(), []);
});

// Seeded pages against a simple model. Each change sets the width to the
// next number, so a newer state is a bigger width. A run is a chain of
// visits sharing one KeyValue and one localStorage; in each visit random
// steps (a change, time passing, a held save finishing or failing, the
// tab hidden) end in the page going, either through leaving() (a reload
// or close: beforeunload, pagehide) or with no warning at all (the tab
// killed). Then the next visit puts the journal back and reads the store:
//   - after leaving() that said all is kept: exactly the last change;
//   - with no warning: never older than the newest state whose save
//     finished, nor newer than the last change.

/** A small seeded random source (mulberry32): the same seed gives the same run. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Outcome {
  visits: number;
  left: number;
  killed: number;
  full: number;
}

async function run(seed: number, visits: number, journalFor: (s: ReturnType<typeof fakeStorage>) => JournalStorage = (s) => s): Promise<Outcome> {
  const r = rng(seed);
  const pick = (n: number) => Math.floor(r() * n);
  const kv = memoryKeyValue();
  const storage = fakeStorage();
  const journal = journalFor(storage);
  const outcome: Outcome = { visits: 0, left: 0, killed: 0, full: 0 };
  let width = 1;
  await projectStore(kv, []).save("p", part(width));
  let finished = width; // the newest width the store is known to hold
  for (let v = 0; v < visits; v++) {
    outcome.visits++;
    const h = heldStore(kv);
    const { autosave, edit, clock } = page(h.store, journal, width);
    storage.full = r() < 0.15; // storage full for this whole visit
    if (storage.full) outcome.full++;
    for (let steps = pick(12); steps > 0; steps--) {
      const k = pick(5);
      if (k === 0 || k === 1) edit(++width);
      else if (k === 2) await clock.advance(pick(1500));
      else if (k === 3 && h.waiting.length > 0) {
        const w = h.waiting[0].width;
        if (r() < 0.85) {
          await h.finishOne();
          finished = Math.max(finished, w);
        } else await h.failOne();
      } else if (k === 4) autosave.leaving(); // hidden, then back
    }
    const where = `seed ${seed}, visit ${v}`;
    if (r() < 0.7) {
      outcome.left++;
      const kept = autosave.leaving();
      // A save that finishes as the page goes (pagehide can run that long) or not at all.
      if (h.waiting.length > 0 && r() < 0.3) {
        const w = h.waiting[0].width;
        await h.finishOne();
        finished = Math.max(finished, w);
      }
      const after = await nextVisit(kv, storage);
      if (kept) assert.equal(after.width, width, `${where}: leaving() said all is kept`);
      else {
        assert.ok(storage.full, `${where}: leaving() said a change would be lost with storage working`);
        assert.ok(after.width >= finished && after.width <= width, `${where}: read ${after.width}, finished ${finished}, last ${width}`);
      }
      width = after.width;
    } else {
      outcome.killed++;
      const after = await nextVisit(kv, storage);
      assert.ok(after.width >= finished && after.width <= width, `${where}: killed tab read ${after.width}, finished ${finished}, last ${width}`);
      width = after.width;
    }
    finished = width;
    storage.full = false;
  }
  return outcome;
}

const SEEDS = 200;
const VISITS = 8;

test(`seeded: ${SEEDS} runs × ${VISITS} visits keep every change a page leaves with, and never go back behind a finished save`, async () => {
  const base = Number(process.env.FISSION_SEED ?? 1907);
  const total: Outcome = { visits: 0, left: 0, killed: 0, full: 0 };
  for (let seed = base; seed < base + SEEDS; seed++) {
    const o = await run(seed, VISITS);
    for (const k of Object.keys(total) as (keyof Outcome)[]) total[k] += o[k];
  }
  if (process.env.FISSION_SEED === undefined) for (const k of ["left", "killed", "full"] as const) assert.ok(total[k] >= 50, `${k} reached ${total[k]} times`);
});

test("the seeded runs catch a journal that loses its writes", async () => {
  // A localStorage that takes writes without keeping them, as if leaving()
  // wrote nothing: some run must read an older width than the last change.
  const forgetful = (s: ReturnType<typeof fakeStorage>): JournalStorage => ({ ...s, length: 0, key: s.key, getItem: s.getItem, removeItem: s.removeItem, setItem: () => {} });
  let caught = false;
  for (let seed = 1907; seed < 1907 + SEEDS && !caught; seed++)
    try {
      await run(seed, VISITS, forgetful);
    } catch (e) {
      caught = /leaving\(\) said all is kept/.test((e as Error).message);
    }
  assert.ok(caught);
});
