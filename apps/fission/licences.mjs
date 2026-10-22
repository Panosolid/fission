// The third-party licence notices the built app carries (audit L2), and the
// licence allowlist CI holds every dependency to.
//
// MIT, BSD, Zlib and Apache-2.0 each ask for their notice to go with every
// copy of the code. The build (vite.config.ts) writes
// `third-party-licences.txt` beside the app from what this finds:
// - npm packages the app depends on at run time (the lockfile's tree from
//   @fission/app's dependencies, through the workspace packages);
// - Rust crates compiled into the kernel's .wasm (`cargo metadata` for
//   wasm32, normal dependencies, not proc-macros and their dependencies,
//   which run only while compiling);
// - code that a package has copied inside itself (EMBEDDED, kept by hand;
//   the build fails if a shipped file names a copyright holder that the
//   notices don't, so a new one can't slip in unlisted).
// `check` holds every npm package and crate in the repository to ALLOWED,
// so no copyleft licence arrives unnoticed and every licence choice stays
// open (audit L4); a development-only tool (never shipped) may also be
// under ALLOWED_DEV_ONLY.
//
//   node licences.mjs check            exit 1 naming each dependency off the list
//   node licences.mjs write <file>     write the notices file
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Licences any dependency may use: all permissive, none asks for source to
 * be shared. Earlier in the list is preferred when a package offers a
 * choice ("MIT OR Apache-2.0" ships as MIT, the shorter notice). Anything
 * else stops CI until the owner decides.
 */
export const ALLOWED = ["MIT", "MIT-0", "0BSD", "ISC", "BSD-2-Clause", "BSD-3-Clause", "Zlib", "BSL-1.0", "Apache-2.0", "Unlicense", "CC0-1.0", "Unicode-3.0", "Unicode-DFS-2016"];
/** Licence exceptions (SPDX `WITH`) that only ever widen what is allowed. */
export const ALLOWED_EXCEPTIONS = ["LLVM-exception"];
/**
 * Licences allowed for development tools only: npm packages and crates that
 * run while building or testing and never ship a byte. MPL-2.0 is a
 * file-level copyleft: changes to the tool's own files must be shared, but
 * what the tool builds is untouched, so it leaves every licence choice for
 * Panosolid open (audit L4). Nothing under these may be bundled: the shipped
 * walks (`npmShipped`, `cratesShipped`), the notices and the build plugin
 * take ALLOWED alone. First use: lightningcss, Vite 8's CSS tool.
 */
export const ALLOWED_DEV_ONLY = ["MPL-2.0"];
/** ALLOWED plus ALLOWED_DEV_ONLY: what a development-only dependency may be under. */
export const ALLOWED_FOR_TOOLS = [...ALLOWED, ...ALLOWED_DEV_ONLY];

/**
 * Parses an SPDX licence expression: ids joined by AND, OR and WITH, with
 * brackets. WITH binds tightest, then AND, then OR. Cargo's old "MIT/Apache-2.0"
 * slash means OR. Returns null for an empty or unreadable expression.
 * @param {string | null | undefined} text
 * @returns {null | { id: string, exception?: string } | { op: "AND" | "OR", parts: any[] }}
 */
