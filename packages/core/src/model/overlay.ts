// Analysis overlays: any workspace can paint data onto the shared
// viewport's faces and edges — colours, warnings and labels — without
// owning the viewport. Printability, machinability, stress results and
// design-rule errors all arrive this way (I16, I17).
//
// Overlays are display only; they are never saved. Until stable ids exist
// (step 32) a mark names a face by its index in the body on screen, or the
// whole body.

export type OverlayTarget = { face: number } | { body: true };

/** Severity sets the colour, so every workspace's warnings look the same. */
export type OverlaySeverity = "info" | "warning" | "error";

export interface OverlayMark {
  target: OverlayTarget;
  severity: OverlaySeverity;
}

export interface AnalysisOverlay {
  /** One overlay per id; setting it again replaces it. */
  id: string;
  /** Shown in the viewport's legend, e.g. "Too big for an accurate STL". */
  label: string;
  /** Longer text for the legend's tooltip. */
  detail?: string;
  marks: OverlayMark[];
}

/** RGB in 0–1 for each severity. */
export const SEVERITY_COLOURS: Record<OverlaySeverity, [number, number, number]> = {
  info: [0.36, 0.62, 0.95],
  warning: [0.96, 0.69, 0.3],
  error: [1, 0.42, 0.42],
};

const rank: Record<OverlaySeverity, number> = { info: 0, warning: 1, error: 2 };

/**
 * The colour of each triangle under these overlays (null where nothing is
 * marked). Where marks overlap, the most severe wins.
 */
export function triangleColours(triangleFaces: readonly number[], overlays: readonly AnalysisOverlay[]): ([number, number, number] | null)[] {
  const worst = new Map<number | "body", OverlaySeverity>();
  for (const o of overlays)
    for (const m of o.marks) {
      const key = "face" in m.target ? m.target.face : "body";
      const was = worst.get(key);
      if (!was || rank[m.severity] > rank[was]) worst.set(key, m.severity);
    }
  const body = worst.get("body");
  return triangleFaces.map((f) => {
    const face = worst.get(f);
    const s = face && body ? (rank[face] >= rank[body] ? face : body) : (face ?? body);
    return s ? SEVERITY_COLOURS[s] : null;
  });
}
