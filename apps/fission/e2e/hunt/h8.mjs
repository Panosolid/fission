// Delete a sketch that is suppressed or rolled back: what the box promises vs what happens.
import * as H from "./lib.mjs";
const env = await H.start(4248);
const show = async (page, what) => console.log(what.padEnd(36), "|", await H.bar(page), "|", await H.volume(page), "|", (await H.bodyRows(page)).join(","), "| k", await H.bodyCount(page), "|", (await H.undoTitle(page)).replace(" (Ctrl+Z)", ""), "| err:", await H.errLine(page), "| warn:", await page.evaluate(() => { const w = document.getElementById("kept-warning"); return w.hidden ? "" : w.textContent; }));
const menu = async (page, id, entry) => { await page.click(`#timeline [data-item="${id}"]`, { button: "right" }); await page.click(`#row-menu-${entry}`); await H.settle(page); };
try {
  for (const how of ["suppressed", "rolled back", "plain"]) {
    for (const run of [1, 2]) {
      const page = await H.fresh(env);
      await H.addSquare(page);
      if (how === "suppressed") await menu(page, "sketch-2", "suppress");
      if (how === "rolled back") await page.click('#timeline [data-button="start"]'), await H.settle(page);
      await show(page, `${how} #${run}: before delete`);
      await page.click('#timeline [data-item="sketch-2"]', { button: "right" });
      await page.click("#row-menu-delete");
      await page.waitForTimeout(300);
      const ask = await page.evaluate(() => [...document.querySelectorAll("dialog[open]")].map((d) => d.innerText.replace(/\s+/g, " ")).join(" // "));
      console.log("   box says:", ask);
      await page.locator("dialog[open] button", { hasText: "Delete" }).first().click().catch((e) => console.log("no delete button", e.message.slice(0, 60)));
      await H.settle(page);
      await show(page, `${how} #${run}: after delete`);
      if (how === "rolled back") { await page.click('#timeline [data-button="end"]'); await H.settle(page); await show(page, `${how} #${run}: marker to end`); }
      const f = H.design(await H.save(page));
      console.log("   kept in file:", JSON.stringify(f.kept ?? null).slice(0, 120));
      await page.keyboard.press("Control+z"); await H.settle(page);
      await show(page, `${how} #${run}: undo`);
      await page.keyboard.press("Control+Shift+z"); await H.settle(page);
      await show(page, `${how} #${run}: redo`);
      if (page.errors.length) console.log("   ERRORS", page.errors);
      await page.context().close();
    }
  }
} finally { await env.browser.close(); await env.server.close(); }
