import { test } from "node:test";
import assert from "node:assert/strict";
import { createSelection } from "../src/model/session.ts";
import type { GeometryReference, StableId } from "../src/model/references.ts";

const face = (id: string): GeometryReference => ({ kind: "face", id: id as StableId });
const edge = (id: string): GeometryReference => ({ kind: "edge", id: id as StableId });
const ids = (items: readonly GeometryReference[]) => items.map((r) => `${r.kind} ${r.id}`);

/** A selection with a listener that records every call it gets. */
function watched() {
  const s = createSelection();
  const calls: string[][] = [];
  s.onChange((items) => calls.push(ids(items)));
  return { s, calls };
}

test("a new selection is empty", () => {
  assert.deepEqual(createSelection().items, []);
});

test("set replaces the items, keeping each once in first-seen order", () => {
  const { s, calls } = watched();
  s.set([face("a"), edge("b")]);
  s.set([edge("c"), face("a"), edge("c")]);
  assert.deepEqual(ids(s.items), ["edge c", "face a"]);
  assert.deepEqual(calls, [["face a", "edge b"], ["edge c", "face a"]]);
});

test("same id but different kind are different items", () => {
  const s = createSelection();
  s.set([face("x"), edge("x")]);
  assert.equal(s.items.length, 2);
});

test("toggle adds then removes; toggling twice leaves it empty", () => {
  const { s, calls } = watched();
  s.toggle(face("a"));
  assert.deepEqual(ids(s.items), ["face a"]);
  s.toggle(face("a"));
  assert.deepEqual(s.items, []);
  assert.deepEqual(calls, [["face a"], []]);
});

test("toggle removes only the matching item and keeps the order of the rest", () => {
  const s = createSelection();
  s.set([face("a"), face("b"), face("c")]);
  s.toggle(face("b"));
  assert.deepEqual(ids(s.items), ["face a", "face c"]);
});

test("clear empties it and tells listeners once", () => {
  const { s, calls } = watched();
  s.set([face("a"), face("b")]);
  s.clear();
  assert.deepEqual(s.items, []);
  assert.equal(calls.length, 2);
});

test("listeners are told exactly once per change and never for a no-op", () => {
  // Counted by hand: set(a) changes (1), set(a) again no-op, set(a,a) dedups
  // to (a) no-op, clear (2), clear again no-op, set([]) no-op, toggle(b) (3).
  const { s, calls } = watched();
  s.set([face("a")]);
  s.set([face("a")]);
  s.set([face("a"), face("a")]);
  s.clear();
  s.clear();
  s.set([]);
  s.toggle(face("b"));
  assert.equal(calls.length, 3);
});

test("every listener is told; an unsubscribed one is not", () => {
  const s = createSelection();
  let first = 0;
  let second = 0;
  const off = s.onChange(() => first++);
  s.onChange(() => second++);
  s.set([face("a")]);
  off();
  s.set([face("b")]);
  assert.deepEqual([first, second], [1, 2]);
});

test("the items can't be changed from outside", () => {
  const s = createSelection();
  const given = [face("a")];
  s.set(given);
  given.push(face("b")); // the caller's array is not the selection's
  assert.equal(s.items.length, 1);
  assert.throws(() => (s.items as GeometryReference[]).push(face("c")), TypeError);
});
