// @fission/image: the Image workspace. PLACEHOLDER: nothing here works yet.
//
// Photo and texture editing: layers, masks, adjustments, brushes and
// selections, PNG and JPEG import and export. Images keep their physical
// size (mm per pixel), so an image can become a texture or material map in
// Render, a raster engraving in Laser, a lithophane in Slice, or traced
// outlines in Vector or a Design sketch. Work starts after CAD step 33 and
// Render's first steps (R1–R2).

import type { WorkspacePlugin } from "@fission/core";
import { showPlaceholder } from "@fission/ui";

const summary = "Photo and texture editing with real-world sizes, for textures, engravings, lithophanes and tracing.";

/** DRAFT: one image document. */
export interface ImageDocument {
  id: string;
  width: number;
  height: number;
  /** Physical size of one pixel. */
  mmPerPixel: number;
  layers: { name: string; visible: boolean }[];
}

/** Reads a PNG or JPEG file. Not implemented yet. */
export function importImage(_bytes: Uint8Array, _mmPerPixel: number): ImageDocument {
  throw new Error("not implemented");
}

export const imageWorkspace: WorkspacePlugin = {
  id: "image",
  title: "Image",
  summary,
  status: "placeholder",
  representations: { produces: [], accepts: [] },
  mount(ctx) {
    showPlaceholder(ctx.panel, {
      title: "Image",
      summary,
      plans: [
        "Layers, masks, adjustments, brushes and selections",
        "PNG and JPEG import and export, with physical size kept",
        "Use an image as a texture in Render, a raster engraving in Laser or a lithophane in Slice",
        "Trace an image into outlines for Vector or a Design sketch",
      ],
      startsAfter: "after CAD step 33 and Render's first steps (R1–R2)",
    });
    return () => {};
  },
};
