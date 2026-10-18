// The reopen guard (security audit S2): a project that froze or crashed the
// tab while opening is skipped once on the next visit, and every other
// project reopens as before. Visits are played out on a fake clock and a
// fake localStorage that outlives each page, as the browser's does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { OPENING_KEY, reopenGuard, SETTLED_MS, type MarkStorage, type Timers } from "../src/index.ts";

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
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = [...pending.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      pending.delete(due[0]);
      now = due[1].at;
      due[1].fn();
    }
    now = end;
  };
  return { timers, advance };
}

/** localStorage as a Map; `items` shows what it holds. */
function fakeStorage(): MarkStorage & { items: Map<string, string> } {
  const items = new Map<string, string>();
  return { items, getItem: (k) => items.get(k) ?? null, setItem: (k, v) => void items.set(k, v), removeItem: (k) => void items.delete(k) };
}

test("a visit story, worked by hand: opened fine, froze, skipped once, tried again", () => {
  const storage = fakeStorage();
  const page = () => {
    const clock = fakeTimers();
    return { clock, guard: reopenGuard(storage, { timers: clock.timers }) };
  };
  // Visit 1: nothing marked, so p1 opens; the mark names it until the tab has run SETTLED_MS after showing it.
  let v = page();
  assert.equal(v.guard.stuck("p1"), false);
  v.guard.opening("p1");
  assert.equal(storage.items.get(OPENING_KEY), "p1");
  v.guard.shown("p1");
  v.clock.advance(SETTLED_MS - 1);
  assert.equal(storage.items.get(OPENING_KEY), "p1");
  v.clock.advance(1);
  assert.equal(storage.items.has(OPENING_KEY), false);
  // Visit 2: p1 reopens and freezes the tab before it is shown: the mark stays.
  v = page();
  assert.equal(v.guard.stuck("p1"), false);
  v.guard.opening("p1");
  // Visit 3: the mark names p1, so p1 is skipped, and the mark is gone.
  v = page();
  assert.equal(v.guard.stuck("p1"), true);
  assert.equal(storage.items.has(OPENING_KEY), false);
  // Visit 4: p1 is tried again.
  v = page();
  assert.equal(v.guard.stuck("p1"), false);
});

test("the mark clears at SETTLED_MS: still there at 0.9×, gone at 1.1×", () => {
  for (const [fraction, left] of [[0.9, true], [1.1, false]] as const) {
    const storage = fakeStorage();
    const clock = fakeTimers();
    const guard = reopenGuard(storage, { timers: clock.timers });
    guard.opening("p1");
    guard.shown("p1");
    clock.advance(fraction * SETTLED_MS);
    assert.equal(storage.items.has(OPENING_KEY), left, `${fraction}×`);
  }
  assert.equal(SETTLED_MS, 3000);
});

test("a mark for another project skips nothing, and is cleared", () => {
  const storage = fakeStorage();
  storage.items.set(OPENING_KEY, "p2"); // p2 froze, then p1 was saved more recently in another tab
  assert.equal(reopenGuard(storage).stuck("p1"), false);
  assert.equal(storage.items.has(OPENING_KEY), false);
});

test("finished clears the mark at once and stops the timer; a newer opening isn't cleared by an older one's timer", () => {
  const storage = fakeStorage();
  const clock = fakeTimers();
  const guard = reopenGuard(storage, { timers: clock.timers });
  guard.opening("p1");
  guard.finished(); // the store refused p1 with a message, or the page was closed: not a freeze
  assert.equal(storage.items.has(OPENING_KEY), false);
  // p1 shown, then a file opened as p2 before p1 settled: p1's timer must not clear p2's mark.
  guard.opening("p1");
  guard.shown("p1");
  clock.advance(SETTLED_MS / 2);
  guard.opening("p2");
  clock.advance(SETTLED_MS);
  assert.equal(storage.items.get(OPENING_KEY), "p2");
  // And a timer whose mark was replaced by another tab leaves that mark alone.
  guard.shown("p2");
  storage.items.set(OPENING_KEY, "p3");
  clock.advance(SETTLED_MS);
  assert.equal(storage.items.get(OPENING_KEY), "p3");
});

