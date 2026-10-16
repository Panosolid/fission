import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyProject, projectToJson, type DataReader, type Project } from "@fission/core";
import { memoryKeyValue, projectStore, startAutosave } from "../src/index.ts";

// A stand-in Design reader: marks its part as read, and refuses a part
// without a version, the way readDesignDocument refuses bad data.
const design: DataReader = {
  id: "design",
  readData: (d) => {
    if (typeof d !== "object" || d === null || !("version" in d)) throw new Error("no version");
    return { ...d, read: true };
  },
};

/** A clock that reads `times` in turn (ISO strings, UTC). */
function clock(...times: string[]) {
  let i = 0;
  return () => new Date(times[Math.min(i++, times.length - 1)]);
}

function part(name: string): Project {
  return { ...emptyProject(name), workspaces: { design: { version: 1 } } };
}

test("save then list shows the name and the save time (worked by hand)", async () => {
  const store = projectStore(memoryKeyValue(), [design], clock("2026-10-16T12:00:00.000Z"));
  await store.save("p1", part("Bracket"));
  const list = await store.list();
  // One save, at the clock's only time: 2026-10-16 12:00 UTC is
  // Date.UTC(2026, 9, 16, 12) ms (months count from 0, so October is 9).
  assert.deepEqual(list, [{ id: "p1", name: "Bracket", modified: new Date(Date.UTC(2026, 9, 16, 12)) }]);
});

test("the list is newest first, and saving again moves a project to the top", async () => {
  const store = projectStore(memoryKeyValue(), [design], clock("2026-10-16T01:00:00Z", "2026-10-16T02:00:00Z", "2026-10-16T03:00:00Z"));
  await store.save("a", part("A")); // 01:00
  await store.save("b", part("B")); // 02:00
  assert.deepEqual((await store.list()).map((s) => s.id), ["b", "a"]);
  await store.save("a", part("A2")); // 03:00: newer than b, and renamed
  const list = await store.list();
  assert.deepEqual(list.map((s) => [s.id, s.name]), [["a", "A2"], ["b", "B"]]);
});

test("open returns an equal project (self-consistency), read by each workspace", async () => {
  const store = projectStore(memoryKeyValue(), [design]);
  const p = part("Box");
  await store.save("box", p);
  const back = await store.open("box");
  assert.deepEqual(back, { ...p, workspaces: { design: { version: 1, read: true } } });
});

test("what is stored is exactly the .fission.json file text", async () => {
  const kv = memoryKeyValue();
  const p = part("Box");
  await projectStore(kv, [design]).save("box", p);
  assert.equal(kv.entries.get("project/box"), projectToJson(p));
});

test("a stored version-1 project migrates on open, like an opened file", async () => {
  const kv = memoryKeyValue();
  // Written by hand as an old Fission would have stored it: version 1 had no "links".
  kv.entries.set("project/old", `{"formatVersion": 1, "name": "Old", "units": {"length": "mm"}, "materials": [], "workspaces": {"design": {"version": 1}}}`);
  kv.entries.set("summary/old", `{"name": "Old", "modified": "2025-01-01T00:00:00.000Z"}`);
  const p = await projectStore(kv, [design]).open("old");
  assert.equal(p.formatVersion, 2);
  assert.deepEqual(p.links, []);
  assert.deepEqual(p.workspaces.design, { version: 1, read: true });
});

test("remove forgets a project; removing or opening it again is refused", async () => {
  const kv = memoryKeyValue();
  const store = projectStore(kv, [design]);
  await store.save("a", part("A"));
  await store.save("b", part("B"));
  await store.remove("a");
  assert.deepEqual((await store.list()).map((s) => s.id), ["b"]);
  assert.deepEqual([...kv.entries.keys()].sort(), ["project/b", "summary/b"]);
  await assert.rejects(store.open("a"), /^Error: there is no stored project "a" in this browser$/);
  await assert.rejects(store.remove("a"), /^Error: there is no stored project "a" to remove$/);
});

test("opening a missing id is refused with a message", async () => {
  const store = projectStore(memoryKeyValue(), [design]);
  await assert.rejects(store.open("nope"), /^Error: there is no stored project "nope" in this browser$/);
  await assert.rejects(store.open(""), /needs a non-empty id/);
});

test("a stored corrupt project is refused with its reason, not thrown as a crash", async () => {
  const kv = memoryKeyValue();
  const store = projectStore(kv, [design]);
  await store.save("p", part("P"));
  const good = kv.entries.get("project/p")!;
  const corrupt = async (text: string) => {
    kv.entries.set("project/p", text);
    return store.open("p");
  };
  // Each way of breaking a valid stored project gives its own message.
  await assert.rejects(corrupt(good.slice(0, good.length / 2)), /^Error: can't open the stored project "p": not a Fission project: the file is not valid JSON \(/);
  await assert.rejects(corrupt(good.replace('"formatVersion": 2', '"formatVersion": 3')), /^Error: can't open the stored project "p": this project was saved by a newer Fission \(format 3/);
  await assert.rejects(corrupt(good.replace('"workspaces"', '"elsewhere"')), /^Error: can't open the stored project "p": not a Fission project: "workspaces" is missing$/);
  await assert.rejects(corrupt(good.replace('"version": 1', '"versio": 1')), /^Error: can't open the stored project "p": can't open the design workspace's data: no version$/);
  // And the unbroken text still opens, so the breaks above are what was refused.
  kv.entries.set("project/p", good);
  assert.equal((await store.open("p")).name, "P");
});

test("a broken summary still lists, marked with its problem, and the project still opens", async () => {
  const kv = memoryKeyValue();
  const store = projectStore(kv, [design], clock("2026-10-16T12:00:00Z"));
  await store.save("good", part("Good"));
  await store.save("bad", part("Bad"));
  kv.entries.set("summary/bad", "{not json");
  const list = await store.list();
  assert.deepEqual(list.map((s) => s.id), ["good", "bad"]); // the unreadable one sorts as oldest
  assert.match(list[1].problem ?? "", /^this project's summary can't be read/);
  assert.equal(list[1].name, "bad");
  assert.equal(list[0].problem, undefined);
  kv.entries.set("summary/bad", `{"name": "Bad", "modified": "yesterday"}`);
  assert.match((await store.list())[1].problem ?? "", /no save time/);
  assert.equal((await store.open("bad")).name, "Bad");
});

test("a project a file can't hold is refused before anything is written", async () => {
  const kv = memoryKeyValue();
  const store = projectStore(kv, [design]);
  const p = { ...emptyProject(), workspaces: { design: { version: 1, width: NaN } } };
  await assert.rejects(store.save("p", p), /can't save: project\.workspaces\.design\.width is NaN/);
  assert.equal(kv.entries.size, 0);
  await assert.rejects(store.save("", part("x")), /needs a non-empty id/);
});

test("a failing key-value store's message reaches the caller", async () => {
  const kv = memoryKeyValue();
  kv.set = async () => {
    throw new Error("browser storage is full: can't save \"project/p\"");
  };
  await assert.rejects(projectStore(kv, [design]).save("p", part("P")), /browser storage is full/);
});

test("autosave is still a placeholder (step 19c) and says so", () => {
  assert.throws(() => startAutosave(projectStore(memoryKeyValue(), []), "p", () => emptyProject()), /not implemented/);
});
