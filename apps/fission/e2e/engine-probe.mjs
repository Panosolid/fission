// Temporary probe for the daily bug hunt 3e (never merged): the smoke test's
// steps from the phone-width focus check to Save, in Firefox, logged.
import { launch, browserName } from "./browser.mjs";
import { preview } from "vite";

const server = await preview({ preview: { port: 4174, strictPort: true }, logLevel: "error" });
const url = "http://localhost:4174/";
const browser = await launch();
const t0 = Date.now();
const log = (...a) => console.log(`[${browserName} ${((Date.now() - t0) / 1000).toFixed(2)}s]`, ...a);
const page = await browser.newPage({ viewport: { width: 1000, height: 640 } });
await page.addInitScript(() => {
  indexedDB.deleteDatabase("fission");
  for (const k of Object.keys(localStorage)) if (k.startsWith("panoshape.unsaved/")) localStorage.removeItem(k);
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    console.log(`anchor click download=${this.download} activation=${navigator.userActivation?.isActive}`);
    return click.call(this);
  };
  addEventListener("click", (e) => console.log(`click on ${e.target?.id || e.target?.tagName} trusted=${e.isTrusted}`), true);
  addEventListener("pointerdown", (e) => console.log(`pointerdown on ${e.target?.id || e.target?.tagName}`), true);
});
page.on("console", (m) => log(`console.${m.type()}: ${m.text().slice(0, 300)}`));
page.on("pageerror", (e) => log(`pageerror: ${e.message}`));
page.on("download", (d) => log(`DOWNLOAD event: ${d.suggestedFilename()}`));
page.on("framenavigated", (f) => f === page.mainFrame() && log(`navigated ${f.url()}`));
const st = () => page.evaluate(() => ({ v: document.querySelector("#volume")?.textContent, s: document.querySelector("#save-status")?.dataset.state, w: document.querySelector("#width")?.value }));

await page.goto(url);
await page.waitForFunction(() => document.querySelector("#viewport")?.dataset.rebuilding === "false");
log("loaded", JSON.stringify(await st()));
// The phone check's steps.
await page.setViewportSize({ width: 375, height: 740 });
await page.goto(url + "#design");
await page.waitForFunction(() => document.querySelector("#status")?.textContent === "valid");
await page.waitForFunction(() => document.querySelector("#save-status")?.dataset.state === "saved");
await page.fill("#width", "41");
await page.waitForFunction(() => document.querySelector("#volume")?.textContent === "24,600 mm³" && !document.querySelector("#undo").disabled);
await page.click("#browser-toggle");
await page.click("#browser-toggle");
await page.fill("#width", "40");
await page.waitForFunction(() => document.querySelector("#volume")?.textContent === "24,000 mm³" && document.querySelector("#save-status")?.dataset.state === "saved");
await page.setViewportSize({ width: 1000, height: 640 });
log("phone steps done", JSON.stringify(await st()));
// The Save check's steps.
await page.goto(url + "#design");
log("after goto", JSON.stringify(await st()));
await page.reload();
log("after reload", JSON.stringify(await st()));
await page.waitForFunction(() => document.querySelector("#volume")?.textContent === "24,000 mm³");
await page.fill("#width", "50");
await page.waitForFunction(() => document.querySelector("#volume")?.textContent === "30,000 mm³");
const where = await page.evaluate(() => {
  const b = document.querySelector("#save").getBoundingClientRect();
  const at = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
  return `save at ${b.x.toFixed(0)},${b.y.toFixed(0)} ${b.width.toFixed(0)}x${b.height.toFixed(0)}; element there: ${at?.id || at?.tagName}; menu ${document.querySelector("#menu-toggle")?.getAttribute("aria-expanded")}; actions display ${getComputedStyle(document.querySelector("#topbar-actions")).display}`;
});
log(where);
const got = page.waitForEvent("download", { timeout: 8000 }).then(() => "yes", () => "no");
await page.click("#save");
log("clicked save; download:", await got);
log("file-status:", await page.textContent("#file-status"));
// Once more after a pause.
await page.waitForTimeout(2000);
const got2 = page.waitForEvent("download", { timeout: 8000 }).then(() => "yes", () => "no");
await page.click("#save");
log("clicked save again; download:", await got2);
await browser.close();
await server.close();
log("done");
