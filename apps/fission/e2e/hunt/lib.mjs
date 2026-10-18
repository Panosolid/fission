// Bug-hunt helpers (untracked, deleted after the hunt).
import { readFileSync } from "node:fs";
import { launch, browserName } from "../browser.mjs";
import { clickPlane, TOP } from "../sketch-screen.mjs";
import { preview } from "vite";
export { browserName };

export async function start(port) {
  const server = await preview({ preview: { port, strictPort: true }, logLevel: "error" });
  const browser = await launch();
  return { server, browser, url: `http://localhost:${port}/?test-hooks` };
}

export async function fresh(env, width = 1280, touch = false, height = 800) {
  const context = await env.browser.newContext({ viewport: { width, height }, hasTouch: touch, acceptDownloads: true });
  const page = await context.newPage();
  await page.addInitScript(() => {
    if (sessionStorage.getItem("store-cleared")) return;
    indexedDB.deleteDatabase("fission");
    sessionStorage.setItem("store-cleared", "1");
  });
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") page.errors.push("console: " + m.text()); });
  await page.goto(env.url + "#design");
  await page.waitForFunction(() => document.querySelector("#volume")?.textContent === "24,000 mm³", null, { timeout: 20000 });
  return page;
}

export const bar = (page) =>
  page.$$eval("#timeline .timeline-bar > li", (lis) =>
    lis.filter((li) => !li.classList.contains("timeline-bar-more-slot"))
      .map((li) => (li.classList.contains("timeline-bar-marker") ? "|" : [li.dataset.item, li.dataset.suppressed && "S", li.dataset.rolledBack && "R", li.dataset.failed && "F"].filter(Boolean).join(" "))).join("  "));

export const undoTitle = (page) => page.evaluate(() => document.getElementById("undo").title);
export const errLine = (page) => page.evaluate(() => document.getElementById("error")?.textContent ?? "");
export const volume = (page) => page.textContent("#volume").catch(() => null);
export const bodyCount = (page) => page.evaluate(() => window.fissionTest.bodyCount());
export const bodyRows = (page) => page.$$eval('#browser .tree-row[data-node^="body-"]', (r) => r.map((x) => x.dataset.node));

export async function settle(page, ms = 6000) {
  let last = "";
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const now = await page.evaluate(() => document.body.innerText.length + "|" + document.querySelector("#timeline")?.innerHTML + "|" + document.querySelector("#volume")?.textContent);
    if (now === last) return true;
    last = now;
    await page.waitForTimeout(200);
  }
  return false;
}

export async function save(page) {
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 8000 }).catch(() => null), page.evaluate(() => document.getElementById("save").click())]);
  if (!download) return null;
  return readFileSync(await download.path(), "utf8");
}
export async function openText(page, text, name = "hunt.fission.json") {
  const [chooser] = await Promise.all([page.waitForEvent("filechooser", { timeout: 5000 }), page.evaluate(() => document.getElementById("open").click())]);
  await chooser.setFiles({ name, mimeType: "application/json", buffer: Buffer.from(text) });
  await settle(page);
}

const press = (page, sel, tap) => (tap ? page.tap(sel) : page.click(sel));
/** A square sketched at corners and extruded by `distance`. */
export async function addSquare(page, corners = [[50, 0], [60, 10]], distance = 10, tap = false) {
  await press(page, "#create-sketch", tap);
  await press(page, "#sketch-plane-XY", tap);
  await page.waitForFunction(() => document.querySelector("#viewport").dataset.sketching === "true");
  await page.check("#sketch-grid-snap");
  await page.evaluate(() => (document.getElementById("workspace").scrollTop = 0));
  await press(page, "#sketch-tool-rectangle", tap);
  for (const p of corners) await clickPlane(page, p, TOP, tap);
  await page.waitForFunction(() => document.querySelector("#sketch-status")?.textContent === "4 lines, a closed outline.", null, { timeout: 5000 });
  await press(page, "#sketch-extrude", tap);
  await page.fill("#extrude-distance", String(distance));
  await press(page, "#extrude-ok", tap);
  await page.waitForFunction(() => document.querySelector("#viewport").dataset.sketching !== "true");
  await settle(page);
  await page.evaluate(() => (window.scrollTo(0, 0), (document.getElementById("workspace").scrollTop = 0)));
}

/** The centre of item id's box on the bar. */
export async function itemBox(page, id) {
  const l = page.locator(`#timeline [data-item="${id}"]`);
  await l.scrollIntoViewIfNeeded();
  return l.boundingBox();
}
export async function markerBox(page) {
  return page.locator("#timeline .timeline-bar-marker").boundingBox();
}
/** Mouse drag from (x0,y0) to (x1,y1) in n steps. */
export async function mouseDrag(page, x0, y0, x1, y1, n = 10, beforeUp) {
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  for (let i = 1; i <= n; i++) await page.mouse.move(x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n);
  if (beforeUp) await beforeUp();
  await page.mouse.up();
}
/** Drag item `id` with the mouse to the gap x (page px). */
export async function dragItemTo(page, id, x, beforeUp) {
  const b = await itemBox(page, id);
  await mouseDrag(page, b.x + b.width / 2, b.y + b.height / 2, x, b.y + b.height / 2, 12, beforeUp);
  await settle(page);
}
/** The page x of the gap before item index `place` (0..n) as the bar lays them out now. */
export async function gapPageX(page, place) {
  return page.evaluate((p) => {
    const lis = [...document.querySelectorAll("#timeline .timeline-bar-item")].map((li) => li.getBoundingClientRect());
    if (p === 0) return lis[0].left - 2;
    if (p === lis.length) return lis[lis.length - 1].right + 2;
    return (lis[p - 1].right + lis[p].left) / 2;
  }, place);
}
export const design = (text) => JSON.parse(text).workspaces.design;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
