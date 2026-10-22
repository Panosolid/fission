// Step 25c3: what the AI is told about a timeline (`designAIView`) on
// seeded timelines from Design's own edits (`timelineEdits`), checked
// against the build model written apart from Design (`buildModel`): each
// item's state and body number, where the marker is, and what an accepted
// set_part does. That last is checked by doing it: `documentFor` (the
// command Design's run builds) either changes the part in place or adds
// exactly one item, where the view said it would.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Command } from "@fission/core";
import { designAIView, documentFor, partDocument, SHAPES, type DesignDocument } from "@fission/design";
import { buildModel, timelineEdits } from "../src/project-fuzz.ts";
import { seeded } from "../src/index.ts";

/** Where a new item goes, worked out from the marker alone: after the item it names, first at "start", else last. */
const insertPlace = (d: DesignDocument) => (d.timeline.marker === undefined ? d.timeline.features.length : d.timeline.marker === "start" ? 0 : d.timeline.features.findIndex((f) => f.id === d.timeline.marker) + 1);
const isExtrudedSketch = (d: DesignDocument, id: string) => {
  const f = d.timeline.features.find((x) => x.id === id)!;
  return f.intent.type === "extrude" && Object.hasOwn(f.intent.parameters, "sketch");
};

/** The label of the first suppressed item `id` is built on, following what each item depends on that is still in the timeline; null when none is. */
function suppressedUnder(d: DesignDocument, id: string): string | null {
  const byId = new Map(d.timeline.features.map((f) => [f.id, f]));
  for (const dep of byId.get(id)!.dependsOn) {
    const on = byId.get(dep);
    if (on === undefined) continue;
    if (on.suppressed) return on.provenance.self.label;
    const deeper = suppressedUnder(d, dep);
    if (deeper !== null) return deeper;
  }
  return null;
}

test("seeded: on 300 random timelines the AI is told each item's state, and set_part does what it is told it does", () => {
  const reached = { change: 0, addStart: 0, addMiddle: 0, addEnd: 0, noBody: 0, suppressed: 0, afterMarker: 0, failed: 0, greyed: 0, greyedSketch: 0, kept: 0, sketch: 0 };
  for (let seed = 1n; seed <= 300n; seed++) {
    const r = seeded(seed);
    const doc = timelineEdits(r, partDocument("box", 40, 30, 20));
    const where = `seed ${seed}`;
    const sizes = { width: 1 + Math.floor(r.next() * 50), depth: 1 + Math.floor(r.next() * 50), height: 1 + Math.floor(r.next() * 50) };
    const view = designAIView(doc, new Set(), sizes);
    const model = buildModel(doc);
    const building = new Set(model.building);
    const items = doc.timeline.features;
    const end = doc.timeline.marker === undefined ? items.length : doc.timeline.marker === "start" ? 0 : items.findIndex((f) => f.id === doc.timeline.marker) + 1;
    // The model's answer to whether Accept adds a body: no part, or the part an extruded sketch.
    const adds = model.part === null || isExtrudedSketch(doc, model.part);
    assert.equal(view.adds !== null, adds, where);
    assert.equal(view.setup.length, adds ? 0 : 1, where);
    // Each item: its number, its summary, then its state from the model.
    assert.equal(view.notes[0], "The design's timeline, in build order:", where);
    let body = 0;
    for (const [i, f] of items.entries()) {
      const line = view.notes[i + 1];
      const head = `${i + 1}. ${f.intent.summary}. `;
      assert.ok(line.startsWith(head), `${where}: ${line}`);
      const state = line.slice(head.length);
      if (f.suppressed) (reached.suppressed++, assert.equal(state, "Suppressed: builds nothing.", where));
      else if (i >= end) (reached.afterMarker++, assert.equal(state, "After the timeline marker: not built.", where));
      else if (f.intent.type === "sketch") {
        // 27d (rule 13): a sketch projecting an edge of a suppressed item is greyed by it (`dependsOn` names it).
        const by = suppressedUnder(doc, f.id);
        if (by !== null) (reached.greyedSketch++, assert.equal(state, `Greyed: builds nothing while ${by}, which it is built on, is suppressed.`, where));
        else (reached.sketch++, assert.equal(state, "A sketch: builds no body.", where));
      }
      else if (building.has(f.id)) {
        body++;
        const kept = doc.kept !== undefined && Object.hasOwn(doc.kept, f.id);
        reached.kept += kept ? 1 : 0;
        const part = f.id === model.part && !adds;
        assert.equal(state, `Builds Body ${body}.${kept ? " Its sketch is lost (deleted, or no longer a closed outline), so it builds from the shape it kept." : ""}${part ? " This is the part set_part changes." : ""}`, where);
      } else {
        // 26e (Q3): built on a suppressed item, through its sketch (and that sketch's face), greyed naming that item; else its sketch is gone.
        const by = suppressedUnder(doc, f.id);
        if (by !== null) (reached.greyed++, assert.equal(state, `Greyed: builds nothing while ${by}, which it is built on, is suppressed.`, where));
        else (reached.failed++, assert.equal(state, "Failed: builds no body (its sketch is gone).", where));
      }
    }
    const marker = view.notes[items.length + 1];
    if (end === items.length && doc.timeline.marker === undefined) assert.equal(marker, "The timeline marker is at the end: every item is built.", where);
    else if (end === 0) assert.equal(marker, "The timeline marker is at the start: nothing is built.", where);
    else assert.equal(marker, `The timeline marker is after item ${end}: items after it are not built.`, where);
    assert.equal(view.notes.at(-1), `A size set_part leaves out keeps the value it has now: width ${sizes.width}, depth ${sizes.depth}, height ${sizes.height}.`, where);

    // Do it: a set_part of a random shape, its left-out sizes kept from the panel (as Design's run fills them).
    const shape = SHAPES[Math.floor(r.next() * SHAPES.length)];
    const command: Command = { op: "set_part", shape, ...sizes, width: 1 + Math.floor(r.next() * 50) };
    const after = documentFor(command, doc);
    const before = items.map((f) => f.id);
    const now = after.timeline.features.map((f) => f.id);
    if (!adds) {
      reached.change++;
      // In place: the same items in the same order, the part the same feature; setup is the part as it is, so doing it changes nothing.
      assert.deepEqual(now, before, where);
      assert.equal(buildModel(after).part, model.part, where);
      const same = documentFor({ ...view.setup[0], ...Object.fromEntries(Object.entries(sizes).filter(([k]) => !(k in view.setup[0]))) }, doc);
      assert.deepEqual(same.timeline.features.find((f) => f.id === model.part)!.intent, items.find((f) => f.id === model.part)!.intent, `${where}: setup is the part`);
      continue;
    }
    // Added: exactly one new item, at the place the marker gives, and it is the part now; the rest keep their order.
    const at = insertPlace(doc);
    assert.equal(now.length, before.length + 1, where);
    assert.deepEqual([...now.slice(0, at), ...now.slice(at + 1)], before, where);
    assert.equal(buildModel(after).part, now[at], where);
    assert.equal(view.adds, `a new body as item ${at + 1}, ${at === 0 ? "at the start of the timeline" : `after ${at}. ${items[at - 1].intent.summary}`}`, where);
    if (model.part === null) reached.noBody++;
    reached[at === 0 ? "addStart" : at === items.length ? "addEnd" : "addMiddle"]++;
  }
  for (const [what, n] of Object.entries(reached)) assert.ok(n >= 10, `reached ${what} only ${n} times: ${JSON.stringify(reached)}`);
});
