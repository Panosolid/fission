// DRAFT: what happens to commands once the AI has proposed them. Every AI
// action is PREVIEWED first (ghosted geometry, highlighted changes, or a
// diff of parameters); the user accepts or rejects it. Accepted, it lands
// in the normal undo history as ONE labelled step ("AI: added 5 mm
// hole"); rejected, the project is exactly as it was. Needs undo (step 20)
// and the timeline (step 32), so not built yet.

import type { Command } from "@fission/core";

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
