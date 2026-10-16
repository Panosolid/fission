import { test } from "node:test";
import assert from "node:assert/strict";
import { BROWSER_RESERVED, CLIPBOARD_CHORDS, chordLabel, chordOf, parseChord, SHELL_SHORTCUTS, ShortcutTable, type KeyPress, type ShortcutSpec } from "../src/model/shortcuts.ts";
import type { WorkspaceId } from "../src/model/project.ts";

const press = (key: string, mods: Partial<KeyPress> = {}): KeyPress => ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });

test("hand-worked: chords are written one way whatever order or case they are given in", () => {
  // Modifiers go Mod, Alt, Shift, then the key; letters become capitals.
  assert.equal(parseChord("shift+mod+z"), "Mod+Shift+Z");
  assert.equal(parseChord("Alt+Mod+s"), "Mod+Alt+S");
  assert.equal(parseChord("esc"), "Escape");
  assert.equal(parseChord("space"), "Space");
  assert.equal(parseChord("Shift+Tab"), "Shift+Tab"); // Shift changes what Tab does, so it stays
  assert.equal(parseChord("?"), "?");
  assert.equal(parseChord("Mod++"), "Mod++"); // Mod and the plus key
  assert.equal(parseChord("+"), "+");
  assert.equal(parseChord("f5"), "F5");
});

test("chords that aren't keys a user can press are refused with the reason", () => {
  assert.throws(() => parseChord("Ctrl+C"), /"Ctrl" is not a modifier \(Mod, Alt or Shift\)/);
  assert.throws(() => parseChord("Mod+Mod+C"), /names Mod twice/);
  assert.throws(() => parseChord("Mod+"), /no key after its modifiers/);
  assert.throws(() => parseChord("Mod+Hello"), /"Hello" is not a key/);
  assert.throws(() => parseChord("Shift+/"), /write the character Shift gives/);
  assert.throws(() => parseChord("Shift+1"), /write the character Shift gives/);
  assert.throws(() => new ShortcutTable([{ id: "x", keys: "Cmd+S", label: "x" }], []), /Shortcut app\/x: "Cmd\+S": "Cmd" is not a modifier/);
});

test("hand-worked: key presses become chords", () => {
  assert.equal(chordOf(press("c", { ctrlKey: true })), "Mod+C");
  assert.equal(chordOf(press("c", { metaKey: true })), "Mod+C", "Cmd on a Mac is Mod too");
  assert.equal(chordOf(press("Z", { ctrlKey: true, shiftKey: true })), "Mod+Shift+Z");
  // "?" is Shift+/ on a US keyboard and Shift+, on a French one: the character decides, not the Shift.
  assert.equal(chordOf(press("?", { shiftKey: true })), "?");
  assert.equal(chordOf(press("Escape")), "Escape");
  assert.equal(chordOf(press("Tab", { shiftKey: true })), "Shift+Tab");
  assert.equal(chordOf(press(" ")), "Space");
  // Alt+C on a Mac types "ç": the key position says it was C.
  assert.equal(chordOf(press("ç", { altKey: true, code: "KeyC" })), "Alt+C");
  // A Russian layout gives "с" for Ctrl+C's key: still Mod+C.
  assert.equal(chordOf(press("с", { ctrlKey: true, code: "KeyC" })), "Mod+C");
  // Without a modifier the character is what was typed (no position fallback).
  assert.equal(chordOf(press("с", { code: "KeyC" })), "С");
  assert.equal(chordOf(press("Shift", { shiftKey: true })), null, "a modifier alone is no chord");
  assert.equal(chordOf(press("Dead")), null);
});

test("hand-worked: labels read as this machine writes them", () => {
  assert.equal(chordLabel("Mod+Shift+Z", false), "Ctrl+Shift+Z");
  assert.equal(chordLabel("Mod+Shift+Z", true), "⌘⇧Z"); // a Mac writes its symbols side by side
  assert.equal(chordLabel("Mod+Alt+S", true), "⌘⌥S");
  assert.equal(chordLabel("Escape", false), "Esc");
  assert.equal(chordLabel("Mod++", false), "Ctrl++");
  assert.equal(chordLabel("+", false), "+");
});

