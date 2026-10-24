// The steps after 27 that have landed (step 30d): one list for everything
// written before its step exists and held until then, so turning a step on
// is one line. Today it holds the golden models waiting for a step
// (golden.ts `plan`: their project files must then exist) and the timeline
// session bots' waiting moves (timeline-session.ts `WAITING_MOVES`: the
// model and Design must then answer them). A step's thread adds its
// number here the day it lands.

export const LANDED: ReadonlySet<string> = new Set<string>();
