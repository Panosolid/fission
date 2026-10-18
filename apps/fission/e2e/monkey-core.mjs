// The pure half of the monkey tester (e2e/monkey.mjs): the seeded generator,
// the choice of the next action from what the page offers, the junk typed
// into boxes, the edits made to a saved file before opening it again, the
// independent model of what a saved document should show, and the shrinker
// (delta debugging) that cuts a failing action list down to a few actions.
// Nothing here touches a browser, so `monkey.test.mjs` (in `npm test`)
// checks it by hand.

/** Mulberry32, as in sketch-session.mjs: the same seed gives the same numbers. */
export function rng(seed) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One of `list`, picked by `random`. */
export const pick = (random, list) => list[Math.floor(random() * list.length)];

/** A key of `weights`, picked in proportion to its weight; keys with weight 0 never. */
export function weighted(random, weights) {
  const entries = Object.entries(weights).filter(([, w]) => w > 0);
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = random() * total;
  for (const [k, w] of entries) {
    r -= w;
    if (r < 0) return k;
  }
  return entries.at(-1)[0];
}

/** What a chaotic user types into a size or angle box: sensible numbers, edge cases and junk. */
export const JUNK = ["12", "3.5", "40", "0.5", "", " ", "0", "-0", "-5", "-1e3", "1e308", "1e-9", "0.0000001", "999999999", "NaN", "Infinity", "-Infinity", "abc", "1,5", " 7 ", "1e", "--3", "0x10", "1/2", "２０", "12mm", "3e2"];
/** How a typed value is finished. */
export const FINISH = ["Enter", "Tab", "Escape", "none"];
/** Keys pressed on their own (the sketch tools, Escape, undo and redo, the shortcut list…). */
export const KEYS = ["l", "r", "c", "a", "t", "Escape", "Escape", "Enter", "Delete", "Backspace", "Control+z", "Control+Shift+z", "Control+y", "?", "Control+c", "Tab", "f", "h"];
/** Window sizes: desktop, phone, and one in between. */
export const SIZES = [
  [1280, 800],
  [375, 740],
  [820, 600],
];

/** Buttons the monkey never presses: the guide and the assistant are tested on their own and the assistant would call out; full screen leaves the test's window. */
export const SKIP_TARGETS = new Set(["#guide-open", "#assistant-toggle", 'button[data-view="full-screen"]', "#save", "#open"]);

/**
 * The next action, from a snapshot of the page: `targets` (what can be
 * clicked: buttons, menu rows, folds, each with a descriptor `sel`),
 * `inputs` (boxes that take typing, each `sel` and `type`), `rows` (tree
 * rows a right-click opens a menu on), `sketching` and whether a file was
 * saved yet (`haveSave`). Probes are actions too, so a replay repeats them.
 * Coordinates on the view are fractions of its box, so a replay at another
 * size still lands inside it.
 */
