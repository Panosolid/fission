// Outline → SVG (X6b): what "Copy as SVG" puts on the clipboard, and later
// what Laser and Vector export. One <path> holds the outer loop and every
// hole (fill-rule evenodd), so other programs see one shape with holes.
//
// Conventions, each checked by a hand-worked test:
// - Units are millimetres: width="…mm" and height="…mm" match the viewBox,
//   so one user unit is one mm.
// - SVG's y points down, so every point is written as (x, −y): x stays as
//   in the model and the shape is not mirrored.
// - A corner's bulge b shapes the piece to the next corner (as the kernel's
//   ProfileIn): the arc turns 4·atan b, counter-clockwise for b > 0, round
//   a centre the chord's midpoint moved c(1 − b²)/(4b) along its left normal.
//   It is written as SVG `A` commands of at most a quarter turn each (an arc
//   of more is split into equal parts), so the large-arc flag is always 0;
//   the sweep flag is 0 for b > 0: with y flipped, the model's
//   counter-clockwise is SVG's negative-angle way.
// - A circle is four quarter arcs, counter-clockwise from its east point.
// - Why quarter turns: SVG gives an arc by its ends and radius, and finds
//   the centre from those. Near a half turn the centre moves by ~√(r·δ) when
//   the radius moves by δ, so rounding r to 1e-6 could shift a 1 m half
//   circle by ~0.03 mm. Up to a quarter turn it moves by at most √2·δ.
// - Numbers are rounded to 1e-6 mm (100× below LINEAR, 10 nm) and written
//   without trailing zeros or exponents.
// - The viewBox is the outline's exact bounding box: corners, circles, and
//   each arc's points due east, north, west or south of its centre that lie
//   on the arc.
//
// The arc maths here is only what the file format needs (radius, flags,
// extremes for the viewBox); it moves to the kernel's 2D curve library
// once that exists (packages/CLAUDE.md, "Ecosystem").

import type { Loop, Outline } from "../kernel/kernel-types.ts";

export interface SvgFile {
  /** The whole file, starting `<svg`. */
  text: string;
  /** The outline's size in mm (the viewBox's width and height). */
  width: number;
  height: number;
}

/** A number as SVG writes it: rounded to 1e-6, no trailing zeros, never "-0" or an exponent. */
export function svgNumber(v: number): string {
  const s = v.toFixed(6).replace(/\.?0+$/, "");
  return s === "-0" ? "0" : s;
}

const TAU = 2 * Math.PI;

/**
 * The bulges of one, two and three quarter turns (tan of a quarter of the
 * turn): an arc with a bulge above k of these is split into k + 1 parts.
 * Compared on the bulge, not the turn 4·atan b, so a quarter or half turn
 * given exactly (tan(π/8), 1) is never split by rounding.
 */
const QUARTERS = [Math.tan(Math.PI / 8), 1, Math.tan((3 * Math.PI) / 8)];

interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function grow(box: Box, x: number, y: number) {
  box.minX = Math.min(box.minX, x);
  box.minY = Math.min(box.minY, y);
  box.maxX = Math.max(box.maxX, x);
  box.maxY = Math.max(box.maxY, y);
}

/** Throws unless the loop is well formed: finite numbers, whole corners, one bulge per corner or none, a positive radius. */
function check(loop: Loop, which: string) {
  const bad = (why: string) => {
    throw new Error(`the ${which} can't be written as SVG: ${why}`);
  };
  if ("circle" in loop) {
    const { center, radius } = loop.circle;
    if (!center.every(Number.isFinite) || !Number.isFinite(radius)) bad("its circle has a number that is not finite");
    if (!(radius > 0)) bad(`its circle's radius is ${radius}, not above 0`);
    return;
  }
  const { corners, bulges } = loop.path;
  if (corners.length % 2 !== 0) bad(`it has ${corners.length} corner numbers, not whole x, y pairs`);
  const n = corners.length / 2;
  if (n < 2) bad(`it has ${n} corner${n === 1 ? "" : "s"}, and a closed path needs at least 2`);
  if (bulges.length !== 0 && bulges.length !== n) bad(`it has ${n} corners but ${bulges.length} bulges (one per corner, or none)`);
  if (bulges.length === 0 && n < 3) bad("2 corners joined by straight pieces enclose nothing");
  if (!corners.every(Number.isFinite) || !bulges.every(Number.isFinite)) bad("it has a number that is not finite");
}

