import { test } from "node:test";
import assert from "node:assert/strict";
import { downstreamChip, type ChipInfo } from "../src/downstream-chip.ts";

const print: ChipInfo = { id: "slice.print-estimate", label: "Print", value: "2 h 14 m · 38 g", state: "fresh", preview: "Body 1 on the default printer", target: "slice", targetName: "Slice" };

test("a current chip, written out in full: label, value, no mark, preview and where a click goes", () => {
  assert.equal(
    downstreamChip(print),
    '<button type="button" class="downstream-chip fresh" data-chip="slice.print-estimate" data-target="slice" data-state="fresh" title="Body 1 on the default printer\nUp to date.\nClick to open Slice.">' +
      '<span class="chip-label">Print:</span> <span class="chip-value">2 h 14 m · 38 g</span></button>',
  );
});

test("an out-of-date chip keeps its last value but is marked, and says how it gets current", () => {
  const updating = downstreamChip({ ...print, state: "updating" });
  assert.match(updating, /chip-value">2 h 14 m · 38 g<\/span> <span class="chip-mark">updating…<\/span>/);
  assert.match(updating, /title="[^"]*being worked out again/);
  const rerun = downstreamChip({ ...print, label: "Safety factor", value: "1.4", state: "needs-rerun", target: "simulate", targetName: "Simulate" });
  assert.match(rerun, /chip-value">1\.4<\/span> <span class="chip-mark">out of date<\/span>/);
  assert.match(rerun, /rerun it in Simulate\.\nClick to open Simulate\./);
});

test("a missing chip and one with no value yet show a dash, never an old number", () => {
  const missing = downstreamChip({ ...print, state: "missing" });
  assert.match(missing, /chip-value">–<\/span> <span class="chip-mark">missing<\/span>/);
  assert.doesNotMatch(missing, /38 g/);
  assert.match(downstreamChip({ ...print, value: undefined, state: "updating" }), /chip-value">–</);
});

test("text from a workspace is escaped", () => {
  const html = downstreamChip({ ...print, label: '<b>"x"</b>', value: "a & b", preview: 'say "hi"' });
  assert.match(html, /&lt;b&gt;&quot;x&quot;&lt;\/b&gt;:/);
  assert.match(html, /a &amp; b/);
  assert.match(html, /title="say &quot;hi&quot;/);
});
