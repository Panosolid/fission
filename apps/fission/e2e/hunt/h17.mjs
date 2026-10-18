// A finger dragging the marker at phone width (Chromium CDP touch).
import * as H from "./lib.mjs";
const env = await H.start(4265);
try {
  for (const run of [1, 2]) {
    const page = await H.fresh(env, 375, true);
    await H.addSquare(page, [[10, 40], [20, 50]], 10, true);
    const cdp = await page.context().newCDPSession(page);
    const m = await H.markerBox(page); const y = m.y + m.height / 2; const x0 = m.x + m.width / 2; const x1 = await H.gapPageX(page, 1);
    console.log(`#${run} touch-action on marker: ${await page.$eval("#timeline .timeline-bar-marker", (e) => getComputedStyle(e).touchAction)}, marker width ${m.width}`);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: x0, y }] });
    for (let k = 1; k <= 8; k++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x0 + ((x1 - x0) * k) / 8, y }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await H.settle(page);
    console.log(`   finger drag marker to gap 1: ${await H.bar(page)} | ${await H.undoTitle(page)}`);
    await page.context().close();
  }
} finally { await env.browser.close(); await env.server.close(); }
