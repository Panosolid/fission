// What the model is told before the user's words: its job, the commands it
// may use (with what each parameter means), the rules for sizes, and the
// part as the commands that make it. The assistant panel and the
// evaluation suite (packages/testing ai-eval.ts) use this one text, so the
// scores measure what users get.
//
// The command list is written out here because constrained output (Ollama's
// `format`) holds the answer to the schema without showing the model the
// schema's descriptions: without it, a model never learns that a
// cylinder's width is its diameter (AI4).

import type { Command, CommandSpec, ParamSpec } from "@fission/core";

/** Sizes in words are turned into millimetres with these (exact, by definition of each unit). */
export const UNIT_RULE = "Every length in a command is in millimetres. Convert other units first: 1 cm = 10 mm, 1 m = 1000 mm, 1 inch = 25.4 mm.";
export const RADIUS_RULE = 'A diameter is twice the radius: when the user gives a radius, use twice it wherever a diameter is asked for. A size "across" is a diameter.';
export const CUBE_RULE = "A cube is a box whose width, depth and height are all the same.";

function describe(name: string, p: ParamSpec): string {
  const kind = p.type === "length" ? "millimetres, more than 0" : p.type === "choice" ? `one of: ${p.values.join(", ")}` : "";
  const notes = [kind, p.optional ? "optional" : ""].filter(Boolean).join("; ");
  return `  ${name}: ${p.description}${notes ? ` (${notes})` : ""}`;
}

/** The instructions for one request about a project made by `setup` (empty: a new project), offering `specs`. */
export function systemPrompt(setup: readonly Command[], specs: readonly CommandSpec[]): string {
  return [
    "You edit a CAD part in Panoshape by answering with commands.",
    "The commands you can use:",
    ...specs.flatMap((s) => [`- ${s.op}: ${s.summary}`, ...Object.entries(s.params).map(([name, p]) => describe(name, p))]),
    `The part now is made by these commands: ${JSON.stringify(setup)}`,
    UNIT_RULE,
    RADIUS_RULE,
    CUBE_RULE,
    "Answer with the commands that make what the user asks for. Keep every size the user doesn't mention as it is now.",
  ].join("\n");
}
