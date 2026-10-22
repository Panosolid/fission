// BodyCache's overlapping uses (26g, the monkey's seed 8): the app's
// rebuilds and its settling share one cache, so a body is held once, and
// nothing is freed while a use runs. On a stand-in kernel whose handles
// count from 1 and whose frees can be held back, so each interleaving is
// set up exactly.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { BodyHandle, BodySpec, KernelCalls } from "@fission/core";
import { BodyCache } from "../src/rebuild.ts";

/** A kernel that builds handles 1, 2, 3… and keeps them until freed; a view of one not held is refused, as the real one does. */
function standIn() {
  const live = new Set<BodyHandle>();
  let next = 1;
  let gate: Promise<void> | null = null;
  const kernel: KernelCalls = {
    call: (async (op: string, arg: unknown) => {
      if (op === "body_build") {
        const h = next++ as BodyHandle;
        live.add(h);
        return h;
      }
      if (op === "body_view") {
        if (!live.has(arg as BodyHandle)) throw new Error(`body ${arg} is not held`);
        return { handle: arg };
      }
      if (op === "body_free") {
        if (gate) await gate;
        if (!live.delete(arg as BodyHandle)) throw new Error(`body ${arg} freed twice`);
        return;
      }
      throw new Error(`no ${op}`);
    }) as KernelCalls["call"],
  };
  return {
    kernel,
    live: () => [...live].sort((a, b) => a - b),
    /** Frees wait until the returned function is called. */
    hold() {
      let open = () => {};
      gate = new Promise<void>((r) => (open = r));
      return () => {
        gate = null;
        open();
      };
    },
  };
}

const box = (h: number): BodySpec => ({ box: { width: 40, depth: 30, height: h } }) as unknown as BodySpec;

/** A promise and the function that settles it. */
function later() {
  let done = () => {};
  const p = new Promise<void>((r) => (done = r));
  return { p, done };
}

test("hand-worked: a settle overlapping a rebuild reuses the drawn body, keeps it while it runs, and frees only what no rebuild keeps", async () => {
  const k = standIn();
  const cache = new BodyCache(k.kernel);
  // Rebuild 1 draws the 20-high box: handle 1, kept.
  const one = await cache.using(async () => {
    const h = await cache.body(box(20));
    await cache.keepOnly([h]);
    return h;
  });
  assert.deepEqual([one, k.live()], [1, [1]]);
  // A settle starts: the 20-high box again is handle 1 (reused, not built twice), and it builds the 25-high one: 2.
  const settleGoesOn = later();
  const settle = cache.using(async () => {
    const before = await cache.body(box(20));
    const after = await cache.body(box(25));
    await settleGoesOn.p;
    // Still held while it runs, though rebuild 2 kept neither: their views are read.
    await cache.view(before);
    await cache.view(after);
    return [before, after];
  });
  await new Promise((r) => setImmediate(r));
  // Rebuild 2, meanwhile, draws a 30-high box (3) and keeps only that: nothing is freed yet, the settle is running.
  await cache.using(async () => {
    const h = await cache.body(box(30));
    await cache.keepOnly([h]);
  });
  assert.deepEqual(k.live(), [1, 2, 3], "nothing freed while the settle runs");
  settleGoesOn.done();
  assert.deepEqual(await settle, [1, 2]);
  // The settle ended, the last use: what rebuild 2 didn't keep (1 and 2) is freed; 3 stays, the one drawn.
  assert.deepEqual(k.live(), [3]);
  assert.equal(cache.size, 1);
});

test("with no use running, keepOnly frees at once, as before", async () => {
  const k = standIn();
  const cache = new BodyCache(k.kernel);
  const a = await cache.body(box(20));
  await cache.body(box(25));
  await cache.keepOnly([a]);
  assert.deepEqual(k.live(), [1]);
  await cache.clear();
  assert.deepEqual(k.live(), []);
});

test("a use's own bodies are freed when it ends, unless a keepOnly kept them meanwhile", async () => {
  // A cache never asked to keep anything (a settle's own, delete-ask's): all it built goes when the use ends.
  const k = standIn();
  const cache = new BodyCache(k.kernel);
  await cache.using(async () => {
    await cache.body(box(20));
    await cache.body(box(25));
  });
  assert.deepEqual(k.live(), []);
  // Kept by a keepOnly made during the use: it stays.
  await cache.using(async () => {
    const h = await cache.body(box(20)); // 3
    await cache.body(box(25)); // 4
    await cache.keepOnly([h]);
    assert.deepEqual(k.live(), [3, 4], "deferred while the use runs");
  });
  assert.deepEqual(k.live(), [3]);
});

test("a use that throws still ends: its bodies are freed and the error is its own", async () => {
  const k = standIn();
  const cache = new BodyCache(k.kernel);
  await assert.rejects(
    cache.using(async () => {
      await cache.body(box(20));
      throw new Error("the kernel refused the extrude");
    }),
    /the kernel refused the extrude/,
  );
  assert.deepEqual(k.live(), []);
  // Nothing is left counted as running: a keepOnly frees at once again.
  await cache.body(box(25));
  await cache.keepOnly([]);
  assert.deepEqual(k.live(), []);
});

test("a use begun while the last one's bodies are being freed keeps what it builds until it ends", async () => {
  // Use 1 ends and frees body 1 (the kernel slow to answer); use 2 begins meanwhile and builds 2, which no keepOnly
  // kept: it must not be freed under use 2, which reads its view, only once use 2 ends.
  const k = standIn();
  const cache = new BodyCache(k.kernel);
  await cache.using(async () => void (await cache.body(box(20))));
  // (Freed at once: the first use found nothing to wait for.) Again, with the free held back this time.
  await cache.using(async () => void (await cache.body(box(21)))); // 2, freed
  const open = k.hold();
  const ending = cache.using(async () => void (await cache.body(box(22)))); // 3: its free waits at the gate
  await new Promise((r) => setImmediate(r));
  const twoGoesOn = later();
  const two = cache.using(async () => {
    const h = await cache.body(box(23)); // 4
    await twoGoesOn.p;
    await cache.view(h);
    return h;
  });
  await new Promise((r) => setImmediate(r));
  open(); // 3 is freed; the loop must stop there, 4 belongs to a running use
  await ending;
  assert.deepEqual(k.live(), [4]);
  twoGoesOn.done();
  assert.equal(await two, 4);
  assert.deepEqual(k.live(), []);
});

test("closed during a use: everything is freed once the use ends, and nothing more is built", async () => {
  const k = standIn();
  const cache = new BodyCache(k.kernel);
  const goesOn = later();
  const use = cache.using(async () => {
    const h = await cache.body(box(20));
    await goesOn.p;
    await cache.view(h);
  });
  await new Promise((r) => setImmediate(r));
  await cache.close();
  assert.deepEqual(k.live(), [1], "still in use");
  goesOn.done();
  await use;
  assert.deepEqual(k.live(), []);
  await assert.rejects(cache.body(box(25)), /closed/);
});
