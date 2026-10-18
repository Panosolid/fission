// Seeded sessions on the timeline bar (step 24f2, test plan point 2): each
// step is a random menu choice, playback button, marker drag, tap at phone
// width or item drag, done through the bar's own functions (`dropIndex`,
// `tapPlace`, `stepTarget`, `itemMenu`, `barEdit`) on Design's document,
// and done again on a plain model: a list of items, the marker and the
// suppressed flags, with the owner's rules written out again here from
// scratch, sharing no code with timeline-bar.ts or timeline-edits.ts.
// After every step the bar's items, order, names, marker, rolled-back,
// suppressed and failed flags, and the action's outcome (nothing, the undo
// step's name, the delete's ask, or the refusal's exact message) must
// match the model's. Steps are numbers in [0, 1) read against the state
// when they run, so a failing list shrinks by dropping steps and still
// replays (`shrink`). Used by timeline-bar.test.ts and, with planted bugs,
// by timeline-bar-planted.test.ts.

import { partDocument, insertPreset, type DesignDocument } from "../src/document.ts";
import { addSketch } from "../src/sketch.ts";
import { extrudeSketch } from "../src/extrude.ts";
import type * as BarModule from "../src/timeline-bar.ts";

export type Bar = typeof BarModule;

export const OPS = ["sketch", "extrude", "preset", "menu", "button", "marker", "tap", "item", "edit", "undo", "redo"] as const;
export type Op = (typeof OPS)[number];
export interface Step {
  op: Op;
  a: number;
  b: number;
  c: number;
}

/** A seeded generator (mulberry32), so a failure replays from its seed. */
export function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The ops' weights: mostly bar actions, enough new items to keep the timeline from emptying. */
const WEIGHTS: Record<Op, number> = { sketch: 3, extrude: 3, preset: 1, menu: 6, button: 3, marker: 3, tap: 2, item: 5, edit: 2, undo: 2, redo: 1 };

export function randomSteps(seed: number, count: number): Step[] {
  const r = rng(seed);
  const total = OPS.reduce((s, o) => s + WEIGHTS[o], 0);
  const steps: Step[] = [];
  for (let i = 0; i < count; i++) {
    let w = r() * total;
    const op = OPS.find((o) => (w -= WEIGHTS[o]) < 0) ?? "menu";
    steps.push({ op, a: r(), b: r(), c: r() });
  }
  return steps;
}

// ---- The model: written from the owner's rules, not from the code. ----

interface MItem {
  id: string;
  name: string;
  kind: "sketch" | "extrude" | "preset";
  /** The item it is built from (an extrude's sketch), which may be gone. */
  uses: string | null;
  suppressed: boolean;
}
interface Model {
  items: MItem[];
  /** "start" (nothing built), an item's id (built up to and including it), or null (everything built). */
  marker: string | null;
}
type Outcome = { kind: "none" } | { kind: "edit"; step: string } | { kind: "delete"; step: string; ask: boolean } | { kind: "refused"; message: string };

const place = (m: Model) => (m.marker === "start" ? 0 : m.marker === null ? m.items.length : m.items.findIndex((i) => i.id === m.marker) + 1);
const markerFor = (items: MItem[], p: number): string | null => (p === 0 ? "start" : p === items.length ? null : items[p - 1].id);
const editingWords = (name: string) => `${name} is being edited: finish the sketch first`;
const rollbackWords = (name: string) => `The marker can't go before ${name} while it is being edited: finish the sketch first`;

/** The sketch being edited ends up after the marker in `m`: the edit that made `m` is refused. */
function rollsBack(m: Model, editing: string | null): string | null {
  if (editing === null) return null;
  const at = m.items.findIndex((i) => i.id === editing);
  return at >= place(m) ? rollbackWords(m.items[at].name) : null;
}

function moveTo(m: Model, p: number, editing: string | null): [Model, Outcome] {
  if (p === place(m)) return [m, { kind: "none" }];
  const next = { ...m, marker: markerFor(m.items, p) };
  const no = rollsBack(next, editing);
  if (no) return [m, { kind: "refused", message: no }];
  return [next, { kind: "edit", step: "Move the rollback marker" }];
}

