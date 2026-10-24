// scratch: before/after screenshots (not committed)
import { readFileSync } from "node:fs";
import { launch } from "./browser.mjs";
import { preview } from "vite";
const out = process.argv[2];
const server = await preview({ preview: { port: 4299, strictPort: true }, logLevel: "error" });
const browser = await launch();
const file = readFileSync(new URL("../../../tests/golden/stepped-boss.panosolid.json", import.meta.url));
for (const width of [1280, 375]) {
  const context = await browser.newContext({ viewport: { width, height: width > 700 ? 720 : 667 }, hasTouch: width < 700 });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log("pageerror", e.message));
  await page.goto("http://localhost:4299/");
  await page.waitForFunction(() => document.querySelector("#volume")?.textContent === "24,000 mm³");
  await page.setInputFiles("#open-file", { name: "boss.panosolid.json", mimeType: "application/json", buffer: file });
  await page.waitForTimeout(1500);
  if (width < 700) { await page.click("#browser-toggle").catch(() => {}); }
  await page.click('[data-shape="slot"]');
  if (process.env.FOLD && width > 700) {
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${out}/folded-${width}.png` });
    await page.click('#browser .tree-row[data-node="body-2"]');
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${out}/selected-${width}.png` });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${out}/cleared-${width}.png` });
  }
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${out}/design-${width}.png`, fullPage: false });
  if (width < 700) await page.screenshot({ path: `${out}/design-${width}-full.png`, fullPage: true });
  if (width > 700 && process.env.OPEN_TIMELINE) {
    await page.click('#browser details[data-node="timeline"] > summary');
    await page.hover('#browser .tree-row[data-node="sketch-2"]').catch(() => {});
    await page.hover('#browser [data-node="timeline"] .tree-row >> nth=1');
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${out}/timeline-open-${width}.png` });
  }
  // select body 4 like Ben's
  const rows = await page.$$eval("#browser .tree-row", (r) => r.map((x) => x.textContent));
  console.log(width, rows.join(" | "));
  console.log(await page.$eval("#provenance", (e) => e.textContent));
  await context.close();
}
await browser.close();
server.close?.();
process.exit(0);
