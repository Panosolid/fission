// The licence notices and allowlist (licences.mjs, audit L2), worked by hand,
// plus the repository's own dependencies held to the list: this file is the
// CI licence check. Run by `npm test`.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ALLOWED, ALLOWED_DEV_ONLY, ALLOWED_FOR_TOOLS, chooseLicences, cratesAll, cratesShipped, EMBEDDED, licencesPlugin, noticesFile, noticeTexts, npmAll, npmShipped, packageDir, parseLicence, refused, unlistedHolders } from "../licences.mjs";
import { rng } from "./monkey-core.mjs";

const scratch = mkdtempSync(join(tmpdir(), "licences-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
let made = 0;
/** A package folder holding the given files. */
function pkg(licence, files, name = `p${++made}`) {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
  return { name, version: "1.0.0", licence, dir };
}

test("licence expressions read as SPDX does: WITH tightest, then AND, then OR", () => {
  assert.deepEqual(parseLicence("MIT"), { id: "MIT" });
  assert.deepEqual(parseLicence("MIT OR Apache-2.0"), { op: "OR", parts: [{ id: "MIT" }, { id: "Apache-2.0" }] });
  // Cargo's old slash is OR, spaces or not.
  assert.deepEqual(parseLicence("MIT/Apache-2.0"), parseLicence("MIT OR Apache-2.0"));
  assert.deepEqual(parseLicence("Apache-2.0 / MIT"), parseLicence("Apache-2.0 OR MIT"));
  // A OR B AND C is A OR (B AND C), as 1 + 2 × 3 is 1 + (2 × 3).
  assert.deepEqual(parseLicence("A OR B AND C"), { op: "OR", parts: [{ id: "A" }, { op: "AND", parts: [{ id: "B" }, { id: "C" }] }] });
  assert.deepEqual(parseLicence("(MIT OR Apache-2.0) AND Unicode-3.0"), { op: "AND", parts: [{ op: "OR", parts: [{ id: "MIT" }, { id: "Apache-2.0" }] }, { id: "Unicode-3.0" }] });
  assert.deepEqual(parseLicence("Apache-2.0 WITH LLVM-exception OR MIT"), { op: "OR", parts: [{ id: "Apache-2.0", exception: "LLVM-exception" }, { id: "MIT" }] });
  // "or later" plus: the base licence, which decides the same way.
  assert.deepEqual(parseLicence("GPL-2.0+"), { id: "GPL-2.0" });
  assert.deepEqual(parseLicence("mit or apache-2.0"), { op: "OR", parts: [{ id: "mit" }, { id: "apache-2.0" }] });
  for (const bad of [null, undefined, "", "  ", "MIT OR", "OR MIT", "(MIT", "MIT)", "MIT Apache-2.0", "MIT, Apache-2.0", "MIT & ISC", "MIT WITH", "()"]) assert.equal(parseLicence(bad), null, JSON.stringify(bad));
});

test("a choice ships under the best allowed licence; any other part decides alone", () => {
  // MIT comes first in ALLOWED, so it wins every choice it is in.
  assert.deepEqual(chooseLicences("Apache-2.0 OR MIT"), ["MIT"]);
  assert.deepEqual(chooseLicences("Unlicense OR MIT"), ["MIT"]);
  assert.deepEqual(chooseLicences("Apache-2.0 OR Zlib"), ["Zlib"]);
  // Both halves of an AND go with the copy.
  assert.deepEqual(chooseLicences("(MIT OR Apache-2.0) AND Unicode-3.0"), ["MIT", "Unicode-3.0"]);
  // An allowed way out of a copyleft licence is taken; without one it is refused.
  assert.deepEqual(chooseLicences("GPL-3.0-only OR MIT"), ["MIT"]);
  for (const no of ["GPL-3.0-only", "LGPL-2.1-or-later", "MPL-2.0", "AGPL-3.0", "MIT AND GPL-2.0", "SEE LICENSE IN LICENSE.txt", "UNLICENSED", null, "", "mit"]) assert.equal(chooseLicences(no), null, JSON.stringify(no));
  assert.deepEqual(chooseLicences("Apache-2.0 WITH LLVM-exception"), ["Apache-2.0"]);
  assert.equal(chooseLicences("GPL-2.0 WITH Classpath-exception-2.0"), null);
  assert.equal(chooseLicences("Apache-2.0 WITH Commons-Clause"), null);
  assert.deepEqual(refused([{ name: "ok", version: "1", licence: "ISC" }, { name: "bad", version: "2.3", licence: "GPL-3.0" }, { name: "none", version: "0.1", licence: null }]), ["bad 2.3: GPL-3.0", "none 0.1: no licence given"]);
});

test("random expressions: printed and read back the same, and allowed exactly when the logic says so", () => {
  // A second path to the answer: allowed is true for a leaf on the list,
  // AND is all, OR is any. 3,000 seeded trees of up to depth 4.
  const next = rng(20261018);
  const ids = ["MIT", "Apache-2.0", "GPL-3.0", "Zlib", "MPL-2.0", "Unicode-3.0"];
  const tree = (depth) => {
    if (depth === 0 || next() < 0.35) return { id: ids[Math.floor(next() * ids.length)] };
    const parts = Array.from({ length: 2 + Math.floor(next() * 2) }, () => tree(depth - 1));
    return { op: next() < 0.5 ? "AND" : "OR", parts };
  };
  const print = (t, outer) => {
    if ("id" in t) return t.id;
    const s = t.parts.map((p) => print(p, t.op)).join(` ${t.op} `);
    return outer !== undefined ? `(${s})` : s;
  };
  const allowed = (t) => ("id" in t ? ALLOWED.includes(t.id) : t.op === "AND" ? t.parts.every(allowed) : t.parts.some(allowed));
  // A same-op child is flattened by the reader: (A OR B) OR C is A OR B OR C.
  const flat = (t) => ("id" in t ? t : { op: t.op, parts: t.parts.map(flat).flatMap((p) => ("op" in p && p.op === t.op ? p.parts : [p])) });
  for (let i = 0; i < 3000; i++) {
    const t = tree(4);
    const text = print(t);
    const read = parseLicence(text);
    assert.deepEqual(flat(read), flat(t), text);
    const chosen = chooseLicences(text);
    assert.equal(chosen !== null, allowed(t), text);
    if (chosen !== null) for (const id of chosen) assert.ok(ALLOWED.includes(id), `${text} chose ${id}`);
  }
});

test("each chosen licence takes its own file; NOTICE always goes too", () => {
  const dual = pkg("MIT OR Apache-2.0", { "LICENSE-MIT": "Copyright (c) 2020 A", "LICENSE-APACHE": "Apache text", "README.md": "no" });
  assert.deepEqual(noticeTexts(dual), { chosen: ["MIT"], texts: [{ file: "LICENSE-MIT", text: "Copyright (c) 2020 A" }] });
  const plain = pkg("ISC", { LICENSE: "ISC, Copyright B\r\n" });
  assert.deepEqual(noticeTexts(plain).texts, [{ file: "LICENSE", text: "ISC, Copyright B" }]);
  const apache = pkg("Apache-2.0", { "LICENSE.txt": "Apache text", NOTICE: "Product C, Copyright 2021 C" });
  assert.deepEqual(noticeTexts(apache).texts.map((t) => t.file), ["LICENSE.txt", "NOTICE"]);
  const unlicense = pkg("Unlicense", { UNLICENSE: "public domain", "LICENSE-MIT": "mit" });
  assert.deepEqual(noticeTexts(unlicense).texts.map((t) => t.file), ["UNLICENSE"]);
});

test("regression: an AND licence ships every part's text (unicode-ident's Unicode-3.0 was left out)", () => {
  // unicode-ident is (MIT OR Apache-2.0) AND Unicode-3.0, with LICENSE-MIT,
  // LICENSE-APACHE and LICENSE-UNICODE. The first version found LICENSE-MIT
  // and stopped, so the Unicode licence's notice was missing.
  const both = pkg("(MIT OR Apache-2.0) AND Unicode-3.0", { "LICENSE-MIT": "mit", "LICENSE-APACHE": "apache", "LICENSE-UNICODE": "unicode" });
  assert.deepEqual(noticeTexts(both).texts.map((t) => t.file), ["LICENSE-MIT", "LICENSE-UNICODE"]);
  // With the Unicode file gone, the build stops and names the missing part,
  // rather than let a plain LICENSE stand for both halves.
  const missing = pkg("MIT AND Unicode-3.0", { "LICENSE-MIT": "mit", LICENSE: "something" });
  assert.throws(() => noticeTexts(missing), /no licence file for Unicode-3\.0/);
});

test("no licence text, or a licence off the list, stops the notices", () => {
  assert.throws(() => noticeTexts(pkg("MIT", { "README.md": "MIT" })), /no licence file for MIT/);
  assert.throws(() => noticeTexts(pkg("MIT", { NOTICE: "only a notice" })), /no licence file for MIT/);
  assert.throws(() => noticeTexts(pkg("GPL-3.0", { LICENSE: "GPL" })), /"GPL-3\.0" is not on the allowed list/);
});

test("copyright holders in shipped code must be named in the notices", () => {
  const notices = "loglevel 1.9.2: MIT\nCopyright (c) 2013 Tim Perry\n";
  // Years, (c) and © are dropped and case and punctuation evened out, so
  // "Copyright © 2013-2014 TIM PERRY." is the same holder, Tim Perry.
  assert.deepEqual(unlistedHolders(" * Copyright (c) 2013 Tim Perry\n * Copyright © 2013-2014 TIM PERRY.", notices), []);
  assert.deepEqual(unlistedHolders("/* Copyright 2019-2024 Example Corp. All rights reserved. */", notices), ["example corp"]);
  assert.deepEqual(unlistedHolders("// Copyright: Some One\n", notices), ["some one"]);
  // Licence wording is not a notice: lower-case "copyright ownership", capital "COPYRIGHT HOLDERS".
  assert.deepEqual(unlistedHolders("regarding copyright ownership. THE COPYRIGHT HOLDERS BE LIABLE. the above copyright notice", notices), []);
});

test("a bundled file's package is the folder under its last node_modules", () => {
  assert.equal(packageDir("/r/node_modules/three/build/three.module.js"), "/r/node_modules/three");
  assert.equal(packageDir("/r/node_modules/@mlc-ai/web-llm/lib/index.js"), "/r/node_modules/@mlc-ai/web-llm");
  assert.equal(packageDir("/r/node_modules/a/node_modules/@s/b/lib/i.js"), "/r/node_modules/a/node_modules/@s/b");
  assert.equal(packageDir("/r/packages/core/src/index.ts"), null);
});

test("the lockfile walk takes the app's run-time tree, nested copies included, nothing dev-only", () => {
  // The app needs a, which needs b@2 (nested under a); the root's b@1 is a
  // dev tool's, so only b@2 ships.
  const root = join(scratch, "repo");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "package-lock.json"), JSON.stringify({ packages: {
    "": { workspaces: ["apps/*", "packages/*"] },
    "apps/fission": { dependencies: { "@fission/ui": "*", a: "^1" }, devDependencies: { vite: "*" } },
    "packages/ui": { name: "@fission/ui", dependencies: { c: "*" } },
    "node_modules/@fission/ui": { resolved: "packages/ui", link: true },
    "node_modules/a": { version: "1.0.0", license: "MIT", dependencies: { b: "^2" } },
    "node_modules/a/node_modules/b": { version: "2.0.0", license: "ISC" },
    "node_modules/b": { version: "1.0.0", license: "GPL-3.0", dev: true },
    "node_modules/c": { version: "3.0.0", license: "Zlib", optionalDependencies: { gone: "*" } },
    "node_modules/vite": { version: "5.0.0", license: "MIT", dev: true, dependencies: { b: "^1", css: "*" } },
    "node_modules/css": { version: "1.0.0", license: "MPL-2.0", dev: true },
  } }));
  assert.deepEqual(npmShipped(root).map((p) => `${p.name}@${p.version}`), ["a@1.0.0", "b@2.0.0", "c@3.0.0"]);
  assert.deepEqual(npmShipped(root).find((p) => p.name === "b").dir, join(root, "node_modules/a/node_modules/b"));
  // Every package, dev ones too, is held to a list: the root's b@1 is
  // refused either way; the dev tool's MPL css only by the shipped list.
  assert.deepEqual(refused(npmAll(root)), ["b 1.0.0: GPL-3.0", "css 1.0.0: MPL-2.0"]);
  assert.deepEqual(refused(npmAll(root), ALLOWED_FOR_TOOLS), ["b 1.0.0: GPL-3.0"]);
});

