// A failed body listed before a built one: does selecting the rows select the right body?
import { readFileSync } from "node:fs";
import * as H from "./lib.mjs";
const env = await H.start(4259);
const T = JSON.parse(readFileSync(new URL("./template.json", import.meta.url), "utf8"));
const d = T.workspaces.design; const f = d.timeline.features;
d.timeline.features = [f[1], f[2], f[0]]; // Sketch 1, Extrude 1, Box
f[2].intent.parameters.distance = 1e9; f[2].intent.summary = "Extrude Sketch 1 by 1000000000 mm";
const state = (page) => page.evaluate(() => ({
  rows: [...document.querySelectorAll('#browser .tree-row[data-node^="body-"]')].map((r) => r.dataset.node + ":" + r.textContent.trim()),
  feature: document.querySelector("#properties")?.innerText.split("\n").filter((l) => /Box|Extrude|Feature|Body|mm³/.test(l)).slice(0, 6).join(" / "),
}));
try {
  for (const run of [1, 2]) {
    const page = await H.fresh(env);
    await H.openText(page, JSON.stringify(T));
    console.log(`#${run} bar:`, await H.bar(page), "| k", await H.bodyCount(page), "| err:", await H.errLine(page));
    console.log("   ", JSON.stringify(await state(page)));
    for (const row of ["body-1", "body-2"]) {
      await page.evaluate(() => document.querySelectorAll("#browser details").forEach((d) => (d.open = true)));
      const el = page.locator(`#browser .tree-row[data-node="${row}"]`);
      if (!(await el.count())) { console.log("    no row", row); continue; }
      await el.click(); await H.settle(page);
      const sel = await page.evaluate(() => [...document.querySelectorAll("#properties .selection-row, #properties [data-selected]")].map((x) => x.textContent.trim()).join(" | "));
      console.log(`    clicked ${row}:`, JSON.stringify(await state(page)), "| selection:", sel);
    }
    await page.screenshot({ path: `/tmp/claude-0/hunt/failed-first-${run}.png` });
    await page.context().close();
  }
} finally { await env.browser.close(); await env.server.close(); }
