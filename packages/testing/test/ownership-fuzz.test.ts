// Random sessions on one linked value (one owner per value, X2): seeded
// chains of edits, suggestions, answers and hand-overs from every side,
// nasty values included, checked step by step against a simple model of the
// rules. The value is Design's real part width, edited through Design's own
// set_part command, as a print plate in Slice would suggest it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { acceptProposal, linkedValue, proposeEdit, rejectProposal, setOwnedValue, transferOwnership, type LinkedValue, type ProposedEdit, type WorkspaceId } from "@fission/core";
import { DESIGN_COMMANDS } from "@fission/design";
import { seeded, type SeededRandom } from "../src/index.ts";

const SEEDS = [0x5eedn, 1n, 2n, 3n, 0xdeadbeefn];
const SIDES: WorkspaceId[] = ["design", "slice", "laser", "circuit"];
const NASTY: unknown[] = [NaN, Infinity, -Infinity, -0, 0, -1, 1e308, 5e-324, "40", null, true];

const pick = <T>(r: SeededRandom, xs: readonly T[]): T => xs[Math.floor(r.next() * xs.length)];
const widthCommand = (w: unknown) => ({ op: "set_part", shape: "box", width: w, depth: 30, height: 20 });

function session(seed: bigint, steps: number) {
  const r = seeded(seed);
  let v: LinkedValue = linkedValue("feature-1/width", "Width", 40, "mm", "design");
  // The model: who owns it, what it is, and every hand-over, kept independently of the code.
  let owner: WorkspaceId = "design";
  let value = 40;
  const handovers: [WorkspaceId, WorkspaceId][] = [];
  // Each proposal with the owner and value it was made against.
  const proposals: { p: ProposedEdit; owner: WorkspaceId; value: number }[] = [];
  const counts = { direct: 0, proposed: 0, refused: 0, accepted: 0, refusedAccept: 0, rejected: 0, transfers: 0 };

  for (let i = 0; i < steps; i++) {
    const at = `seed ${seed} step ${i}`;
    const n = r.next();
    if (n < 0.4) {
      // An edit from some side, mostly good widths, sometimes nasty ones or the wrong command.
      const by = pick(r, SIDES);
      const w = r.next() < 0.8 ? Math.round(r.next() * 1000) / 10 + 0.1 : pick(r, NASTY);
      const command = r.next() < 0.9 ? widthCommand(w) : { op: "set_board_holes", pitch: w };
      const route = proposeEdit(`p${i}`, v, by, w as number, command, DESIGN_COMMANDS);
      const good = typeof w === "number" && Number.isFinite(w) && w > 0 && w !== value && command.op === "set_part";
      if (!good) {
        assert.equal(route.kind, "refused", `${at}: ${JSON.stringify(w)} by ${by} must be refused`);
        counts.refused++;
        continue;
      }
      if (by === owner) {
        assert.equal(route.kind, "direct", at);
        v = setOwnedValue(v, by, w as number);
        value = w as number;
        counts.direct++;
      } else {
        assert.equal(route.kind, "proposed", at);
        if (route.kind !== "proposed") continue;
        assert.equal(route.proposal.to, owner, `${at}: proposed to the owner`);
        assert.equal(v.value, value, `${at}: a proposal changes nothing`);
        proposals.push({ p: route.proposal, owner, value });
        counts.proposed++;
      }
    } else if (n < 0.75 && proposals.length) {
      // Answer some earlier suggestion, possibly one already answered or overtaken.
      // Half the time the newest one, which is most often still answerable.
      const k = r.next() < 0.5 ? proposals.length - 1 : Math.floor(r.next() * proposals.length);
      const entry = proposals[k];
      if (r.next() < 0.6) {
        const answer = acceptProposal(entry.p, v);
        const canAccept = entry.p.state === "pending" && entry.owner === owner && entry.value === value;
        assert.equal(answer.ok, canAccept, `${at}: accept of ${entry.p.id}`);
        if (answer.ok) {
          // The owner runs the command; it must be Design's own, setting the proposed width.
          assert.equal(answer.command?.op, "set_part", at);
          assert.equal((answer.command as { width: number }).width, entry.p.proposed, at);
          const other = SIDES.find((s) => s !== owner) as WorkspaceId;
          assert.throws(() => setOwnedValue(v, other, entry.p.proposed), /can only suggest/, `${at}: only the owner records it`);
          v = setOwnedValue(v, owner, entry.p.proposed);
          value = entry.p.proposed as number;
          entry.p = answer.proposal;
          counts.accepted++;
        } else counts.refusedAccept++;
      } else {
        const answer = rejectProposal(entry.p);
        assert.equal(answer.ok, entry.p.state === "pending", at);
        if (answer.ok) {
          assert.equal(answer.command, null, at);
          entry.p = answer.proposal;
          counts.rejected++;
        }
      }
    } else {
      // Hand the value to some side (sometimes the owner itself, which is refused).
      const to = pick(r, SIDES);
      const t = transferOwnership(v, to);
      assert.equal(t.ok, to !== owner, `${at}: transfer to ${to}`);
      if (t.ok) {
        assert.deepEqual(t.inverse, { op: "transfer_ownership", value: v.id, to: owner }, at);
        handovers.push([owner, to]);
        owner = to;
        v = t.value;
        counts.transfers++;
      }
    }
    // After every step: exactly the model's owner and value, and a history that chains.
    assert.equal(v.owner, owner, at);
    assert.equal(v.value, value, at);
    assert.deepEqual(v.ownership.map((c) => [c.from, c.to]), handovers, at);
    v.ownership.forEach((c, j) => assert.equal(c.from, j === 0 ? "design" : v.ownership[j - 1].to, `${at}: history chains`));
  }
  return counts;
}

test("random sessions on one linked value follow the one-owner rules at every step", () => {
  for (const seed of SEEDS) {
    const c = session(seed, 2_000);
    // Every path must be reached, or the test proves nothing.
    for (const [k, n] of Object.entries(c)) assert.ok(n > 10, `seed ${seed}: only ${n} ${k}`);
  }
});

test("the same seed gives the same session", () => {
  assert.deepEqual(session(7n, 500), session(7n, 500));
});
