// A second, independent reading of the prompts, for the consistency test:
// what a careful person would send for these words, worked out from the
// text alone (numbers, units, keywords), never from the recipes. If a
// recipe writes words that mean something other than its command (a
// radius taken as a diameter, a unit not converted), the two disagree.
// It reads only the phrasings the recipes use; anything else is null.

import type { Command } from "@fission/core";

const MM_PER: Record<string, number> = { mm: 1, cm: 10, m: 1000, in: 25.4 };

function unitOf(word: string | undefined): string | undefined {
  if (!word) return undefined;
  if (/^(mm|millimet)/.test(word)) return "mm";
  if (/^(cm|centimet)/.test(word)) return "cm";
  if (/^(m|met)/.test(word)) return "m";
  if (/^(in|inch|")/.test(word)) return "in";
  return undefined;
}

interface Found {
  mm: number;
  /** The text just before it, and the word and text just after it. */
  before: string;
  after: string;
  rest: string;
}

/** Every length in the text, in mm. A number written without a unit takes the prompt's one unit, or mm. */
function lengths(text: string): Found[] {
  const re = /(\d+(?:\.\d+)?)(?:\s*(millimet(?:re|er)s?|mm|centimet(?:re|er)s?|cm|met(?:re|er)s?|m|inch(?:es)?|in|"))?(?![\w%]|\.\d)/g;
  const raw = [...text.matchAll(re)];
  const promptUnit = raw.map((m) => unitOf(m[2])).find((u) => u !== undefined) ?? "mm";
  return raw.map((m) => {
    const rest = text.slice(m.index + m[0].length).trimStart();
    // "25 in diameter" could be inches or a bare 25 mm: no reading.
    const mm = m[2] === "in" && /^(diameter|radius)/.test(rest) ? NaN : Number(m[1]) * MM_PER[unitOf(m[2]) ?? promptUnit];
    return { mm, before: text.slice(Math.max(0, m.index - 14), m.index), after: rest.split(/[\s,.?]+/)[0], rest };
  });
}

const SHAPE_NOUNS: [RegExp, string][] = [
  [/\bcube\b/, "cube"],
  [/\b(box|block)\b/, "box"],
  [/\b(cylinder|rod|dowel|peg|puck|disc)\b/, "cylinder"],
  [/\b(sphere|ball)\b/, "sphere"],
  [/\bplate\b/, "plate"],
  [/\bbracket\b/, "l-bracket"],
  [/\bslot\b/, "slot"],
  [/\bstar\b/, "star"],
];
const shapeIn = (t: string) => SHAPE_NOUNS.find(([re]) => re.test(t))?.[1];

/** Which size a word is about, and what one of it is worth in width (a radius is half a diameter). */
function sizeOf(word: string): { key: "width" | "depth" | "height"; times: number } | undefined {
  if (/^(wider|narrower|width|wide|diameter|across)$/.test(word)) return { key: "width", times: 1 };
  if (word === "radius") return { key: "width", times: 2 };
  if (/^(deeper|shallower|depth|deep)$/.test(word)) return { key: "depth", times: 1 };
  if (/^(taller|shorter|higher|lower|thicker|thinner|height|thickness|tall|high|thick|long)$/.test(word)) return { key: "height", times: 1 };
  return undefined;
}

const GROW = /^(wider|deeper|taller|higher|thicker)$/;

/** The sizes of a new part of this kind, from the words. */
function created(kind: string, t: string): Command | null {
  const ls = lengths(t);
  // A round part's size: "25 mm across", "Ø25 mm", "with a diameter of 25 mm"; a radius counts twice.
  const round = () => {
    for (const l of ls) {
      if (/radius (of )?$/.test(l.before) || /^in radius/.test(l.rest)) return 2 * l.mm;
      if (/(diameter of |ø)$/.test(l.before) || /^(across|in diameter)/.test(l.rest)) return l.mm;
    }
    return undefined;
  };
  // How thick or tall: "thick" first, since a plate or slot is "40 mm long" across.
  const thick = ls.find((l) => l.after === "thick") ?? ls.find((l) => /^(tall|long|high)$/.test(l.after));
  const others = ls.filter((l) => l !== thick).map((l) => l.mm);
  switch (kind) {
    case "cube":
      return ls.length === 1 ? { op: "set_part", shape: "box", width: ls[0].mm, depth: ls[0].mm, height: ls[0].mm } : null;
    case "box": {
      const by = (word: string, label: string) => ls.find((l) => l.after === word || new RegExp(`${label} $`).test(l.before))?.mm;
      const [w, d, h] = [by("wide", "width"), by("deep", "depth"), by("tall", "height")];
      if (w !== undefined && d !== undefined && h !== undefined) return { op: "set_part", shape: "box", width: w, depth: d, height: h };
      return ls.length === 3 ? { op: "set_part", shape: "box", width: ls[0].mm, depth: ls[1].mm, height: ls[2].mm } : null;
    }
    case "cylinder": {
      const w = round();
      return w !== undefined && thick && ls.length === 2 ? { op: "set_part", shape: "cylinder", width: w, depth: w, height: thick.mm } : null;
    }
    case "sphere": {
      const w = round();
      return w !== undefined && ls.length === 1 ? { op: "set_part", shape: "sphere", width: w, depth: w, height: w } : null;
    }
    case "star":
      return thick && others.length === 1 ? { op: "set_part", shape: "star", width: others[0], depth: others[0], height: thick.mm } : null;
    default: // plate, bracket, slot: two sizes across, then how thick
      return thick && others.length === 2 ? { op: "set_part", shape: kind, width: others[0], depth: others[1], height: thick.mm } : null;
  }
}

/** The commands these words ask for, about the part `setup` makes; null when this reader can't tell. */
export function read(prompt: string, setup: readonly Command[]): Command[] | null {
  let t = prompt.toLowerCase();
  const out: Command[] = [];
  const exporting = /\bstl\b/.test(t);
  if (exporting) t = t.replace(/(^| and |\. then )(export|download|save|give)\b.*$/, "");
  const now = setup.at(-1);
  const edit = (change: Partial<Command>) => (now ? [{ ...now, ...change }] : null);
  const scale = (f: number, what: string) => {
    if (!now) return null;
    if (/^(big|size|its size)$/.test(what)) return [{ ...now, width: (now.width as number) * f, depth: (now.depth as number) * f, height: (now.height as number) * f }];
    const s = sizeOf(what);
    return s ? edit({ [s.key]: (now[s.key] as number) * f }) : null;
  };

  let m: RegExpMatchArray | null;
  let made: Command[] | null;
  if (t === "") made = [];
  else if ((m = t.match(/^(turn it into|make it|change the shape to) an? (.+?)( instead)?[.?]?$/))) {
    const kind = shapeIn(m[2]);
    made = kind && kind !== "cube" ? edit({ shape: kind }) : null;
  } else if ((m = t.match(/(twice|three times|half) as (\w+)/))) made = scale({ twice: 2, "three times": 3, half: 0.5 }[m[1]]!, m[2]);
  else if ((m = t.match(/^(double|halve) the (\w+)/))) made = scale(m[1] === "double" ? 2 : 0.5, m[2]);
  else if ((m = t.match(/(50)% bigger|up by (50)%/))) made = scale(1.5, "big");
  else if (/half (the|its) size/.test(t)) made = scale(0.5, "big");
  else if ((m = t.match(/\b(wider|narrower|deeper|shallower|taller|shorter|higher|lower|thicker|thinner)\b/))) {
    const ls = lengths(t);
    const s = sizeOf(m[1]);
    made = ls.length === 1 && s && now ? edit({ [s.key]: (now[s.key] as number) + (GROW.test(m[1]) ? ls[0].mm : -ls[0].mm) }) : null;
  } else if ((m = t.match(/^(set|change|make|i want) the (width|depth|height|diameter|radius|thickness)\b/))) {
    const ls = lengths(t);
    const s = sizeOf(m[2]);
    made = ls.length === 1 && s ? edit({ [s.key]: ls[0].mm * s.times }) : null;
  } else {
    const kind = shapeIn(t);
    const c = kind ? created(kind, t) : null;
    made = c ? [c] : null;
  }
  if (made === null) return null;
  out.push(...made);
  if (exporting) out.push({ op: "export_stl" });
  return out;
}
