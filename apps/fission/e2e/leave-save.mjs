// Browser check that a change survives the page going before autosave has
// stored it (timeline bug hunt, finding 1: a reload or close within about
// a second of an edit lost it, in every engine). Each check makes its
// change and leaves while the top bar still says "Saving…", so autosave's
// quiet moment has not come:
//   - a width typed, then reloaded at once (1280 px, and 375 px with taps);
//   - the hunt's own steps: Box, Sketch 1 (a square), Extrude 1, Go to the
//     start, reloaded at once: all three items and the marker come back;
//   - a burst of widths, then the tab closed (its beforeunload run): no
//     question asked, and a new tab opens the last width;
//   - localStorage refusing the journal (as when it is full): closing while
//     a change waits asks first, staying keeps the page, and once Saved it
//     closes without asking.
// Every page comes back saying Saved, with no journal entry left.
// Run with `npm run e2e` (after `npm run build`); `E2E_BROWSER` picks the engine.
import assert from "node:assert/strict";
import { launch } from "./browser.mjs";
import { clickPlane, TOP } from "./sketch-screen.mjs";
import { preview } from "vite";

const server = await preview({ preview: { port: 4232, strictPort: true }, logLevel: "error" });
const url = "http://localhost:4232/";
const browser = await launch();
const errors = [];
const UNSAVED_PREFIX = "panoshape.unsaved/"; // packages/storage/src/unsaved.ts

