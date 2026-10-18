// Tests written to kill the mutants StrykerJS found surviving in reading and
// upgrading Design's data (testing hunt 3a, 2026-10-17; run it again with
// packages/testing/stryker/run.sh design). Each test names the change to
// the code it catches. Mutants that change nothing a caller can see are
// listed, with the reason, in packages/testing/stryker/explained.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { idNumber, partDocument, readDesignDocument } from "../src/document.ts";
import { addSketch } from "../src/sketch.ts";

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
/** A saved box part as plain data, the way a file holds it. */
const box = (): Record<string, any> => clone(partDocument("box", 40, 30, 20));
/** Refused with exactly this message (not a TypeError from reading past a missing part). */
const refused = (data: unknown, message: string) =>
  assert.throws(() => readDesignDocument(data), (e: Error) => e.constructor === Error && e.message === message);

test("idNumber, worked by hand: the number after the last dash, only at the very end of a text id", () => {
  assert.equal(idNumber("line-4"), 4);
  assert.equal(idNumber("feature-12"), 12);
  assert.equal(idNumber("a-1-2"), 2); // the last dash's number
  // Catches the end anchor dropped: "line-4b" has digits after a dash, but not at the end.
  assert.equal(idNumber("line-4b"), null);
  assert.equal(idNumber("profile"), null);
  // Catches a number id being read as text: String(-3) is "-3", which would give 3.
  assert.equal(idNumber(-3), null);
  assert.equal(idNumber(undefined), null);
});

test("a version 2 or version 1 file with no timeline is refused as having no timeline", () => {
  // Catches the upgrade from 2 walking into a missing timeline (TypeError) or
  // returning an empty object (which would be refused for its version instead).
  const v2 = { ...box(), version: 2 };
  delete v2.timeline;
  refused(v2, "Design data has no timeline");
  refused({ ...v2, timeline: "x" }, "Design data has no timeline");
  refused({ ...v2, timeline: { features: "x" } }, "Design data has no timeline");
  // Version 1 had no counter or sketches lists.
  const { nextId: _, sketches: __, ...v1 } = { ...v2, version: 1 };
  refused(v1, "Design data has no timeline");
});

test("a version 1 file with a profile that is null is refused for that profile", () => {
  const { nextId: _, sketches: __, ...v1 } = { ...box(), version: 1, profiles: [null] };
  refused(v1, "Design profile 1 is not an object");
});

test("hand-worked: a version 1 file whose ids carry no numbers starts the counter at 1, and opens", () => {
  // Ids "base" and no profiles: no number is in use, so the counter is
  // max(0) + 1 = 1. Catches `nextId < 1` becoming `<= 1`.
  const f = box().timeline.features[0];
  f.id = "base";
  const doc = readDesignDocument({ version: 1, profiles: [], timeline: { features: [f] } });
  assert.equal(doc.nextId, 1);
  assert.equal(doc.version, 3);
});

test("a version 3 file missing its profiles list or its timeline is refused as having no timeline", () => {
  const noProfiles = box();
  delete noProfiles.profiles;
  refused(noProfiles, "Design data has no timeline");
  const noTimeline = box();
  delete noTimeline.timeline;
  refused(noTimeline, "Design data has no timeline");
});

test("a timeline item that is null, or lacks its id, type, summary or parameters, is refused by its place", () => {
  const broken: [string, (f: Record<string, any>) => unknown][] = [
    ["null", () => null],
    ["no id", (f) => ({ ...f, id: 7 })],
    ["no type", (f) => ({ ...f, intent: { ...f.intent, type: undefined } })],
    ["no summary", (f) => ({ ...f, intent: { ...f.intent, summary: 3 } })],
    ["parameters not an object", (f) => ({ ...f, intent: { ...f.intent, parameters: "w=4" } })],
    ["parameters null", (f) => ({ ...f, intent: { ...f.intent, parameters: null } })],
  ];
  for (const [what, edit] of broken) {
    const d = box();
    d.timeline.features = [edit(d.timeline.features[0])];
    assert.throws(() => readDesignDocument(d), (e: Error) => e.constructor === Error && e.message === "Design feature 1 has no id or intent", what);
  }
});

test("a sketch with no timeline item is refused even when another sketch has one", () => {
  // Catches the search for the sketch's item matching any item at all.
  const one = addSketch(partDocument("box", 40, 30, 20)).doc;
  const two = addSketch(one);
  const d = clone(two.doc) as Record<string, any>;
  d.timeline.features = d.timeline.features.filter((f: { id: string }) => f.id !== two.id);
  refused(d, `Design sketch ${two.id} has no place in the timeline`);
});

test("a profile's id counts: one used twice, or at or above the counter, is refused", () => {
  // Catches profile ids being left out of the id checks.
  const d = clone(partDocument("l-bracket", 40, 30, 20)) as Record<string, any>;
  assert.equal(d.profiles[0].id, "profile-1");
  refused({ ...d, profiles: [{ ...d.profiles[0], id: "feature-1" }] }, "Design id feature-1 is used twice");
  // Counter at 2, so profile-2 could be made again by the next new item.
  refused({ ...d, profiles: [{ ...d.profiles[0], id: "profile-2" }], timeline: { features: [{ ...d.timeline.features[0], dependsOn: ["profile-2"], intent: { ...d.timeline.features[0].intent, parameters: { ...d.timeline.features[0].intent.parameters, profile: "profile-2" } } }] } }, "Design data's nextId 2 is not above profile-2, so a new id could repeat it");
});
