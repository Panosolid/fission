import { writeFileSync } from "node:fs";
import * as H from "./lib.mjs";
const env = await H.start(4241);
try {
  const page = await H.fresh(env);
  await H.addSquare(page);
  console.log("start:", await H.bar(page), await H.volume(page));
  writeFileSync(new URL("./template.json", import.meta.url), await H.save(page));
  // marker to after sketch-2 via the menu
  await page.click('#timeline [data-item="sketch-2"]', { button: "right" });
  await page.click("#row-menu-marker");
  await H.settle(page);
  console.log("marker after sketch:", await H.bar(page), await H.volume(page), await H.bodyRows(page));
  // drag Box (feature-1) to the gap at the marker (place 2)
  const x = await H.gapPageX(page, 2);
  await H.dragItemTo(page, "feature-1", x, async () => console.log("  line while dragging:", await page.evaluate(() => { const l = document.querySelector(".timeline-reorder-line"); const n = document.querySelector(".timeline-reorder-note"); return l && [l.dataset.place, l.dataset.state, n?.hidden ? "" : n?.textContent]; })));
  console.log("after drop box at marker gap:", await H.bar(page), await H.volume(page), await H.bodyRows(page), await H.undoTitle(page), await H.errLine(page));
  await page.click("#undo"); await H.settle(page);
  console.log("undo:", await H.bar(page));
  // drag sketch-2 (holding the marker) to the end
  const x2 = await H.gapPageX(page, 3);
  await H.dragItemTo(page, "sketch-2", x2);
  console.log("after drag marker-item sketch-2 to end:", await H.bar(page), await H.volume(page), await H.bodyRows(page), await H.undoTitle(page), await H.errLine(page));
  console.log("errors:", page.errors);
} finally { await env.browser.close(); await env.server.close(); }
