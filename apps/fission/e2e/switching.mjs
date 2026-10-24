// Browser check of warm workspaces (X7, docs/integration.md principle 10):
// switching between workspaces takes under 100 ms, every time, measured from
// the tab's click to the first frame painted after it; a workspace switched
// away and back is the very same page (not rebuilt), and the page never holds
// two slots with one id.
// Run with `npm run e2e` (after `npm run build`).
import assert from "node:assert/strict";
import { launch } from "./browser.mjs";
import { preview } from "vite";
import { pinProperties } from "./properties.mjs";

/** Principle 10's limit, from the click to the painted frame. */
const LIMIT_MS = 100;

const server = await preview({ preview: { port: 4178, strictPort: true }, logLevel: "error" });
const url = "http://localhost:4178/";
const browser = await launch();
const errors = [];

async function fresh(width = 1280, plant = null) {
  const context = await browser.newContext({ viewport: { width, height: 800 } });
  const page = await context.newPage();
  await page.addInitScript(() => indexedDB.deleteDatabase("fission"));
  if (plant) await page.addInitScript(plant);
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector("#volume")?.textContent === "24,000 mm³");
  await pinProperties(page); // the size boxes are in the panel, folded at the start on a wide screen (U0b)
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

const ORDER = ["image", "render", "slice", "vector", "community", "design"];

/**
 * Times every switch of ORDER on `page`: the first visits, then five rounds
 * of returns. A switch at or over the limit is timed once more, the same
 * kind of switch again, and counts as slow only if it is slow both times
 * (Ben, 2026-10-23: a one-off runner stall, 106 ms against a 28 ms median,
 * kept failing the merge queue; the limit itself stays 100 ms). A first
 * visit is timed again as a first visit, in a fresh page with the same
 * `plant`; a return, by switching to the workspace before it and back.
 */
async function slowSwitches(page, plant = null) {
  const first = [];
  for (const id of ORDER) first.push([id, await switchTo(page, id)]);
  const again = [];
  for (let round = 0; round < 5; round++) for (const id of ORDER) again.push([id, await switchTo(page, id)]);
  const firstStats = stats(first.map(([, ms]) => ms));
  const againStats = stats(again.map(([, ms]) => ms));
  console.log(`  first visits: median ${fmt(firstStats.median)}, slowest ${fmt(firstStats.max)}; returns (${again.length}): median ${fmt(againStats.median)}, slowest ${fmt(againStats.max)}`);
  const slow = [];
  for (const [id, ms] of first.filter(([, ms]) => ms >= LIMIT_MS)) {
    const other = await fresh(1280, plant);
    try {
      for (const before of ORDER.slice(0, ORDER.indexOf(id))) await switchTo(other, before);
      const retimed = await switchTo(other, id);
      console.log(`  first visit to ${id} took ${fmt(ms)}; timed again: ${fmt(retimed)}`);
      if (retimed >= LIMIT_MS) slow.push(`first ${id} ${fmt(ms)}, ${fmt(retimed)}`);
    } finally {
      await other.close();
    }
  }
  for (const [id, ms] of again.filter(([, ms]) => ms >= LIMIT_MS)) {
    await switchTo(page, ORDER.at(ORDER.indexOf(id) - 1));
    const retimed = await switchTo(page, id);
    console.log(`  return to ${id} took ${fmt(ms)}; timed again: ${fmt(retimed)}`);
    if (retimed >= LIMIT_MS) slow.push(`return ${id} ${fmt(ms)}, ${fmt(retimed)}`);
  }
  return slow;
}

/** A planted slowdown for the checks below: a click on `which` workspace's tab holds the page for 150 ms, on the clicks numbered in `on` (1 is the first; null, every click). */
const slowTab = (which, on) => `(() => {
  let n = 0;
  document.addEventListener("click", (e) => {
    if (!e.target.closest?.('#workspaces [data-workspace="${which}"]')) return;
    n++;
    const on = ${JSON.stringify(on)};
    if (on !== null && !on.includes(n)) return;
    const end = performance.now() + 150;
    while (performance.now() < end);
  }, true);
})()`;

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
      assert.deepEqual(await slowSwitches(page), [], "switches at or over the limit, twice");
    } finally {
      await page.close();
    }
  });

  await check(`the ${LIMIT_MS} ms check fails a switch slowed every time (a 150 ms hold on every click on Image's tab), first visit and returns`, async () => {
    const plant = slowTab("image", null);
    const page = await fresh(1280, plant);
    try {
      const slow = await slowSwitches(page, plant);
      // Image is visited first once and returned to five times: all six are slow both times, and nothing else is.
      assert.equal(slow.length, 6, slow.join("; "));
      assert.ok(slow.every((s) => / image /.test(s)) && slow[0].startsWith("first image"), slow.join("; "));
    } finally {
      await page.close();
    }
  });

  await check(`the ${LIMIT_MS} ms check passes a switch slow only once (a 150 ms hold on the second click on Design's tab, its first return)`, async () => {
    const page = await fresh(1280, slowTab("design", [2]));
    try {
      assert.deepEqual(await slowSwitches(page), [], "a one-off stall is timed again and passes");
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
      await page.waitForFunction(() => document.body.dataset.split === "image");
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

  await check("a design that builds nothing (marker at the start) moved to the other pane and back keeps its timeline: no new box, no step (daily hunt 2026-10-23)", async () => {
    const page = await fresh(1400);
    const items = (pane) => page.$$eval(`${pane} [data-item]`, (els) => els.map((e) => e.dataset.item));
    const undoTitle = () => page.getAttribute("#undo", "title");
    try {
      await page.click('#timeline [data-button="start"]');
      await page.waitForFunction(() => document.querySelector("#viewport").dataset.shape === "none");
      const atStart = { items: await items("#timeline"), undo: await undoTitle() };
      assert.deepEqual(atStart.items, ["feature-1"], "the box alone, rolled back");
      await page.click("#split-toggle");
      await page.waitForFunction(() => document.body.dataset.split === "image");
      // Choosing the split pane's workspace in the switcher swaps the panes: Design is mounted again in the split pane.
      await switchTo(page, "image");
      await page.waitForFunction(() => document.body.dataset.split === "design");
      await page.waitForTimeout(500);
      assert.deepEqual(await items("#split-timeline"), atStart.items, "the split pane's timeline: no new box");
      assert.equal(await page.textContent("#split-properties #volume"), "—", "nothing built");
      assert.equal(await undoTitle(), atStart.undo, "no undo step");
      await page.click("#split-close");
      await switchTo(page, "design");
      await page.waitForTimeout(500);
      assert.deepEqual(await items("#timeline"), atStart.items, "back in the main pane: no new box");
      assert.equal(await page.textContent("#properties #volume"), "—", "still nothing built");
      assert.equal(await undoTitle(), atStart.undo, "still no undo step");
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
