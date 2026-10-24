// Tests written to kill the mutants StrykerJS found surviving in the rest
// of core's model (2026-10-22; run it again with
// packages/testing/stryker/run.sh model). Each test names the change to the
// code it catches. Mutants that change nothing a caller can see are listed,
// with the reason, in packages/testing/stryker/explained.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ActionRegistry, type Action } from "../src/model/actions.ts";
import { ChangeNotes } from "../src/model/change-notes.ts";
import { commandListSchema, parseCommand, parseCommandList } from "../src/model/commands.ts";
import { DownstreamRegistry, type DownstreamSource } from "../src/model/downstream.ts";
import { DependencyGraph, type GraphNode } from "../src/model/graph.ts";
import { claimedFormat, FILE_FORMATS, HEAD_BYTES, identifyFile, type FileFormat, type FileHead, type Identified } from "../src/model/files.ts";
import { fetchLinked, type FrozenCopy } from "../src/model/links.ts";
import { linkedValue, proposeEdit, TRANSFER_OWNERSHIP, transferOwnership } from "../src/model/ownership.ts";
import type { WorkspaceId } from "../src/model/project.ts";
import { chordOf, parseChord, SHELL_SHORTCUTS, ShortcutTable, type KeyPress } from "../src/model/shortcuts.ts";

const is = (format: FileFormat): Identified => ({ ok: true, format });
const renamed = (claimed: FileFormat): Identified => ({ ok: false, reason: "renamed", claimed });
const node = (id: string, cost: GraphNode["cost"] = "cheap"): GraphNode => ({ id, label: id, workspace: "design", cost });

// ---------- actions.ts, downstream.ts: ids ----------

test("an action or summary id with anything after the name is refused, not just one that starts wrong", () => {
  // Kills ID's `$` anchor removed in both files: /^[a-z]+\.[a-z0-9-]+/ matches the start of
  // "design.download stl" and would accept it.
  const verb: Action = { id: "design.download stl", workspace: "design", label: "x", title: "", kinds: ["body"], uses: "mesh", count: "one", run: async () => ({ message: "", bad: false }) };
  assert.throws(() => new ActionRegistry().register(verb), /must be "design\.<verb>" in lower case/);
  const summary: DownstreamSource = { id: "slice.print time", workspace: "slice", node: "n", label: "Print time", value: () => "1 h", preview: () => "" };
  assert.throws(() => new DownstreamRegistry().register(summary), /must be "slice\.<name>" in lower case/);
});

// ---------- change-notes.ts ----------

test("a change note's cause whose label is only spaces is refused", () => {
  // Kills `cause.label.trim()` => `cause.label`.
  const g = new DependencyGraph();
  g.set(node("thickness"));
  assert.throws(
    () => new ChangeNotes().record({ node: "thickness", label: "   ", workspace: "design", change: "you changed it" }, g.changed("thickness"), g),
    /a change note's cause thickness needs a label/,
  );
});

// ---------- graph.ts ----------

test("a node can't read itself, even when nothing reads it yet", () => {
  // Kills `d === node.id` => false: with no readers the walk is skipped, so only this catches a
  // node set to read itself.
  const g = new DependencyGraph();
  g.set(node("a"));
  assert.throws(() => g.set(node("a"), ["a"]), /a would depend on itself through a/);
});

test("one change with a cheap and an expensive reader tells the listeners once", () => {
  // Kills `updateNow.length + awaitingRerun.length` => `-`: 1 - 1 = 0 would tell nobody.
  const g = new DependencyGraph();
  g.set(node("w"));
  g.set(node("mesh", "cheap"), ["w"]);
  g.set(node("stress", "expensive"), ["w"]);
  let told = 0;
  g.onChange(() => told++);
  const s = g.changed("w");
  assert.deepEqual([s.updateNow, s.awaitingRerun], [["mesh"], ["stress"]]);
  assert.equal(told, 1);
});

