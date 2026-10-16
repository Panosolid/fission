// Drawing the selection and hover (step 17d). Pure, so the colours are
// unit-tested without a browser; viewer.ts applies them.
//
// A selected or hovered face is tinted towards the selection colour rather
// than painted over, so an analysis overlay under it stays visible. Edges
// are drawn in the selection colour itself (black otherwise).

import type { ViewportHighlight } from "@fission/core";

export type Rgb = [number, number, number];

/** Green, apart from the overlays' blue, orange and red (SEVERITY_COLOURS), sRGB 0–1. */
export const SELECTION_COLOUR: Rgb = [0.25, 0.9, 0.45];
/** How far a selected face moves from its own colour towards SELECTION_COLOUR. */
export const SELECTED_MIX = 0.6;
/** The same for a hovered face: lighter, so hover and selection tell apart. */
export const HOVER_MIX = 0.3;
/** A face's colour when nothing marks it, sRGB 0–1 (0x9aa7b8). */
export const BASE_COLOUR: Rgb = [0x9a / 255, 0xa7 / 255, 0xb8 / 255];
/** An edge's colour when not selected or hovered. */
export const EDGE_COLOUR: Rgb = [0x0b / 255, 0x0c / 255, 0x0e / 255];

/** `colour` moved the fraction `mix` of the way towards `towards` (0 keeps it, 1 replaces it). */
export function tint(colour: Rgb, towards: Rgb, mix: number): Rgb {
  return [0, 1, 2].map((i) => colour[i] + (towards[i] - colour[i]) * mix) as Rgb;
}

/**
 * How far each triangle moves towards the selection colour: SELECTED_MIX
 * on a selected face (every face when the body is selected), HOVER_MIX on
 * the hovered face, 0 elsewhere. Selected wins over hovered.
 */
export function faceMixes(triangleFaces: ArrayLike<number>, highlight: ViewportHighlight, hoverFace: number | null): number[] {
  const selected = new Set(highlight.faces);
  return Array.from(triangleFaces, (f) => (highlight.body || selected.has(f) ? SELECTED_MIX : f === hoverFace ? HOVER_MIX : 0));
}

/**
 * The colour of each line segment (one per entry of `edge_line_edges`): the
 * selection colour on a selected edge, halfway there on the hovered edge,
 * EDGE_COLOUR elsewhere. Selecting the body tints faces, not edges.
 */
export function segmentColours(edgeLineEdges: ArrayLike<number>, highlight: ViewportHighlight, hoverEdge: number | null): Rgb[] {
  const selected = new Set(highlight.edges);
  const hovered = tint(EDGE_COLOUR, SELECTION_COLOUR, 0.5);
  return Array.from(edgeLineEdges, (e) => (selected.has(e) ? SELECTION_COLOUR : e === hoverEdge ? hovered : EDGE_COLOUR));
}