let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}\n  ${e.stack ?? e}`);
  }
}

const until = (page, fn, arg, what) => page.waitForFunction(fn, arg, { timeout: 10000 }).catch(() => assert.fail(`${what}: timed out`));
const press = (page, sel, tap) => (tap ? page.tap(sel) : page.click(sel));
const status = (page) => page.$eval("#save-status", (s) => s.dataset.state);
const journal = (page) => page.evaluate((prefix) => Object.keys(localStorage).filter((k) => k.startsWith(prefix)), UNSAVED_PREFIX);
const volume = (page, want) => until(page, (w) => document.querySelector("#volume")?.textContent === w, want, `the volume ${want}`);

/** A context of its own (its own IndexedDB and localStorage, kept across reloads), the app open on the stored box. */
async function fresh(width, { touch = false, init } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 800 }, hasTouch: touch });
  if (init) await context.addInitScript(init);
  const page = await open(context);
  // A new browser: the default box is stored as a new project.
  await until(page, () => document.querySelector("#save-status").dataset.state === "saved", null, "the box stored");
  return { context, page };
}

async function open(context, want = "24,000 mm³") {
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto(url + "#design");
  await volume(page, want);
  return page;
}

/** Types `value` into the width box as a person would (a click first, which is the user's gesture a leave question needs). */
async function typeWidth(page, value, tap) {
  await press(page, "#width", tap);
  await page.fill("#width", value);
}

/** After the page has come back: the project was put back and stored, and the journal is empty. */
async function cameBack(page) {
  await until(page, () => document.querySelector("#save-status").dataset.state === "saved", null, "Saved after coming back");
  assert.equal(await page.textContent("#file-status"), "", "no message");
  assert.deepEqual(await journal(page), [], "no journal entry left");
}

const bar = (page) =>
  page.$$eval("#timeline .timeline-bar > li", (lis) =>
    lis.filter((li) => !li.classList.contains("timeline-bar-more-slot")).map((li) => (li.classList.contains("timeline-bar-marker") ? "|" : li.dataset.item + (li.dataset.rolledBack ? " rolled back" : ""))),
  );

try {
  for (const [width, tap] of [
    [1280, false],
    [375, true],
  ]) {
    await check(`a width typed and the page reloaded at once, still Saving…, comes back (${width} px${tap ? ", taps" : ""})`, async () => {
      const { context, page } = await fresh(width, { touch: tap });
      const id = await page.evaluate(() => document.body.dataset.projectId);
      await typeWidth(page, "50", tap);
      await volume(page, "30,000 mm³"); // V = 50 · 30 · 20, worked by hand
      assert.equal(await status(page), "saving", "left before autosave's quiet moment");
      await page.reload();
      await volume(page, "30,000 mm³");
      assert.equal(await page.inputValue("#width"), "50");
      assert.equal(await page.evaluate(() => document.body.dataset.projectId), id, "the same stored project");
      await cameBack(page);
      await context.close();
    });
  }

  await check("the hunt's steps: Box, Sketch 1, Extrude 1, Go to the start, reloaded at once: all of it and the marker come back", async () => {
    const { context, page } = await fresh(1280);
    // A 10 × 10 square on XY, extruded 10: 1,000 mm³ (the panel shows the last body).
    await page.click("#create-sketch");
    await page.click("#sketch-plane-XY");
    await until(page, () => document.querySelector("#viewport").dataset.sketching === "true", null, "sketching");
    await page.check("#sketch-grid-snap");
    await page.click("#sketch-tool-rectangle");
    for (const p of [
      [50, 0],
      [60, 10],
    ])
      await clickPlane(page, p, TOP);
    await until(page, () => document.querySelector("#sketch-status")?.textContent === "4 lines, a closed outline.", null, "the square closed");
    await page.click("#sketch-extrude");
    await page.fill("#extrude-distance", "10");
    await page.click("#extrude-ok");
    await volume(page, "1,000 mm³");
    await until(page, () => document.querySelector("#viewport").dataset.sketching !== "true", null, "the sketch finished");
    // As the hunt did: wait for Saved, then move the marker and reload within a second.
    await until(page, () => document.querySelector("#save-status").dataset.state === "saved", null, "the extrude stored");
    const items = (await bar(page)).filter((i) => i !== "|");
    assert.equal(items.length, 3, `Box, Sketch 1, Extrude 1: ${items}`);
    await page.click('#timeline [data-button="start"]');
    await until(page, () => document.querySelector("#viewport").dataset.shape === "none", null, "nothing built");
    assert.equal(await status(page), "saving", "left before autosave's quiet moment");
    await page.reload();
    await until(page, () => document.querySelector("#timeline .timeline-bar-marker"), null, "the bar");
    await until(page, () => document.querySelector("#viewport").dataset.shape === "none", null, "nothing built after the reload");
    assert.deepEqual(await bar(page), ["|", ...items.map((i) => `${i} rolled back`)]);
    assert.equal(await page.textContent("#volume"), "—");
    await cameBack(page);
    await context.close();
  });

  await check("a burst of widths and the tab closed: no question asked, a new tab opens the last width", async () => {
    const { context, page } = await fresh(1280);
    const asked = [];
    page.on("dialog", (d) => (asked.push(d.type()), d.dismiss()));
    for (const w of ["41", "42", "43", "44", "45"]) await typeWidth(page, w);
    await volume(page, "27,000 mm³"); // 45 · 30 · 20
    assert.equal(await status(page), "saving", "left before autosave's quiet moment");
    await Promise.all([page.waitForEvent("close", { timeout: 5000 }), page.close({ runBeforeUnload: true })]);
    const again = await open(context, "27,000 mm³");
    assert.equal(await again.inputValue("#width"), "45");
    assert.deepEqual(asked, [], "the journal kept the change, so nothing was asked");
    await cameBack(again);
    await context.close();
  });

  await check("localStorage refusing the journal: a saved page closes without asking; closing while Saving… asks first, and staying keeps the page", async () => {
    // As a full localStorage does: every journal write throws.
    const { context, page } = await fresh(1280, {
      init: () => {
        const set = Storage.prototype.setItem;
        Storage.prototype.setItem = function (k, v) {
          if (String(k).startsWith("panoshape.unsaved/")) throw new DOMException("the quota has been exceeded", "QuotaExceededError");
          return set.call(this, k, v);
        };
      },
    });
    const asked = [];
    page.on("dialog", (d) => (asked.push(d.type()), d.dismiss()));
    await typeWidth(page, "50");
    await volume(page, "30,000 mm³");
    await until(page, () => document.querySelector("#save-status").dataset.state === "saved", null, "Saved");
    await Promise.all([page.waitForEvent("close", { timeout: 5000 }), page.close({ runBeforeUnload: true })]);
    assert.deepEqual(asked, [], "a saved page asks nothing");
    // Another tab, a change still waiting: closing asks; dismissing the question stays.
    const second = await open(context, "30,000 mm³");
    await typeWidth(second, "60");
    await volume(second, "36,000 mm³"); // 60 · 30 · 20
    assert.equal(await status(second), "saving");
    const question = new Promise((done) => {
      second.once("dialog", async (d) => (done(d.type()), await d.dismiss()));
      setTimeout(() => done("no question within 5 s"), 5000);
    });
    await second.close({ runBeforeUnload: true });
    assert.equal(await question, "beforeunload");
    await second.waitForTimeout(300);
    assert.equal(second.isClosed(), false, "staying keeps the page");
    // leaving() started the save straight away, without waiting for another quiet moment.
    await until(second, () => document.querySelector("#save-status").dataset.state === "saved", null, "Saved");
    assert.deepEqual(await journal(second), []);
    // The second tab still counts as opening for SETTLED_MS after it showed (the reopen guard, reopen.ts):
    // a tab opened before then would start a new project instead, so wait for its mark to clear.
    await until(second, () => localStorage.getItem("panoshape.opening") === null, null, "the second tab counted as opened");
    await open(context, "36,000 mm³");
    await context.close();
  });

  await check("no page errors", async () => {
    assert.deepEqual(errors, []);
  });
} finally {
  await browser.close();
  await server.close();
}
if (failed) {
  console.log(`${failed} leave-save check(s) failed`);
  process.exit(1);
}
