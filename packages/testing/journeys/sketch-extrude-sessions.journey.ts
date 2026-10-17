// Journey: seeded sketch-and-extrude sessions on the real kernel
// (src/sketch-extrude-session.ts): a simulated user draws with Design's
// tools, extrudes, edits and saves, and every step's part is checked
// against a model kept apart from Design and the kernel. Hand-worked
// shapes first, then the model's own checks, then the sessions, then each
// planted bug caught. Run with `npm run journeys` after the app build.
//
// Size: FISSION_SESSIONS sessions (default 40) of FISSION_SESSION_STEPS
// steps (default 30). Replay one failing session: FISSION_SEED=<its seed,
// decimal> FISSION_SESSIONS=1, with the steps it names. Seeds of failures
// kept for good are in test/regressions/sketch-extrude/*.json and replay
// every run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { addSketch, buildSpec, clickAt, extrudeSketch, featureSpec, lastFeature, partDocument, startTool, switchTool, type DesignDocument, type SketchTool } from "@fission/design";
import { nodeKernel } from "../src/node-kernel.ts";
import { FAULTS, clearlySimple, matches, measureShape, reversedLoop, runSession, sessionSeed, type Fault, type LoopShape } from "../src/sketch-extrude-session.ts";

const kernel = nodeKernel();
const SESSIONS = Number(process.env.FISSION_SESSIONS ?? "40");
const STEPS = Number(process.env.FISSION_SESSION_STEPS ?? "30");
const FIRST = process.env.FISSION_SEED;
if (FIRST !== undefined && !/^\d+$/.test(FIRST.trim())) throw new Error("FISSION_SEED is a decimal number");

const near = (got: number, want: number, what: string) => assert.ok(Math.abs(got - want) <= 1e-9 * Math.max(1, Math.abs(want)), `${what}: ${got}, expected ${want}`);

/** Clicks with one tool after another, as a user makes them; returns the document. */
function clicks(doc: DesignDocument, sketch: string, plan: [SketchTool["kind"], ...[number, number][]][]): DesignDocument {
  let tool: SketchTool = startTool("line", sketch);
  for (const [kind, ...points] of plan) {
    tool = switchTool(doc, tool, kind);
    for (const p of points) ({ doc, tool } = clickAt(doc, tool, p));
  }
  return doc;
}

test("hand-worked: a 20 mm square with a half circle on top and its right side bitten in, drawn with the tools and extruded 5 mm", async () => {
  // Bottom (0,0)→(20,0) and left (0,20)→(0,0) are lines. Top (20,20)→(0,20)
  // bulges up through (10,30): a half circle of radius 10, adding ½π·10² =
  // 50π mm² and 10π mm of edge. Right (20,0)→(20,20) bends in through
  // (15,10): half chord h = 10, sagitta s = 5, so r = (h² + s²)/(2s) =
  // 125/10 = 12.5 and the half turn θ has sin θ = h/r = 0.8, cos θ = 0.6;
  // the turn φ = 2θ = 4·atan(½), sin φ = 2·0.8·0.6 = 0.96. Its segment
  // r²(φ − sin φ)/2 = 78.125(φ − 0.96) leaves the square; its length is 12.5φ.
  // Area A = 400 + 50π − 78.125(φ − 0.96); perimeter P = 40 + 10π + 12.5φ.
  // By 5 mm: V = 5A, surface 2A + 5P; 4 sides: 8 vertices, 12 edges, 6 faces.
  const s = addSketch(partDocument("box", 10, 10, 10));
  const doc = clicks(s.doc, s.id, [
    ["line", [0, 0], [20, 0]],
    ["arc", [20, 0], [20, 20], [15, 10]],
    ["arc", [20, 20], [0, 20], [10, 30]],
    ["line", [0, 20], [0, 0]],
  ]);
  const phi = 4 * Math.atan(0.5);
  const A = 400 + 50 * Math.PI - 78.125 * (phi - 0.96);
  const P = 40 + 10 * Math.PI + 12.5 * phi;
  const part = extrudeSketch(doc, s.id, 5).doc;
  const body = await buildSpec(kernel, await featureSpec(kernel, part, lastFeature(part)));
  near(body.volume, 5 * A, "volume");
  near(body.area, 2 * A + 5 * P, "area");
  assert.deepEqual([body.vertices, body.edges, body.faces, body.errors], [8, 12, 6, []]);
  // The model, from corners and sagittas alone, gives the same numbers:
  // side 1 bends left of (20,0)→(20,20) (inwards, −5), side 2 right of
  // (20,20)→(0,20) (outwards, +10).
  const shape: LoopShape = { kind: "loop", corners: [[0, 0], [20, 0], [20, 20], [0, 20]], sagitta: [0, -5, 10, 0] };
  const m = measureShape(shape);
  near(m.area, A, "model area");
  near(m.perimeter, P, "model perimeter");
  // Drawn the other way round, the same shape.
  const back = measureShape(reversedLoop(shape));
  near(back.area, A, "model area drawn backwards");
  near(back.perimeter, P, "model perimeter drawn backwards");
});

