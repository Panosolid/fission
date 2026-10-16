import { test } from "node:test";
import assert from "node:assert/strict";
import { shortcutList } from "../src/shortcut-list.ts";

test("hand-worked: one section per group, the on-screen one marked, each key in a kbd", () => {
  const html = shortcutList([
    { title: "Design", onScreen: true, rows: [{ keys: "Esc", label: "Clear the selection" }] },
    { title: "Everywhere", onScreen: false, rows: [{ keys: "?", label: "Show the keyboard shortcuts" }] },
  ]);
  assert.equal(
    html,
    '<section data-on-screen=""><h3>Design <span class="here">on screen</span></h3><dl><div><dt><kbd>Esc</kbd></dt><dd>Clear the selection</dd></div></dl></section>' +
      '<section><h3>Everywhere</h3><dl><div><dt><kbd>?</kbd></dt><dd>Show the keyboard shortcuts</dd></div></dl></section>',
  );
});

test("labels and keys are escaped, never read as HTML", () => {
  const html = shortcutList([{ title: "<b>x</b>", onScreen: false, rows: [{ keys: "Ctrl+<", label: 'Say "hi" & go' }] }]);
  assert.ok(!html.includes("<b>"));
  assert.match(html, /<kbd>Ctrl\+&lt;<\/kbd><\/dt><dd>Say &quot;hi&quot; &amp; go<\/dd>/);
});