test("downstreamOf visits each id once: 40 diamonds in a row take a moment, not 2^40 steps", { timeout: 10_000 }, () => {
  // Kills `if (seen.has(n)) continue` => false. Each diamond is top -> left, right -> bottom, the
  // bottom being the next top: 2 ways through each, so 2^40 paths from the first top to the last
  // bottom. Visiting each id once is 1 + 3 * 40 = 121 ids (the first top is not its own reader).
  const g = new DependencyGraph();
  g.set(node("t0"));
  for (let i = 0; i < 40; i++) {
    g.set(node(`l${i}`), [`t${i}`]);
    g.set(node(`r${i}`), [`t${i}`]);
    g.set(node(`t${i + 1}`), [`l${i}`, `r${i}`]);
  }
  assert.equal(g.downstreamOf("t0").size, 120);
});

// ---------- links.ts ----------

test("asking a frozen copy for what its link shows says it is not a live link", async () => {
  // Kills `status.state === "unresolved"` => true (and "not a live link" => ""): a frozen copy
  // has no warning, so the message would be empty.
  const frozen = { id: "l1", mode: "frozen", source: {}, representation: {} } as unknown as FrozenCopy;
  await assert.rejects(fetchLinked(frozen as never, (() => undefined) as never, {} as never), { message: "not a live link" });
});

// ---------- ownership.ts ----------

test("every one of the ten workspaces can own a linked value", () => {
  // Kills each workspace name in WORKSPACES => "".
  const all: WorkspaceId[] = ["design", "render", "simulate", "manufacture", "laser", "slice", "circuit", "vector", "image", "layout"];
  for (const w of all) assert.equal(linkedValue("v", "V", 1, "mm", w).owner, w);
});

test("a true/false linked value is accepted", () => {
  // Kills `typeof value === "boolean"` => false and "boolean" => "".
  assert.equal(linkedValue("mirror", "Mirror", true, "", "design").value, true);
});

test("a suggestion shows the unit only for a number with a unit (worked by hand)", () => {
  // Kills `v.unit && typeof x === "number"` => true / => `||` / `typeof x === "number"` => true.
  // A number with a unit reads "45 mm"; a number with no unit "3" (not "3 "); text with a unit
  // (the unit names what the text means) reads as the text alone.
  const by = "circuit" as const;
  const cmd = (v: unknown) => ({ op: "set", value: v });
  const specs = [{ op: "set", summary: "set", params: { value: { type: "text" as const, maxLength: 50, description: "v" } } }];
  const spacing = linkedValue("s", "Hole spacing", 40, "mm", "design");
  const count = linkedValue("c", "Holes", 2, "", "design");
  const finish = linkedValue("f", "Finish", "matte", "style", "design");
  const summary = (v: ReturnType<typeof linkedValue>, x: number | string) => {
    const r = proposeEdit("p", v, by, x, cmd(String(x)), specs);
    assert.equal(r.kind, "proposed", JSON.stringify(r));
    return r.kind === "proposed" ? r.proposal.summary : "";
  };
  assert.equal(summary(spacing, 45), "Circuit suggests Hole spacing 45 mm (now 40 mm). Owned by Design.");
  assert.equal(summary(count, 3), "Circuit suggests Holes 3 (now 2). Owned by Design.");
  assert.equal(summary(finish, "gloss"), "Circuit suggests Finish gloss (now matte). Owned by Design.");
});

test("the hand-over command takes a value id as text of at most 200 characters", () => {
  // Kills TRANSFER_OWNERSHIP's `value` param => {} and its type "text" => "": the command reader
  // would let any value through.
  const ok = transferOwnership(linkedValue("s", "Hole spacing", 40, "mm", "design"), "circuit");
  assert.ok(ok.ok);
  if (ok.ok) assert.equal(parseCommand(ok.command, [TRANSFER_OWNERSHIP]).ok, true);
  assert.equal(parseCommand({ op: "transfer_ownership", value: 5, to: "circuit" }, [TRANSFER_OWNERSHIP]).ok, false);
  assert.equal(parseCommand({ op: "transfer_ownership", value: "x".repeat(201), to: "circuit" }, [TRANSFER_OWNERSHIP]).ok, false);
  assert.equal(parseCommand({ op: "transfer_ownership", value: "x".repeat(200), to: "circuit" }, [TRANSFER_OWNERSHIP]).ok, true);
});

