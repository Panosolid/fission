// The sketch-extrude sessions' simple-loop check (`clearlySimple`) next to
// a straight side: issue #140, where it passed a triangle whose arc crossed
// the straight side next to it, so the session expected a body the kernel
// rightly refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import { clearlySimple, reversedLoop, type LoopShape } from "../src/sketch-extrude-session.ts";

test("an arc bent in far enough to cross the straight side next to it is not clearly simple; bent in less, it is", () => {
  // Triangle (0,0) → (40,0) → (0,10), counter-clockwise; side 1, the
  // hypotenuse (40,0) → (0,10), is bent in (to its left: sagitta < 0).
  // Half chord h = √(40² + 10²)/2 = √1700/2 ≈ 20.616. The corner at (40,0)
  // is atan(10/40) ≈ 14.04° between the bottom side and the chord; the arc
  // leaves the chord at half its turn, 2·atan(|s|/h).
  // Bent in by 4: half turn 2·atan(4/20.616) ≈ 21.96° > 14.04°, so the arc
  // dips under y = 0. Its radius is (h² + s²)/(2|s|) = (425 + 16)/8 =
  // 55.125, its centre (r − |s|) = 51.125 along the chord's right normal
  // (10, 40)/√1700 from the chord's middle (20, 5): (32.40, 54.60). It meets
  // y = 0 where (x − 32.40)² = 55.125² − 54.60² ≈ 57.6: x = 40 (the corner)
  // and x ≈ 24.81, a crossing 15.2 mm along the bottom side.
  const crossing: LoopShape = { kind: "loop", corners: [[0, 0], [40, 0], [0, 10]], sagitta: [0, -4, 0] };
  assert.equal(clearlySimple(crossing), false);
  // Bent in by 1: half turn 2·atan(1/20.616) ≈ 5.55° < 14.04°, so the arc
  // stays above y = 0, leaving the bottom side at 8.49° (clear of the
  // 0.1 rad ≈ 5.73° cusp guard), its first piece (radius (425 + 1)/2 = 213,
  // turn 4·atan(1/20.616) ≈ 0.194 rad in 6 pieces, so 6.9 mm long) ending
  // about 1 mm above it, far past the 0.041 margin: clearly simple. (Bent
  // in by 2 it leaves at 2.96°, which the cusp guard refuses.)
  assert.equal(clearlySimple({ ...crossing, sagitta: [0, -1, 0] }), true);
  assert.equal(clearlySimple({ ...crossing, sagitta: [0, -2, 0] }), false);
  // The same two loops started at each corner and drawn the other way
  // round give the same answers (the straight side is then each of side 0,
  // side n − 1 and a middle side next to the arc).
  for (const [s, want] of [[-4, false], [-1, true]] as const) {
    const c: [number, number][] = [[0, 0], [40, 0], [0, 10]];
    const sag = [0, s, 0];
    for (let k = 0; k < 3; k++) {
      const corners = [...c.slice(k), ...c.slice(0, k)];
      const sagitta = [...sag.slice(k), ...sag.slice(0, k)];
      assert.equal(clearlySimple({ kind: "loop", corners, sagitta }), want, `from corner ${k}`);
      // Reversed: corners backwards, side i of the new loop is old side n − 2 − i, sagitta negated.
      const rc = [...corners].reverse();
      const rs = rc.map((_, i) => -sagitta[(3 - 2 - i + 3) % 3]);
      assert.equal(clearlySimple({ kind: "loop", corners: rc, sagitta: rs }), want, `from corner ${k}, reversed`);
    }
  }
});

test("issue #140's triangle: the arc from (158,-10) to (183,-39) bent in by 5.84 crosses the side from (183,-39) to (172,5)", () => {
  // Its centre is (148.95, -43.08), radius 34.30. The side (183,-39) → (172,5)
  // is the line x·(-0.970) + y·(-0.2425) = c; the arc point at 21.4° round
  // the centre, (180.88, -30.56), is on it, 8.7 mm from the corner, and the
  // arc at 40° round the centre, (175.23, -21.03), is 3.18 mm past it.
  const shape: LoopShape = { kind: "loop", corners: [[183, -39], [172, 5], [158, -10]], sagitta: [0, 0, -5.840267196986291] };
  assert.equal(clearlySimple(shape), false);
});

