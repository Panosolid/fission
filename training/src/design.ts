// Design's commands for the generator: how each is built on the kernel,
// and the ways people ask for them. Sizes in a prompt are written in one
// unit; the command holds the millimetres that text means (lengths.ts).
//
// Conventions the answers follow (the same as the system prompt's "keep
// every size the user doesn't mention"): a new cylinder's depth is its
// width and a new sphere's depth and height are its width (the box it
// fits in); a new star is as deep as it is wide; an edit keeps every
// size it doesn't name, ignored ones included.

import type { Command, KernelCalls } from "@fission/core";
import { buildSpec, documentFor, lastFeature, SHAPES, specOf } from "@fission/design";
import type { SeededRandom } from "@fission/testing";
import { pick, randomLength, randomSize, randomUnit, unitAfter, type Length } from "./lengths.ts";
import type { Applied, CommandRule, Draft, Recipe, ReplayState } from "./recipe.ts";

type Shape = (typeof SHAPES)[number];
type Size = "width" | "depth" | "height";
interface Part extends Command {
  op: "set_part";
  shape: Shape;
  width: number;
  depth: number;
  height: number;
}

const part = (shape: Shape, width: number, depth: number, height: number): Part => ({ op: "set_part", shape, width, depth, height });
const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const DESIGN_RULES: readonly CommandRule[] = [
  {
    op: "set_part",
    async apply(kernel: KernelCalls, state: ReplayState, command: Command): Promise<Applied> {
      try {
        const doc = documentFor(command);
        const spec = specOf(doc, lastFeature(doc));
        const view = await buildSpec(kernel, spec);
        if (view.errors.length > 0) return { ok: false, reason: `the kernel's checks failed: ${view.errors.join("; ")}` };
        if (!(view.volume > 0)) return { ok: false, reason: `the part has no volume (${view.volume})` };
        return { ok: true, state: { ...state, part: spec } };
      } catch (e) {
        return { ok: false, reason: `the kernel refused it: ${reason(e)}` };
      }
    },
  },
  {
    op: "export_stl",
    async apply(kernel: KernelCalls, state: ReplayState): Promise<Applied> {
      if (!state.part) return { ok: false, reason: "there is no part to export" };
      try {
        const stl = await kernel.call("export_stl", state.part, "part");
        // A binary STL is an 80-byte header, a count, then 50 bytes per triangle.
        if (stl.bytes.length < 84 + 50) return { ok: false, reason: `the STL has no triangles (${stl.bytes.length} bytes)` };
        if (stl.warning) return { ok: false, reason: `the STL would lose detail: ${stl.warning}` };
        return { ok: true, state };
      } catch (e) {
        return { ok: false, reason: `the kernel refused the export: ${reason(e)}` };
      }
    },
  },
];

// ---- Setups: a part that already exists, in mm as the system prompt shows it.

/** A random existing part, sized as people make them. Cylinders sometimes carry a leftover depth, as a part changed from a box does. */
export function randomPart(r: SeededRandom): Part {
  const mm = () => Number(randomSize(r, "mm"));
  const shape = pick(r, SHAPES);
  const [w, d, h] = [mm(), mm(), mm()];
  switch (shape) {
    case "cylinder":
      return part(shape, w, r.next() < 0.5 ? w : d, h);
    case "sphere":
      return part(shape, w, w, w);
    case "star":
      return part(shape, w, w, h);
    case "slot":
      // Straight sides need the length to beat the width.
      return w > 1.5 * d ? part(shape, w, d, h) : part(shape, Math.max(w, d) * 2, Math.min(w, d), h);
    default:
      return part(shape, w, d, h);
  }
}

// ---- Creating a part.

const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Three sizes as one list: "40 by 30 by 20 mm", "4 cm x 3 cm x 2 cm". */
function list(r: SeededRandom, ls: readonly Length[]): string {
  const sep = pick(r, [" by ", " x ", " × ", "×"]);
  return r.next() < 0.6 ? ls.map((l) => l.number).join(sep) + unitAfter(ls[0].unit, r) : ls.map((l) => l.text).join(sep);
}

