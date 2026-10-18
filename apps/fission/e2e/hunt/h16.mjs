import * as H from "./lib.mjs";
const env = await H.start(4264);
try {
  for (const run of [1, 2]) {
    const page = await H.fresh(env);
    await H.addSquare(page);
    await page.click('#timeline [data-item="feature-11"]', { button: "right" });
    await page.keyboard.press("Control+z"); await page.waitForTimeout(500);
    console.log(`#${run} menu open + Ctrl+Z: menu ${await page.evaluate(() => document.getElementById("row-menu").open)} | ${await H.bar(page)} | ${await H.undoTitle(page)}`);
    await page.click("#row-menu-delete").catch((e) => console.log("  click failed", e.message.slice(0, 60))); await H.settle(page);
    console.log(`   then Delete: ${await H.bar(page)} | ${await H.undoTitle(page)} | errors ${JSON.stringify(page.errors)} | err ${await H.errLine(page)}`);
    // delete-ask box open, then Ctrl+Z, then Delete
    await page.keyboard.press("Control+z"); await H.settle(page);
    await page.click('#timeline [data-item="sketch-2"]', { button: "right" }); await page.click("#row-menu-delete"); await page.waitForTimeout(300);
    await page.keyboard.press("Control+z"); await page.waitForTimeout(500);
    console.log(`   ask box open + Ctrl+Z: ${await H.bar(page)} | ${await H.undoTitle(page)}`);
    await page.locator("dialog[open] button", { hasText: "Delete" }).first().click().catch(() => {}); await H.settle(page);
    console.log(`   then Delete: ${await H.bar(page)} | ${await H.undoTitle(page)} | errors ${JSON.stringify(page.errors)}`);
    await page.context().close();
  }
} finally { await env.browser.close(); await env.server.close(); }
