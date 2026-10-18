import * as H from "./lib.mjs";
const env = await H.start(4258);
const errVis = (page) => page.evaluate(() => { const e = document.getElementById("error"); const r = e.getBoundingClientRect(); return { text: e.textContent, top: Math.round(r.top), viewport: innerHeight, scrollY: scrollY, ws: document.getElementById("workspace").scrollTop }; });
try {
  for (const run of [1, 2]) {
    const page = await H.fresh(env, 375, true);
    await H.addSquare(page, [[10, 40], [20, 50]], 10, true);
    await page.tap("#create-sketch"); await page.tap("#sketch-plane-XY");
    await page.waitForFunction(() => document.querySelector("#viewport").dataset.sketching === "true");
    await page.tap('#timeline [data-button="start"]', { force: true });
    await page.waitForTimeout(400);
    console.log(`#${run} refused Go to start while sketching:`, JSON.stringify(await errVis(page)));
    // and a refused tap between items (gap 0)
    if (run === 1) await page.screenshot({ path: "/tmp/claude-0/hunt/phone-refusal.png" });
    await page.context().close();
  }
} finally { await env.browser.close(); await env.server.close(); }
