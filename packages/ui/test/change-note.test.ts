import { test } from "node:test";
import assert from "node:assert/strict";
import { changeNote, type ChangeNoteInfo } from "../src/change-note.ts";

const plate: ChangeNoteInfo = { id: "note-1", state: "updated", text: "Print plate updated: you changed wall thickness in Design.", chain: ["Wall thickness in Design", "Part in Design", "Print plate in Slice"] };

test("a note, written out in full: the line, the chain behind Why?, and a dismiss button", () => {
  assert.equal(
    changeNote(plate),
    '<div class="change-note updated" role="status" data-note="note-1" data-state="updated">' +
      '<div class="note-body"><span class="note-text">Print plate updated: you changed wall thickness in Design.</span>' +
      "<details><summary>Why?</summary><ol><li>Wall thickness in Design</li><li>Part in Design</li><li>Print plate in Slice</li></ol></details></div>" +
      '<button type="button" class="note-dismiss" data-dismiss="note-1" aria-label="Dismiss this note" title="Dismiss">×</button></div>',
  );
});

test("the state is a class, so a note waiting for a rerun looks different", () => {
  assert.match(changeNote({ ...plate, state: "needs-rerun" }), /class="change-note needs-rerun"/);
});

test("text from a workspace is escaped", () => {
  const html = changeNote({ ...plate, id: 'a"b', text: "<b>x</b> & y", chain: ['say "hi"'] });
  assert.match(html, /data-note="a&quot;b"/);
  assert.match(html, /&lt;b&gt;x&lt;\/b&gt; &amp; y/);
  assert.match(html, /<li>say &quot;hi&quot;<\/li>/);
  assert.doesNotMatch(html, /<b>x/);
});