test("a line and an arc meeting almost straight on are not clearly simple, measured on the arc's true tangent", () => {
  // Side 0 runs along +x from (0,0) to (40,0); side 1 is an arc of turn
  // φ = 1 rad over a 20 mm chord at angle α from (40,0), bulging right, so
  // it curves left and leaves (40,0) at α − φ/2 (sagitta h·tan(φ/4) =
  // 10·tan 0.25 = 2.553); side 2 runs straight back to (0,0). With
  // α = τ + 0.5 the corner at (40,0) turns τ. The guard refuses turns under
  // 0.02 rad: τ = 0.9 × 0.02 is refused, 1.1 × 0.02 passes. The arc's first
  // piece (of 2 + ⌈1/0.05⌉ = 22) points φ/44 = 0.0227 rad further left,
  // so measured on it (as before issue #140) both passed.
  const loop = (tau: number): LoopShape => {
    const alpha = tau + 0.5;
    return { kind: "loop", corners: [[0, 0], [40, 0], [40 + 20 * Math.cos(alpha), 20 * Math.sin(alpha)]], sagitta: [0, 10 * Math.tan(0.25), 0] };
  };
  for (const [tau, want] of [[0.018, false], [0.022, true]] as const) {
    assert.equal(clearlySimple(loop(tau)), want, `turn ${tau}`);
    assert.equal(clearlySimple(reversedLoop(loop(tau))), want, `turn ${tau}, drawn the other way`);
  }
});

test("issue #140 again: the three loops random testing found on main, each a line and an arc turning under 1e-4 rad, are not clearly simple", () => {
  // Each corner turn worked from the true tangents: 4.2e-5 rad between a
  // line and an arc of radius 16.80 (the arc parallel to the line 16.80 ×
  // 4.2e-5 = 7.06e-4 mm past the corner, the kernel's 7.055894981908582e-4),
  // 3.3e-5 rad at radius 6.516 (2.15e-4; kernel 2.17e-4) and 6.9e-5 rad at
  // radius 13.45 (9.3e-4; kernel 9.33e-4).
  const loops: LoopShape[] = [
    { kind: "loop", corners: [[7.5, -275], [10, -262.5], [2.5, -245], [20, -230], [45, -227.5], [65, -245], [47.5, -270], [32.5, -267.5]], sagitta: [0, 2.9569460046694185, 0, 0.8281045856958971, -12.711127688581389, 0, 0, 0] },
    { kind: "loop", corners: [[-107.97000511683193, -325.9538384652543], [-110.37403541185812, -337.72006160599307], [-120.41488816184297, -335.3904534366089], [-113.2268696919924, -322.35552063529036]], sagitta: [-3.986297184012875, -3.7823752193597038, 0, 0] },
    { kind: "loop", corners: [[-73.5, 258], [-50.5, 274], [-71.5, 294], [-98, 298.5], [-100, 284], [-98, 268.5], [-102.5, 246], [-79.5, 253.5]], sagitta: [1.5611113234386775, 0, 13.86581630586769, 0, -1.5940621349996444, 8.585608708300963, -3.3872431631666404, 2.8585036162413098] },
  ];
  for (const [i, shape] of loops.entries()) assert.equal(clearlySimple(shape), false, `loop ${i}`);
});

test("two arcs crossing 1.47 mm from their narrow corner are not clearly simple, however long their first pieces", () => {
  // Issue #140, seed 3955982769946476140 on main. Side 4 runs (0,-100) →
  // (0,-90) bulging west by 5.137: radius (5² + 5.137²)/(2·5.137) = 5.0018,
  // centre (−0.1347, −95). Side 5 runs (0,-90) → (−20,-90) bulging south by
  // 0.650: radius (10² + 0.65²)/(2·0.65) = 77.241, centre (−10, −13.409).
  // They leave (0,-90) 6.2° apart (east-going in, 187.4° out: a turn of
  // 3.033 rad, inside the 3.042 cusp guard). The two circles meet at the
  // corner and again at (−1.4573, −90.1762), 1.468 mm along, which lies on
  // both arcs: a crossing. Side 5's first piece is 20 × 0.26/8 ≈ 2.5 mm
  // long; leaving it out hid the crossing.
  const shape: LoopShape = { kind: "loop", corners: [[-10, -80], [0, -80], [10, -80], [10, -90], [0, -100], [0, -90], [-20, -90]], sagitta: [0, -6.435302632380251, 0.48843629388785004, 0, -5.136540470553309, -0.6500593012656113, -2.0228515972102623] };
  assert.equal(clearlySimple(shape), false);
  assert.equal(clearlySimple(reversedLoop(shape)), false);
});