test("a dev-only licence never ships: in the run-time tree it is refused, and the notices stop", () => {
  // The same MPL package, now a run-time dependency of the app.
  const root = join(scratch, "repo-shipped-mpl");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "package-lock.json"), JSON.stringify({ packages: {
    "": { workspaces: ["apps/*"] },
    "apps/fission": { dependencies: { css: "*" }, devDependencies: { tool: "*" } },
    "node_modules/css": { version: "1.0.0", license: "MPL-2.0" },
    "node_modules/tool": { version: "2.0.0", license: "MPL-2.0", dev: true },
  } }));
  // The tools walk takes both and allows both; the shipped walk takes css and refuses it.
  assert.deepEqual(refused(npmAll(root), ALLOWED_FOR_TOOLS), []);
  assert.deepEqual(npmShipped(root).map((p) => p.name), ["css"]);
  assert.deepEqual(refused(npmShipped(root)), ["css 1.0.0: MPL-2.0"]);
  assert.throws(() => noticesFile({ npm: npmShipped(root), crates: [] }), /MPL-2.0/);
  // The dev-only list adds to ALLOWED and never repeats it: a licence in both would make the strict list weaker in disguise.
  assert.ok(ALLOWED_DEV_ONLY.length > 0 && ALLOWED_DEV_ONLY.every((id) => !ALLOWED.includes(id)));
  assert.deepEqual(ALLOWED_FOR_TOOLS, [...ALLOWED, ...ALLOWED_DEV_ONLY]);
  assert.deepEqual(chooseLicences("MPL-2.0"), null);
  assert.deepEqual(chooseLicences("MPL-2.0", ALLOWED_FOR_TOOLS), ["MPL-2.0"]);
  // A choice still prefers the strict list's licences: a tool offering MIT OR MPL-2.0 is read as MIT.
  assert.deepEqual(chooseLicences("MPL-2.0 OR MIT", ALLOWED_FOR_TOOLS), ["MIT"]);
  assert.deepEqual(chooseLicences("GPL-3.0", ALLOWED_FOR_TOOLS), null);
});

