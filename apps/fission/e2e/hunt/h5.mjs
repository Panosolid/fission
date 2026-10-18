import * as H from "./lib.mjs";
const env = await H.start(4245);
const show = async (page, what) => console.log(what.padEnd(40), "|", await H.bar(page), "|", await H.volume(page), "|", (await H.bodyRows(page)).join(","), "| k", await H.bodyCount(page), "|", (await H.undoTitle(page)).replace(" (Ctrl+Z)", ""), "| err:", await H.errLine(page), "| status:", await page.textContent("#save-status"));
const btn = (page, b) => page.click(`#timeline [data-button="${b}"]`);
const reload = async (page) => { await page.reload(); await page.waitForFunction(() => document.querySelector("#timeline li[data-item]"), null, { timeout: 20000 }); await H.settle(page); };
try {
  for (const wait of [true, false]) {
    for (const where of ["start", "back", "end"]) {
      const page = await H.fresh(env);
      await H.addSquare(page);
      if (where !== "end") await btn(page, where);
      await H.settle(page);
      if (wait) await page.waitForFunction(() => document.getElementById("save-status").dataset.state === "saved", null, { timeout: 10000 });
      await show(page, `${where}, wait=${wait}, before reload`);
      const t0 = Date.now();
      await reload(page);
      await show(page, `${where}, wait=${wait}, after reload`);
      if (wait && where === "start") {
        // now edit at start after reload: type a width
        await page.fill("#width", "50"); await page.press("#width", "Enter"); await H.settle(page);
        await show(page, "width 50 typed at start (after reload)");
        const f = H.design(await H.save(page));
        console.log("  file:", f.timeline.features.map((x) => x.id + ":" + x.intent.summary).join(" ; "), "marker", f.timeline.marker);
        await btn(page, "end"); await H.settle(page);
        await show(page, "end");
      }
      await page.context().close();
    }
  }
} finally { await env.browser.close(); await env.server.close(); }