const design: ShortcutSpec[] = [
  { id: "clear", keys: "Escape", label: "Clear" },
  { id: "copy", keys: "Mod+C", label: "Copy as SVG" },
];
// The same keys meaning other things in another workspace: allowed, each workspace keeps its users' keys.
const image: ShortcutSpec[] = [
  { id: "deselect", keys: "Mod+D", label: "Deselect" },
  { id: "copy-pixels", keys: "Mod+C", label: "Copy pixels" },
  { id: "move", keys: "V", label: "Move tool" },
];
const two = (d = design, i = image) => new ShortcutTable(SHELL_SHORTCUTS, [{ id: "design", shortcuts: d }, { id: "image", shortcuts: i }]);

test("hand-worked: a key goes to the workspace in use, then the other on screen, then the app", () => {
  const t = two();
  // Design alone: Mod+C is Design's copy; ? is the app's.
  assert.equal(t.lookup("Mod+C", ["design"])?.id, "copy");
  assert.equal(t.lookup("?", ["design"])?.id, "shortcuts");
  // Split, Image in use: Mod+C is Image's; Escape only Design binds, so Design (on screen too) gets it.
  assert.equal(t.lookup("Mod+C", ["image", "design"])?.scope, "image");
  assert.equal(t.lookup("Escape", ["image", "design"])?.scope, "design");
  // A workspace off screen never gets a key: V is Image's, Image isn't shown.
  assert.equal(t.lookup("V", ["design"]), null);
  assert.equal(t.lookup("Mod+D", []), null, "Community: nothing on screen, Mod+D is no app key");
  assert.equal(t.lookup("Mod+V", []), t.of("app")[1], "the app's paste works with nothing on screen");
});

test("the real shell keys are sound on their own, and the copy/paste chords are the clipboard ones", () => {
  assert.deepEqual(new ShortcutTable(SHELL_SHORTCUTS, []).clashes(), []);
  assert.equal(two().clashes().length, 0, "two workspaces may bind the same key");
  assert.equal(CLIPBOARD_CHORDS.paste, parseChord("Mod+V"));
  assert.equal(CLIPBOARD_CHORDS.copy, parseChord("mod+c"));
});

// Each check broken in exactly its own way, with the specific clash asserted.
test("clashes: one key twice in a workspace", () => {
  const c = two([...design, { id: "clear-2", keys: "esc", label: "Also clear" }]).clashes();
  assert.deepEqual(c.map((x) => [x.kind, x.chord, x.message]), [["duplicate-key", "Escape", "Escape is both design/clear and design/clear-2"]]);
});
test("clashes: one id twice in a workspace", () => {
  const c = two([...design, { id: "copy", keys: "Mod+Shift+C", label: "Copy again" }]).clashes();
  assert.deepEqual(c.map((x) => [x.kind, x.message]), [["duplicate-id", "design/copy is declared twice"]]);
});
test("clashes: a workspace taking the app's key", () => {
  const c = two(design, [...image, { id: "help", keys: "?", label: "Image help" }]).clashes();
  assert.deepEqual(c.map((x) => [x.kind, x.message]), [["shadows-app", "image/help takes ? from the app's shortcuts"]]);
  // Mod+V too (the app's paste), written another way.
  assert.deepEqual(two([...design, { id: "paste", keys: "mod+v", label: "Paste" }]).clashes().map((x) => x.kind), ["shadows-app"]);
});
test("clashes: a key the browser keeps (new document, close, new tab)", () => {
  const c = two(design, [...image, { id: "new", keys: "Mod+N", label: "New image" }, { id: "close", keys: "Mod+W", label: "Close" }]).clashes();
  assert.deepEqual(c.map((x) => [x.kind, x.chord]), [["browser-reserved", "Mod+N"], ["browser-reserved", "Mod+W"]]);
  // Every reserved chord is itself a canonical chord, so the comparison can match.
  for (const r of BROWSER_RESERVED) assert.equal(parseChord(r), r);
});

test("the help list puts the workspaces on screen first, then the app, then the rest; scopes with no keys left out", () => {
  const t = new ShortcutTable(SHELL_SHORTCUTS, [{ id: "design", shortcuts: design }, { id: "slice" }, { id: "image", shortcuts: image }]);
  assert.deepEqual(t.help(["image"]).map((g) => [g.scope, g.onScreen, g.entries.length]), [["image", true, 3], ["app", false, 2], ["design", false, 2]]);
  assert.deepEqual(t.help(["slice", "design"]).map((g) => g.scope), ["design", "app", "image"]);
  assert.deepEqual(t.help([]).map((g) => g.scope), ["app", "design", "image"]);
});

