// The centre arc tool (sketch arcs, three tools): three clicks, the
// centre, the start (which sets the radius), then where the arc ends. The
// end goes on the circle through the start, on the ray from the centre
// through the third click, and the arc runs from the start the way the
// pointer went round the centre to get there: sweep counter-clockwise and
// it is counter-clockwise, sweep back the other way and it is clockwise,
// past half a turn either way if the pointer goes that far. The way round
// is kept as the pointer's angle unwrapped (`sweep`), so going on past
// the start's own ray keeps adding to it rather than jumping back.

import type { SketchArc, SketchXY } from "@fission/core";
import type { DesignDocument, Sketch } from "./document.ts";
import { drawArc, pointAt, type LineEnd } from "./sketch.ts";

/** The centre arc tool on one sketch: the centre, then the start, or null before each; `swept` the pointer's angle round the centre from the start, unwrapped (radians, counter-clockwise above 0). */
export interface CentreArcTool {
  kind: "centre";
  sketch: string;
  centre: SketchXY | null;
  start: SketchXY | null;
  swept: number;
}

const TURN = 2 * Math.PI;

/** An angle brought into (−π, π]. */
function wrap(a: number): number {
  let x = a % TURN;
  if (x > Math.PI) x -= TURN;
  else if (x <= -Math.PI) x += TURN;
  return x;
}

/**
 * The angle at `c` from `s` round to `p`, in (−π, π], counter-clockwise
 * above 0: atan2(u × v, u · v) with u = s − c, v = p − c. Null when `p`
 * is on the centre, which has no direction. Only for which way the arc
 * goes, never for where its end is.
 */
export function angleAt(c: SketchXY, s: SketchXY, p: SketchXY): number | null {
  const [ux, uy] = [s[0] - c[0], s[1] - c[1]];
  const [vx, vy] = [p[0] - c[0], p[1] - c[1]];
  if (vx === 0 && vy === 0) return null;
  return Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
}

/**
 * The sweep after the pointer moves to `p`: the last sweep plus the
 * smallest turn from where it pointed to where it points now, so the
 * pointer can go round past the start and on (the sweep then passes ±π
 * and grows on towards a whole turn). Unchanged with the pointer on the
 * centre. Hovers between clicks feed it; a tap with no hover gives the
 * shorter way round.
 */
export function sweep(c: SketchXY, s: SketchXY, swept: number, p: SketchXY): number {
  const now = angleAt(c, s, p);
  return now === null ? swept : swept + wrap(now - wrap(swept));
}

/**
 * The arc round `c` from `s` to the ray through `p`: the end is
 * c + (p − c)·(r / d), r = |s − c| and d = |p − c|, so it is on the circle
 * through `s` (to within rounding of the coordinates) and lands exactly
 * where a whole-number ratio makes it exact, (3, 4) from the centre with
 * r = 10 at (6, 8). Counter-clockwise (`ccw`) it runs from `s` to the end;
 * clockwise it is counter-clockwise from the end to `s`, so the ends swap.
 * Null when `p` is on the centre (no direction) or the end comes out on
 * `s` itself (no turn).
 */
export function centreArc(c: SketchXY, s: SketchXY, p: SketchXY, ccw: boolean): SketchArc | null {
  const d = Math.sqrt((p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2);
  if (d === 0) return null;
  const k = Math.sqrt((s[0] - c[0]) ** 2 + (s[1] - c[1]) ** 2) / d;
  const e: [number, number] = [c[0] + (p[0] - c[0]) * k, c[1] + (p[1] - c[1]) * k];
  if (e[0] === s[0] && e[1] === s[1]) return null;
  const [start, end] = ccw ? [s, e] : [e, s];
  return { start: [start[0], start[1]], end: [end[0], end[1]], centre: [c[0], c[1]] };
}

/** The tool after a hover at `p` (snapped): the sweep follows the pointer once the start is down. */
export function centreHover(tool: CentreArcTool, p: SketchXY): CentreArcTool {
  if (!tool.centre || !tool.start) return tool;
  const swept = sweep(tool.centre, tool.start, tool.swept, p);
  return swept === tool.swept ? tool : { ...tool, swept };
}

export const NO_RADIUS = "An arc needs a radius: click its start away from the centre.";
export const NO_DIRECTION = "An arc needs an end: click away from its centre to say where it ends.";
export const NO_TURN = "An arc needs to turn: click its end away from its start.";

/**
 * A centre arc's clicks: the centre, the start, then the end (`centreArc`,
 * the way round from `sweep`, this click included), one undo step. The
 * centre and start share points already there; the end shares one only if
 * it is exactly there, else it is a new point. A start on the centre, an
 * end on the centre or one that comes out on the start draws nothing and
 * says why. After an arc the tool starts again from a new centre.
 */
export function centreClick(doc: DesignDocument, sketch: Sketch, tool: CentreArcTool, at: SketchXY): { doc: DesignDocument; tool: CentreArcTool; drew: boolean; note?: string } {
  if (tool.centre === null) return { doc, tool: { ...tool, centre: [at[0], at[1]] }, drew: false };
  if (tool.start === null) {
    if (tool.centre[0] === at[0] && tool.centre[1] === at[1]) return { doc, tool, drew: false, note: NO_RADIUS };
    return { doc, tool: { ...tool, start: [at[0], at[1]], swept: 0 }, drew: false };
  }
  const swept = sweep(tool.centre, tool.start, tool.swept, at);
  const arc = centreArc(tool.centre, tool.start, at, swept >= 0);
  if (!arc) return { doc, tool: { ...tool, swept }, drew: false, note: angleAt(tool.centre, tool.start, at) === null ? NO_DIRECTION : NO_TURN };
  const share = (p: SketchXY): LineEnd => pointAt(sketch, p) ?? p;
  const drawn = drawArc(doc, tool.sketch, share(arc.start), share(arc.end), share(arc.centre));
  return { doc: drawn.doc, tool: { ...tool, centre: null, start: null, swept: 0 }, drew: true };
}

/**
 * What a click at `p` would draw, as a centre arc and the line from its
 * centre: before the start, the radius line from the centre to the
 * pointer; after it, the arc and the radius line to its end (just the
 * radius line while the end would be on the start). `arcSegments` draws
 * the arc; the caller passes it in so this module needs no drawing code.
 */
export function centrePreview(tool: CentreArcTool, p: SketchXY, segments: (arc: SketchArc) => (readonly [SketchXY, SketchXY])[]): (readonly [SketchXY, SketchXY])[] {
  const c = tool.centre;
  if (!c) return [];
  if (!tool.start) return c[0] === p[0] && c[1] === p[1] ? [] : [[c, p]];
  const swept = sweep(c, tool.start, tool.swept, p);
  const arc = centreArc(c, tool.start, p, swept >= 0);
  if (!arc) return [[c, tool.start]];
  const end = swept >= 0 ? arc.end : arc.start;
  return [[c, tool.start], ...segments(arc), [c, end]];
}