export function nextAction(random, page) {
  const targets = page.targets.filter((t) => !SKIP_TARGETS.has(t.sel));
  const weights = {
    click: targets.length ? 30 : 0,
    type: page.inputs.length ? 14 : 0,
    canvas: page.sketching ? 40 : 12,
    drag: 4,
    wheel: 2,
    key: 12,
    menu: page.rows.length ? 5 : 0,
    resize: 2,
    open: page.haveSave ? 6 : 0,
    reload: 1,
    "undo-redo": 7,
    "round-trip": 3,
    unstick: 4,
  };
  const kind = weighted(random, weights);
  const frac = () => Math.round((0.05 + 0.9 * random()) * 1000) / 1000;
  switch (kind) {
    case "click": {
      // Most clicks go to the controls of the mode the app is in, then half of the rest to the modelling flow; another workspace's tab is kept to one pick in four.
      const hot = targets.filter((t) => t.hot);
      const local = targets.filter((t) => t.local);
      let t = local.length && random() < 0.6 ? pick(random, local) : hot.length && random() < 0.5 ? pick(random, hot) : pick(random, targets);
      if (t.cold && random() < 0.75) t = pick(random, targets.filter((x) => !x.cold).length ? targets.filter((x) => !x.cold) : targets);
      return { do: "click", sel: t.sel };
    }
    case "type": {
      const local = page.inputs.filter((i) => i.local);
      const box = local.length && random() < 0.7 ? pick(random, local) : pick(random, page.inputs);
      if (box.type === "checkbox") return { do: "click", sel: box.sel };
      return { do: "type", sel: box.sel, text: pick(random, JUNK), finish: pick(random, FINISH) };
    }
    case "canvas":
      return { do: "canvas", x: frac(), y: frac(), double: random() < 0.05 };
    case "drag":
      return { do: "drag", x: frac(), y: frac(), x2: frac(), y2: frac(), button: pick(random, ["left", "middle", "right"]), shift: random() < 0.3 };
    case "wheel":
      return { do: "wheel", x: frac(), y: frac(), dy: pick(random, [-400, -100, 100, 400]) };
    case "key":
      return { do: "key", key: pick(random, KEYS) };
    case "menu":
      return { do: "menu", sel: pick(random, page.rows).sel };
    case "resize":
      return { do: "resize", size: pick(random, SIZES) };
    case "open":
      return { do: "open", edit: pick(random, FILE_EDITS), at: Math.floor(random() * 1000) };
    default:
      return { do: kind };
  }
}

/** Edits a user could make to a saved file before opening it (24f's timeline edits, ahead of their buttons, and plain damage). */
export const FILE_EDITS = ["same", "suppress", "suppress", "suppress", "marker", "marker", "marker-start", "no-marker", "swap", "drop", "bad-number", "truncate"];

/**
 * The saved text with `edit` made to its Design timeline; `at` picks the
 * item. Returns the text to open (it may not be valid JSON: "truncate").
 */
export function editFile(text, edit, at) {
  if (edit === "truncate") return text.slice(0, Math.floor(text.length * ((at % 90) + 5) / 100));
  const file = JSON.parse(text);
  const design = file.workspaces?.design;
  const features = design?.timeline?.features ?? [];
  if (!features.length || edit === "same") return JSON.stringify(file, null, 2);
  const i = at % features.length;
  const f = features[i];
  if (edit === "suppress") f.suppressed = !f.suppressed;
  else if (edit === "marker") design.timeline.marker = f.id;
  else if (edit === "marker-start") design.timeline.marker = "start";
  else if (edit === "no-marker") delete design.timeline.marker;
  else if (edit === "swap" && features.length > 1) {
    const j = (i + 1) % features.length;
    [features[i], features[j]] = [features[j], features[i]];
  } else if (edit === "drop") features.splice(i, 1);
  else if (edit === "bad-number") {
    const keys = Object.keys(f.intent?.parameters ?? {}).filter((k) => typeof f.intent.parameters[k] === "number");
    if (keys.length) f.intent.parameters[keys[at % keys.length]] = [-1, 0, 1e308, "12"][at % 4];
  }
  return JSON.stringify(file, null, 2);
}

/**
 * What a saved Design document should show, worked out from the file alone
 * (written apart from document.ts's `builds`, from the rules in
 * workspaces/design/CLAUDE.md): the timeline bar's items in order with
 * their suppressed and rolled-back marks, and how many bodies the Bodies
 * group lists. A solid builds when it is not suppressed, not after the
 * marker, and, for a sketch extrude, its sketch builds, or the sketch is
 * gone and its last shape was kept.
 */
export function expectedView(design) {
  const features = design.timeline.features;
  const marker = design.timeline.marker;
  const stop = marker === undefined ? features.length : marker === "start" ? 0 : features.findIndex((f) => f.id === marker) + 1;
  const kept = design.kept ?? {};
  const byId = new Map(features.map((f, i) => [f.id, { f, i }]));
  const active = (i) => i < stop && !features[i].suppressed;
  const builds = (f, i) => {
    if (!active(i)) return false;
    if (f.intent.type !== "extrude" || !Object.hasOwn(f.intent.parameters, "sketch")) return true;
    const s = byId.get(f.intent.parameters.sketch);
    if (s === undefined || s.f.intent.type !== "sketch") return Object.hasOwn(kept, f.id);
    return active(s.i);
  };
  return {
    items: features.map((f, i) => ({ id: f.id, suppressed: f.suppressed === true, rolledBack: i >= stop })),
    bodies: features.filter((f, i) => f.intent.type !== "sketch" && builds(f, i)).length,
  };
}