test("the crates walk takes normal dependencies for wasm, not proc-macros, build or dev ones", () => {
  const p = (name, kind = "lib") => ({ id: name, name, version: "1.0.0", license: "MIT", manifest_path: `/c/${name}/Cargo.toml`, authors: [], targets: [{ kind: [kind] }] });
  const dep = (pkg, kind = null) => ({ pkg, dep_kinds: [{ kind }] });
  const metadata = {
    packages: [p("kernel"), p("glam"), p("libm"), p("derive", "proc-macro"), p("syn"), p("cc"), p("proptest")],
    workspace_members: ["kernel"],
    resolve: { root: "kernel", nodes: [
      { id: "kernel", deps: [dep("glam"), dep("derive"), dep("cc", "build"), dep("proptest", "dev")] },
      { id: "glam", deps: [dep("libm")] },
      { id: "libm", deps: [] },
      { id: "derive", deps: [dep("syn")] },
      { id: "syn", deps: [] }, { id: "cc", deps: [] }, { id: "proptest", deps: [] },
    ] },
  };
  assert.deepEqual(cratesShipped("/", metadata).map((c) => c.name), ["glam", "libm"]);
  assert.deepEqual(cratesAll("/", metadata).map((c) => c.name).sort(), ["cc", "derive", "glam", "libm", "proptest", "syn"]);
});

