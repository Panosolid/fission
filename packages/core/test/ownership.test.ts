import { test } from "node:test";
import assert from "node:assert/strict";
import type { CommandSpec } from "../src/model/commands.ts";
import { linkTo, type LinkSource } from "../src/model/links.ts";
import {
  TRANSFER_OWNERSHIP,
  acceptProposal,
  linkOwner,
  linkedValue,
  ownedBy,
  proposeEdit,
  rejectProposal,
  setOwnedValue,
  transferOwnership,
  type ProposedEdit,
} from "../src/model/ownership.ts";
import { parseCommand } from "../src/model/commands.ts";
import type { WorkspaceId } from "../src/model/project.ts";

// The owner's own command for the shared value: Design's hole spacing on an
// enclosure that a board in Circuit also uses (docs/integration.md, decision 1).
const DESIGN: readonly CommandSpec[] = [{ op: "set_hole_spacing", summary: "Set the mounting hole spacing", params: { spacing: { type: "length", description: "centre to centre" } } }];
const CIRCUIT: readonly CommandSpec[] = [{ op: "set_board_holes", summary: "Set the board's hole spacing", params: { pitch: { type: "length", description: "centre to centre" } } }];

const spacing = () => linkedValue("enclosure/hole-spacing", "Hole spacing", 40, "mm", "design");
const to45 = { op: "set_hole_spacing", spacing: 45 };

function proposal(): ProposedEdit {
  const r = proposeEdit("p1", spacing(), "circuit", 45, to45, DESIGN);
  assert.equal(r.kind, "proposed");
  return (r as { proposal: ProposedEdit }).proposal;
}

test("the UI says who owns a value", () => {
  assert.equal(ownedBy(spacing()), "Owned by Design");
  assert.equal(ownedBy(linkedValue("t", "Sheet thickness", 3, "mm", "laser")), "Owned by Laser");
});

test("an edit by the owner runs now; the same edit from the other side becomes a proposal for the owner", () => {
  assert.deepEqual(proposeEdit("p0", spacing(), "design", 45, to45, DESIGN), { kind: "direct", command: to45 });
  // Worked by hand: Circuit edits Design's value from 40 to 45 mm, so it is
  // a pending suggestion to Design, carrying Design's command, based on 40.
  assert.deepEqual(proposal(), {
    id: "p1",
    valueId: "enclosure/hole-spacing",
    from: "circuit",
    to: "design",
    basedOn: 40,
    proposed: 45,
    command: to45,
    summary: "Circuit suggests Hole spacing 45 mm (now 40 mm). Owned by Design.",
    state: "pending",
  });
});

test("a proposal is never applied by itself: the value only moves when the owner records it", () => {
  const v = spacing();
  proposal();
  assert.equal(v.value, 40, "proposing changed nothing");
  assert.throws(() => setOwnedValue(v, "circuit", 45), /^Error: Hole spacing is owned by Design; Circuit can only suggest a change$/);
  assert.equal(setOwnedValue(v, "design", 45).value, 45);
});

test("accepting gives the owner's command to run; rejecting gives none; neither can be answered twice", () => {
  const v = spacing();
  const yes = acceptProposal(proposal(), v);
  assert.ok(yes.ok);
  assert.equal(yes.proposal.state, "accepted");
  assert.deepEqual(yes.command, to45);
  assert.deepEqual(acceptProposal(yes.proposal, v), { ok: false, error: "this suggestion was already accepted" });

  const no = rejectProposal(proposal());
  assert.ok(no.ok);
  assert.equal(no.proposal.state, "rejected");
  assert.equal(no.command, null);
  assert.deepEqual(rejectProposal(no.proposal), { ok: false, error: "this suggestion was already rejected" });
  assert.deepEqual(acceptProposal(no.proposal, v), { ok: false, error: "this suggestion was already rejected" });
});

test("a proposal overtaken by an edit or a hand-over is refused, never applied on top", () => {
  const p = proposal();
  const edited = setOwnedValue(spacing(), "design", 42);
  assert.deepEqual(acceptProposal(p, edited), { ok: false, error: "Hole spacing changed to 42 mm since this was suggested; suggest the change again" });
  const handed = transferOwnership(spacing(), "circuit");
  assert.ok(handed.ok);
  assert.deepEqual(acceptProposal(p, handed.value), {
    ok: false,
    error: "Hole spacing is now owned by Circuit, not Design; suggest the change again",
  });
  const other = linkedValue("enclosure/wall", "Wall", 40, "mm", "design");
  assert.deepEqual(acceptProposal(p, other), { ok: false, error: "this suggestion is for enclosure/hole-spacing, not enclosure/wall" });
  // The unchanged value still accepts: the refusals above come from the change, not the proposal.
  assert.ok(acceptProposal(p, spacing()).ok);
});

