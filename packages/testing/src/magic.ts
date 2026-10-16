// "Magic moment" journeys (X8, docs/integration.md "Measuring the magic"):
// browser walks with a click limit and a time limit. The browser test
// (apps/fission/e2e/journeys.mjs) walks each ready one, counts the user's
// clicks and times it from the first click to the result, then asks
// `judge` for the verdict. A journey waiting for a workspace is pending and
// is never reported as passing, whatever was measured.

export interface MagicJourney {
  name: string;
  /** The steps, in the user's words. */
  steps: string[];
  /** The most clicks the journey may take; one more fails. */
  clickLimit: number;
  /** The most seconds from the first click to the result. */
  secondsLimit: number;
  status: "ready" | { waitsFor: string };
}

/** What a walk measured: the user's clicks and the milliseconds taken. */
export interface JourneyRun {
  clicks: number;
  ms: number;
}

export type JourneyVerdict =
  | { kind: "pass"; clicks: number; seconds: number }
  | { kind: "fail"; reasons: string[] }
  | { kind: "pending"; waitsFor: string };

export const MAGIC_JOURNEYS: MagicJourney[] = [
  {
    name: "Design: shape to STL",
    steps: ["pick a shape", "change a size", "Download STL"],
    // One click per step: the shape's button, the size field, the STL button.
    clickLimit: 3,
    secondsLimit: 5,
    status: "ready",
  },
  {
    name: "Box to laser panels",
    steps: ["draw a box", "click Cut on laser", "change the thickness to 6 mm", "the panels update"],
    clickLimit: 5,
    secondsLimit: 10,
    status: { waitsFor: "Laser (L1–L3), X13" },
  },
  {
    name: "Logo to everything",
    steps: ["draw a logo", "emboss it in Design", "engrave it in Laser", "render it"],
    clickLimit: 8,
    secondsLimit: 15,
    status: { waitsFor: "Vector (V3), Laser (L1), Render (R1)" },
  },
  {
    name: "Enclosure and board",
    steps: ["model an enclosure", "board outline from it", "mounting holes linked both ways", "print the enclosure"],
    clickLimit: 10,
    secondsLimit: 20,
    status: { waitsFor: "Circuit (E3), Slice (P1)" },
  },
  {
    name: "Photo to lithophane",
    steps: ["edit a photo", "make a lithophane", "slice it"],
    clickLimit: 6,
    secondsLimit: 15,
    status: { waitsFor: "Image (G2), Slice (P2)" },
  },
  {
    name: "Part to simulation and back",
    steps: ["model a part", "simulate it", "change a parameter", "rerun"],
    clickLimit: 6,
    secondsLimit: 30,
    status: { waitsFor: "Simulate (S3), parameters (34, I18)" },
  },
];

/**
 * The verdict on one journey. Pending journeys stay pending even with a
 * run; a ready one with no run, a bad measurement, too many clicks or too
 * long fails, naming each reason.
 */
export function judge(journey: MagicJourney, run: JourneyRun | null): JourneyVerdict {
  if (journey.status !== "ready") return { kind: "pending", waitsFor: journey.status.waitsFor };
  if (run === null) return { kind: "fail", reasons: ["not walked"] };
  const reasons: string[] = [];
  if (!Number.isInteger(run.clicks) || run.clicks < 1) reasons.push(`bad click count ${run.clicks}`);
  if (!Number.isFinite(run.ms) || run.ms < 0) reasons.push(`bad time ${run.ms} ms`);
  if (reasons.length > 0) return { kind: "fail", reasons };
  if (run.clicks > journey.clickLimit) reasons.push(`${run.clicks} clicks, limit ${journey.clickLimit}`);
  if (run.ms > journey.secondsLimit * 1000) reasons.push(`${(run.ms / 1000).toFixed(2)} s, limit ${journey.secondsLimit} s`);
  if (reasons.length > 0) return { kind: "fail", reasons };
  return { kind: "pass", clicks: run.clicks, seconds: run.ms / 1000 };
}

/** One line per journey for a run's report: PASS/FAIL/PENDING, clicks and seconds or why. */
export function reportLine(journey: MagicJourney, verdict: JourneyVerdict): string {
  switch (verdict.kind) {
    case "pass":
      return `PASS ${journey.name}: ${verdict.clicks} clicks (limit ${journey.clickLimit}), ${verdict.seconds.toFixed(2)} s (limit ${journey.secondsLimit} s)`;
    case "fail":
      return `FAIL ${journey.name}: ${verdict.reasons.join("; ")}`;
    case "pending":
      return `PENDING ${journey.name}: waits for ${verdict.waitsFor}`;
  }
}
