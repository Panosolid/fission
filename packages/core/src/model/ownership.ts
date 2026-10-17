// One owner per linked value (the owner's decision 1, docs/integration.md).
//
// A value two workspaces share (the enclosure's hole spacing that the board
// also uses, a sheet thickness Laser and Design both read) has exactly one
// owner. Only the owner changes it. An edit from the other side becomes a
// PROPOSED EDIT: the owner's own command (the same command a user or the AI
// would issue there), previewed, which the user accepts or rejects. There
// is no two-way sync, so every change traces back to one place.
//
// Ownership can be handed over per value; each hand-over is recorded in the
// value's ownership history (its provenance of who drove it) and comes with
// the command that undoes it. Putting that inverse on the one undo history
// waits for step 20.
//
// Live links follow the same rule: what a live link shows is owned by the
// source's workspace; a frozen copy belongs to the item holding it.
//
// The rules are real and tested; the UI ("Owned by Design" beside the
// value, Accept/Reject on proposals) and storing values in the project
// arrive with the first two-way link (E3).

import { parseCommand, type Command, type CommandSpec } from "./commands.ts";
import { workspaceName, type ParameterValue } from "./feature.ts";
import type { Link } from "./links.ts";
import type { WorkspaceId } from "./project.ts";

const WORKSPACES: readonly WorkspaceId[] = ["design", "render", "simulate", "manufacture", "laser", "slice", "circuit", "vector", "image", "layout"];

/** One hand-over of a value, oldest first in `LinkedValue.ownership`. */
export interface OwnershipChange {
  from: WorkspaceId;
  to: WorkspaceId;
}

/** A value shared between workspaces, with its one owner. */
export interface LinkedValue {
  /** Stable id, e.g. "enclosure/hole-spacing". */
  id: string;
  /** For people, e.g. "Hole spacing". */
  label: string;
  value: ParameterValue;
  /** "mm", "deg", or "" for a plain number or text. */
  unit: string;
  owner: WorkspaceId;
  /** Every hand-over so far: who drove the value, in order. */
  ownership: OwnershipChange[];
}

/** An edit from the side that doesn't own the value, waiting for the user's answer. */
export interface ProposedEdit {
  id: string;
  valueId: string;
  /** The workspace the edit was made in. */
  from: WorkspaceId;
  /** The owner it was proposed to. */
  to: WorkspaceId;
  /** The value when it was proposed; accepting refuses if it has changed since. */
  basedOn: ParameterValue;
  proposed: ParameterValue;
  /** The owner's command that makes the change, already checked against the owner's commands. */
  command: Command;
  /** One line for the preview, e.g. "Circuit suggests Hole spacing 45 mm (now 40 mm). Owned by Design." */
  summary: string;
  state: "pending" | "accepted" | "rejected";
}

/** Where an edit goes: run now by the owner, proposed to the owner, or refused with the reason. */
export type EditRoute = { kind: "direct"; command: Command } | { kind: "proposed"; proposal: ProposedEdit } | { kind: "refused"; error: string };

export type Answer = { ok: true; proposal: ProposedEdit; command: Command | null } | { ok: false; error: string };

const isWorkspace = (x: unknown): x is WorkspaceId => typeof x === "string" && (WORKSPACES as readonly string[]).includes(x);

function checkValue(value: unknown): string | null {
  if (typeof value === "number") return Number.isFinite(value) ? null : `a linked value must be a finite number, got ${value}`;
  if (typeof value === "string" || typeof value === "boolean") return null;
  return "a linked value must be a number, text or true/false";
}

const show = (v: LinkedValue, x: ParameterValue) => (v.unit && typeof x === "number" ? `${x} ${v.unit}` : String(x));

/** A new linked value owned by `owner`. Throws on an empty id or label, an unknown owner, or a value a file can't hold. */
export function linkedValue(id: string, label: string, value: ParameterValue, unit: string, owner: WorkspaceId): LinkedValue {
  if (!id) throw new Error("a linked value needs an id");
  if (!label) throw new Error("a linked value needs a label");
  if (!isWorkspace(owner)) throw new Error(`unknown workspace ${JSON.stringify(owner)}`);
  const problem = checkValue(value);
  if (problem) throw new Error(problem);
  return { id, label, value, unit, owner, ownership: [] };
}

/** What the UI shows next to the value. */
export function ownedBy(v: LinkedValue): string {
  return `Owned by ${workspaceName(v.owner)}`;
}

/** Who owns what a link shows: the source's workspace while it is live; the holder once it is a frozen copy. */
export function linkOwner(link: Link, holder: WorkspaceId): WorkspaceId {
  return link.mode === "live" ? link.source.origin.workspace : holder;
}

/**
 * Routes an edit of `v` made in workspace `by`. `command` is the owner's
 * command that sets the value to `proposed`, checked against the owner's
 * commands (`ownerCommands`) whichever side it came from. The owner gets it
 * back to run now; anyone else gets a pending proposal for the owner.
 */