test("this repository: everything shipped is under an allowed licence, and every tool under an allowed or dev-only one", () => {
  assert.deepEqual(refused(npmShipped()), []);
  assert.deepEqual(refused(cratesShipped()), []);
  assert.deepEqual(refused(npmAll(), ALLOWED_FOR_TOOLS), []);
  assert.deepEqual(refused(cratesAll(), ALLOWED_FOR_TOOLS), []);
  // Whatever the dev-only list lets through must be a tool: none of it is in the shipped trees.
  const shipped = new Set([...npmShipped(), ...cratesShipped()].map((p) => `${p.name} ${p.version}`));
  const devOnly = [...refused(npmAll()), ...refused(cratesAll())];
  for (const entry of devOnly) assert.ok(!shipped.has(entry.replace(/: .*$/, "")), entry);
  // Today that is lightningcss, Vite 8's CSS tool, under MPL-2.0 (so the list is exercised, not idle).
  assert.ok(devOnly.length > 0 && devOnly.every((e) => /^lightningcss.* MPL-2\.0$/.test(e)), devOnly.join(", "));
});

test("this repository: the notices name what ships and leave out the tools", () => {
  const npm = npmShipped();
  const crates = cratesShipped();
  const names = (list) => list.map((p) => p.name);
  for (const name of ["three", "@mlc-ai/web-llm", "loglevel"]) assert.ok(names(npm).includes(name), name);
  for (const name of ["vite", "typescript", "playwright", "happy-dom"]) assert.ok(!names(npm).includes(name), name);
  for (const name of ["glam", "spade", "robust", "serde", "serde_json", "wasm-bindgen", "libm"]) assert.ok(names(crates).includes(name), name);
  for (const name of ["serde_derive", "wasm-bindgen-macro", "syn", "quote", "proptest"]) assert.ok(!names(crates).includes(name), name);
  const text = noticesFile({ npm, crates });
  for (const p of [...npm, ...crates]) assert.ok(text.includes(`\n${p.name} ${p.version}: `), p.name);
  for (const e of EMBEDDED) assert.ok(text.includes(`\n${e.name}, inside ${e.inside}: ${e.licence}`), e.name);
  // The Apache licence's long text is printed once for web-llm, and once
  // more inside libm's LICENSE.txt (its contributors' Apache grant is part
  // of that one file); none of the 20-odd crates offering "MIT OR
  // Apache-2.0" add a copy, since they ship as MIT.
  assert.equal(text.split("TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION").length - 1, 2);
  assert.ok(!text.includes("LICENSE-APACHE"));
  assert.ok(text.includes("UNICODE LICENSE V3"));
});