export function parseLicence(text) {
  if (typeof text !== "string") return null;
  const tokens = text.replace(/\//g, " OR ").match(/\(|\)|[A-Za-z0-9.+:-]+/g);
  if (!tokens || text.replace(/\(|\)|[A-Za-z0-9.+:-]+|\//g, "").trim() !== "") return null;
  let at = 0;
  const peek = () => tokens[at];
  const word = (w) => peek() !== undefined && peek().toUpperCase() === w;
  function list(op, next) {
    const parts = [next()];
    if (parts[0] === null) return null;
    while (word(op)) {
      at++;
      const part = next();
      if (part === null) return null;
      parts.push(part);
    }
    return parts.length === 1 ? parts[0] : { op, parts };
  }
  function atom() {
    const t = peek();
    if (t === undefined || t === ")" || word("AND") || word("OR") || word("WITH")) return null;
    at++;
    if (t === "(") {
      const inner = list("OR", () => list("AND", atom));
      if (inner === null || peek() !== ")") return null;
      at++;
      return inner;
    }
    const id = t.replace(/\+$/, "");
    if (!word("WITH")) return { id };
    at++;
    const exception = peek();
    if (exception === undefined || exception === "(" || exception === ")") return null;
    at++;
    return { id, exception };
  }
  const tree = list("OR", () => list("AND", atom));
  return tree !== null && at === tokens.length ? tree : null;
}

/**
 * The licences a copy is shipped under: for OR, the allowed alternative
 * ranked best in `allowed` (ALLOWED, or ALLOWED_FOR_TOOLS for a dependency
 * that never ships); for AND, every part. Null when no reading of the
 * expression is fully allowed, which is exactly when CI refuses it.
 * @param {string | null | undefined} text
 * @param {string[]} allowed
 * @returns {string[] | null}
 */
export function chooseLicences(text, allowed = ALLOWED) {
  const rank = (ids) => Math.max(...ids.map((id) => allowed.indexOf(id)));
  function choose(node) {
    if ("id" in node) {
      if (!allowed.includes(node.id)) return null;
      if (node.exception !== undefined && !ALLOWED_EXCEPTIONS.includes(node.exception)) return null;
      return [node.id];
    }
    const picks = node.parts.map(choose);
    if (node.op === "AND") return picks.includes(null) ? null : [...new Set(picks.flat())];
    const usable = picks.filter((p) => p !== null);
    if (usable.length === 0) return null;
    return usable.reduce((best, p) => (rank(p) < rank(best) ? p : best));
  }
  const tree = parseLicence(text);
  return tree === null ? null : choose(tree);
}

const lockfile = (root) => JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")).packages;

/** Where npm would find `name` from the package at `from`: its own node_modules, then each one above it. */
function lockResolve(lock, from, name) {
  let dir = from;
  for (;;) {
    const key = `${dir ? `${dir}/` : ""}node_modules/${name}`;
    if (lock[key]) return key;
    if (!dir) return null;
    const i = dir.lastIndexOf("/node_modules/");
    dir = i < 0 ? "" : dir.slice(0, i);
  }
}

/**
 * npm packages the app needs at run time: the lockfile's tree from
 * @fission/app's dependencies (optional ones too), through the workspace
 * packages (which are ours and not listed).
 * @returns {{ name: string, version: string, licence: string | null, dir: string }[]}
 */
export function npmShipped(root = ROOT) {
  const lock = lockfile(root);
  const seen = new Set();
  const found = new Map();
  function walk(key) {
    if (seen.has(key)) return;
    seen.add(key);
    let entry = lock[key];
    if (entry.link) {
      key = entry.resolved;
      entry = lock[key];
      if (seen.has(key)) return;
      seen.add(key);
    }
    if (key.includes("node_modules/")) {
      const name = entry.name ?? key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
      found.set(key, { name, version: entry.version, licence: entry.license ?? null, dir: join(root, key) });
    }
    for (const dep of Object.keys({ ...entry.dependencies, ...entry.optionalDependencies })) {
      const next = lockResolve(lock, key, dep);
      if (next === null) {
        if (entry.optionalDependencies?.[dep] !== undefined) continue;
        throw new Error(`${dep} (needed by ${key}) is not in package-lock.json`);
      }
      walk(next);
    }
  }
  walk("apps/fission");
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Every npm package in the lockfile, development-only ones too, but not the workspace's own. */
export function npmAll(root = ROOT) {
  return Object.entries(lockfile(root))
    .filter(([key, entry]) => key.includes("node_modules/") && !entry.link)
    .map(([key, entry]) => ({ name: key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length), version: entry.version, licence: entry.license ?? null, dir: join(root, key) }));
}

function cargoMetadata(kernel, platform) {
  const args = ["metadata", "--format-version", "1", "--locked"];
  if (platform) args.push("--filter-platform", platform);
  return JSON.parse(execFileSync("cargo", args, { cwd: kernel, encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "inherit"] }));
}

const crate = (p) => ({ name: p.name, version: p.version, licence: p.license ?? null, dir: dirname(p.manifest_path), authors: p.authors ?? [] });

/**
 * Rust crates compiled into the kernel's .wasm: the normal dependencies of
 * fission-kernel for wasm32, stopping at proc-macro crates (they run in the
 * compiler and leave none of their own code behind).
 */
export function cratesShipped(root = ROOT, metadata = cargoMetadata(join(root, "kernel"), "wasm32-unknown-unknown")) {
  const nodes = new Map(metadata.resolve.nodes.map((n) => [n.id, n]));
  const packages = new Map(metadata.packages.map((p) => [p.id, p]));
  const isProcMacro = (p) => p.targets.some((t) => t.kind.includes("proc-macro"));
  const found = new Map();
  const visit = (id) => {
    for (const dep of nodes.get(id).deps) {
      if (found.has(dep.pkg) || !dep.dep_kinds.some((k) => k.kind === null)) continue;
      const p = packages.get(dep.pkg);
      if (isProcMacro(p)) continue;
      found.set(dep.pkg, crate(p));
      visit(dep.pkg);
    }
  };
  visit(metadata.resolve.root);
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

/** Every crate the kernel's workspace uses on any platform, test-only ones too, but not the kernel itself. */
export function cratesAll(root = ROOT, metadata = cargoMetadata(join(root, "kernel"))) {
  const own = new Set(metadata.workspace_members);
  return metadata.packages.filter((p) => !own.has(p.id)).map(crate);
}

/**
 * Code a shipped package has copied inside itself, with its own notice.
 * Kept by hand; the build's copyright scan (`unlistedHolders`) fails when a
 * shipped file names a holder these and the packages' own files don't.
 */
export const EMBEDDED = [
  {
    inside: "@mlc-ai/web-llm",
    name: "tslib (TypeScript's helpers)",
    licence: "0BSD",
    text: `Copyright (c) Microsoft Corporation.

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.`,
  },
  {
    inside: "@mlc-ai/web-llm",
    name: "Apache TVM's web runtime (tvmjs)",
    licence: "Apache-2.0",
    text: `Apache TVM
Copyright 2019-2024 The Apache Software Foundation

This product includes software developed at
The Apache Software Foundation (http://www.apache.org/).

Licensed to the Apache Software Foundation (ASF) under one or more
contributor license agreements, under the Apache License, Version 2.0
(full text below, with @mlc-ai/web-llm).`,
  },
  {
    inside: "@mlc-ai/web-llm",
    name: "openai-node's request types",
    licence: "Apache-2.0",
    text: `Copyright 2024 OpenAI

Licensed under the Apache License, Version 2.0 (full text below, with
@mlc-ai/web-llm).`,
  },
];

const LICENCE_FILE = /^(licen[cs]e|copying|unlicense)/i;
const NOTICE_FILE = /^(notice|copyright)/i;
/** Which file in a package holds each licence's text, when it ships several. */
const FILE_FOR = { MIT: /^[-_.]?mit\b/i, "MIT-0": /mit/i, "0BSD": /0bsd/i, ISC: /isc/i, "BSD-2-Clause": /bsd/i, "BSD-3-Clause": /bsd/i, Zlib: /zlib/i, "BSL-1.0": /boost|bsl/i, "Apache-2.0": /apache/i, Unlicense: /unlicense/i, "CC0-1.0": /cc0/i, "Unicode-3.0": /unicode/i, "Unicode-DFS-2016": /unicode/i };

/**
 * A package's notice texts for the licences it ships under: the file
 * named for each chosen licence (LICENSE-MIT for MIT), else its one plain
 * licence file; NOTICE and COPYRIGHT files always. Throws when there is no
 * text at all, so the build fails rather than ship a bare name.
 * @param {{ name: string, version: string, licence: string | null, dir: string }} pkg
 */
export function noticeTexts(pkg) {
  const chosen = chooseLicences(pkg.licence);
  if (chosen === null) throw new Error(`${pkg.name} ${pkg.version}: licence ${JSON.stringify(pkg.licence)} is not on the allowed list`);
  const files = readdirSync(pkg.dir).filter((f) => LICENCE_FILE.test(f) || NOTICE_FILE.test(f)).sort();
  const licenceFiles = files.filter((f) => LICENCE_FILE.test(f));
  const plain = licenceFiles.filter((f) => /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(f));
  const picked = new Set();
  for (const id of chosen) {
    // An UNLICENSE file is named for its licence by itself; LICENSE-MIT by its suffix.
    const named = licenceFiles.filter((f) => FILE_FOR[id].test(id === "Unlicense" ? f : f.replace(/^(licen[cs]e|copying)/i, "")));
    // A plain LICENSE stands for the chosen licence only when the package names no other file for one of its parts.
    const use = named.length > 0 ? named : chosen.length === 1 ? plain : [];
    if (use.length === 0) throw new Error(`${pkg.name} ${pkg.version}: no licence file for ${id} in ${pkg.dir}`);
    for (const f of use) picked.add(f);
  }
  for (const f of files.filter((f) => NOTICE_FILE.test(f))) picked.add(f);
  return { chosen, texts: [...picked].sort().map((f) => ({ file: f, text: readFileSync(join(pkg.dir, f), "utf8").replace(/\r\n/g, "\n").trim() })) };
}

/**
 * The notices file: every shipped package with the licence it ships under
 * and that licence's text, each distinct text printed once.
 */
export function noticesFile({ npm, crates, embedded = EMBEDDED, app = "Panosolid" }) {
  const printed = new Map();
  const out = [
    `Third-party licences for ${app}`,
    "",
    `${app} ships code from the packages below. Their licences ask for these`,
    "notices to go with every copy, so here they are, each with the licence",
    "it is shipped under (a package offering a choice ships under the first",
    "one named).",
    "",
  ];
  const section = (title, list) => {
    out.push("=".repeat(76), `${title} (${list.length})`, "=".repeat(76), "");
    for (const pkg of list) {
      const { chosen, texts } = pkg.texts ?? noticeTexts(pkg);
      out.push("-".repeat(76), `${pkg.name}${pkg.version ? ` ${pkg.version}` : ""}${pkg.inside ? `, inside ${pkg.inside}` : ""}: ${chosen.join(" AND ")}${pkg.licence && pkg.licence !== chosen.join(" AND ") ? ` (offered as ${pkg.licence})` : ""}`);
      if (pkg.authors?.length) out.push(`Authors: ${pkg.authors.join(", ")}`);
      out.push("");
      for (const { file, text } of texts) {
        const first = printed.get(text);
        if (first) out.push(`${file}: the same text as ${first}'s, above.`, "");
        else {
          printed.set(text, pkg.name);
          out.push(text, "");
        }
      }
    }
  };
  section("npm packages in the app", npm);
  section("Rust crates in the geometry kernel (kernel/*.wasm)", crates);
  section("Code bundled inside the packages above", embedded.map((e) => ({ ...e, texts: { chosen: [e.licence], texts: [{ file: "notice", text: e.text }] } })));
  return `${out.join("\n").trimEnd()}\n`;
}

/**
 * Each dependency whose licence isn't in `allowed` (ALLOWED for what ships;
 * ALLOWED_FOR_TOOLS for the whole lockfile or crate graph, where the
 * development-only tools live), as "name version: licence".
 */
export function refused(list, allowed = ALLOWED) {
  return list.filter((p) => chooseLicences(p.licence, allowed) === null).map((p) => `${p.name} ${p.version}: ${p.licence ?? "no licence given"}`);
}

/**
 * Copyright holders named in `source` that `notices` doesn't mention: each
 * "Copyright …" (capital C, so licence wording like "copyright ownership"
 * and "COPYRIGHT HOLDERS" isn't taken for a notice), cut to the holder (years, (c), © and "All rights
 * reserved" dropped), looked for case-blind with spaces evened out.
 */
export function unlistedHolders(source, notices) {
  const flat = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const haystack = flat(notices);
  const holders = new Set();
  for (const [, rest] of source.matchAll(/Copyright\b(?:\s*(?:\(c\)|©))?[\s:]*([^\n*]*)/g)) {
    const holder = flat(rest.replace(/all rights reserved.*/i, "").replace(/\b(19|20)\d\d\b(\s*[-,–]\s*(19|20)?\d\d\b)*/g, "").replace(/\(c\)|©/gi, "")).replace(/^(by|the) /, "");
    if (holder.length >= 3 && !/^(notice|holder|holders|owner|law|license|licence|and|statement|notices|year)\b/.test(holder)) holders.add(holder);
  }
  return [...holders].filter((h) => !haystack.includes(h));
}

/** The npm package a bundled file belongs to: its folder under the last node_modules, or null for our own code. */
export function packageDir(file) {
  const at = file.lastIndexOf("/node_modules/");
  if (at < 0) return null;
  const parts = file.slice(at + "/node_modules/".length).split("/");
  return file.slice(0, at + "/node_modules/".length) + parts.slice(0, parts[0].startsWith("@") ? 2 : 1).join("/");
}

let cached = null;
/** The notices for this checkout, worked out once per build. */
function notices() {
  if (cached === null) {
    const npm = npmShipped();
    cached = { npm, text: noticesFile({ npm, crates: cratesShipped() }) };
  }
  return cached;
}

/**
 * The Vite plugin: fails the build when a bundled file comes from an npm
 * package the notices don't list, or names a copyright holder they don't
 * mention; with `emit`, writes the notices beside the app as
 * third-party-licences.txt. The worker build uses it without `emit`.
 * `source` stands in for this checkout's notices in tests.
 */
export function licencesPlugin({ emit, source = notices }) {
  return {
    name: "fission-licences",
    generateBundle() {
      const { npm, text } = source();
      const listed = new Set(npm.map((p) => p.dir));
      const problems = [];
      for (const id of this.getModuleIds()) {
        const file = id.replace(/\?.*$/, "");
        const dir = packageDir(file);
        if (id.startsWith("\0") || dir === null) continue;
        if (!listed.has(dir)) problems.push(`${file} is bundled, but its package isn't in the notices (is it a run-time dependency in a package.json?)`);
        else for (const holder of unlistedHolders(readFileSync(file, "utf8"), text)) problems.push(`${file} names copyright holder "${holder}", which the notices don't (add it to EMBEDDED in apps/fission/licences.mjs)`);
      }
      if (problems.length > 0) this.error(`Third-party licences:\n  ${[...new Set(problems)].join("\n  ")}`);
      if (emit) this.emitFile({ type: "asset", fileName: "third-party-licences.txt", source: text });
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, file] = process.argv.slice(2);
  if (command === "check") {
    // What ships is held to ALLOWED; every dependency, the tools too, to ALLOWED_FOR_TOOLS.
    const bad = [...new Set([...refused(npmShipped()), ...refused(cratesShipped()), ...refused(npmAll(), ALLOWED_FOR_TOOLS), ...refused(cratesAll(), ALLOWED_FOR_TOOLS)])];
    if (bad.length > 0) {
      console.error(`Licences not on the allowed list (apps/fission/licences.mjs, ALLOWED; ALLOWED_DEV_ONLY for tools that never ship):\n  ${bad.join("\n  ")}`);
      process.exit(1);
    }
    console.log(`every shipped npm package and crate is under an allowed licence, and every tool under an allowed or dev-only one`);
  } else if (command === "write" && file) {
    writeFileSync(file, noticesFile({ npm: npmShipped(), crates: cratesShipped() }));
    console.log(`wrote ${file}`);
  } else {
    console.error("usage: node licences.mjs check | write <file>");
    process.exit(2);
  }
}
