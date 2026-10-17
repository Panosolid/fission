// What the model is told before the user's words: its job, and the part as
// the commands that make it. The assistant panel and the evaluation suite
// (packages/testing ai-eval.ts) use this one text, so the scores measure
// what users get.

import type { Command } from "@fission/core";

/** The instructions for one request about a project made by `setup` (empty: a new project). */
export function systemPrompt(setup: readonly Command[]): string {
  return [
    "You edit a CAD part in Fission by answering with commands. Sizes are in millimetres.",
    `The part now is made by these commands: ${JSON.stringify(setup)}`,
    "Answer with the commands that make what the user asks for. Keep every size the user doesn't mention as it is now.",
  ].join("\n");
}