test("the comparer at 0.9× and 1.1× of MATCH_REL (1e-9, relative)", () => {
  // 1000 mm³ against 1000·(1 + 0.9e-9) passes; 1000·(1 + 1.1e-9) fails.
  assert.equal(matches(1000 * (1 + 0.9e-9), 1000), true);
  assert.equal(matches(1000 * (1 + 1.1e-9), 1000), false);
  // Below 1 the allowance is absolute 1e-9: 0.5 + 0.9e-9 passes, 0.5 + 1.1e-9 fails.
  assert.equal(matches(0.5 + 0.9e-9, 0.5), true);
  assert.equal(matches(0.5 + 1.1e-9, 0.5), false);
});

test("the model's simple-loop check refuses what it must", () => {
  const square: LoopShape = { kind: "loop", corners: [[0, 0], [20, 0], [20, 20], [0, 20]], sagitta: [0, 0, 0, 0] };
  assert.equal(clearlySimple(square), true);
  // A bow tie: (0,0)→(20,0)→(0,20)→(20,20) crosses itself at (10,10).
  assert.equal(clearlySimple({ ...square, corners: [[0, 0], [20, 0], [0, 20], [20, 20]] }), false);
  // A 4 × 20 strip whose right side (half chord 10) bends in by 3.9: its
  // middle reaches x = 0.1, clear of the left side by more than 1e-3 of the
  // size (√(4² + 20²) ≈ 20.4, so 0.0204); bent in by 3.99 it reaches
  // x = 0.01, inside that margin, and is refused. (A sagitta under the half
  // chord keeps the arc within the chord's own span, y from 0 to 20.)
  const strip: LoopShape = { kind: "loop", corners: [[0, 0], [4, 0], [4, 20], [0, 20]], sagitta: [0, -3.9, 0, 0] };
  assert.equal(clearlySimple(strip), true);
  assert.equal(clearlySimple({ ...strip, sagitta: [0, -3.99, 0, 0] }), false);
  // A corner turning straight on: (10,0) on the bottom side, a 0 rad turn.
  assert.equal(clearlySimple({ ...square, corners: [[0, 0], [10, 0], [20, 0], [20, 20], [0, 20]], sagitta: [0, 0, 0, 0, 0] }), false);
  // A cusp: a spike out to (40, 10) and back by (20, 10.05) turns 3.13 rad.
  assert.equal(clearlySimple({ ...square, corners: [[0, 0], [20, 0], [20, 10], [40, 10.0001], [20, 10.05], [20, 20], [0, 20]], sagitta: [0, 0, 0, 0, 0, 0, 0] }), false);
});

/** Runs sessions from `first`; returns the totals and fails on the first failing session, naming how to replay it. */
async function sessions(first: bigint, count: number, steps: number, fault?: Fault) {
  const total = { built: 0, refused: 0, curved: 0, failures: [] as string[] };
  for (let i = 0; i < count; i++) {
    const seed = count === 1 ? first : sessionSeed(first, i);
    const r = await runSession(kernel, { seed, steps, fault });
    total.built += r.built;
    total.refused += r.refused;
    total.curved += r.curved;
    if (r.failure) total.failures.push(`${r.failure}\n  replay: FISSION_SEED=${seed} FISSION_SESSIONS=1 FISSION_SESSION_STEPS=${steps}\n  steps: ${r.ops.join("; ")}`);
    if (fault && r.failure) break;
  }
  return total;
}

test(`seeded sessions: ${SESSIONS} sessions of ${STEPS} steps, every part checked against the model`, async () => {
  const t = await sessions(FIRST !== undefined ? BigInt(FIRST.trim()) : 1n, SESSIONS, STEPS);
  assert.deepEqual(t.failures, []);
  console.log(`  sketch-extrude sessions: ${t.built} parts built and matched, ${t.curved} with arcs or circles, ${t.refused} open sketches refused`);
  // The sessions must reach every outcome, not pass by never building.
  if (SESSIONS * STEPS >= 1000) assert.ok(t.built >= SESSIONS * STEPS * 0.5 && t.curved >= SESSIONS * STEPS * 0.15 && t.refused >= SESSIONS, `built ${t.built}, curved ${t.curved}, refused ${t.refused}`);
});

for (const fault of Object.keys(FAULTS) as Fault[]) {
  test(`planted bug caught: ${FAULTS[fault]}`, async () => {
    const t = await sessions(1n, 40, 30, fault);
    assert.ok(t.failures.length > 0, `${fault} was not caught in 40 sessions`);
  });
}

test("saved failing sessions replay and pass", async () => {
  const dir = new URL("../test/regressions/sketch-extrude/", import.meta.url);
  const saved = readdirSync(dir).filter((f) => f.endsWith(".json"));
  for (const f of saved) {
    const { seed, steps } = JSON.parse(readFileSync(new URL(f, dir), "utf8")) as { seed: string; steps: number };
    const r = await runSession(kernel, { seed: BigInt(seed), steps });
    assert.equal(r.failure, undefined, `${f}: ${r.failure}`);
  }
});