test("opening the same project again restarts its wait: the first showing's timer is stopped", () => {
  // p1 shown at 0, opened again at 1,500 (as Open would with a file) and not
  // yet shown: at 3,000 the first timer would clear the mark of the second
  // opening, which is still under way, so it must have been stopped.
  const storage = fakeStorage();
  const clock = fakeTimers();
  const guard = reopenGuard(storage, { timers: clock.timers });
  guard.opening("p1");
  guard.shown("p1");
  clock.advance(SETTLED_MS / 2);
  guard.opening("p1");
  clock.advance(SETTLED_MS);
  assert.equal(storage.items.get(OPENING_KEY), "p1");
  guard.shown("p1");
  clock.advance(SETTLED_MS);
  assert.equal(storage.items.has(OPENING_KEY), false);
});

test("no storage, or storage that throws, never skips and never throws", () => {
  const throwing: MarkStorage = {
    getItem: () => {
      throw new Error("SecurityError");
    },
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
    removeItem: () => {
      throw new Error("SecurityError");
    },
  };
  for (const storage of [null, throwing]) {
    const clock = fakeTimers();
    const guard = reopenGuard(storage, { timers: clock.timers });
    guard.opening("p1");
    guard.shown("p1");
    clock.advance(SETTLED_MS);
    guard.finished();
    assert.equal(guard.stuck("p1"), false);
  }
});

/** splitmix64, as packages/core's tests use: the same seed gives the same visits. */
function rng(seed: bigint) {
  let s = seed;
  const M = (1n << 64n) - 1n;
  return () => {
    s = (s + 0x9e3779b97f4a7c15n) & M;
    let z = s;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & M;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & M;
    return Number((z ^ (z >> 31n)) >> 11n) / 2 ** 53;
  };
}

type Outcome = "fine" | "froze-opening" | "froze-shown" | "closed-early" | "refused";
const OUTCOMES: Outcome[] = ["fine", "froze-opening", "froze-shown", "closed-early", "refused"];

test("seeded visits against a model: skipped exactly when the visit before froze on that project", () => {
  // The model, written from the rule and not from the guard: a visit skips
  // its newest project iff the visit before tried that same project and
  // froze (before or after showing it, short of SETTLED_MS). A skipped
  // visit opens nothing, so the next one tries again.
  for (let seed = 1n; seed <= 20n; seed++) {
    const random = rng(seed);
    const storage = fakeStorage();
    let froze: string | null = null; // the project the last visit froze on
    const seen = new Set<string>();
    for (let visit = 0; visit < 200; visit++) {
      const newest = `p${1 + Math.floor(random() * 3)}`;
      const outcome = OUTCOMES[Math.floor(random() * OUTCOMES.length)];
      const clock = fakeTimers();
      const guard = reopenGuard(storage, { timers: clock.timers });
      const skipped = guard.stuck(newest);
      assert.equal(skipped, froze === newest, `seed ${seed}, visit ${visit}: ${newest} after a freeze on ${froze}`);
      seen.add(`${skipped}`);
      froze = null;
      if (skipped) continue;
      guard.opening(newest);
      if (outcome === "froze-opening") froze = newest;
      else if (outcome === "refused") guard.finished();
      else {
        guard.shown(newest);
        if (outcome === "froze-shown") {
          clock.advance(SETTLED_MS * random() * 0.99);
          froze = newest;
        } else if (outcome === "closed-early") {
          clock.advance(SETTLED_MS * random() * 0.99);
          guard.finished();
        } else clock.advance(SETTLED_MS + random() * 10_000);
      }
    }
    assert.deepEqual([...seen].sort(), ["false", "true"], `seed ${seed} reached both answers`);
  }
});
