import { readFileSync } from "node:fs";
import * as H from "./lib.mjs";
const env = await H.start(4271);
const T = readFileSync(new URL("./template.json", import.meta.url), "utf8");
const menuState = (page) => page.evaluate(() => { const m = document.getElementById("row-menu"); return { open: m.open, modal: m.matches(":modal"), items: [...m.querySelectorAll("button")].map((b) => b.getAttribute("aria-label")).join(", ") }; });
try {
  for (const run of [1, 2]) {
    const page = await H.fresh(env);
    await page.click('#timeline [data-item="feature-1"]', { button: "right" });
    console.log(`#${run} menu:`, JSON.stringify(await menuState(page)));
    await H.openText(page, T); // Open's button clicked by script while the menu is up (a file arriving under the menu)
    console.log(`   after a file opened:`, JSON.stringify(await menuState(page)), "| bar", await H.bar(page));
    await page.keyboard.press("Escape"); await page.waitForTimeout(300);
    console.log(`   after Escape:`, JSON.stringify(await menuState(page)));
    await page.click("#row-menu-suppress").catch((e) => console.log("   click failed:", e.message.split("\n")[0]));
    await H.settle(page);
    console.log(`   after choosing Suppress: bar ${await H.bar(page)} | ${await H.undoTitle(page)} | err ${await H.errLine(page)} | errors ${JSON.stringify(page.errors)}`);
    await page.context().close();
  }
} finally { await env.browser.close(); await env.server.close(); }