export function proposeEdit(
  id: string,
  v: LinkedValue,
  by: WorkspaceId,
  proposed: ParameterValue,
  command: unknown,
  ownerCommands: readonly CommandSpec[],
): EditRoute {
  if (!isWorkspace(by)) return { kind: "refused", error: `unknown workspace ${JSON.stringify(by)}` };
  const problem = checkValue(proposed);
  if (problem) return { kind: "refused", error: problem };
  if (typeof proposed !== typeof v.value) return { kind: "refused", error: `${v.label} is a ${typeof v.value}, got a ${typeof proposed}` };
  if (proposed === v.value) return { kind: "refused", error: `${v.label} is already ${show(v, proposed)}` };
  const parsed = parseCommand(command, ownerCommands);
  if (!parsed.ok) return { kind: "refused", error: `not a ${workspaceName(v.owner)} command: ${parsed.error}` };
  if (by === v.owner) return { kind: "direct", command: parsed.command };
  return {
    kind: "proposed",
    proposal: {
      id,
      valueId: v.id,
      from: by,
      to: v.owner,
      basedOn: v.value,
      proposed,
      command: parsed.command,
      summary: `${workspaceName(by)} suggests ${v.label} ${show(v, proposed)} (now ${show(v, v.value)}). ${ownedBy(v)}.`,
      state: "pending",
    },
  };
}

/** Why a proposal can no longer be answered, or null if it can. */
function stale(p: ProposedEdit, current: LinkedValue): string | null {
  if (p.state !== "pending") return `this suggestion was already ${p.state}`;
  if (p.valueId !== current.id) return `this suggestion is for ${p.valueId}, not ${current.id}`;
  if (current.owner !== p.to)
    return `${current.label} is now owned by ${workspaceName(current.owner)}, not ${workspaceName(p.to)}; suggest the change again`;
  if (current.value !== p.basedOn) return `${current.label} changed to ${show(current, current.value)} since this was suggested; suggest the change again`;
  return null;
}

/** Accepts a pending proposal: the owner runs the returned command. Refuses a proposal overtaken by an edit or a hand-over. */
export function acceptProposal(p: ProposedEdit, current: LinkedValue): Answer {
  const problem = stale(p, current);
  if (problem) return { ok: false, error: problem };
  return { ok: true, proposal: { ...p, state: "accepted" }, command: p.command };
}

/** Rejects a pending proposal: nothing changes. */
export function rejectProposal(p: ProposedEdit): Answer {
  if (p.state !== "pending") return { ok: false, error: `this suggestion was already ${p.state}` };
  return { ok: true, proposal: { ...p, state: "rejected" }, command: null };
}

/** The owner records a new value after running its command (a direct edit or an accepted proposal). Nobody else can. */
export function setOwnedValue(v: LinkedValue, by: WorkspaceId, value: ParameterValue): LinkedValue {
  if (by !== v.owner) throw new Error(`${v.label} is owned by ${workspaceName(v.owner)}; ${isWorkspace(by) ? workspaceName(by) : JSON.stringify(by)} can only suggest a change`);
  const problem = checkValue(value);
  if (problem) throw new Error(problem);
  if (typeof value !== typeof v.value) throw new Error(`${v.label} is a ${typeof v.value}, got a ${typeof value}`);
  return { ...v, value };
}

/** The core command that hands a value to another workspace (the user, or the AI through the same command). */
export const TRANSFER_OWNERSHIP: CommandSpec = {
  op: "transfer_ownership",
  summary: "Hand one linked value to another workspace, which then owns it: only the owner changes it, the other side suggests changes.",
  params: {
    value: { type: "text", maxLength: 200, description: "id of the linked value" },
    to: { type: "choice", values: WORKSPACES, description: "the workspace that will own it" },
  },
};

export type Transfer = { ok: true; value: LinkedValue; command: Command; inverse: Command; label: string } | { ok: false; error: string };

/**
 * Hands `v` to workspace `to`, recording the change in its ownership
 * history. Whoever stores `value` does it inside `history.step(label, …)`,
 * so the hand-over and anything it updates are one undo step named
 * `label` ("Hand Hole spacing to Circuit"), and Undo puts the old owner back
 * (step 20c; the history keeps snapshots, so `inverse`, which hands it back
 * as a command, is for the timeline from step 24). Proposals still pending
 * for the old owner can no longer be accepted.
 */
export function transferOwnership(v: LinkedValue, to: WorkspaceId): Transfer {
  if (!isWorkspace(to)) return { ok: false, error: `unknown workspace ${JSON.stringify(to)}` };
  if (to === v.owner) return { ok: false, error: `${v.label} is already owned by ${workspaceName(to)}` };
  return {
    ok: true,
    value: { ...v, owner: to, ownership: [...v.ownership, { from: v.owner, to }] },
    command: { op: TRANSFER_OWNERSHIP.op, value: v.id, to },
    inverse: { op: TRANSFER_OWNERSHIP.op, value: v.id, to: v.owner },
    label: `Hand ${v.label} to ${workspaceName(to)}`,
  };
}
