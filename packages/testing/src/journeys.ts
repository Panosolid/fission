// "Zero exports": multi-workspace journeys walked with NO file exports.
// Each real journey lives in journeys/*.journey.ts and also checks that
// live links update and round trips lose nothing. The others wait for the
// workspaces they need; when one becomes real, its journey is written.

export interface Journey {
  name: string;
  /** The steps, in the user's words. */
  steps: string[];
  /** "ready" journeys run in `npm run journeys`; the rest name what they wait for. */
  status: "ready" | { waitsFor: string };
}

export const JOURNEYS: Journey[] = [
  { name: "Design to STL", steps: ["model a part", "a print plate links to it", "get its STL", "edit the part", "the STL follows"], status: "ready" },
  { name: "Logo to everything", steps: ["draw a logo", "emboss it in Design", "engrave it in Laser", "render it"], status: { waitsFor: "Vector (V3), Laser (L1), Render (R1)" } },
  { name: "Enclosure and board", steps: ["model an enclosure", "board outline from it", "mounting holes linked both ways", "print the enclosure"], status: { waitsFor: "Circuit (E3), Slice (P1)" } },
  { name: "Photo to lithophane", steps: ["edit a photo", "make a lithophane", "slice it"], status: { waitsFor: "Image (G2), Slice (P2)" } },
  { name: "Part to simulation and back", steps: ["model a part", "simulate it", "change a parameter", "rerun"], status: { waitsFor: "Simulate (S3), parameters (34, I18)" } },
];

/** Round trips that must lose nothing; each gets an integration test when both ends are real. */
export const ROUND_TRIPS: { name: string; waitsFor: string }[] = [
  { name: "Constrained sketch → Laser → back: still constrained and editable", waitsFor: "the sketcher (21–31) and Laser (L1)" },
  { name: "Vector logo → Design → back: still an editable vector", waitsFor: "Vector (V3)" },
  { name: "Image → Vector trace → back: the image is unchanged", waitsFor: "Image (G2) and Vector (V1)" },
];
