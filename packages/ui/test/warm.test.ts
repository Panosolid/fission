import { test } from "node:test";
import assert from "node:assert/strict";
import { WarmPool } from "../src/warm.ts";

type Pane = "main" | "split";
type Id = "design" | "image" | "slice";

/** A pool whose hooks write what they were asked into `log`; instances are numbered in mount order. */
function logged() {
  const log: string[] = [];
  let made = 0;
  const pool = new WarmPool<Id, Pane, number>({
    mount: (pane, id) => (log.push(`mount ${id} in ${pane}`), ++made),
    sleep: (pane, id, n) => log.push(`sleep ${id}#${n} in ${pane}`),
    wake: (pane, id, n) => log.push(`wake ${id}#${n} in ${pane}`),
    unmount: (pane, id, n) => log.push(`unmount ${id}#${n} in ${pane}`),
  });
  return { pool, log };
}

test("hand-worked: Design, Image, Design again wakes the first Design; nothing is mounted twice", () => {
  const { pool, log } = logged();
  pool.show("main", "design");
  pool.show("main", "image");
  pool.show("main", "design");
  pool.show("main", "design"); // already shown: nothing at all
  pool.show("main", "image");
  // Worked out from the rules: each workspace is mounted once (#1 Design, #2
  // Image); every later switch is one sleep of the shown one and one wake of
  // the chosen one.
  assert.deepEqual(log, [
    "mount design in main",
    "sleep design#1 in main",
    "mount image in main",
    "sleep image#2 in main",
    "wake design#1 in main",
    "sleep design#1 in main",
    "wake image#2 in main",
  ]);
  assert.equal(pool.showing("main"), "image");
  assert.equal(pool.paneOf("design"), "main");
});

test("hand-worked: a workspace asked for in the other pane is put to sleep, unmounted there and mounted afresh", () => {
  const { pool, log } = logged();
  pool.show("main", "design"); // #1
  pool.show("split", "image"); // #2
  pool.show("main", "image"); // the swap's first half: Image leaves the split pane
  assert.deepEqual(log.slice(2), [
    "sleep design#1 in main",
    "sleep image#2 in split", // on screen there, so asleep before it is unmounted
    "unmount image#2 in split",
    "mount image in main", // #3
  ]);
  assert.equal(pool.showing("split"), null);
  assert.equal(pool.paneOf("image"), "main");
});

test("hide, forgetPane and forgetAll: everything shown sleeps before it is unmounted", () => {
  const { pool, log } = logged();
  pool.show("main", "design"); // #1
  pool.show("main", "slice"); // #2
  pool.show("split", "image"); // #3
  pool.hide("main"); // Community
  assert.equal(pool.showing("main"), null);
  pool.hide("main"); // nothing shown: nothing happens
  pool.forgetPane("split"); // the split closes
  assert.equal(pool.paneOf("image"), null);
  pool.forgetAll(); // a project opened
  assert.deepEqual(log.slice(4), [
    "sleep slice#2 in main",
    "sleep image#3 in split",
    "unmount image#3 in split",
    "unmount design#1 in main",
    "unmount slice#2 in main",
  ]);
  assert.equal(pool.paneOf("design"), null);
  pool.show("main", "design");
  assert.equal(log.at(-1), "mount design in main"); // forgotten means mounted afresh
});

test("seeded random switching matches a model: one instance per workspace, awake exactly when shown, unmounted once and only asleep", () => {
  // SplitMix64 inline (ui can't import packages/testing, which imports core).
  const rng = (seed: bigint) => {
    let s = seed;
    const M = (1n << 64n) - 1n;
    return () => {
      s = (s + 0x9e3779b97f4a7c15n) & M;
      let z = s;
      z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & M;
      z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & M;
      return Number((z ^ (z >> 31n)) >> 11n) / 2 ** 53;
    };
  };
  const ids: Id[] = ["design", "image", "slice"];
  const panes: Pane[] = ["main", "split"];
  for (const seed of [0x5eedn, 1n, 2n, 3n, 0xdeadbeefn]) {
    const next = rng(seed);
    const pick = <T>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)];
    // Each instance's life as the hooks saw it.
    type Life = { id: Id; pane: Pane; awake: boolean; gone: boolean };
    const lives: Life[] = [];
    const life = (n: number, id: Id, pane: Pane) => {
      const l = lives[n - 1];
      assert.ok(l && l.id === id && l.pane === pane, `seed ${seed}: hook for the right instance`);
      assert.ok(!l.gone, `seed ${seed}: no hook after unmount`);
      return l;
    };
    const pool = new WarmPool<Id, Pane, number>({
      mount: (pane, id) => (lives.push({ id, pane, awake: true, gone: false }), lives.length),
      sleep: (pane, id, n) => {
        const l = life(n, id, pane);
        assert.ok(l.awake, `seed ${seed}: sleep only when awake`);
        l.awake = false;
      },
      wake: (pane, id, n) => {
        const l = life(n, id, pane);
        assert.ok(!l.awake, `seed ${seed}: wake only when asleep`);
        l.awake = true;
      },
      unmount: (pane, id, n) => {
        const l = life(n, id, pane);
        assert.ok(!l.awake, `seed ${seed}: unmount only when asleep`);
        l.gone = true;
      },
    });
    // The model: what each pane shows, and where each workspace lives.
    const shown = new Map<Pane, Id>();
    const home = new Map<Id, Pane>();
    let mounts = 0;
    for (let step = 0; step < 2000; step++) {
      const r = next();
      if (r < 0.7) {
        const pane = pick(panes);
        const id = pick(ids);
        const fresh = home.get(id) !== pane; // not living here: a mount
        if (shown.get(pane) === id) {
          // nothing changes
        } else {
          if (home.get(id) && home.get(id) !== pane && shown.get(home.get(id)!) === id) shown.delete(home.get(id)!);
          home.set(id, pane);
          shown.set(pane, id);
          if (fresh) mounts++;
        }
        pool.show(pane, id);
      } else if (r < 0.85) {
        const pane = pick(panes);
        shown.delete(pane);
        pool.hide(pane);
      } else if (r < 0.95) {
        const pane = pick(panes);
        shown.delete(pane);
        for (const [id, p] of [...home]) if (p === pane) home.delete(id);
        pool.forgetPane(pane);
      } else {
        shown.clear();
        home.clear();
        pool.forgetAll();
      }
      assert.equal(lives.length, mounts, `seed ${seed} step ${step}: mounts only when the model says so`);
      // The pool agrees with the model, and the hooks' lives agree with both.
      for (const pane of panes) assert.equal(pool.showing(pane), shown.get(pane) ?? null, `seed ${seed} step ${step}`);
      for (const id of ids) assert.equal(pool.paneOf(id), home.get(id) ?? null, `seed ${seed} step ${step}`);
      const living = lives.filter((l) => !l.gone);
      for (const id of ids) assert.ok(living.filter((l) => l.id === id).length <= 1, `seed ${seed}: one instance of ${id}`);
      for (const l of living) assert.equal(l.awake, shown.get(l.pane) === l.id, `seed ${seed} step ${step}: ${l.id} awake exactly when shown`);
    }
  }
});
