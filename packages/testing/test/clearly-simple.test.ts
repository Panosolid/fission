// The sketch-extrude sessions' simple-loop check (`clearlySimple`) next to
// a straight side: issue #140, where it passed a triangle whose arc crossed
// the straight side next to it, so the session expected a body the kernel
// rightly refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import { clearlySimple, type LoopShape } from "../src/sketch-extrude-session.ts";

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
