// Browser check of warm workspaces (X7, docs/integration.md principle 10):
// switching between workspaces takes under 100 ms, every time, measured from
// the tab's click to the first frame painted after it; a workspace switched
// away and back is the very same page (not rebuilt), and the page never holds
// two slots with one id.
// Run with `npm run e2e` (after `npm run build`).
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { preview } from "vite";

/** Principle 10's limit, from the click to the painted frame. */
const LIMIT_MS = 100;

const server = await preview({ preview: { port: 4178, strictPort: true }, logLevel: "error" });
const url = "http://localhost:4178/";
const sandboxChromium = "/opt/pw-browsers/chromium";
const browser = await chromium.launch(existsSync(sandboxChromium) ? { executablePath: sandboxChromium } : {});
const errors = [];

async function fresh(width = 1280) {
  const context = await browser.newContext({ viewport: { width, height: 800 } });
  const page = await context.newPage();
  await page.addInitScript(() => indexedDB.deleteDatabase("fission"));
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector("#volume")?.textContent === "24,000 mm³");
  return page;
}

/**
 * Clicks workspace `id`'s tab (or Community) and returns the milliseconds
 * until the frame after it was painted: the second animation frame runs
 * once the first one's frame is on screen.
 */
const switchTo = (page, id) =>
  page.evaluate(async (id) => {
    const target = id === "community" ? document.getElementById("community") : document.querySelector(`#workspaces [data-workspace="${id}"]`);
    const t0 = performance.now();
    target.click();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const ms = performance.now() - t0;
    if (document.body.dataset.activeWorkspace !== id) throw new Error(`asked for ${id}, showing ${document.body.dataset.activeWorkspace}`);
    return ms;
  }, id);

/** Ids used by more than one element in the page. */
const duplicateIds = (page) =>
  page.evaluate(() => {
    const seen = new Map();
    for (const el of document.querySelectorAll("[id]")) seen.set(el.id, (seen.get(el.id) ?? 0) + 1);
    return [...seen].filter(([, n]) => n > 1).map(([id]) => id);
  });

const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return { median: s[Math.floor(s.length / 2)], max: s.at(-1) };
};
const fmt = (ms) => `${ms.toFixed(1)} ms`;

let failed = false;
async function check(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    failed = true;
    console.log(`FAIL ${name}\n  ${e.message.split("\n").join("\n  ")}`);
  }
}

try {
  await check(`switching workspaces takes under ${LIMIT_MS} ms each time, first visits and returns`, async () => {
    const page = await fresh();
    try {
      const order = ["image", "render", "slice", "vector", "community", "design"];
      const first = [];
      for (const id of order) first.push([id, await switchTo(page, id)]);
      const again = [];
      for (let round = 0; round < 5; round++) for (const id of order) again.push([id, await switchTo(page, id)]);
      const firstStats = stats(first.map(([, ms]) => ms));
      const againStats = stats(again.map(([, ms]) => ms));
      console.log(`  first visits: median ${fmt(firstStats.median)}, slowest ${fmt(firstStats.max)}; returns (${again.length}): median ${fmt(againStats.median)}, slowest ${fmt(againStats.max)}`);
      const slow = [...first, ...again].filter(([, ms]) => ms >= LIMIT_MS).map(([id, ms]) => `${id} ${fmt(ms)}`);
      assert.deepEqual(slow, [], "switches at or over the limit");
    } finally {
      await page.close();
    }
  });

  await check("a workspace switched away and back is the same page, not rebuilt, with what was folded still folded", async () => {
    const page = await fresh();
    try {
      await page.click("#browser details[data-node] > summary"); // fold the first group
      await page.evaluate(() => {
        window.designPage = { width: document.querySelector("#width"), toolbar: document.querySelector("#toolbar"), browser: document.querySelector("#browser") };
      });
      const folded = () => page.$eval("#browser details[data-node]", (d) => !d.open);
      assert.equal(await folded(), true);
      await switchTo(page, "image");
      await page.evaluate(() => (window.imagePage = document.querySelector("#image-dpi")));
      assert.equal(await page.$("#width"), null, "Design's page is out of the page while Image is shown");
      await switchTo(page, "render");
      await switchTo(page, "design");
      assert.equal(await page.evaluate(() => document.querySelector("#width") === window.designPage.width), true, "the same size input");
      assert.equal(await page.evaluate(() => document.querySelector("#toolbar") === window.designPage.toolbar), true, "the same toolbar");
      assert.equal(await page.evaluate(() => document.querySelector("#browser") === window.designPage.browser), true, "the same browser");
      assert.equal(await folded(), true, "still folded");
      await switchTo(page, "image");
      assert.equal(await page.evaluate(() => document.querySelector("#image-dpi") === window.imagePage), true, "Image's same page");
      // Design still works after waking: an edit rebuilds the body.
      await switchTo(page, "design");
      await page.fill("#width", "50");
      await page.waitForFunction(() => document.querySelector("#volume")?.textContent === "30,000 mm³"); // 50 × 30 × 20
      assert.deepEqual(await duplicateIds(page), []);
    } finally {
      await page.close();
    }
  });

  await check("split view: switching either pane keeps one element per id; a workspace moving panes still works", async () => {
    const page = await fresh(1400);
    try {
      await page.click("#split-toggle");
      await page.waitForFunction(() => document.body.dataset.split === "render");
      for (const id of ["image", "slice", "render"]) {
        await page.selectOption("#split-choice", id);
        await page.waitForFunction((id) => document.body.dataset.split === id, id);
        await switchTo(page, id === "render" ? "vector" : "design");
      }
      await switchTo(page, "design");
      // Choosing the split pane's workspace in the switcher swaps the panes.
      await switchTo(page, "render");
      await page.waitForFunction(() => document.body.dataset.split === "design");
      await page.fill("#split-properties #width", "50");
      await page.waitForFunction(() => document.querySelector("#split-properties #volume")?.textContent === "30,000 mm³");
      assert.deepEqual(await duplicateIds(page), []);
      await page.click("#split-close");
      await switchTo(page, "design");
      await page.waitForFunction(() => document.querySelector("#properties #volume")?.textContent === "30,000 mm³");
      assert.deepEqual(await duplicateIds(page), []);
    } finally {
      await page.close();
    }
  });

  await check("no page errors", async () => assert.deepEqual(errors, []));
} finally {
  await browser.close();
  await new Promise((r) => server.httpServer.close(r));
}
if (failed) process.exit(1);
console.log("switching checks passed");