// A bare number before "in diameter" reads as inches ("25 in diameter"), so that wording needs a unit.
function diameterWords(r: SeededRandom, l: Length): string {
  return pick(r, [`${l.text} across`, `with a diameter of ${l.text}`, `Ø${l.text}`, ...(l.unit === "none" ? [] : [`${l.text} in diameter`])]);
}
function radiusWords(r: SeededRandom, l: Length): string {
  return pick(r, [`with a radius of ${l.text}`, `of radius ${l.text}`, ...(l.unit === "none" ? [] : [`${l.text} in radius`])]);
}

/** A round size given as a diameter or a radius, and the diameter (width) it means. */
function roundSize(r: SeededRandom, unit: ReturnType<typeof randomUnit>): { words: string; width: number } {
  const l = randomLength(r, unit);
  return r.next() < 0.5 ? { words: diameterWords(r, l), width: l.mm } : { words: radiusWords(r, l), width: Number((2 * l.mm).toPrecision(12)) };
}

/** Sizes smallest first, so a plate's or star's thickness is its smallest size, as people make them. */
const thinFirst = (ls: Length[]) => ls.sort((a, b) => a.mm - b.mm);

/** How a round part's height is said, by what it's called. */
const HEIGHT_WORDS: Record<string, readonly string[]> = { cylinder: ["tall", "high", "long"], rod: ["long"], dowel: ["long"], peg: ["long", "tall"], puck: ["thick"], disc: ["thick"] };

/** A new part as a prompt and the command it means. */
export function createPart(r: SeededRandom): { prompt: string; command: Part } {
  const unit = randomUnit(r);
  const L = () => randomLength(r, unit);
  const kind = pick(r, [...SHAPES, "cube"] as const);
  switch (kind) {
    case "box": {
      const [w, d, h] = [L(), L(), L()];
      const prompt = pick(r, [
        `make a box ${list(r, [w, d, h])}.`,
        `a block ${list(r, [w, d, h])}, please.`,
        `I need a block ${w.text} wide, ${d.text} deep and ${h.text} tall.`,
        `create a rectangular block: width ${w.text}, depth ${d.text}, height ${h.text}.`,
        `can you make a ${list(r, [w, d, h])} box?`,
      ]);
      return { prompt: sentence(prompt), command: part("box", w.mm, d.mm, h.mm) };
    }
    case "cube": {
      const s = L();
      const prompt = pick(r, [`a ${s.text} cube.`, `make a cube with ${s.text} sides.`, `I'd like a cube, ${s.text} on each side.`]);
      return { prompt: sentence(prompt), command: part("box", s.mm, s.mm, s.mm) };
    }
    case "cylinder": {
      const round = roundSize(r, unit);
      const h = L();
      const noun = pick(r, ["cylinder", "rod", "dowel", "peg", "puck", "disc"]);
      const tall = pick(r, HEIGHT_WORDS[noun]);
      const prompt = pick(r, [`make a ${noun} ${round.words}, ${h.text} ${tall}.`, `I need a ${noun} ${round.words} and ${h.text} ${tall}.`, `a ${noun}, ${h.text} ${tall}, ${round.words}.`]);
      return { prompt: sentence(prompt), command: part("cylinder", round.width, round.width, h.mm) };
    }
    case "sphere": {
      const round = roundSize(r, unit);
      const noun = pick(r, ["sphere", "ball"]);
      const prompt = pick(r, [`make a ${noun} ${round.words}.`, `a ${noun} ${round.words}, please.`, `I want a ${noun} ${round.words}.`]);
      return { prompt: sentence(prompt), command: part("sphere", round.width, round.width, round.width) };
    }
    case "plate": {
      const [h, a, b] = thinFirst([L(), L(), L()]);
      const [w, d] = r.next() < 0.5 ? [a, b] : [b, a];
      const prompt = pick(r, [
        `a plate ${list(r, [w, d])}, ${h.text} thick.`,
        `make a mounting plate ${w.text} long, ${d.text} wide and ${h.text} thick.`,
        `I need a flat plate with two holes, ${list(r, [w, d])} and ${h.text} thick.`,
      ]);
      return { prompt: sentence(prompt), command: part("plate", w.mm, d.mm, h.mm) };
    }
    case "l-bracket": {
      const [w, d, h] = [L(), L(), L()];
      const prompt = pick(r, [`an L bracket ${list(r, [w, d])}, ${h.text} thick.`, `make an L-shaped bracket with legs of ${w.text} and ${d.text}, ${h.text} thick.`]);
      return { prompt: sentence(prompt), command: part("l-bracket", w.mm, d.mm, h.mm) };
    }
    case "slot": {
      const [a, b, h] = [L(), L(), L()];
      const [w, d] = a.mm > b.mm ? [a, b] : [b, a]; // a slot is longer than it is wide
      const prompt = pick(r, [`a slot ${w.text} long and ${d.text} wide, ${h.text} thick.`, `make a rounded slot shape ${list(r, [w, d])}, ${h.text} thick.`]);
      return { prompt: sentence(prompt), command: part("slot", w.mm, d.mm, h.mm) };
    }
    case "star": {
      const [h, w] = thinFirst([L(), L()]);
      const prompt = pick(r, [`a five-pointed star ${w.text} across and ${h.text} thick.`, `make a star ${w.text} wide, ${h.text} thick.`]);
      return { prompt: sentence(prompt), command: part("star", w.mm, w.mm, h.mm) };
    }
  }
}

