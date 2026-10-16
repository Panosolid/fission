// Verbs, not apps (docs/integration.md, principle 1): the one action
// registry. Each workspace registers the verbs it offers, each for some
// kinds of selected thing (body, face, edge, outline) and working on one
// representation of it (a mesh for Download STL; later a flat face's
// outline for Cut on laser, a body's mesh for Print). Whatever shows the
// selection asks the registry which verbs apply and offers those, so no
// workspace keeps private buttons for actions on a selection.

import type { WorkspaceId } from "./project.ts";
import type { RepresentationKind } from "./representation.ts";
import type { WorkspaceContext } from "./workspace.ts";

/** What can be selected and acted on. Outlines (sketch profiles, Vector paths) come with step 21 and V1. */
export type SelectionKind = "body" | "face" | "edge" | "outline";

/** Something selected: a GeometryReference today (body, face, edge); an outline from step 21. */
export interface Selected {
  kind: SelectionKind;
  id: string;
}

/** A selected thing, with the representations it can be handed over in (most exact first). */
export interface ActionTarget {
  ref: Selected;
  representations: readonly RepresentationKind[];
}

/** What running an action came to: a line to show the user ("" for nothing to say). */
export interface ActionOutcome {
  message: string;
  /** True for a warning or an error, shown as one. */
  bad: boolean;
}

export interface Action {
  /** Unique, prefixed by the workspace: "design.download-stl". */
  id: string;
  /** The workspace that offers it (and that the user ends up in, once verbs lead into workspaces). */
  workspace: WorkspaceId;
  /** The verb, as the button says it: "Download STL". */
  label: string;
  /** One line: what it does. */
  title: string;
  /** The selection kinds it applies to. */
  kinds: readonly SelectionKind[];
  /** The representation it works on: every target must be able to give it. */
  uses: RepresentationKind;
  /** "one": exactly one thing selected; "many": one or more. */
  count: "one" | "many";
  /** Does it to the targets. Never throws: a failure comes back as a bad outcome. */
  run(targets: readonly Selected[], ctx: WorkspaceContext): Promise<ActionOutcome>;
}

const ID = /^[a-z]+\.[a-z0-9-]+$/;

export class ActionRegistry {
  private actions: Action[] = [];

  /** Adds a verb. A repeated id, an id not prefixed by its workspace, or a verb for no kinds is refused. */
  register(action: Action): void {
    if (!ID.test(action.id) || !action.id.startsWith(`${action.workspace}.`))
      throw new Error(`action id ${JSON.stringify(action.id)} must be "${action.workspace}.<verb>" in lower case`);
    if (this.actions.some((a) => a.id === action.id)) throw new Error(`action ${action.id} is already registered`);
    if (action.kinds.length === 0) throw new Error(`action ${action.id} applies to nothing: give it at least one selection kind`);
    this.actions.push(action);
  }

  /** The action with this id, or undefined. */
  get(id: string): Action | undefined {
    return this.actions.find((a) => a.id === id);
  }

  /** Every verb a workspace registered, in registration order. */
  byWorkspace(workspace: WorkspaceId): Action[] {
    return this.actions.filter((a) => a.workspace === workspace);
  }

  /**
   * The verbs that apply to this selection, in registration order: each
   * target is of a kind the verb takes and can give the representation it
   * uses, and the count fits. An empty selection has none.
   */
  actionsFor(targets: readonly ActionTarget[]): Action[] {
    if (targets.length === 0) return [];
    return this.actions.filter(
      (a) =>
        (a.count === "many" || targets.length === 1) &&
        targets.every((t) => a.kinds.includes(t.ref.kind) && t.representations.includes(a.uses)),
    );
  }
}
