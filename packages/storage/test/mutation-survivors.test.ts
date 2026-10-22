// Tests written to kill the mutants StrykerJS found surviving in saving:
// the project store, the unsaved-changes journal, autosave and the reopen
// guard (2026-10-22; run it again with packages/testing/stryker/run.sh
// storage). Each test names the change to the code it catches. Mutants that
// change nothing a caller can see are listed, with the reason, in
// packages/testing/stryker/explained.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyProject, projectToJson, type Project } from "@fission/core";
import {
  memoryKeyValue,
  OPENING_KEY,
  projectStore,
  recoverUnsaved,
  reopenGuard,
  startAutosave,
  unsavedKey,
  type AutosaveStatus,
  type JournalStorage,
  type ProjectStore,
  type Timers,
} from "../src/index.ts";

const settle = () => new Promise<void>((r) => setImmediate(r));

/** A fake clock: timers run only when the test moves time on; `pending` counts the timers waiting. */
function fakeTimers() {
  let now = 0;
  let next = 1;
  const waiting = new Map<number, { at: number; fn: () => void }>();
  const timers: Timers = {
    setTimeout(fn, ms) {
      waiting.set(next, { at: now + ms, fn });
      return next++;
    },
    clearTimeout(h) {
      waiting.delete(h as number);
    },
  };
  async function advance(ms: number) {
    const end = now + ms;
    for (;;) {
      const due = [...waiting.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      waiting.delete(due[0]);
      now = due[1].at;
      due[1].fn();
      await settle();
    }
    now = end;
    await settle();
  }
  return { timers, advance, pending: () => waiting.size };
}

/** localStorage as a Map, with key(i) and length. */
function fakeStorage(items = new Map<string, string>()) {
  return {
    items,
    get length() {
      return items.size;
    },
    key: (i: number) => [...items.keys()][i] ?? null,
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => void items.set(k, v),
    removeItem: (k: string) => void items.delete(k),
  } satisfies JournalStorage;
}

const part = (width: number): Project => ({ ...emptyProject("Box"), workspaces: { design: { version: 1, width } } });
const widthOf = (p: Project) => (p.workspaces.design as { width: number }).width;

/** A store whose saves wait until the test finishes them, counting each save asked for. */
function heldStore(kv = memoryKeyValue()) {
  const inner = projectStore(kv, []);
  const waiting: (() => Promise<void>)[] = [];
  let asked = 0;
  const store: ProjectStore = {
    ...inner,
    save: (id, p) => {
      asked++;
      return new Promise<void>((resolve) => waiting.push(() => inner.save(id, p).then(resolve)));
    },
  };
  return { kv, store, waiting, asked: () => asked, finishOne: async () => (await waiting.shift()!(), settle()) };
}

// ---------- store.ts ----------

test("a summary that can't be read says why: not an object, no name, no save time, a number for a time", async () => {
  // Kills `typeof s !== "object" || s === null` => false (and each half, and && for ||), the "not an
  // object" / "no name" strings => "", `typeof name !== "string"` => false, and
  // `typeof modified === "string"` => true (new Date(5) is a valid time, 5 ms after 1970, so
  // without the check a number would pass as a save time).
  const kv = memoryKeyValue();
  const cases: [string, string, string][] = [
    ["a", "null", "not an object"],
    ["b", "7", "not an object"],
    ["c", '{"modified":"2026-10-22T00:00:00.000Z"}', "no name"],
    ["d", '{"name":5,"modified":"2026-10-22T00:00:00.000Z"}', "no name"],
    ["e", '{"name":"E","modified":5}', "no save time"],
  ];
  for (const [id, text] of cases) await kv.set(`summary/${id}`, text);
  const list = await projectStore(kv, []).list();
  for (const [id, , why] of cases) {
    const entry = list.find((e) => e.id === id)!;
    assert.equal(entry.problem, `this project's summary can't be read (${why})`, id);
    assert.equal(entry.name, id, "a broken summary is listed under its id");
    assert.equal(entry.modified.getTime(), 0);
  }
});

test("a missing summary text reads as empty JSON, not as the words of a mutant", async () => {
  // Kills `text ?? ""` => `text ?? "Stryker was here!"`: both fail to parse, so the message is
  // what tells them apart. JSON.parse("") says "Unexpected end of JSON input".
  const kv = memoryKeyValue();
  const keys = kv.keys;
  kv.keys = async (prefix) => (prefix === "summary/" ? ["summary/gone"] : keys(prefix)); // listed, then gone
  const [entry] = await projectStore(kv, []).list();
  assert.equal(entry.problem, "this project's summary can't be read (Unexpected end of JSON input)");
});

test("an id that is not a string is refused before anything is read", async () => {
  // Kills `typeof id !== "string"` => false: (5).length is undefined, and undefined === 0 is false,
  // so the length check alone lets a number through.
  const store = projectStore(memoryKeyValue(), []);
  for (const call of [() => store.open(5 as never), () => store.save(5 as never, part(1)), () => store.remove(5 as never)])
    await assert.rejects(call, { message: "a stored project needs a non-empty id" });
});

test("projects saved at the same moment list by id, a before b before c", async () => {
  // The tie-break's mutants of `a.id > b.id` survive in explained.json (V8's sort never tells 0
  // from 1). Twelve saves at one fixed time, l down to a: the
  // times are equal, so the order comes from the ids alone.
  const kv = memoryKeyValue();
  const store = projectStore(kv, [], () => new Date("2026-10-22T03:00:00Z"));
  const ids = [..."abcdefghijkl"];
  for (const id of [...ids].reverse()) await store.save(id, part(1));
  assert.deepEqual((await store.list()).map((e) => e.id), ids);
  // V8's sort only asks whether the comparator is below 0, so a tie-break that says -1 for every
  // pair would just reverse the order the keys came in: c, a, b is not a reversal of a, b, c.
  // Kills `a.id < b.id` => true.
  const fresh = projectStore(memoryKeyValue(), [], () => new Date("2026-10-22T03:00:00Z"));
  for (const id of ["c", "a", "b"]) await fresh.save(id, part(1));
  assert.deepEqual((await fresh.list()).map((e) => e.id), ["a", "b", "c"]);
  // And a newer save still comes first whatever its id.
  await projectStore(kv, [], () => new Date("2026-10-22T04:00:00Z")).save("z", part(1));
  assert.deepEqual((await store.list()).map((e) => e.id), ["z", ...ids]);
});

test("remove takes away exactly its own two entries, and works when only one of them is left", async () => {
  // Kills `SUMMARY + id` / `PROJECT + id` => `-` (they would look up and delete "NaN"), and
  // `p === undefined && s === undefined` => `||` or either half => true (a half-stored project,
  // say the summary write was lost, must still be removable).
  const kv = memoryKeyValue();
  const store = projectStore(kv, []);
  await store.save("a", part(1));
  await store.save("b", part(2));
  await store.remove("a");
  assert.deepEqual([...kv.entries.keys()].sort(), ["project/b", "summary/b"]);
  await kv.delete("summary/b"); // only the project left
  await store.remove("b");
  assert.equal(kv.entries.size, 0);
  await kv.set("summary/c", "{}"); // only the summary left
  await store.remove("c");
  assert.equal(kv.entries.size, 0);
});

// ---------- unsaved.ts ----------

test("no journal: nothing to recover and no problems, an empty list", async () => {
  // Kills `const problems = []` => ["Stryker was here"].
  assert.deepEqual(await recoverUnsaved(projectStore(memoryKeyValue(), []), null, []), []);
});

test("other localStorage keys are never read or removed by the recovery", async () => {
  // Kills `k !== null && k.startsWith(UNSAVED_PREFIX)` => `||` and => true: a key such as the
  // reopen mark or a theme setting would be read as a project, fail, and be deleted.
  const journal = fakeStorage(new Map([[OPENING_KEY, "p"], ["theme", "dark"], [unsavedKey("p"), projectToJson(part(20))]]));
  const kv = memoryKeyValue();
  const store = projectStore(kv, []);
  assert.deepEqual(await recoverUnsaved(store, journal, []), []);
  assert.deepEqual([...journal.items.keys()], [OPENING_KEY, "theme"]);
  assert.equal(widthOf(await store.open("p")), 20);
});

test("a key another tab removed while the keys are counted is passed over; the rest are recovered", async () => {
  // Kills `k !== null` => true: localStorage.key(i) is null when the entry went meanwhile, and
  // null.startsWith would throw, which is caught as "storage off" and recovers nothing at all.
  const items = new Map([[unsavedKey("a"), projectToJson(part(1))], [unsavedKey("b"), projectToJson(part(2))]]);
  const journal = { ...fakeStorage(items), length: 3, key: (i: number) => [unsavedKey("a"), null, unsavedKey("b")][i] ?? null };
  const store = projectStore(memoryKeyValue(), []);
  assert.deepEqual(await recoverUnsaved(store, journal, []), []);
  assert.deepEqual([widthOf(await store.open("a")), widthOf(await store.open("b"))], [1, 2]);
});

test("storage that throws while its keys are listed recovers nothing and says nothing", async () => {
  // Kills the catch's `return problems` => {} (it would go on with the keys read before the throw).
  const items = new Map([[unsavedKey("a"), projectToJson(part(1))], [unsavedKey("b"), projectToJson(part(2))]]);
  const journal = {
    ...fakeStorage(items),
    length: 2,
    key(i: number) {
      if (i === 1) throw new DOMException("the operation is insecure", "SecurityError");
      return unsavedKey("a");
    },
  };
  const kv = memoryKeyValue();
  assert.deepEqual(await recoverUnsaved(projectStore(kv, []), journal, []), []);
  assert.equal(kv.entries.size, 0, "nothing half-recovered");
  assert.equal(items.size, 2, "the journal is left for a visit that can read it");
});

test("an entry that can't be read is reported with the browser's reason and kept", async () => {
  // Kills the getItem catch block => {} and its message => ``.
  const items = new Map([[unsavedKey("p"), projectToJson(part(20))]]);
  const journal = {
    ...fakeStorage(items),
    getItem(): string | null {
      throw new DOMException("the operation is insecure", "SecurityError");
    },
  };
  const problems = await recoverUnsaved(projectStore(memoryKeyValue(), []), journal, []);
  assert.deepEqual(problems, ["unsaved changes from your last visit couldn't be read (the operation is insecure)"]);
  assert.equal(items.size, 1);
});

test("an entry another tab put back meanwhile (now null) is no problem", async () => {
  // Kills `text === null` => false: projectFromJson(null) would fail and report a problem for
  // changes that are in fact safely stored.
  const journal = { ...fakeStorage(new Map([[unsavedKey("p"), "x"]])), getItem: () => null };
  assert.deepEqual(await recoverUnsaved(projectStore(memoryKeyValue(), []), journal, []), []);
});

// ---------- autosave.ts ----------

function page(store: ProjectStore, journal: JournalStorage | null = null) {
  let project = part(10);
  const statuses: AutosaveStatus[] = [];
  const clock = fakeTimers();
  const autosave = startAutosave(store, "p", () => project, (s) => statuses.push(s), { timers: clock.timers, journal });
  const edit = (width: number) => {
    project = part(width);
    autosave.changed();
  };
  return { autosave, edit, clock, statuses };
}

test("a journal entry left by an earlier page is removed once this page stores a change", async () => {
  // Not a killer (the start-up read's mutants are explained: every one still removes the entry),
  // but the case they guard: an entry left standing would make the next visit put the earlier
  // page's older state back over this page's newer save.
  const journal = fakeStorage(new Map([[unsavedKey("p"), projectToJson(part(15))]]));
  const h = heldStore();
  const { edit, clock } = page(h.store, journal);
  edit(30);
  await clock.advance(1000);
  await h.finishOne();
  assert.equal(journal.items.size, 0);
  // The next visit keeps 30.
  const store = projectStore(h.kv, []);
  await recoverUnsaved(store, journal, []);
  assert.equal(widthOf(await store.open("p")), 30);
});

test("after stop, nothing is reported, not even when a save in flight finishes", async () => {
  // Kills `if (!stopped) onStatus(s)` => always.
  const h = heldStore();
  const { autosave, edit, clock, statuses } = page(h.store);
  edit(20);
  await clock.advance(1000);
  const before = statuses.length;
  autosave.stop();
  await h.finishOne();
  assert.equal(statuses.length, before);
});

test("after stop, a change starts no timer and is not counted", async () => {
  // Kills `if (stopped) return` in changed() => false: it would start a timer and report saving.
  const h = heldStore();
  const { autosave, edit, clock } = page(h.store);
  autosave.stop();
  edit(20);
  assert.equal(clock.pending(), 0);
});

test("stop clears the waiting timer", async () => {
  // Kills `if (timer !== null)` in stop() => false / => `===` (the timer would be left waiting).
  const h = heldStore();
  const { autosave, edit, clock } = page(h.store);
  edit(20);
  assert.equal(clock.pending(), 1);
  autosave.stop();
  assert.equal(clock.pending(), 0);
});

test("stop during a save drops the save asked for during it", async () => {
  // Kills save()'s `if (stopped) return` => false. Change to 20, its save starts at 1000 and is
  // held; change to 30 at 1100, whose timer fires at 2100 while the save is in flight and asks for
  // one more. Stop, then the held save finishes: the one asked for must not run (stop() says a
  // waiting save is dropped, one in flight finishes).
  const h = heldStore();
  const { autosave, edit, clock } = page(h.store);
  edit(20);
  await clock.advance(1000);
  await clock.advance(100);
  edit(30);
  await clock.advance(1000);
  autosave.stop();
  await h.finishOne();
  assert.equal(h.asked(), 1);
  assert.equal(h.waiting.length, 0);
});

test("a save finishing while a newer change waits says saving, not saved (worked by hand)", async () => {
  // Kills `else if (timer === null)` => true. Change to 20 at t=0, due at 1000; the save starts at
  // 1000. Change to 30 at t=1500 starts a new timer (due 2500). The first save finishes at 1600:
  // the store holds 20 but 30 is waiting, so the last status must still be "saving".
  const h = heldStore();
  const { edit, clock, statuses } = page(h.store);
  edit(20);
  await clock.advance(1000);
  await clock.advance(500);
  edit(30);
  await clock.advance(100);
  await h.finishOne();
  assert.deepEqual(statuses.at(-1), { state: "saving" });
  await clock.advance(900);
  await h.finishOne();
  assert.deepEqual(statuses.at(-1), { state: "saved" });
});

test("the save asked for during a save runs once, then autosave goes quiet", async () => {
  // Kills `again = false` => `again = true`: the follow-up save would ask for one more after it,
  // without end. Change to 20 (save starts at 1000), change to 30 at 1100 whose timer fires at
  // 2100 during the first save, so exactly one more save follows: two saves in all.
  const h = heldStore();
  const { edit, clock } = page(h.store);
  edit(20);
  await clock.advance(1000);
  await clock.advance(100);
  edit(30);
  await clock.advance(1000);
  await h.finishOne();
  await h.finishOne();
  await clock.advance(10_000);
  assert.equal(h.asked(), 2, "one save and the one asked for during it");
  assert.equal(h.waiting.length, 0);
  assert.equal(widthOf(await projectStore(h.kv, []).open("p")), 30, "the follow-up save took the latest state");
});

// ---------- reopen.ts ----------

test("finished stops the showing's timer, so none is left waiting", async () => {
  // Kills `if (pending !== null)` in finished() => false / => `===`.
  const clock = fakeTimers();
  const g = reopenGuard(fakeStorage(), { timers: clock.timers });
  g.opening("p");
  g.shown("p");
  assert.equal(clock.pending(), 1);
  g.finished();
  assert.equal(clock.pending(), 0);
});

test("the opening mark's key is panoshape.opening, as earlier versions wrote it", () => {
  // Kills OPENING_KEY => "". The key is stored in browsers, so it must never change.
  assert.equal(OPENING_KEY, "panoshape.opening");
  const items = new Map<string, string>();
  reopenGuard({ getItem: (k) => items.get(k) ?? null, setItem: (k, v) => void items.set(k, v), removeItem: (k) => void items.delete(k) }).opening("p");
  assert.deepEqual([...items], [["panoshape.opening", "p"]]);
});

test("showing again restarts the wait: the earlier showing's timer is stopped (worked by hand)", async () => {
  // Kills `if (pending !== null)` in shown() => false / => `===`. Shown at t=0 (due 3000) and again
  // at t=2000 (due 5000): at t=4000 only the first timer is past due, so the mark must still be
  // there; it clears at 5000.
  const items = new Map<string, string>();
  const clock = fakeTimers();
  const g = reopenGuard({ getItem: (k) => items.get(k) ?? null, setItem: (k, v) => void items.set(k, v), removeItem: (k) => void items.delete(k) }, { timers: clock.timers });
  g.opening("p");
  g.shown("p");
  await clock.advance(2000);
  g.shown("p");
  assert.equal(clock.pending(), 1, "one timer waiting, not two");
  await clock.advance(2000);
  assert.equal(items.get(OPENING_KEY), "p");
  await clock.advance(1000);
  assert.equal(items.has(OPENING_KEY), false);
});