function modelMenu(m: Model, k: number, action: string, editing: string | null): [Model, Outcome] {
  const item = m.items[k];
  if (action === "marker") {
    if (place(m) === k + 1) return [m, { kind: "refused", message: "The marker is already here" }];
    return moveTo(m, k + 1, editing);
  }
  if (editing === item.id) return [m, { kind: "refused", message: editingWords(item.name) }];
  if (action === "delete") {
    const items = m.items.filter((_, j) => j !== k);
    const marker = m.marker === item.id ? (k === 0 ? "start" : m.items[k - 1].id) : m.marker;
    return [{ items, marker }, { kind: "delete", step: `Delete ${item.name}`, ask: m.items.some((i) => i.uses === item.id) }];
  }
  const on = !item.suppressed;
  return [{ ...m, items: m.items.map((i, j) => (j === k ? { ...i, suppressed: on } : i)) }, { kind: "edit", step: `${on ? "Suppress" : "Unsuppress"} ${item.name}` }];
}

function modelDrag(m: Model, k: number, p: number, editing: string | null): [Model, Outcome] {
  if (p === k || p === k + 1) return [m, { kind: "none" }];
  const item = m.items[k];
  const items = m.items.filter((_, j) => j !== k);
  const to = p > k ? p - 1 : p;
  items.splice(to, 0, item);
  const from = items.findIndex((i) => i.id === item.uses);
  if (from > to) return [m, { kind: "refused", message: `${item.name} can't go before ${items[from].name}: it is built from ${items[from].name}` }];
  const user = items.findIndex((i, j) => j < to && i.uses === item.id);
  if (user >= 0) return [m, { kind: "refused", message: `${item.name} can't go after ${items[user].name}: ${items[user].name} is built from it` }];
  const next = { ...m, items };
  const no = rollsBack(next, editing);
  if (no) return [m, { kind: "refused", message: no }];
  return [next, { kind: "edit", step: `Move ${item.name} in the timeline` }];
}

/** What the bar must show for `m`: each item's id, name, suppressed, rolled-back and failed flags, and the marker's place. */
function modelBar(m: Model) {
  const p = place(m);
  const shown = (id: string | null) => {
    const j = m.items.findIndex((i) => i.id === id);
    return j >= 0 && j < p && !m.items[j].suppressed;
  };
  return {
    marker: p,
    items: m.items.map((i, j) => {
      const rolledBack = j >= p;
      const failed = !rolledBack && !i.suppressed && i.kind === "extrude" && !shown(i.uses);
      return [i.id, i.name, i.suppressed, rolledBack, failed] as const;
    }),
  };
}

// ---- Pixels: random item widths, gaps and scroll; a pointer x picked for a place. ----

/** Item edges from `c`: widths 16 to 40 px, gaps 2 to 10 px, from 4 px in, so two gaps' middles are always more than 16 px apart. */
function edgesFor(n: number, c: number): { left: number; right: number }[] {
  const r = rng(Math.floor(c * 2 ** 31));
  const edges = [];
  let x = 4;
  for (let i = 0; i < n; i++) {
    const w = 16 + Math.floor(r() * 25);
    edges.push({ left: x, right: x + w });
    x += w + 2 + Math.floor(r() * 9);
  }
  return edges;
}

/**
 * A pointer x for a drop at place `p` (row scrolled `scroll`): somewhere
 * after the middle of the item before the place and up to and including
 * the middle of the item after it, worked out from the places' meaning
 * ("before item p"), with a drop on a middle 1 time in 4.
 */
function dropX(edges: { left: number; right: number }[], p: number, f: number, scroll: number): number {
  const mid = (i: number) => (edges[i].left + edges[i].right) / 2;
  const lo = p === 0 ? mid(0) - 30 : mid(p - 1);
  const hi = p === edges.length ? mid(p - 1) + 30 : mid(p);
  const at = f < 0.25 && p < edges.length ? hi : lo + Math.max(1e-6, f) * (hi - lo);
  return at - scroll;
}

/** A tap x within 0.9 × TAP_REACH of gap `p`'s middle (before the first: its left edge; past the last: its right edge). */
function tapX(edges: { left: number; right: number }[], p: number, f: number, scroll: number, reach: number): number {
  const gap = p === 0 ? edges[0].left : p === edges.length ? edges[p - 1].right : (edges[p - 1].right + edges[p].left) / 2;
  return gap + (f * 2 - 1) * 0.9 * reach - scroll;
}

// ---- The session. ----

export interface Failure {
  step: number;
  message: string;
}

