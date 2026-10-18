import * as H from "./lib.mjs";
const env = await H.start(4262);
const panel = (page) => page.evaluate(() => document.querySelector("#properties").innerText.split("\n").filter((l) => /Box|Extrude|Body|mm³|faces/.test(l)).slice(0, 6).join(" / "));
try {
  for (const run of [1, 2]) {
    const page = await H.fresh(env);
    await H.addSquare(page);
    // the box fails: its width typed as -5 (the panel shows the last body, the square: re-select the box first by its row)
    await page.evaluate(() => document.querySelectorAll("#browser details").forEach((d) => (d.open = true)));
    const f = H.design(await H.save(page)); f.timeline.features[0].intent.parameters.width = -5;
    const all = JSON.parse(await H.save(page)); all.workspaces.design = f;
    await H.openText(page, JSON.stringify(all));
    await page.evaluate(() => document.querySelectorAll("#browser details").forEach((d) => (d.open = true)));
    console.log(`#${run} bar ${await H.bar(page)} | rows ${(await H.bodyRows(page)).join(",")} | k ${await H.bodyCount(page)}`);
    for (const row of ["body-1", "body-2"]) {
      await page.click(`#browser .tree-row[data-node="${row}"]`); await H.settle(page);
      console.log(`   ${row} selected: ${await panel(page)} | lit faces: ${await page.evaluate(() => document.querySelector("#viewport").dataset.highlight ?? "?")}`);
    }
    await page.screenshot({ path: `/tmp/claude-0/hunt/failed-row-${run}.png` });
    await page.context().close();
  }
} finally { await env.browser.close(); await env.server.close(); }
