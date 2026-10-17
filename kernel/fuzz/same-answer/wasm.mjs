// Prints the WebAssembly build's answer line for every saved fuzz input,
// in the same order and format as the native program (src/main.rs):
//
//   node wasm.mjs <fission_same_answer.wasm> <kernel dir>
//
// The module is the kernel built as the app builds it (wasm32-unknown-unknown,
// release), without wasm-bindgen's JavaScript glue: the app's own exports
// are never called, so their imports are stubs that throw if they ever are.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const [wasmPath, root] = process.argv.slice(2);
const module = new WebAssembly.Module(readFileSync(wasmPath));
const imports = {};
for (const { module: m, name } of WebAssembly.Module.imports(module)) {
  imports[m] ??= {};
  imports[m][name] = () => {
    throw new Error(`unexpected call to ${m}.${name}`);
  };
}
let kernel = new WebAssembly.Instance(module, imports).exports;

const targets = ["extrude", "sketch", "placed"];
const lines = [];
for (const [t, target] of targets.entries()) {
  const inputs = [];
  const packed = readFileSync(join(root, "fuzz/seeds", `${target}.seeds`));
  for (let at = 0; at < packed.length; ) {
    const size = packed.readUInt32LE(at);
    inputs.push([`seed ${inputs.length}`, packed.subarray(at + 4, at + 4 + size)]);
    at += 4 + size;
  }
  const dir = join(root, "tests/regressions/libfuzzer", target);
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => statSync(join(dir, f)).isFile());
  } catch {}
  // Byte order, as Rust sorts the names natively.
  files.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  for (const f of files) inputs.push([f, readFileSync(join(dir, f))]);

  for (const [name, data] of inputs) {
    let line;
    try {
      const at = kernel.answer_input(data.length);
      new Uint8Array(kernel.memory.buffer, at, data.length).set(data);
      const out = kernel.answer(t);
      line = Buffer.from(new Uint8Array(kernel.memory.buffer, out, kernel.answer_len())).toString("utf8");
    } catch (e) {
      // A panic traps and leaves the instance unusable: note it, start afresh.
      line = `trapped: ${e.message}`;
      kernel = new WebAssembly.Instance(module, imports).exports;
    }
    lines.push(`${target}\t${name}\t${line}`);
  }
}
process.stdout.write(lines.join("\n") + "\n");