// ---------- commands.ts: the checks every AI answer goes through ----------

const spec = {
  op: "tune",
  summary: "Tune a thing.",
  params: {
    count: { type: "number" as const, min: 2, max: 10, description: "how many" },
    free: { type: "number" as const, description: "any number", optional: true },
    note: { type: "text" as const, maxLength: 5, description: "a note", optional: true },
    target: { type: "reference" as const, to: "body" as const, description: "which body", optional: true },
    depth: { type: "length" as const, description: "how deep", optional: true },
  },
};
const tune = (over: Record<string, unknown>) => parseCommand({ op: "tune", count: 5, ...over }, [spec]);
const refused = (over: Record<string, unknown>) => {
  const r = tune(over);
  return r.ok ? "accepted" : r.error;
};

test("a number parameter: inside its range, at both ends, and one step past each (worked by hand)", () => {
  // Kills every mutant of the number check's min and max lines (`<` for `<=`, `||` for `&&`, each
  // half => true/false, the messages => ""). Range 2..10: 2 and 10 are in, 1.999 and 10.001 out.
  assert.equal(refused({ count: 2 }), "accepted");
  assert.equal(refused({ count: 10 }), "accepted");
  assert.equal(refused({ count: 1.999 }), "tune: count must be at least 2, got 1.999");
  assert.equal(refused({ count: 10.001 }), "tune: count must be at most 10, got 10.001");
  // With no min or max any finite number goes, even far out.
  assert.equal(refused({ free: -1e300 }), "accepted");
  assert.equal(refused({ free: 1e300 }), "accepted");
});

test("a number parameter refuses what is not a finite number, with what it got", () => {
  // Kills `typeof v !== "number" || !Number.isFinite(v)` and its parts, and the message => "".
  assert.equal(refused({ count: "5" }), 'tune: count must be a number, got "5"');
  assert.equal(refused({ count: Infinity }), "tune: count must be a number, got null");
  assert.equal(refused({ count: NaN }), "tune: count must be a number, got null");
  assert.equal(refused({ free: true }), "tune: free must be a number, got true");
});

test("a length must be above 0: 0 is refused, the smallest positive number is not", () => {
  // Kills `v > 0` => `v >= 0` and `typeof v === "number"` => true (a numeric string would pass
  // `"3" > 0`).
  assert.equal(refused({ depth: 0 }), "tune: depth must be a length in mm greater than 0, got 0");
  assert.equal(refused({ depth: Number.MIN_VALUE }), "accepted");
  assert.equal(refused({ depth: "3" }), 'tune: depth must be a length in mm greater than 0, got "3"');
});

test("text: exactly maxLength characters pass, one more is refused, and only text counts", () => {
  // Kills `v.length <= p.maxLength` => `<` and `typeof v === "string"` => true (an array of 5
  // has a length too).
  assert.equal(refused({ note: "abcde" }), "accepted");
  assert.equal(refused({ note: "abcdef" }), "tune: note must be text of at most 5 characters");
  assert.equal(refused({ note: ["a"] }), "tune: note must be text of at most 5 characters");
});

