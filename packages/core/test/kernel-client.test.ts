// Unit tests for the main-thread kernel client helpers.
// Run with `npm test` (Node's built-in test runner).
import assert from "node:assert/strict";
import { test } from "node:test";
import { KernelClient, KernelError, kernelFailure, latestOnly } from "../src/kernel/kernel-client.ts";

/** A promise we resolve by hand, to force replies out of order. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

test("latestOnly marks only the most recent call as current, even when replies arrive out of order", async () => {
  const replies = [deferred<string>(), deferred<string>(), deferred<string>()];
  let call = 0;
  const wrapped = latestOnly(() => replies[call++].promise);

  const first = wrapped();
  const second = wrapped();
  const third = wrapped();
  // Answer the newest first, then the older ones late.
  replies[2].resolve("third");
  replies[0].resolve("first");
  replies[1].resolve("second");

  assert.deepEqual(await third, { current: true, value: "third" });
  assert.deepEqual(await first, { current: false, value: "first" });
  assert.deepEqual(await second, { current: false, value: "second" });
});

test("latestOnly with a single call is current", async () => {
  const wrapped = latestOnly(async (x: number) => x * 2);
  assert.deepEqual(await wrapped(21), { current: true, value: 42 });
});

test("latestOnly passes errors through", async () => {
  const wrapped = latestOnly(async () => {
    throw new Error("width must be positive");
  });
  await assert.rejects(wrapped(), /width must be positive/);
});

test("kernelFailure keeps the kernel's kind, inputs and message", () => {
  // What the WASM kernel throws: an Error with kind and inputs beside the message.
  const thrown = Object.assign(new Error("width must be between 0.001 and 1000000 mm, got -1"), {
    kind: "invalid-input",
    inputs: [{ input: "param", name: "width" }],
  });
  const failure = kernelFailure(thrown);
  assert.deepEqual(failure, { kind: "invalid-input", inputs: [{ input: "param", name: "width" }], message: "width must be between 0.001 and 1000000 mm, got -1" });
  // Rebuilt on the main thread it is still an Error with the same message,
  // so code that shows e.message keeps working.
  const e = new KernelError(failure);
  assert.ok(e instanceof Error);
  assert.equal(e.message, failure.message);
  assert.equal(e.kind, "invalid-input");
  assert.deepEqual(e.inputs, failure.inputs);
  // Printed as any Error was, which tests matching /^Error: …/ rely on.
  assert.equal(String(e), "Error: width must be between 0.001 and 1000000 mm, got -1");
});

test("anything else thrown is an internal failure with no inputs", () => {
  // A WASM crash: a plain Error with no kind.
  assert.deepEqual(kernelFailure(new Error("unreachable")), { kind: "internal", inputs: [], message: "unreachable" });
  // A kind the kernel never gives is not trusted, and neither are its inputs.
  const odd = Object.assign(new Error("x"), { kind: "made-up", inputs: [{ input: "line", index: 0 }] });
  assert.deepEqual(kernelFailure(odd), { kind: "internal", inputs: [], message: "x" });
  // A known kind with inputs that aren't a list keeps the kind, no inputs.
  const bare = Object.assign(new Error("y"), { kind: "unknown-body", inputs: "body" });
  assert.deepEqual(kernelFailure(bare), { kind: "unknown-body", inputs: [], message: "y" });
  // Not an Error at all.
  assert.deepEqual(kernelFailure("text"), { kind: "internal", inputs: [], message: "text" });
  assert.deepEqual(kernelFailure(null), { kind: "internal", inputs: [], message: "null" });
});

/**
 * A stand-in for the browser's Worker: records what is posted and lets a test
 * fire the worker's error event, as a browser does when the worker's script
 * can't be fetched (the page left while it loaded, a dropped connection) or
 * throws while it starts. Daily bug hunt 3e: WebKit's smoke test found a page
 * whose worker load was cancelled reporting "kernel worker crashed: undefined"
 * as an uncaught error, and every call made after that waited forever.
 */
class FakeWorker {
  static last: FakeWorker;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: { message?: string; preventDefault(): void }) => void) | null = null;
  posted: unknown[] = [];
  constructor() {
    FakeWorker.last = this;
  }
  postMessage(m: unknown) {
    this.posted.push(m);
  }
  /** Fires the error event; true if the client took it (preventDefault), so the browser doesn't also report it. */
  fail(message?: string) {
    let prevented = false;
    this.onerror?.({ message, preventDefault: () => (prevented = true) });
    return prevented;
  }
  answer(id: number, value: unknown) {
    this.onmessage?.({ data: { id, ok: true, value } });
  }
}

async function withFakeWorker(fn: (client: KernelClient, worker: FakeWorker) => Promise<void>) {
  const real = (globalThis as { Worker?: unknown }).Worker;
  (globalThis as { Worker?: unknown }).Worker = FakeWorker;
  try {
    await fn(new KernelClient(), FakeWorker.last);
  } finally {
    (globalThis as { Worker?: unknown }).Worker = real;
  }
}

test("calls are answered by id through the worker", () =>
  withFakeWorker(async (client, worker) => {
    const v = client.call("kernel_version");
    assert.deepEqual(worker.posted, [{ id: 1, op: "kernel_version", args: [] }]);
    worker.answer(1, "0.30.1");
    assert.equal(await v, "0.30.1");
  }));

test("a worker that didn't load fails the call waiting on it and every later one, in words, and is taken as handled", () =>
  withFakeWorker(async (client, worker) => {
    const waiting = client.call("kernel_version");
    // A script that can't be fetched fires an error event with no message.
    assert.equal(worker.fail(undefined), true);
    const words = /The geometry kernel didn't start \(its worker didn't load\)\. Reload the page to try again\.$/;
    await assert.rejects(waiting, (e: KernelError) => e instanceof KernelError && e.kind === "internal" && words.test(e.message));
    // Nothing answers a worker that never loaded: a later call fails at once instead of waiting forever.
    const later = client.call("body_count");
    assert.equal(worker.posted.length, 1, "nothing more is posted to the dead worker");
    await assert.rejects(later, words);
  }));

test("a worker that throws while it starts says what it threw, for this call and every later one", () =>
  withFakeWorker(async (client, worker) => {
    const waiting = client.call("kernel_version");
    assert.equal(worker.fail("SyntaxError: unexpected token"), true);
    const words = /The geometry kernel stopped \(kernel worker crashed: SyntaxError: unexpected token\)\. Reload the page to try again\.$/;
    await assert.rejects(waiting, words);
    await assert.rejects(client.call("body_count"), words);
    // An empty message is no message: the same words as a worker that didn't load.
    await withFakeWorker(async (c2, w2) => {
      const p = c2.call("kernel_version");
      w2.fail("");
      await assert.rejects(p, /didn't load/);
    });
  }));
