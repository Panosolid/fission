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
    steps: ["insert a shape", "change a size", "Download STL"],
    // From an empty design (a new project, U0c): Insert ▾ and its Box (U0d: the presets live in a menu), the size field, the STL button.
    clickLimit: 4,
    secondsLimit: 5,
    status: "ready",
  },
  {
    // Step 25c4: a part from a sketch, from an empty design (a new project, U0c).
    name: "Design: sketch to STL",
    steps: ["start a sketch on the ground", "draw a rectangle", "extrude it", "Download STL"],
    // Create Sketch and the plane, the rectangle tool and its two corners, Extrude and OK, the STL button.
    clickLimit: 8,
    // 2.7 s in this project's sandbox and about 3.6 times that on GitHub's runners (as the shape journey is):
    // a limit with room, the baseline's 15% catching any slowdown nightly.
    secondsLimit: 20,
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
    status: { waitsFor: "Simulate (S3), parameters (50, I18)" },
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

// The baseline (X8b): what each ready journey took when the owner confirmed
// it, kept in tests/baseline.json under "journeys". The nightly run flags any
// click over the baseline, and a slowest walk more than 15% over it (root
// CLAUDE.md, "Metrics and baselines"). Clicks are deterministic, so PR CI
// fails on an extra click too; time is only judged nightly.

/** A ready journey's confirmed numbers: clicks, and the slowest of the walks in ms. */
export interface JourneyBaseline {
  clicks: number;
  slowestMs: number;
}

/** What one browser run measured for a journey: the most clicks and the slowest walk. */
export interface JourneyMeasured {
  clicks: number;
  slowestMs: number;
}

/** How far over the baseline the slowest walk may be, in percent, before it is flagged. */
export const SLOWEST_MARGIN_PERCENT = 15;

export type BaselineFlag = { kind: "clicks" | "time" | "missing"; text: string };

export type JourneyCheck =
  | { kind: "ok"; note?: string }
  | { kind: "flag"; flags: BaselineFlag[] }
  | { kind: "pending"; waitsFor: string };

/**
 * Reads the "journeys" part of tests/baseline.json. Every entry must name a
 * journey in `MAGIC_JOURNEYS` and hold whole clicks ≥ 1 and a slowest time
 * > 0 ms; anything else throws, naming the entry, so a broken baseline can
 * never quietly pass.
 */
export function parseBaselines(json: unknown, journeys: MagicJourney[] = MAGIC_JOURNEYS): Map<string, JourneyBaseline> {
  if (typeof json !== "object" || json === null || Array.isArray(json)) throw new Error("journey baseline: not an object");
  const out = new Map<string, JourneyBaseline>();
  for (const [name, value] of Object.entries(json)) {
    if (!journeys.some((j) => j.name === name)) throw new Error(`journey baseline: no journey named "${name}"`);
    const v = value as Partial<JourneyBaseline> | null;
    if (typeof v !== "object" || v === null || !Number.isInteger(v.clicks) || (v.clicks as number) < 1) {
      throw new Error(`journey baseline "${name}": clicks must be a whole number ≥ 1`);
    }
    if (typeof v.slowestMs !== "number" || !Number.isFinite(v.slowestMs) || v.slowestMs <= 0) {
      throw new Error(`journey baseline "${name}": slowestMs must be a number > 0`);
    }
    out.set(name, { clicks: v.clicks as number, slowestMs: v.slowestMs });
  }
  return out;
}

/**
 * One journey against its baseline. Pending journeys stay pending. A ready
 * journey with no baseline or no measurement is flagged ("missing"); more
 * clicks than the baseline is flagged ("clicks"); a slowest walk more than
 * 15% over is flagged ("time"; exactly 15% over is not). Fewer clicks or a
 * faster walk is fine, with a note when the clicks could tighten the baseline.
 */
export function compareToBaseline(journey: MagicJourney, measured: JourneyMeasured | null, baseline: JourneyBaseline | undefined): JourneyCheck {
  if (journey.status !== "ready") return { kind: "pending", waitsFor: journey.status.waitsFor };
  const flags: BaselineFlag[] = [];
  if (baseline === undefined) flags.push({ kind: "missing", text: "no baseline in tests/baseline.json" });
  if (measured === null) flags.push({ kind: "missing", text: "not walked" });
  if (baseline === undefined || measured === null) return { kind: "flag", flags };
  if (measured.clicks > baseline.clicks) {
    const extra = measured.clicks - baseline.clicks;
    flags.push({ kind: "clicks", text: `${measured.clicks} clicks, baseline ${baseline.clicks} (${extra} extra)` });
  }
  // Integer-safe "more than 15% over": ms × 100 > baseline × 115.
  if (measured.slowestMs * 100 > baseline.slowestMs * (100 + SLOWEST_MARGIN_PERCENT)) {
    const over = (measured.slowestMs / baseline.slowestMs - 1) * 100;
    flags.push({
      kind: "time",
      text: `slowest ${(measured.slowestMs / 1000).toFixed(2)} s, baseline ${(baseline.slowestMs / 1000).toFixed(2)} s (${over.toFixed(0)}% over, flag above ${SLOWEST_MARGIN_PERCENT}%)`,
    });
  }
  if (flags.length > 0) return { kind: "flag", flags };
  if (measured.clicks < baseline.clicks) return { kind: "ok", note: `${measured.clicks} clicks, fewer than the baseline ${baseline.clicks}: ask the owner to lower it` };
  return { kind: "ok" };
}

/** One line per journey for the nightly summary: OK/FLAG/PENDING with the numbers. */
export function baselineLine(journey: MagicJourney, measured: JourneyMeasured | null, baseline: JourneyBaseline | undefined, check: JourneyCheck): string {
  switch (check.kind) {
    case "pending":
      return `PENDING ${journey.name}: waits for ${check.waitsFor}`;
    case "flag":
      return `FLAG ${journey.name}: ${check.flags.map((f) => f.text).join("; ")}`;
    case "ok": {
      const m = measured as JourneyMeasured;
      const b = baseline as JourneyBaseline;
      const line = `OK ${journey.name}: ${m.clicks} clicks (baseline ${b.clicks}), slowest ${(m.slowestMs / 1000).toFixed(2)} s (baseline ${(b.slowestMs / 1000).toFixed(2)} s)`;
      return check.note ? `${line}; ${check.note}` : line;
    }
  }
}