// ---- Editing the part there is.

/** The sizes a shape uses, with the words for making each bigger and smaller. */
const SIZES: Record<Shape, readonly Size[]> = {
  box: ["width", "depth", "height"],
  plate: ["width", "depth", "height"],
  "l-bracket": ["width", "depth", "height"],
  slot: ["width", "depth", "height"],
  cylinder: ["width", "height"],
  sphere: ["width"],
  star: ["width", "height"],
};
const FLAT: readonly Shape[] = ["plate", "l-bracket", "slot", "star"];

function moreLess(r: SeededRandom, shape: Shape, size: Size): [more: string, less: string] {
  if (size === "width") return ["wider", "narrower"];
  if (size === "depth") return ["deeper", "shallower"];
  if (FLAT.includes(shape) && r.next() < 0.5) return ["thicker", "thinner"];
  return pick(r, [["taller", "shorter"], ["higher", "lower"]] as const);
}

/** What people call a size of this shape: a cylinder's width is its diameter, a plate's height its thickness. */
function sizeName(r: SeededRandom, shape: Shape, size: Size): { name: string; factor: number } {
  if (size === "width" && (shape === "cylinder" || shape === "sphere")) return pick(r, [{ name: "diameter", factor: 1 }, { name: "radius", factor: 2 }, { name: "width", factor: 1 }]);
  if (size === "height" && FLAT.includes(shape) && r.next() < 0.5) return { name: "thickness", factor: 1 };
  return { name: size, factor: 1 };
}

const it = (r: SeededRandom, shape: Shape) => (r.next() < 0.7 ? "it" : `the ${shape === "l-bracket" ? "bracket" : shape}`);
const round12 = (v: number) => Number(v.toPrecision(12));

/** "Make it 10 mm wider": one size changed by a length. */
function relativeEdit(r: SeededRandom, from: Part): Draft | null {
  const size = pick(r, SIZES[from.shape]);
  const by = randomLength(r, r.next() < 0.8 ? "mm" : randomUnit(r));
  const grow = r.next() < 0.5;
  const [more, less] = moreLess(r, from.shape, size);
  const to = round12(from[size] + (grow ? by.mm : -by.mm));
  if (to < 1) return null; // shrinking past nothing isn't a sensible request
  const word = grow ? more : less;
  const subject = it(r, from.shape);
  const prompt = pick(r, [`make ${subject} ${by.text} ${word}.`, `can you make ${subject} ${by.text} ${word}?`, `${by.text} ${word}, please.`]);
  return { task: "edit-parameter", setup: [from], prompt: sentence(prompt), commands: [{ ...from, [size]: to }] };
}

/** "Set the height to 40 mm": one size given outright. */
function setEdit(r: SeededRandom, from: Part): Draft | null {
  const size = pick(r, SIZES[from.shape]);
  const { name, factor } = sizeName(r, from.shape, size);
  const l = randomLength(r, randomUnit(r));
  const to = round12(l.mm * factor);
  if (to === from[size]) return null; // no change asked for
  const prompt = pick(r, [`set the ${name} to ${l.text}.`, `change the ${name} to ${l.text}.`, `make the ${name} ${l.text}.`, `I want the ${name} to be ${l.text}.`]);
  return { task: "edit-parameter", setup: [from], prompt: sentence(prompt), commands: [{ ...from, [size]: to }] };
}

