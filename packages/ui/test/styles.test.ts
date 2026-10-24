import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Feature styles live one file per feature (src/styles/<feature>.css) so two
// threads adding features never edit the same file. That only works if each
// file styles its own feature alone: every rule's selectors start with
// .<feature>, so load order never matters.
const repo = resolve(import.meta.dirname, "../../..");
const dirs = [join(repo, "packages/ui/src/styles"), ...readdirSync(join(repo, "workspaces")).map((w) => join(repo, "workspaces", w, "src/styles"))];

/** A selector list split at its own commas, not those inside :is(…) or :not(…). */
function topLevel(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < list.length; i++) {
    if (list[i] === "(") depth++;
    else if (list[i] === ")") depth--;
    else if (list[i] === "," && depth === 0) {
      parts.push(list.slice(from, i));
      from = i + 1;
    }
  }
  return [...parts, list.slice(from)];
}

/** Selectors of every top-level rule (comments and @-rules' own lines skipped). */
export function selectors(css: string): string[] {
  const body = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: string[] = [];
  for (const m of body.matchAll(/([^{}]+)\{/g)) {
    const head = m[1].trim();
    if (head.startsWith("@")) continue;
    out.push(...topLevel(head).map((s) => s.trim()));
  }
  return out;
}

export function strays(name: string, css: string): string[] {
  return selectors(css).filter((s) => s !== `.${name}` && !new RegExp(`^\\.${name}[.:\\s\\[>]`).test(s));
}

test("selectors are read by hand-worked example", () => {
  // Two rules, one with two selectors, a comment with a brace-like { in it,
  // and a media query whose own line is skipped: four selectors.
  const css = "/* a { b */ .x { c: d; }\n.x:hover, .x .y { e: f; }\n@media (max-width: 9px) { .x.z { g: h; } }";
  assert.deepEqual(selectors(css), [".x", ".x:hover", ".x .y", ".x.z"]);
});

test("a comma inside :is(…) or :not(…) is part of its selector, not a new one (hand-worked)", () => {
  // Two selectors: the first holds two commas in brackets, the second one in :not(…).
  const css = ".x :is(.a, .b:not(.c, .d)) { } .x:not(:hover, :focus) { }";
  assert.deepEqual(selectors(css), [".x :is(.a, .b:not(.c, .d))", ".x:not(:hover, :focus)"]);
  // A stray hidden after a bracket's comma is still found: the list's own comma splits it off.
  assert.deepEqual(strays("x", ".x :is(.a, .b), .y { }"), [".y"]);
});

test("a selector for another feature, or a bare element, is caught", () => {
  assert.deepEqual(strays("change-note", ".change-note { } .change-note.updated { }"), []);
  assert.deepEqual(strays("change-note", ".change-notes { }"), [".change-notes"]);
  assert.deepEqual(strays("change-note", "button { }"), ["button"]);
  assert.deepEqual(strays("change-note", ".change-note, .link-badge { }"), [".link-badge"]);
});

test("every feature style file styles only its own feature", () => {
  let files = 0;
  for (const dir of dirs) {
    let names: string[];
    try {
      names = readdirSync(dir).filter((f) => f.endsWith(".css"));
    } catch {
      continue;
    }
    for (const f of names) {
      files++;
      const name = f.slice(0, -4);
      assert.deepEqual(strays(name, readFileSync(join(dir, f), "utf8")), [], `${f} styles something other than .${name}`);
    }
  }
  assert.ok(files >= 3, "the feature style files were not found");
});

test("the base theme keeps no feature's styles", () => {
  const theme = readFileSync(join(repo, "packages/ui/src/theme.css"), "utf8");
  for (const f of readdirSync(join(repo, "packages/ui/src/styles"))) {
    assert.ok(!theme.includes(`.${f.slice(0, -4)}`), `theme.css still styles .${f.slice(0, -4)}`);
  }
});
