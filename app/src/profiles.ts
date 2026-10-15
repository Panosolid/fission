// Ready-made outlines for the extrude demo, until the sketcher (steps 21–31)
// lets people draw their own. Each fits a width × depth rectangle with one
// corner at the origin, and crosses to the kernel as flat [x0, y0, x1, y1, …]
// arrays (see profile_from_flat in kernel/src/lib.rs).

export type ShapeKind = "box" | "l-bracket" | "plate" | "star";

export interface Outline {
  outer: number[];
  /** Corners in each hole, in order. */
  holeCorners: number[];
  /** Every hole's corners, flattened one after another. */
  holes: number[];
}

/** Regular polygon around (cx, cy), first corner on the +x side. */
function polygon(cx: number, cy: number, radii: number[], sides: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * 2 * Math.PI;
    const r = radii[i % radii.length];
    out.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
  return out;
}

/** Corners in a round hole; true circles arrive with step 10. */
export const HOLE_SIDES = 24;

export function outline(kind: Exclude<ShapeKind, "box">, w: number, d: number): Outline {
  switch (kind) {
    case "l-bracket":
      // Arms 0.3 of the width and depth thick.
      return { outer: [0, 0, w, 0, w, 0.3 * d, 0.3 * w, 0.3 * d, 0.3 * w, d, 0, d], holeCorners: [], holes: [] };
    case "plate": {
      // Two round holes, centred a quarter in from each end.
      const r = 0.15 * Math.min(w, d);
      return {
        outer: [0, 0, w, 0, w, d, 0, d],
        holeCorners: [HOLE_SIDES, HOLE_SIDES],
        holes: [...polygon(w / 4, d / 2, [r], HOLE_SIDES), ...polygon((3 * w) / 4, d / 2, [r], HOLE_SIDES)],
      };
    }
    case "star": {
      // Five points; inner corners at 0.4 of the outer radius.
      const r = 0.5 * Math.min(w, d);
      return { outer: polygon(w / 2, d / 2, [r, 0.4 * r], 10), holeCorners: [], holes: [] };
    }
  }
}
