import * as H from "./lib.mjs";
const env = await H.start(4261);
try {
  for (const junk of ["-5", "0", "", "abc"]) for (const run of [1, 2]) {
    const page = await H.fresh(env);
    await page.fill("#width", junk); await page.press("#width", "Enter"); await H.settle(page);
    const f = H.design(await H.save(page));
    console.log(`width "${junk}" #${run}: file width ${JSON.stringify(f.timeline.features.map((x) => x.intent.parameters.width))} | bar ${await H.bar(page)} | bodies ${(await H.bodyRows(page)).join(",")} k ${await H.bodyCount(page)} | err: ${await H.errLine(page)} | undo: ${await H.undoTitle(page)}`);
    await page.context().close();
  }
} finally { await env.browser.close(); await env.server.close(); }