// SplitMix64, as in packages/testing (core can't import it: testing imports core).
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

test("seeded random tables and key presses match a simple model of lookup and clashes", () => {
  const keys = ["a", "b", "z", "1", "?", "Escape", "Tab", "F2", "Delete", "n", "w"];
  const ids: WorkspaceId[] = ["design", "image", "slice"];
  for (const seed of [0x5eedn, 1n, 2n, 3n, 0xdeadbeefn]) {
    const next = rng(seed);
    const pick = <T>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)];
    for (let round = 0; round < 200; round++) {
      // A random press, and the chord it should make worked out by the rules.
      const key = pick(keys);
      const mods = { ctrlKey: next() < 0.3, metaKey: next() < 0.2, altKey: next() < 0.2, shiftKey: next() < 0.3 };
      const symbol = key === "?" || key === "1";
      const expected = [mods.ctrlKey || mods.metaKey ? "Mod" : "", mods.altKey ? "Alt" : "", mods.shiftKey && !symbol ? "Shift" : "", key.length === 1 ? key.toUpperCase() : key].filter(Boolean).join("+");
      const made = chordOf(press(key, mods));
      assert.equal(made, expected, `seed ${seed} round ${round}`);
      assert.equal(parseChord(made!), made, `seed ${seed}: a chord from a press reads back as itself`);

      // A random table (as specs written in random case and order) and the model's view of it.
      const specs = (n: number) =>
        Array.from({ length: n }, (_, i): ShortcutSpec => {
          const k = pick(keys);
          const m = ["Mod", "Alt", "Shift"].filter(() => next() < 0.3).filter((x) => !(x === "Shift" && (k === "?" || k === "1")));
          const written = [...m.sort(() => next() - 0.5), next() < 0.5 ? k.toLowerCase() : k].map((p) => (next() < 0.5 ? p.toLowerCase() : p)).join("+");
          return { id: `s${i}`, keys: written, label: "x" };
        });
      const app = specs(2);
      const ws = ids.map((id) => ({ id, shortcuts: specs(4) }));
      const t = new ShortcutTable(app, ws);
      const all = [...app.map((s) => ({ scope: "app", s })), ...ws.flatMap((w) => w.shortcuts.map((s) => ({ scope: w.id as string, s })))];
      const chordOfSpec = (s: ShortcutSpec) => {
        const parts = s.keys.split("+");
        const k = parts.pop()!;
        const set = new Set(parts.map((p) => p.toLowerCase()));
        const key = k.length === 1 ? k.toUpperCase() : keys.find((x) => x.toLowerCase() === k.toLowerCase())!;
        return [set.has("mod") ? "Mod" : "", set.has("alt") ? "Alt" : "", set.has("shift") ? "Shift" : "", key].filter(Boolean).join("+");
      };
      const onScreen = ids.filter(() => next() < 0.5).sort(() => next() - 0.5);
      // Model lookup: scan the scopes in order, first match in declaration order.
      const model = [...onScreen, "app"].map((scope) => all.find((e) => e.scope === scope && chordOfSpec(e.s) === made)).find(Boolean);
      const got = t.lookup(made!, onScreen);
      assert.equal(got ? `${got.scope}/${got.id}` : null, model ? `${model.scope}/${model.s.id}` : null, `seed ${seed} round ${round}`);
      // Model clash count: pairs in one scope with one chord (each later one counted once
      // against the first), app-vs-workspace pairs, and reserved chords.
      let count = 0;
      const firsts = new Set<string>();
      for (const e of all) {
        const c = chordOfSpec(e.s);
        if (firsts.has(`${e.scope} ${c}`)) count++;
        else firsts.add(`${e.scope} ${c}`);
        if (BROWSER_RESERVED.includes(c)) count++;
      }
      for (const a of all.filter((e) => e.scope === "app")) count += all.filter((e) => e.scope !== "app" && chordOfSpec(e.s) === chordOfSpec(a.s)).length;
      assert.equal(t.clashes().length, count, `seed ${seed} round ${round}: clash count`);
    }
  }
});
