import * as H from "./lib.mjs";
const env = await H.start(4242);
const show = async (page, what) => console.log(what.padEnd(46), "|", await H.bar(page), "|", await H.volume(page), "|", (await H.bodyRows(page)).join(","), "| kernel bodies", await H.bodyCount(page), "|", (await H.undoTitle(page)).replace(" (Ctrl+Z)", ""), "| err:", await H.errLine(page));
try {
  for (const scenario of ["undo-mid-item-drag", "undo-mid-marker-drag", "redo-mid-item-drag", "rightclick-mid-drag", "escape-mid-drag", "release-far-above", "resize-mid-drag"]) {
    const page = await H.fresh(env);
    await H.addSquare(page);
    await show(page, `${scenario}: start`);
    const b = await H.itemBox(page, scenario.includes("marker") ? "feature-11" : "feature-1");
    let x0, y0;
    if (scenario.includes("marker")) { const m = await H.markerBox(page); x0 = m.x + m.width / 2; y0 = m.y + m.height / 2; }
    else { x0 = b.x + b.width / 2; y0 = b.y + b.height / 2; }
    const xEnd = scenario.includes("marker") ? await H.gapPageX(page, 1) : await H.gapPageX(page, 3);
    await page.mouse.move(x0, y0); await page.mouse.down();
    for (let i = 1; i <= 10; i++) await page.mouse.move(x0 + ((xEnd - x0) * i) / 10, y0);
    if (scenario.startsWith("undo")) { await page.keyboard.press("Control+z"); await page.waitForTimeout(800); }
    if (scenario.startsWith("redo")) { await page.keyboard.press("Control+z"); await page.waitForTimeout(800); await page.keyboard.press("Control+Shift+z"); await page.waitForTimeout(800); }
    if (scenario.startsWith("rightclick")) { await page.mouse.down({ button: "right" }); await page.mouse.up({ button: "right" }); await page.waitForTimeout(300); console.log("   menu open:", await page.evaluate(() => document.getElementById("row-menu").open)); }
    if (scenario.startsWith("escape")) { await page.keyboard.press("Escape"); await page.waitForTimeout(300); }
    if (scenario.startsWith("release-far")) { await page.mouse.move(xEnd, 200, { steps: 5 }); }
    if (scenario.startsWith("resize")) { await page.setViewportSize({ width: 375, height: 800 }); await page.waitForTimeout(500); }
    await show(page, `${scenario}: before release`);
    await page.mouse.up();
    await H.settle(page);
    await show(page, `${scenario}: after release`);
    const leftovers = await page.evaluate(() => [document.querySelectorAll(".timeline-reorder-line").length, document.querySelectorAll(".timeline-reorder-note").length, document.querySelectorAll(".timeline-reorder-dragged").length, document.querySelector("#timeline .timeline-bar")?.dataset.dragging ?? ""]);
    console.log("   leftovers line/note/dragged/dragging:", leftovers, "errors:", page.errors);
    await page.context().close();
  }
} finally { await env.browser.close(); await env.server.close(); }
