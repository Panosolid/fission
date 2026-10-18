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

test("rows next to each other with one label become one row of keys; apart, they stay apart", () => {
  const html = shortcutList([
    {
      title: "Design",
      onScreen: true,
      rows: [
        { keys: "1", label: "Type a size" },
        { keys: "2", label: "Type a size" },
        { keys: "L", label: "Line tool" },
        { keys: "3", label: "Type a size" },
      ],
    },
  ]);
  // Three rows: "1 2", "L", then "3" on its own (not next to the others).
  assert.equal(
    html,
    '<section data-on-screen=""><h3>Design <span class="here">on screen</span></h3><dl>' +
      "<div><dt><kbd>1</kbd> <kbd>2</kbd></dt><dd>Type a size</dd></div>" +
      "<div><dt><kbd>L</kbd></dt><dd>Line tool</dd></div>" +
      "<div><dt><kbd>3</kbd></dt><dd>Type a size</dd></div>" +
      "</dl></section>",
  );
});
