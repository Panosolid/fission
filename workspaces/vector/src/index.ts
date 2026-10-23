// @fission/vector: the Vector workspace. PLACEHOLDER: nothing here works yet.
//
// 2D design: logos and artwork made of paths and shapes, with Bézier editing,
// boolean path operations, text to outlines, layers, and SVG import and
// export. It is the bridge between making art and making things: a vector
// graphic can become an emboss or deboss in Design, an engraving or cut in
// Laser, a decal in Render, or silkscreen on a board in Circuit, live-linked
// so editing the artwork updates every use. Work starts after CAD step 48
// (it reuses the sketcher's curves and constraints).

import type { WorkspacePlugin } from "@fission/core";
import { showPlaceholder } from "@fission/ui";

const summary = "2D design: paths, shapes and text for logos and artwork that flow into every making workspace.";

/** DRAFT: one drawing. Paths are exact curves, never a raster. */
export interface Drawing {
  id: string;
  layers: { name: string; paths: { closed: boolean; svgPath: string }[] }[];
}

/** Reads an SVG file into a drawing. Not implemented yet. */
export function importSvg(_svg: string): Drawing {
  throw new Error("not implemented");
}

/** Writes a drawing as SVG. Not implemented yet. */
export function exportSvg(_drawing: Drawing): string {
  throw new Error("not implemented");
}

export const vectorWorkspace: WorkspacePlugin = {
  id: "vector",
  title: "Vector",
  summary,
  status: "placeholder",
  representations: { produces: [], accepts: [] },
  commands: [],
  mount(ctx) {
    showPlaceholder(ctx.properties, {
      title: "Vector",
      summary,
      plans: [
        "Paths and shapes with Bézier editing",
        "Boolean path operations (join, cut, intersect)",
        "Text to outlines, layers",
        "SVG import and export",
        "Use a graphic as an emboss or deboss in Design, an engraving or cut in Laser, a decal in Render or silkscreen in Circuit, live-linked",
      ],
      startsAfter: "after CAD step 48 (when the sketcher is solid: it reuses its curves and constraints)",
    });
    return { unmount: () => ctx.properties.replaceChildren() };
  },
};
