// @fission/layout: the Layout workspace. PLACEHOLDER: nothing here works yet.
//
// Graphic design and page layout: posters, social posts and slides made of
// pages with text, shapes, images and graphics on them, starting from our
// own templates. Everything placed on a page is live-linked, never copied:
// artwork from Vector, photos from Image, renders from Render, views of a
// part from Design, and parameters as text (a poster's "40 × 30 mm" follows
// the design). Pages keep their real size (mm for print, pixels for screens),
// so a finished page can also go to Laser as an engraving or cut. Export to
// PDF, PNG and SVG, and slides play full screen. Work starts after CAD step
// 33, once Vector (V1–V2) and Image (G1) work: a page is mostly their content.

import type { WorkspacePlugin } from "@fission/core";
import { showPlaceholder } from "@fission/ui";

const summary = "Graphic design and layout: posters, social posts and slides, built from live-linked artwork, photos and renders.";

/** DRAFT: one placed item. Graphics, images and renders are linked by id, never copied. */
export type PageItem =
  | { kind: "text"; id: string; text: string; font: string; size: number }
  | { kind: "shape"; id: string; svgPath: string }
  | { kind: "linked"; id: string; source: { workspace: "vector" | "image" | "render" | "design"; id: string } };

/** DRAFT: one layout document (a poster, a set of social posts, or a slide deck). */
export interface LayoutDocument {
  id: string;
  /** Print sizes in mm; screen sizes in pixels. */
  unit: "mm" | "px";
  pages: { width: number; height: number; items: { item: PageItem; x: number; y: number; rotation: number }[] }[];
}

/** Writes a layout as PDF (vectors stay vectors). Not implemented yet. */
export function exportPdf(_doc: LayoutDocument): Uint8Array {
  throw new Error("not implemented");
}

/** Writes one page as a PNG at the given pixels per mm. Not implemented yet. */
export function exportPng(_doc: LayoutDocument, _page: number, _pixelsPerMm: number): Uint8Array {
  throw new Error("not implemented");
}

export const layoutWorkspace: WorkspacePlugin = {
  id: "layout",
  title: "Layout",
  summary,
  status: "placeholder",
  representations: { produces: [], accepts: [] },
  commands: [],
  mount(ctx) {
    showPlaceholder(ctx.properties, {
      title: "Layout",
      summary,
      plans: [
        "Pages for posters, social posts and slides, with our own templates and preset sizes",
        "Text, shapes, grids, guides and snapping",
        "Place Vector artwork, Image photos, Render images and Design views, live-linked so edits flow through",
        "Design parameters as text that follows the design",
        "PDF, PNG and SVG export, print at real size, and full-screen slides",
        "Send a page to Laser to engrave or cut it",
      ],
      startsAfter: "after CAD step 33, once Vector (V1–V2) and Image (G1) work",
    });
    return () => ctx.properties.replaceChildren();
  },
};
