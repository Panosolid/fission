import * as H from "./lib.mjs";
const env = await H.start(4275);
const st = (page) => page.evaluate(() => ({ open: document.getElementById("row-menu").open, focus: document.activeElement?.id || document.activeElement?.tagName }));
try {
  for (const run of [1, 2]) {
    for (const how of ["blur by script", "click the greyed entry", "click the menu's padding", "touch: tap greyed entry"]) {
      const touch = how.startsWith("touch");
      const page = await H.fresh(env, touch ? 375 : 1280, touch);
      if (touch) { await page.tap('#timeline [data-item="feature-1"]'); await page.tap('#timeline [data-more="feature-1"]'); }
      else await page.click('#timeline [data-item="feature-1"]', { button: "right" });
      await page.waitForTimeout(200);
      const s0 = await st(page);
      if (how === "blur by script") await page.evaluate(() => document.activeElement.blur());
      if (how.includes("greyed")) { const b = await page.locator("#row-menu-marker").boundingBox(); if (touch) await page.touchscreen.tap(b.x + 10, b.y + b.height / 2); else await page.mouse.click(b.x + 10, b.y + b.height / 2); }
      if (how.includes("padding")) { const b = await page.locator("#row-menu").boundingBox(); await page.mouse.click(b.x + 2, b.y + 2); }
      const s1 = await st(page);
      await page.keyboard.press("Escape"); await page.waitForTimeout(300);
      const s2 = await st(page);
      console.log(`#${run} ${how}: opened ${JSON.stringify(s0)} -> after ${JSON.stringify(s1)} -> Escape ${JSON.stringify(s2)}`);
      await page.context().close();
    }
  }
} finally { await env.browser.close(); await env.server.close(); }