/** "Make it twice as tall", "halve the width", "make it 50% bigger". */
function scaleEdit(r: SeededRandom, from: Part): Draft | null {
  if (r.next() < 0.3) {
    const [words, f] = pick(r, [["make it twice as big", 2], ["make it 50% bigger", 1.5], ["scale it up by 50%", 1.5], ["make it half the size", 0.5], ["scale it down to half its size", 0.5], ["make it three times as big", 3]] as const);
    return { task: "edit-parameter", setup: [from], prompt: sentence(`${words}.`), commands: [part(from.shape, round12(from.width * f), round12(from.depth * f), round12(from.height * f))] };
  }
  const size = pick(r, SIZES[from.shape]);
  const adjective = { width: "wide", depth: "deep", height: FLAT.includes(from.shape) ? pick(r, ["thick", "tall"]) : pick(r, ["tall", "high"]) }[size];
  const { name } = sizeName(r, from.shape, size);
  const [words, f] = pick(r, [
    [`make it twice as ${adjective}`, 2],
    [`make it three times as ${adjective}`, 3],
    [`make it half as ${adjective}`, 0.5],
    [`double the ${name}`, 2],
    [`halve the ${name}`, 0.5],
  ] as const);
  return { task: "edit-parameter", setup: [from], prompt: sentence(`${words}.`), commands: [{ ...from, [size]: round12(from[size] * f) }] };
}

const SHAPE_WORDS: Record<Shape, string> = { box: "a box", cylinder: "a cylinder", sphere: "a sphere", plate: "a plate", "l-bracket": "an L bracket", slot: "a slot", star: "a star" };

/** "Turn it into a cylinder": the shape changes, every size stays. */
function shapeEdit(r: SeededRandom, from: Part): Draft | null {
  const to = pick(r, SHAPES.filter((s) => s !== from.shape));
  const prompt = pick(r, [`turn it into ${SHAPE_WORDS[to]}.`, `make it ${SHAPE_WORDS[to]} instead.`, `change the shape to ${SHAPE_WORDS[to]}.`]);
  return { task: "edit-parameter", setup: [from], prompt: sentence(prompt), commands: [{ ...from, shape: to }] };
}

const EXPORT_WORDS = ["export it as an STL", "download it as an STL file", "save it as an STL for printing", "give me the STL file", "export the STL"];

export const DESIGN_RECIPES: readonly Recipe[] = [
  {
    id: "design.create",
    ops: ["set_part"],
    sample(r) {
      const { prompt, command } = createPart(r);
      // Asking for a new part over an old one replaces it: set_part is the whole part.
      return { task: "create", setup: r.next() < 0.2 ? [randomPart(r)] : [], prompt, commands: [command] };
    },
  },
  { id: "design.edit-by", ops: ["set_part"], sample: (r) => relativeEdit(r, randomPart(r)) },
  { id: "design.edit-set", ops: ["set_part"], sample: (r) => setEdit(r, randomPart(r)) },
  { id: "design.edit-scale", ops: ["set_part"], sample: (r) => scaleEdit(r, randomPart(r)) },
  { id: "design.edit-shape", ops: ["set_part"], sample: (r) => shapeEdit(r, randomPart(r)) },
  {
    id: "design.export",
    ops: ["set_part", "export_stl"],
    sample: (r) => ({ task: "export", setup: [randomPart(r)], prompt: sentence(`${pick(r, EXPORT_WORDS)}.`), commands: [{ op: "export_stl" }] }),
  },
  {
    id: "design.create-and-export",
    ops: ["set_part", "export_stl"],
    sample(r) {
      const { prompt, command } = createPart(r);
      const ask = prompt.replace(/[.?]$/, "").replace(/, please$/, "");
      const then = r.next() < 0.5 ? ` and ${pick(r, EXPORT_WORDS)}.` : `. Then ${pick(r, EXPORT_WORDS)}.`;
      return { task: "create", setup: [], prompt: `${ask}${then}`, commands: [command, { op: "export_stl" }] };
    },
  },
];
