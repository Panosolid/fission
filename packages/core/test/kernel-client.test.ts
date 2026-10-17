// Unit tests for the main-thread kernel client helpers.
// Run with `npm test` (Node's built-in test runner).
import assert from "node:assert/strict";
import { test } from "node:test";
import { KernelError, kernelFailure, latestOnly } from "../src/kernel/kernel-client.ts";

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