/**
 * Rules a saved Design document must keep whatever was done to it: ids
 * unique and below `nextId` (never reused), the marker naming an item,
 * and each item built only from items before it. Returns the broken rules.
 */
export function documentRules(design) {
  const broken = [];
  const features = design.timeline.features;
  const sketches = design.sketches ?? [];
  // A sketch's timeline item shares its sketch's id; everything else has an id of its own.
  const ids = [
    ...features.filter((f) => f.intent.type !== "sketch").map((f) => f.id),
    ...(design.profiles ?? []).map((p) => p.id),
    ...sketches.flatMap((s) => [s.id, ...(s.points ?? []).map((p) => p.id), ...(s.curves ?? []).map((c) => c.id)]),
  ];
  const seen = new Set();
  for (const id of ids) {
    if (seen.has(id)) broken.push(`id ${id} is used twice`);
    seen.add(id);
    const n = Number(/-(\d+)$/.exec(id)?.[1]);
    if (Number.isFinite(n) && n >= design.nextId) broken.push(`id ${id} is not below nextId ${design.nextId}`);
  }
  for (const s of sketches) {
    const items = features.filter((f) => f.intent.type === "sketch" && f.id === s.id).length;
    if (items !== 1) broken.push(`sketch ${s.id} has ${items} timeline items`);
  }
  for (const f of features) if (f.intent.type === "sketch" && !sketches.some((s) => s.id === f.id)) broken.push(`timeline item ${f.id} names no sketch`);
  const marker = design.timeline.marker;
  if (marker !== undefined && marker !== "start" && !features.some((f) => f.id === marker)) broken.push(`the marker names ${marker}, which is not in the timeline`);
  features.forEach((f, i) => {
    for (const d of f.dependsOn ?? []) {
      const at = features.findIndex((x) => x.id === d);
      if (at >= i) broken.push(`${f.id} is built from ${d}, which comes after it`);
    }
  });
  return broken;
}

/**
 * Delta debugging (Zeller's ddmin): the shortest sublist of `list` it can
 * find for which `fails` still holds, trying `budget` lists at most. Starts
 * by halves, then quarters…, keeping any part or any complement that fails
 * on its own; the result is 1-minimal when the budget allows (dropping any
 * one action makes it pass).
 */
export async function shrink(list, fails, budget = 200) {
  let current = list;
  let n = 2;
  let tries = 0;
  const attempt = async (candidate) => {
    if (tries >= budget) return false;
    tries++;
    return fails(candidate);
  };
  while (current.length >= 2 && tries < budget) {
    const size = Math.ceil(current.length / n);
    const parts = [];
    for (let i = 0; i < current.length; i += size) parts.push(current.slice(i, i + size));
    let reduced = false;
    for (let k = 0; k < parts.length && !reduced; k++)
      if (await attempt(parts[k])) {
        current = parts[k];
        n = 2;
        reduced = true;
      }
    for (let k = 0; k < parts.length && !reduced && parts.length > 2; k++) {
      const complement = parts.filter((_, j) => j !== k).flat();
      if (await attempt(complement)) {
        current = complement;
        n = Math.max(n - 1, 2);
        reduced = true;
      }
    }
    if (!reduced) {
      if (n >= current.length) break;
      n = Math.min(current.length, n * 2);
    }
  }
  return { list: current, tries };
}

/** A failure's kind, for the shrinker: the check's name and its message with numbers and ids blurred. */
export const signature = (failure) => `${failure.check}: ${String(failure.message).split("\n")[0].replace(/\d+(\.\d+)?/g, "#")}`;
