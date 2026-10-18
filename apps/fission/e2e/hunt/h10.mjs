// Where does a refusal show at phone width, and how long does it stay?
import * as H from "./lib.mjs";
const env = await H.start(4250 + 7);
const errVis = (page) => page.evaluate(() => { const e = document.getElementById("error"); const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); let hidden = false; for (let n = e; n; n = n.parentElement) { const s = getComputedStyle(n); if (s.display === "none" || s.visibility === "hidden" || n.hidden) hidden = true; } return { text: e.textContent, inViewport: r.top >= 0 && r.bottom <= innerHeight && r.width > 0 && r.height > 0 && !hidden, top: Math.round(r.top), h: Math.round(r.height), hidden }; });
try {
  for (const [w, touch] of [[375, true], [1280, false]]) {
    for (const run of [1, 2]) {
      const page = await H.fresh(env, w, touch);
      await H.addSquare(page, w === 375 ? [[10, 40], [20, 50]] : [[50, 0], [60, 10]], 10, touch);
      // A refused reorder: drag Extrude 1 before Sketch 1 (mouse at 1280; at 375 by the menu? use the end button which is off)
      if (touch) await page.tap('#timeline [data-button="end"]', { force: true }); else await page.click('#timeline [data-button="end"]', { force: true });
      await page.waitForTimeout(300);
      console.log(`${w} #${run} refused End:`, JSON.stringify(await errVis(page)));
      if (!touch) { await H.dragItemTo(page, "feature-11", await H.gapPageX(page, 0)); console.log(`${w} #${run} refused drag:`, JSON.stringify(await errVis(page))); }
      // now do something that is not a rebuild: open sketch, finish
      if (touch) { await page.tap("#create-sketch"); await page.tap("#sketch-plane-XY"); } else { await page.click("#create-sketch"); await page.click("#sketch-plane-XY"); }
      await page.waitForTimeout(300);
      console.log(`${w} #${run} after Create sketch:`, (await errVis(page)).text);
      await page.keyboard.press("Escape");
      await page.click("#sketch-finish").catch(() => {});
      await H.settle(page);
      console.log(`${w} #${run} after finishing the sketch:`, (await errVis(page)).text, "| bar:", await H.bar(page));
      if (run === 1 && w === 375) await page.screenshot({ path: "/tmp/claude-0/hunt/phone-refusal.png" });
      await page.context().close();
    }
  }
} finally { await env.browser.close(); await env.server.close(); }
