import { test } from "node:test";
import assert from "node:assert/strict";
import { linkBadge } from "../src/link-badge.ts";

test("a live link, a frozen copy and a broken link look different and say why", () => {
  assert.equal(linkBadge("live", "Feature 1 in Design"), '<span class="link-badge live" title="Feature 1 in Design" data-link="live"><span aria-hidden="true">🔗</span> Linked</span>');
  assert.match(linkBadge("frozen", "x"), /Frozen copy/);
  assert.match(linkBadge("unresolved", 'can\'t find "Logo"'), /title="can't find &quot;Logo&quot;".*Link broken/);
});