test("the build plugin refuses an unlisted package or holder, and writes the file", () => {
  const listed = pkg("MIT", { LICENSE: "Copyright 2020 Listed Ltd" }, "node_modules/listed");
  writeFileSync(join(listed.dir, "index.js"), "/* Copyright 2020 Listed Ltd */");
  writeFileSync(join(listed.dir, "copied.js"), "/* Copyright 2025 Sneaky Ltd */");
  const stranger = pkg("MIT", { LICENSE: "x", "index.js": "" }, "node_modules/stranger");
  const text = noticesFile({ npm: [listed], crates: [], embedded: [] });
  const run = (emit, ids) => {
    const errors = [];
    const files = [];
    licencesPlugin({ emit, source: () => ({ npm: [listed], text }) }).generateBundle.call({
      getModuleIds: () => ids.values(),
      error: (message) => errors.push(message),
      emitFile: (file) => files.push(file),
    });
    return { errors, files };
  };
  const clean = run(true, [join(listed.dir, "index.js?commonjs"), "\0virtual", "/r/src/main.ts"]);
  assert.deepEqual(clean.errors, []);
  assert.deepEqual(clean.files, [{ type: "asset", fileName: "third-party-licences.txt", source: text }]);
  assert.deepEqual(run(false, [join(listed.dir, "index.js")]).files, []);
  const sneaky = run(true, [join(listed.dir, "copied.js")]).errors;
  assert.match(sneaky[0], /names copyright holder "sneaky ltd"/);
  assert.match(run(true, [join(stranger.dir, "index.js")]).errors[0], /stranger\/index\.js is bundled, but its package isn't in the notices/);
});
