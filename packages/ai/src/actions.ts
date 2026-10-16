// DRAFT: what happens to commands once the AI has proposed them. Every AI
// action is PREVIEWED first (ghosted geometry, highlighted changes, or a
// diff of parameters); the user accepts or rejects it. Accepted, it lands
// in the normal undo history as ONE labelled step ("AI: added 5 mm
// hole"); rejected, the project is exactly as it was. The one-step part is
// built (`acceptCommands`, step 20c); the preview needs the timeline (step
// 32), so `proposeAction` is not built yet.

import type { Command, History } from "@fission/core";

export interface ParameterChange {
  feature: string;
  parameter: string;
  before: unknown;
  after: unknown;
}

export interface Preview {
  /** e.g. "AI: added 5 mm hole" — also the undo step's label. */
  label: string;
  /** Faces, edges or bodies to highlight, by stable id. */
  highlights: string[];
  parameterChanges: ParameterChange[];
}

export interface AIAction {
  commands: Command[];
  /** Builds the result off to the side and shows it ghosted; changes nothing. */
  preview(): Promise<Preview>;
  /** Applies it as one undo step. */
  accept(): Promise<void>;
  /** Discards the preview; the project is unchanged. */
  reject(): void;
}

/** An action for these commands. Not implemented yet (needs steps 20 and 32). */
export function proposeAction(_commands: Command[]): AIAction {
  throw new Error("not implemented");
}

/** Prefix of every AI undo step, so Undo says the change was the AI's. */
export const AI_LABEL = "AI: ";

/**
 * Applies accepted commands as ONE undo step ("AI: added 5 mm hole"): `run`
 * does each command exactly as the user's own button would (the AI only
 * issues commands a user could), in order. If any command throws, the
 * project is put back as it was before the first and the error passes on,
 * so the AI never leaves half a change. `label` gets the "AI: " prefix if
 * it lacks one. An empty list is refused: there is nothing to accept.
 */
export function acceptCommands(history: History, label: string, commands: readonly Command[], run: (command: Command) => void): void {
  if (commands.length === 0) throw new Error("no commands to accept");
  const name = label.trim();
  if (name === "") throw new Error("an accepted AI change needs a label for its undo step");
  history.step(name.startsWith(AI_LABEL) ? name : AI_LABEL + name, () => {
    for (const command of commands) run(command);
  });
}