const BUTTONS = ["start", "back", "forward", "end"] as const;
/** Where a playback button sends the marker from place `p` of `n` items: written out again from the owner's rules (held at either end). */
const buttonTarget = (button: (typeof BUTTONS)[number], p: number, n: number) => (button === "start" ? 0 : button === "end" ? n : button === "back" ? (p === 0 ? 0 : p - 1) : p === n ? n : p + 1);

/** Runs `steps` on Design's document through `bar` and on the model; the first step where they differ, or null. */
export function runBarSession(bar: Bar, steps: readonly Step[]): Failure | null {
  let doc: DesignDocument = partDocument("box", 40, 30, 20);
  let model: Model = { items: [{ id: "feature-1", name: "Feature 1 (box)", kind: "preset", uses: null, suppressed: false }], marker: null };
  let editing: string | null = null;
  const undo: [DesignDocument, Model][] = [];
  let redo: [DesignDocument, Model][] = [];
  const record = (d: DesignDocument, m: Model) => {
    undo.push([doc, model]);
    redo = [];
    doc = d;
    model = m;
  };
  /** A new item made by Design's own edit; its name is read from the document (naming is not what this checks). */
  const made = (d: { doc: DesignDocument; id: string }, kind: MItem["kind"], uses: string | null) => {
    const f = d.doc.timeline.features.find((x) => x.id === d.id)!;
    const items = [...model.items];
    items.splice(place(model), 0, { id: d.id, name: f.provenance.self.label, kind, uses, suppressed: false });
    record(d.doc, { items, marker: model.marker === null ? null : d.id });
  };

  for (let s = 0; s < steps.length; s++) {
    const { op, a, b, c } = steps[s];
    const n = model.items.length;
    const fail = (message: string): Failure => ({ step: s, message: `step ${s} (${op}): ${message}` });
    let expected: [Model, Outcome] | null = null;
    let got: ReturnType<Bar["barEdit"]> | null = null;
    const before = JSON.stringify(doc);
    try {
      if (op === "sketch" || op === "extrude" || op === "preset") {
        if (editing !== null) continue;
        if (op === "sketch") made(addSketch(doc), "sketch", null);
        else if (op === "preset") made(insertPreset(doc, "box", 10, 10, 10), "preset", null);
        else {
          const usable = model.items.slice(0, place(model)).filter((i) => i.kind === "sketch");
          if (usable.length === 0) continue;
          const sketch = usable[Math.floor(a * usable.length)];
          made(extrudeSketch(doc, sketch.id, 5), "extrude", sketch.id);
        }
      } else if (op === "undo" || op === "redo") {
        const from = op === "undo" ? undo : redo;
        const to = op === "undo" ? redo : undo;
        const back = from.pop();
        if (!back) continue;
        to.push([doc, model]);
        [doc, model] = back;
      } else if (op === "edit") {
        if (editing !== null) editing = null;
        else {
          const p = place(model);
          const open = model.items.filter((i, j) => i.kind === "sketch" && j < p && !i.suppressed);
          if (open.length > 0) editing = open[Math.floor(a * open.length)].id;
        }
      } else {
        if (n === 0) continue;
        if (op === "menu") {
          const k = Math.floor(a * n);
          const entries = bar.itemMenu(doc, model.items[k].id, editing);
          const entry = entries[Math.floor(b * entries.length)];
          expected = modelMenu(model, k, entry.action === "unsuppress" ? "suppress" : entry.action, editing);
          const words = model.items[k].suppressed ? "Unsuppress" : "Suppress";
          if (entries.map((e) => e.label).join("|") !== `Move the marker here|${words}|Delete`) return fail(`${model.items[k].id}'s menu offers ${entries.map((e) => e.label).join(", ")}`);
          got = bar.barEdit(doc, { kind: "menu", id: model.items[k].id, action: entry.action }, editing);
        } else if (op === "button") {
          const button = BUTTONS[Math.floor(a * 4)];
          const p = place(model);
          const target = buttonTarget(button, p, n);
          expected = moveTo(model, target, editing);
          got = bar.barEdit(doc, { kind: "button", button }, editing);
        } else {
          const edges = edgesFor(n, c);
          const width = edges[n - 1].right + 4;
          const scroll = b < 0.3 ? 0 : Math.floor(b * width);
          if (op === "marker" || op === "tap") {
            const p = Math.floor(a * (n + 1));
            const where = op === "marker" ? bar.dropIndex(edges, dropX(edges, p, (c * 7919) % 1, scroll), scroll) : bar.tapPlace(edges, tapX(edges, p, (c * 7919) % 1, scroll, bar.TAP_REACH), scroll);
            if (where !== p) return fail(`a ${op} meant for place ${p} of ${n} (scrolled ${scroll}) landed at ${where}`);
            expected = moveTo(model, p, editing);
            got = bar.barEdit(doc, { kind: "marker", place: where }, editing);
          } else {
            const k = Math.floor(a * n);
            const p = Math.floor(((a * 104729) % 1) * (n + 1));
            const where = bar.dropIndex(edges, dropX(edges, p, (c * 7919) % 1, scroll), scroll);
            if (where !== p) return fail(`a drop meant for place ${p} of ${n} (scrolled ${scroll}) landed at ${where}`);
            expected = modelDrag(model, k, where, editing);
            got = bar.barEdit(doc, { kind: "item", id: model.items[k].id, place: where }, editing);
          }
        }
      }
    } catch (e) {
      return fail(`threw: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (got && JSON.stringify(doc) !== before) return fail("the document before the action changed, so undo would not have it whole");

    if (expected && got) {
      const [next, want] = expected;
      const have: Outcome =
        got.kind === "edit" ? { kind: "edit", step: got.step } : got.kind === "delete" ? { kind: "delete", step: got.step, ask: got.ask } : got.kind === "refused" ? { kind: "refused", message: got.message } : { kind: "none" };
      if (JSON.stringify(have) !== JSON.stringify(want)) return fail(`the bar gave ${JSON.stringify(have)}, the model ${JSON.stringify(want)}`);
      if (got.kind === "edit" || got.kind === "delete") {
        if (got.doc === doc) return fail(`an edit recorded ("${got.step}") that changes nothing`);
        record(got.doc, next);
      }
    }
    // Undo can take the sketch being edited away, or behind the marker: the app then leaves the sketch.
    if (editing !== null) {
      const j = model.items.findIndex((i) => i.id === editing);
      if (j < 0 || j >= place(model) || model.items[j].suppressed) editing = null;
    }

    const shown = bar.timelineBarItems(doc);
    const have = { marker: shown.marker, items: shown.items.map((i) => [i.id, i.label.replace(/^\d+\. /, ""), i.suppressed, i.rolledBack, i.failed]) };
    const want = modelBar(model);
    const names = doc.timeline.features.map((f) => [f.id, f.provenance.self.label]);
    const wantNames = model.items.map((i) => [i.id, i.name]);
    if (JSON.stringify(names) !== JSON.stringify(wantNames)) return fail(`the items are ${JSON.stringify(names)}, the model's ${JSON.stringify(wantNames)}`);
    const flags = (x: typeof have) => JSON.stringify({ marker: x.marker, items: x.items.map(([id, , sup, rb, f]) => [id, sup, rb, f]) });
    if (flags(have) !== flags(want as unknown as typeof have)) return fail(`the bar shows ${flags(have)}, the model ${flags(want as unknown as typeof have)}`);
    const marker = doc.timeline.marker ?? null;
    if (marker !== model.marker) return fail(`the document's marker is ${JSON.stringify(marker)}, the model's ${JSON.stringify(model.marker)}`);
    // The playback buttons (24f5): each off exactly when the model's move to its target does nothing (with why) or is refused (with its words).
    const buttons = bar.playbackButtons(doc, editing).map((x) => [x.button, x.off]);
    const p = place(model);
    const wantButtons = BUTTONS.map((button) => {
      const target = buttonTarget(button, p, model.items.length);
      if (target === p) return [button, model.items.length === 0 ? "The timeline is empty" : target === 0 ? "The marker is already at the start" : "The marker is already at the end"];
      const [, out] = moveTo(model, target, editing);
      return [button, out.kind === "refused" ? out.message : null];
    });
    if (JSON.stringify(buttons) !== JSON.stringify(wantButtons)) return fail(`the buttons are ${JSON.stringify(buttons)}, the model's ${JSON.stringify(wantButtons)}`);
  }
  return null;
}

/** `steps` cut to a list where dropping any one step makes the failure go (1-minimal), for a regression file. */
export function shrink(bar: Bar, steps: readonly Step[]): Step[] {
  let best = [...steps];
  for (let changed = true; changed; ) {
    changed = false;
    for (let i = 0; i < best.length; i++) {
      const fewer = best.filter((_, j) => j !== i);
      if (runBarSession(bar, fewer)) {
        best = fewer;
        changed = true;
        i--;
      }
    }
  }
  return best;
}
