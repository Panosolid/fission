// Ready-made outlines for the extrude demo, until the sketcher (steps 21–31)
// lets people draw their own. Each fits a width × depth rectangle with one
// corner at the origin, in the form the kernel takes (ProfileIn in
// kernel/src/lib.rs): loops of corners [x0, y0, x1, y1, …] with one bulge
// per corner (0 straight, ±1 a half circle; tan of a quarter of the arc's
// turn), or circles.

export type ShapeKind = "box" | "cylinder" | "l-bracket" | "plate" | "slot" | "star";

export type Loop =
  | { path: { corners: number[]; bulges: number[] } }
  | { circle: { center: [number, number]; radius: number } };

export interface Outline {
  outer: Loop;
  holes: Loop[];
}

const straight = (corners: number[]): Loop => ({ path: { corners, bulges: [] } });

/** Corners of a regular polygon around (cx, cy), first one on the +x side. */
function polygon(cx: number, cy: number, radii: number[], sides: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * 2 * Math.PI;
    const r = radii[i % radii.length];
    out.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
  return out;
}

export function outline(kind: Exclude<ShapeKind, "box" | "cylinder">, w: number, d: number): Outline {
  switch (kind) {
    case "l-bracket":
      // Arms 0.3 of the width and depth thick.
      return { outer: straight([0, 0, w, 0, w, 0.3 * d, 0.3 * w, 0.3 * d, 0.3 * w, d, 0, d]), holes: [] };
    case "plate": {
      // Two round holes, centred a quarter in from each end.
      const radius = 0.15 * Math.min(w, d);
      return {
        outer: straight([0, 0, w, 0, w, d, 0, d]),
        holes: [
          { circle: { center: [w / 4, d / 2], radius } },
          { circle: { center: [(3 * w) / 4, d / 2], radius } },
        ],
      };
    }
    case "slot":
      // Straight sides along x, half-circle ends of radius d/2 (bulge 1:
      // counter-clockwise half turns), the whole fitting w × d.
      return {
        outer: { path: { corners: [d / 2, 0, w - d / 2, 0, w - d / 2, d, d / 2, d], bulges: [0, 1, 0, 1] } },
        holes: [],
      };
    case "star": {
      // Five points; inner corners at 0.4 of the outer radius.
      const r = 0.5 * Math.min(w, d);
      return { outer: straight(polygon(w / 2, d / 2, [r, 0.4 * r], 10)), holes: [] };
    }
  }
}
