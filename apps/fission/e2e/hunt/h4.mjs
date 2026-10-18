import * as H from "./lib.mjs";
const env = await H.start(4244);
const show = async (page, what) => console.log(what.padEnd(44), "|", await H.bar(page), "|", await H.volume(page), "|", (await H.bodyRows(page)).join(","), "| k", await H.bodyCount(page), "|", (await H.undoTitle(page)).replace(" (Ctrl+Z)", ""), "| err:", await H.errLine(page), "| shape:", await page.evaluate(() => document.querySelector("#viewport").dataset.shape));
const btn = (page, b) => page.click(`#timeline [data-button="${b}"]`);
try {
  {
    const page = await H.fresh(env);
    await H.addSquare(page);
    await btn(page, "start"); await H.settle(page);
    await show(page, "marker at start");
    const f1 = await H.save(page);
    console.log("  saved marker:", H.design(f1).timeline.marker);
    await page.reload(); await page.waitForFunction(() => document.querySelector("#timeline li[data-item]"), null, { timeout: 20000 }); await H.settle(page);
    await show(page, "after reload");
    const f2 = await H.save(page);
    console.log("  same file after reload:", f1 === f2);
    // type a width with the marker at start
    const inputs = await page.$$eval("#properties input", (i) => i.map((x) => x.id));
    console.log("  inputs:", inputs.join(","));
    await page.fill("#width", "50"); await page.press("#width", "Enter"); await H.settle(page);
    await show(page, "width 50 typed at start");
    console.log("  file now:", JSON.stringify(H.design(await H.save(page)).timeline.features.map((f) => f.id)), H.design(await H.save(page)).timeline.marker);
    await page.keyboard.press("Control+z"); await H.settle(page);
    await show(page, "undo x2");
    console.log("  errors:", page.errors);
    await page.context().close();
  }
  {
    // rapid clicks on back/forward with no waiting
    const page = await H.fresh(env);
    await H.addSquare(page);
    await H.addSquare(page, [[-30, 0], [-20, 10]], 5);
    await show(page, "two squares");
    for (let i = 0; i < 12; i++) await page.click('#timeline [data-button="back"]', { delay: 0, noWaitAfter: true, force: true });
    await H.settle(page);
    await show(page, "back x12 fast");
    for (let i = 0; i < 3; i++) await page.click('#timeline [data-button="forward"]', { force: true });
    await H.settle(page);
    await show(page, "forward x3 fast");
    // spam undo/redo
    const before = await H.save(page);
    for (let i = 0; i < 25; i++) await page.keyboard.press("Control+z");
    for (let i = 0; i < 25; i++) await page.keyboard.press("Control+Shift+z");
    await H.settle(page, 10000);
    await show(page, "undo x25 then redo x25");
    const after = await H.save(page);
    console.log("  same file after undo/redo spam:", before === after);
    console.log("  errors:", page.errors);
    await page.context().close();
  }
} finally { await env.browser.close(); await env.server.close(); }