test("each bad edit is refused with its own reason", () => {
  const v = spacing();
  const refused = (by: unknown, value: unknown, command: unknown) => {
    const r = proposeEdit("p", v, by as WorkspaceId, value as number, command, DESIGN);
    assert.equal(r.kind, "refused");
    return (r as { error: string }).error;
  };
  assert.equal(refused("cad", 45, to45), 'unknown workspace "cad"');
  assert.equal(refused("circuit", NaN, to45), "a linked value must be a finite number, got NaN");
  assert.equal(refused("circuit", Infinity, to45), "a linked value must be a finite number, got Infinity");
  assert.equal(refused("circuit", null, to45), "a linked value must be a number, text or true/false");
  assert.equal(refused("circuit", "45", to45), "Hole spacing is a number, got a string");
  assert.equal(refused("circuit", 40, to45), "Hole spacing is already 40 mm");
  // The non-owner's own command is not the owner's: it can't be smuggled through.
  assert.equal(refused("circuit", 45, { op: "set_board_holes", pitch: 45 }), 'not a Design command: unknown command "set_board_holes"; known: set_hole_spacing');
  assert.equal(refused("circuit", 45, { op: "set_hole_spacing", spacing: -1 }), "not a Design command: set_hole_spacing: spacing must be a length in mm greater than 0, got -1");
  assert.equal(refused("design", 45, { op: "set_hole_spacing" }), "not a Design command: set_hole_spacing needs spacing");
});

test("handing a value over records it, gives the owner's label, and comes with the command that undoes it", () => {
  const r = transferOwnership(spacing(), "circuit");
  assert.ok(r.ok);
  assert.equal(r.value.owner, "circuit");
  assert.equal(ownedBy(r.value), "Owned by Circuit");
  assert.deepEqual(r.value.ownership, [{ from: "design", to: "circuit" }]);
  assert.deepEqual(r.command, { op: "transfer_ownership", value: "enclosure/hole-spacing", to: "circuit" });
  assert.deepEqual(r.inverse, { op: "transfer_ownership", value: "enclosure/hole-spacing", to: "design" });
  // Both are valid commands of the core command, so the user and the AI issue the same thing.
  assert.ok(parseCommand(r.command, [TRANSFER_OWNERSHIP]).ok);
  assert.ok(parseCommand(r.inverse, [TRANSFER_OWNERSHIP]).ok);
  // Now Circuit edits directly and Design can only suggest.
  assert.equal(proposeEdit("p", r.value, "circuit", 45, { op: "set_board_holes", pitch: 45 }, CIRCUIT).kind, "direct");
  assert.equal(proposeEdit("p", r.value, "design", 45, { op: "set_board_holes", pitch: 45 }, CIRCUIT).kind, "proposed");
  // Handing it back is recorded too: the history says who drove it, in order.
  const back = transferOwnership(r.value, "design");
  assert.ok(back.ok);
  assert.deepEqual(back.value.ownership, [{ from: "design", to: "circuit" }, { from: "circuit", to: "design" }]);
});

test("a hand-over to the current owner or an unknown workspace is refused", () => {
  assert.deepEqual(transferOwnership(spacing(), "design"), { ok: false, error: "Hole spacing is already owned by Design" });
  assert.deepEqual(transferOwnership(spacing(), "cad" as WorkspaceId), { ok: false, error: 'unknown workspace "cad"' });
  assert.equal(parseCommand({ op: "transfer_ownership", value: "x", to: "cad" }, [TRANSFER_OWNERSHIP]).ok, false);
});

test("a linked value must be one a file can hold, with an id, a label and a real owner", () => {
  assert.throws(() => linkedValue("", "Hole spacing", 40, "mm", "design"), /needs an id/);
  assert.throws(() => linkedValue("x", "", 40, "mm", "design"), /needs a label/);
  assert.throws(() => linkedValue("x", "X", NaN, "mm", "design"), /finite number, got NaN/);
  assert.throws(() => linkedValue("x", "X", 40, "mm", "cad" as WorkspaceId), /unknown workspace "cad"/);
  assert.throws(() => setOwnedValue(spacing(), "design", -Infinity), /finite number, got -Infinity/);
  assert.throws(() => setOwnedValue(spacing(), "design", "40" as unknown as number), /is a number, got a string/);
  // Text and true/false values work the same way, without a unit.
  const finish = linkedValue("enclosure/finish", "Finish", "matte", "", "render");
  assert.equal(proposeEdit("p", finish, "design", "gloss", { op: "x" }, [{ op: "x", summary: "", params: {} }]).kind, "proposed");
});

test("a live link is owned by its source; a frozen copy by the item holding it", () => {
  const source: LinkSource = { kind: "object", origin: { workspace: "design", id: "feature-1", label: "Feature 1 (box)" } };
  const live = linkTo("plate-model-1", source, ["solid"]);
  assert.equal(linkOwner(live, "slice"), "design");
  assert.equal(linkOwner({ id: "plate-model-1", mode: "frozen", source, representation: { kind: "solid", spec: { box: { width: 40, depth: 30, height: 20 } } } }, "slice"), "slice");
});
