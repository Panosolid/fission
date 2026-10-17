// What happens to commands once the AI has proposed them. Every AI action
// is PREVIEWED first; the user accepts or rejects it. Accepted, it lands in
// the normal undo history as ONE labelled step ("AI: added 5 mm hole");
// rejected, the project is exactly as it was. Until the timeline (step 32)
// the preview is a diff of parameters (what each command would change,
// before and after); ghosted geometry and highlights come with stable ids.

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
  /** Faces, edges or bodies to highlight, by stable id (none until stable ids exist). */
  highlights: string[];
  parameterChanges: ParameterChange[];
}

export interface AIAction {
  commands: Command[];
  /** What would change; changes nothing. */
  preview(): Promise<Preview>;
  /** Applies it as one undo step. Refused once decided, or when the project changed since the proposal. */
  accept(): Promise<void>;
  /** Discards the proposal; the project is unchanged. */
  reject(): void;
  /** Whether it was accepted or rejected (or refused as out of date). */
  readonly decided: boolean;
}

export interface ProposeOptions {
  /** The undo step's name; gets the "AI: " prefix. */
  label: string;
  history: History;
  /** Does one command exactly as the user's own button would. */
  run: (command: Command) => void;
  /** Each parameter's value now, for the parameter a command names (undefined when it has none). */
  current: (command: Command) => Record<string, unknown>;
  /** The project as it stands (a snapshot string): an accept after it changed is refused, since the preview no longer says what would happen. */
  state: () => string;
}

/** An action for these commands: a preview of what they change, then accept as one undo step, or reject. */
export function proposeAction(commands: readonly Command[], o: ProposeOptions): AIAction {
  if (commands.length === 0) throw new Error("no commands to propose");
  const list = commands.map((c) => ({ ...c }));
  const at = o.state();
  let decided = false;
  const decide = () => {
    if (decided) throw new Error("this AI change was already accepted or rejected");
    decided = true;
  };
  return {
    commands: list,
    get decided() {
      return decided;
    },
    async preview() {
      const parameterChanges: ParameterChange[] = [];
      for (const c of list) {
        const now = o.current(c);
        for (const [parameter, after] of Object.entries(c)) {
          if (parameter === "op" || now[parameter] === after) continue;
          parameterChanges.push({ feature: c.op, parameter, before: now[parameter], after });
        }
      }
      return { label: withPrefix(o.label), highlights: [], parameterChanges };
    },
    async accept() {
      decide();
      if (o.state() !== at) throw new Error("the project changed after this preview, so it no longer shows what would happen; nothing was changed. Ask again.");
      acceptCommands(o.history, o.label, list, o.run);
    },
    reject() {
      decide();
    },
  };
}

const withPrefix = (label: string) => {
  const name = label.trim();
  return name.startsWith(AI_LABEL) ? name : AI_LABEL + name;
};

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
  if (label.trim() === "") throw new Error("an accepted AI change needs a label for its undo step");
  history.step(withPrefix(label), () => {
    for (const command of commands) run(command);
  });
}