/** The SVG path data for one loop, y flipped, growing `box` by its extent (in model coordinates). */
function loopPath(loop: Loop, box: Box): string {
  const p = (x: number, y: number) => `${svgNumber(x)} ${svgNumber(-y)}`;
  if ("circle" in loop) {
    const {
      center: [cx, cy],
      radius: r,
    } = loop.circle;
    grow(box, cx - r, cy - r);
    grow(box, cx + r, cy + r);
    const R = svgNumber(r);
    const quarter = (x: number, y: number) => `A${R} ${R} 0 0 0 ${p(x, y)}`;
    return `M${p(cx + r, cy)}${quarter(cx, cy + r)}${quarter(cx - r, cy)}${quarter(cx, cy - r)}${quarter(cx + r, cy)}Z`;
  }
  const { corners, bulges } = loop.path;
  const n = corners.length / 2;
  let d = `M${p(corners[0], corners[1])}`;
  for (let i = 0; i < n; i++) {
    const [ax, ay] = [corners[2 * i], corners[2 * i + 1]];
    const j = (i + 1) % n;
    const [bx, by] = [corners[2 * j], corners[2 * j + 1]];
    grow(box, ax, ay);
    const b = bulges[i] ?? 0;
    const c = Math.hypot(bx - ax, by - ay);
    if (b === 0 || c === 0) {
      // The last straight piece is the Z that closes the loop.
      if (j !== 0) d += `L${p(bx, by)}`;
      continue;
    }
    const r = (c * (1 + b * b)) / (4 * Math.abs(b));
    // Centre: the chord's midpoint, moved along its left normal by c(1 − b²)/(4b) (as the kernel's Seg::from_bulge).
    const k = (1 - b * b) / (4 * b);
    const cx = (ax + bx) / 2 - (by - ay) * k;
    const cy = (ay + by) / 2 + (bx - ax) * k;
    const sweep = 4 * Math.atan(b);
    const start = Math.atan2(ay - cy, ax - cx);
    // Points due east, north, west and south of the centre that the arc passes widen the box.
    for (let q = 0; q < 4; q++) {
      const angle = (q * Math.PI) / 2;
      const along = sweep > 0 ? (((angle - start) % TAU) + TAU) % TAU : (((start - angle) % TAU) + TAU) % TAU;
      if (along <= Math.abs(sweep)) grow(box, cx + r * Math.cos(angle), cy + r * Math.sin(angle));
    }
    // Equal parts of at most a quarter turn; the last ends exactly on the next corner.
    const parts = 1 + QUARTERS.filter((t) => Math.abs(b) > t).length;
    const R = svgNumber(r);
    for (let k = 1; k <= parts; k++) {
      const [x, y] = k === parts ? [bx, by] : [cx + r * Math.cos(start + (sweep * k) / parts), cy + r * Math.sin(start + (sweep * k) / parts)];
      d += `A${R} ${R} 0 0 ${b > 0 ? 0 : 1} ${p(x, y)}`;
    }
  }
  return `${d}Z`;
}

/** Escapes text for an SVG element's content. */
const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The outline as an SVG file, sized in mm. `title` (e.g. "L-bracket
 * profile") becomes the file's <title>. A malformed outline throws an
 * Error saying what is wrong; nothing is written for it.
 */
export function outlineToSvg(outline: Outline, title?: string): SvgFile {
  check(outline.outer, "outline");
  outline.holes.forEach((h, i) => check(h, `hole ${i + 1}`));
  const box: Box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const data = [outline.outer, ...outline.holes].map((l) => loopPath(l, box)).join("");
  const width = box.maxX - box.minX;
  const height = box.maxY - box.minY;
  const [w, h] = [svgNumber(width), svgNumber(height)];
  const lines = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}mm" height="${h}mm" viewBox="${svgNumber(box.minX)} ${svgNumber(-box.maxY)} ${w} ${h}">`,
    ...(title ? [`<title>${escape(title)}</title>`] : []),
    `<path d="${data}" fill="none" fill-rule="evenodd" stroke="#000" stroke-width="1" vector-effect="non-scaling-stroke"/>`,
    "</svg>",
    "",
  ];
  return { text: lines.join("\n"), width, height };
}