test("a reference: 1 to 200 characters of text", () => {
  // Kills `v.length > 0` => true / => `>=` and `v.length <= 200` => true / => `<`.
  assert.equal(refused({ target: "b" }), "accepted");
  assert.equal(refused({ target: "b".repeat(200) }), "accepted");
  assert.equal(refused({ target: "" }), 'tune: target must be the stable id of a body, got ""');
  assert.match(refused({ target: "b".repeat(201) }), /^tune: target must be the stable id of a body, got "b{39}…$/);
});

test("what a refusal shows of a long or odd value: 40 characters then …, or the value's own words", () => {
  // Kills show()'s `s.length > 40` => false / => `>=`, the slice => s, the template => "", and
  // `s === undefined` => false and its catch => {}. JSON of "x" * 38 is 40 characters with its
  // quotes, so it shows whole; "x" * 39 is 41, so it shows its first 40 and "…".
  assert.equal(refused({ count: "x".repeat(38) }), `tune: count must be a number, got "${"x".repeat(38)}"`);
  assert.equal(refused({ count: "x".repeat(39) }), `tune: count must be a number, got "${"x".repeat(39)}…`);
  // JSON.stringify of a symbol gives undefined, so it shows as String(v).
  assert.equal(refused({ count: Symbol.for("s") }), "tune: count must be a number, got Symbol(s)");
  // A BigInt can't be turned into JSON (it throws), so it shows as String(10n) = "10".
  assert.equal(refused({ count: 10n }), "tune: count must be a number, got 10");
});

test("a command that is not an object, an unknown one, and one missing a parameter", () => {
  // Kills `typeof raw !== "object"` => false (a string has no op, so it would read as unknown),
  // the list's ", " => "", and `obj[name] === undefined` => false (an explicit undefined must
  // count as missing).
  assert.deepEqual(parseCommand("tune", [spec]), { ok: false, error: 'a command must be an object, got "tune"' });
  const other = { op: "other", summary: "", params: {} };
  assert.deepEqual(parseCommand({ op: "nope" }, [spec, other]), { ok: false, error: 'unknown command "nope"; known: tune, other' });
  assert.deepEqual(parseCommand({ op: "tune", count: undefined }, [spec]), { ok: false, error: "tune needs count" });
});

test("an answer of exactly 50 commands is read, 51 are refused; null and a list of none (worked by hand)", () => {
  // Kills `list.length > 50` => `>=` and `false` => `true` in its result, `commands = []` =>
  // ["Stryker was here"], and `?.commands` => `.commands` (JSON "null" would throw).
  const many = (n: number) => JSON.stringify({ commands: Array.from({ length: n }, () => ({ op: "tune", count: 3 })) });
  const fifty = parseCommandList(many(50), [spec]);
  assert.equal(fifty.ok && fifty.commands.length, 50);
  assert.deepEqual(parseCommandList(many(51), [spec]), { ok: false, error: "too many commands in one answer (at most 50)" });
  assert.deepEqual(parseCommandList(many(0), [spec]), { ok: true, commands: [] });
  assert.deepEqual(parseCommandList("null", [spec]), { ok: false, error: 'the answer must be an object with a "commands" list' });
});

test("the schemas the model is given, worked by hand from the descriptions", () => {
  // Kills every mutant of paramSchema's number case (minimum/maximum only when set) and of
  // commandListSchema (each key, "object", "array", ["commands"]).
  const one = { op: "n", summary: "N.", params: { a: { type: "number" as const, min: 1, description: "a" }, b: { type: "number" as const, max: 9, description: "b" }, c: { type: "number" as const, description: "c" } } };
  assert.deepEqual(commandListSchema([one]), {
    type: "object",
    properties: {
      commands: {
        type: "array",
        items: {
          oneOf: [
            {
              type: "object",
              description: "N.",
              properties: {
                op: { const: "n" },
                a: { type: "number", minimum: 1, description: "a" },
                b: { type: "number", maximum: 9, description: "b" },
                c: { type: "number", description: "c" },
              },
              required: ["op", "a", "b", "c"],
              additionalProperties: false,
            },
          ],
        },
      },
    },
    required: ["commands"],
    additionalProperties: false,
  });
});

// ---------- shortcuts.ts ----------

test("every named key is understood whatever its case, and written one way", () => {
  // Kills each name in NAMED_KEYS => "" (except Space, which canonicalKey also catches by itself).
  const named = ["Escape", "Enter", "Tab", "Backspace", "Delete", "Insert", "Home", "End", "PageUp", "PageDown", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "F1", "F12"];
  for (const k of named) {
    assert.equal(parseChord(k.toLowerCase()), k);
    assert.equal(parseChord(`mod+${k.toUpperCase()}`), `Mod+${k}`);
  }
});

test("only a final '++' is the plus key: an empty part before another key is refused", () => {
  // Kills `parts.at(-1) === ""` => true, the `&&` => `||`, and `at(-1)` => `at(+1)`.
  assert.equal(parseChord("Mod++"), "Mod++");
  assert.equal(parseChord("Alt+Mod++"), "Mod+Alt++");
  assert.throws(() => parseChord("Mod++A"), /"Mod\+\+A": "" is not a modifier/);
});

test("with Alt held, a dead key or a typed symbol is read from the key's position", () => {
  // Kills both anchors of /^[a-z0-9]$/i ("Dead" starts and ends with a letter) and
  // Digit([0-9]) => Digit([^0-9]). Mac Alt+E is the dead key for an accent: key "Dead", code
  // KeyE, so the chord is Alt+E. Ctrl+Shift+1 on a US keyboard is key "!", code Digit1: Mod+1
  // (the digit carries no Shift of its own, as a symbol doesn't).
  const press = (key: string, code: string, mods: Partial<KeyPress>) => chordOf({ key, code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });
  assert.equal(press("Dead", "KeyE", { altKey: true }), "Alt+E");
  assert.equal(press("!", "Digit1", { ctrlKey: true, shiftKey: true }), "Mod+1");
  // Only a whole KeyX or DigitN code counts.
  assert.equal(press("ç", "MyKeyC", { altKey: true }), "Alt+Ç");
  assert.equal(press("ç", "KeyCC", { altKey: true }), "Alt+Ç");
});

test("the shell's own keys, by id: the shell runs each by its id, so they must not change", () => {
  // Kills the shell table's ids and labels => "".
  assert.deepEqual(
    SHELL_SHORTCUTS.map((s) => [s.id, s.keys, s.label]),
    [
      ["shortcuts", "?", "Show the keyboard shortcuts"],
      ["paste-files", "Mod+V", "Paste files into the project (a project file, an image…)"],
      ["undo", "Mod+Z", "Undo"],
      ["redo", "Mod+Shift+Z", "Redo"],
      ["redo-y", "Mod+Y", "Redo"],
    ],
  );
});

test("the help list marks only workspaces as on screen, never the app's own keys", () => {
  // Kills `scope !== "app"` => true and "app" => "".
  const t = new ShortcutTable([{ id: "help", keys: "?", label: "Help" }], [{ id: "design", shortcuts: [{ id: "line", keys: "L", label: "Line" }] }]);
  assert.deepEqual(
    t.help(["design"]).map((s) => [s.scope, s.onScreen]),
    [["design", true], ["app", false]],
  );
});

test("every kind of clash names both entries involved and says what is wrong", () => {
  // Kills [first, e], [sameId, e], [e] and [a, w] => [] and the browser-reserved message => "".
  const t = new ShortcutTable(
    [{ id: "undo", keys: "Mod+Z", label: "Undo" }],
    [{ id: "design", shortcuts: [{ id: "line", keys: "L", label: "Line" }, { id: "line", keys: "Shift+L", label: "Line again" }, { id: "circle", keys: "l", label: "Circle" }, { id: "back", keys: "Mod+Z", label: "Back" }, { id: "close", keys: "Mod+W", label: "Close" }] }],
  );
  const ids = (c: { entries: { scope: string; id: string }[] }) => c.entries.map((e) => `${e.scope}/${e.id}`);
  assert.deepEqual(
    t.clashes().map((c) => [c.kind, c.chord, ids(c), c.message]),
    [
      ["duplicate-id", "Shift+L", ["design/line", "design/line"], "design/line is declared twice"],
      ["duplicate-key", "L", ["design/line", "design/circle"], "L is both design/line and design/circle"],
      ["browser-reserved", "Mod+W", ["design/close"], "design/close uses Mod+W, which the browser keeps for itself"],
      ["shadows-app", "Mod+Z", ["app/undo", "design/back"], "design/back takes Mod+Z from the app's undo"],
    ],
  );
});

// ---------- files.ts: telling what a dropped file is ----------

const fileOf = (name: string, s: string | Uint8Array, size?: number): FileHead => {
  const head = typeof s === "string" ? new Uint8Array([...s].map((c) => c.charCodeAt(0))) : s;
  return { name, size: size ?? head.length, head };
};

test("the format table, as refusals and lists word it", () => {
  // Kills each name, representation and planned use => "" and the PDF's [".pdf"] => [].
  assert.deepEqual(
    FILE_FORMATS.map((f) => [f.format, f.one, f.many, f.extensions.join(" "), f.representation, f.planned.workspaces.join(" "), f.planned.as]),
    [
      ["project", "a SpindleLabs project", "SpindleLabs projects (.spindlelabs.json)", ".spindlelabs.json .panosolid.json .fission.json", null, "", "projects"],
      ["png", "a PNG image", "PNG images", ".png", "image", "image", "images"],
      ["jpeg", "a JPEG image", "JPEG images", ".jpg .jpeg", "image", "image", "images"],
      ["svg", "an SVG drawing", "SVG drawings", ".svg", "outline", "vector laser", "outlines"],
      ["dxf", "a DXF drawing", "DXF drawings", ".dxf", "outline", "laser", "outlines"],
      ["stl", "an STL mesh", "STL meshes", ".stl", "mesh", "design", "mesh bodies"],
      ["step", "a STEP model", "STEP models", ".step .stp", "solid", "design", "exact solids"],
      ["pdf", "a PDF document", "PDF documents", ".pdf", "outline", "layout", "pages"],
    ],
  );
  assert.equal(claimedFormat("plan.PDF"), "pdf");
});

test("the shell reads the first 64 KiB of a file before routing it", () => {
  // Kills 64 * 1024 => 64 / 1024.
  assert.equal(HEAD_BYTES, 65536);
});

test("SVG sniffing: an unclosed '<?' or '<!DOCTYPE', a lower-case doctype, and '<svg' exactly at the end", { timeout: 10_000 }, () => {
  // Kills `indexOf("?>", i + 2)` => `i - 2` ("<?>" holds "?>" only at 1, inside the opening),
  // `startsWith("<!doctype")` => endsWith, `end < 0` => false (an unclosed doctype would loop
  // for ever), `i + 4 === t.length` => false, and `t[i + 4]` => `t[i - 4]` (the space at 4 in
  // "<!-- -->" would let "<svgfoo" pass).
  assert.deepEqual(identifyFile(fileOf("a.svg", "<?><svg/>")), renamed("svg"));
  assert.deepEqual(identifyFile(fileOf("a", "<!doctype svg><svg/>")), is("svg"));
  assert.deepEqual(identifyFile(fileOf("a.svg", "<!DOCTYPE svg <svg/")), renamed("svg"));
  assert.deepEqual(identifyFile(fileOf("a", "<svg")), is("svg"));
  assert.deepEqual(identifyFile(fileOf("a.svg", "<!-- --><svgfoo/>")), renamed("svg"));
});

test("an STL named file whose head was cut short is refused, not read past its end", () => {
  // Kills `file.size < 84 || file.head.length < 84` => `&&` and its second half => false: a
  // 134-byte file whose head holds only 10 bytes would make DataView read bytes 80-83 of 10 and
  // throw, and identifyFile must never throw.
  assert.deepEqual(identifyFile(fileOf("part.stl", new Uint8Array(10), 134)), renamed("stl"));
});

test("an ASCII STL starts with 'solid' (after spaces only); a DXF with 0 then SECTION", () => {
  // Kills the ^ of /^\s*solid(\s|$)/ and `lines[0] === "0"` => true.
  assert.deepEqual(identifyFile(fileOf("part.stl", "  solid cube\n")), is("stl"));
  assert.deepEqual(identifyFile(fileOf("part.stl", "not solid\n")), renamed("stl"));
  assert.deepEqual(identifyFile(fileOf("plan.dxf", "\n  0\nSECTION\n")), is("dxf"));
  assert.deepEqual(identifyFile(fileOf("plan.dxf", "1\nSECTION\n")), renamed("dxf"));
});

// ---------- leftovers from the second run ----------

test("an id whose verb holds a second dot is refused, though its end alone looks like an id", () => {
  // Kills ID's `^` anchor removed in both files: /[a-z]+\.[a-z0-9-]+$/ finds "download.stl"
  // at the end of "design.download.stl" and would accept it, while the whole id has a second
  // dot that [a-z0-9-]+ after the first one can't take.
  const verb: Action = { id: "design.download.stl", workspace: "design", label: "x", title: "", kinds: ["body"], uses: "mesh", count: "one", run: async () => ({ message: "", bad: false }) };
  assert.throws(() => new ActionRegistry().register(verb), /must be "design\.<verb>" in lower case/);
  const summary: DownstreamSource = { id: "slice.print.time", workspace: "slice", node: "n", label: "Print time", value: () => "1 h", preview: () => "" };
  assert.throws(() => new DownstreamRegistry().register(summary), /must be "slice\.<name>" in lower case/);
});

test("'<!-->' does not close the comment it opens, so what follows is still inside it", () => {
  // Kills `indexOf("-->", i + 4)` => `i - 4`: searching from before the opening finds the
  // "-->" made by the opening's own "--" and the ">" after it (characters 2-4), and would
  // read "<svg/>" as the first element. In XML a comment's "--" must come after "<!--".
  assert.deepEqual(identifyFile(fileOf("a.svg", "<!--><svg/>")), renamed("svg"));
  // The same text closed properly a little later is an SVG.
  assert.deepEqual(identifyFile(fileOf("a", "<!-->--><svg/>")), is("svg"));
});

test("the hand-over command's words, which the assistant reads to know what it does", () => {
  // Kills each of the three strings => "": the summary and both parameter descriptions are
  // the only explanation the model gets of transfer_ownership.
  assert.equal(TRANSFER_OWNERSHIP.summary, "Hand one linked value to another workspace, which then owns it: only the owner changes it, the other side suggests changes.");
  assert.equal(TRANSFER_OWNERSHIP.params.value.description, "id of the linked value");
  assert.equal(TRANSFER_OWNERSHIP.params.to.description, "the workspace that will own it");
});

test("what a node reads after its input was removed is just that dangling id", () => {
  // Kills `this.inputs.get(x) ?? []` => `?? ["Stryker was here"]` in upstreamOf: the removed
  // "a" has no inputs of its own, so the walk must stop there. Worked by hand: b reads a, a
  // goes, so b's upstream is {a}; an id the graph never had reads nothing.
  const g = new DependencyGraph();
  g.set(node("a"));
  g.set(node("b"), ["a"]);
  g.remove("a");
  assert.deepEqual([...g.upstreamOf("b")], ["a"]);
  assert.deepEqual([...g.upstreamOf("never-added")], []);
});

test("an unclosed comment after a declaration ends the sniffing, it doesn't start it again", () => {
  // Kills the comment's `end < 0` => false: indexOf gives -1, so i would become -1 + 3 = 2,
  // which in "<?<??><!--" is the start of "<??>": that closes again at 4, the unclosed
  // comment at 6 is met again, and the loop never ends. Worked by hand: "<?" at 0 closes
  // at the "?>" at 4, i = 6, "<!--" there has no "-->", so the first element isn't <svg.
  assert.deepEqual(identifyFile(fileOf("a.svg", "<?<??><!--")), renamed("svg"));
});
