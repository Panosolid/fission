// Browser checks of the empty start and Insert ▾ (U0c, U0d, the owner's
// ask): a new project opens empty with the hint, whose buttons do what
// they say and whose ✕ closes it for the page; Insert ▾ adds each preset
// as a whole new body (never changing one already there), one undo step
// each, its sizes shown in the panel; Community is off and says why; the
// menu works by keyboard, closes on Escape and a press outside, and stays
// on the screen at 375 px; the part's shape changes with the properties'
// Shape choice. Each at 1280 px with the mouse and 375 px with taps, with
// deliberate breaks that fail. Run with `npm run e2e` (after `npm run build`).
import assert from "node:assert/strict";
import { launch } from "./browser.mjs";
import { preview } from "vite";
import { insertPreset } from "./start.mjs";
import { pinProperties } from "./properties.mjs";

const server = await preview({ preview: { port: 4236, strictPort: true }, logLevel: "error" });
const url = "http://localhost:4236/";
const browser = await launch();
const errors = [];

const until = (page, fn, arg, what) => page.waitForFunction(fn, arg, { timeout: 10000 }).catch(async () => assert.fail(`${what}: timed out`));
const press = (page, sel, tap) => (tap ? page.tap(sel) : page.click(sel));
const undoTitle = (page) => page.getAttribute("#undo", "title");
const bodies = (page) => page.$$eval('#browser .tree-row[data-node^="body-"]', (rows) => rows.map((r) => r.textContent));
/** Whether a box is whole on a screen `width` wide. */
const fits = (box, width) => box.x >= 0 && box.x + box.width <= width;
const items = (page) => page.$$eval("#timeline [data-item]", (els) => els.map((e) => e.dataset.item));

async function fresh(width, touch) {
  const context = await browser.newContext({ viewport: { width, height: width > 640 ? 800 : 667 }, hasTouch: touch, isMobile: touch });
  const page = await context.newPage();
  await page.addInitScript(() => indexedDB.deleteDatabase("fission"));
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto(url + "#design");
  await page.waitForSelector("#start-hint", { state: "visible" });
  return page;
}

let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (e) {
    failed++;
    console.log(`not ok - ${name}\n  ${e.message.split("\n").join("\n  ")}`);
  }
}

try {
  for (const [width, tap] of [[1280, false], [375, true]]) {
    const at = `${width} px${tap ? ", taps" : ""}`;

    await check(`${at}: a new project opens empty with the hint; Insert a preset opens Insert ▾; ✕ closes the hint for the page`, async () => {
      const page = await fresh(width, tap);
      try {
        // Empty: no body, nothing in the timeline, Undo has nothing.
        assert.deepEqual(await items(page), []);
        assert.deepEqual(await bodies(page), []);
        assert.equal(await page.$eval("#viewport", (el) => el.dataset.shape), "none");
        assert.equal(await undoTitle(page), "Nothing to undo");
        assert.equal(await page.textContent("#start-hint-words"), "Start your design");
        assert.deepEqual(await page.$$eval("#start-hint .start-hint-actions button", (bs) => bs.map((b) => b.textContent)), ["Create sketch", "Insert a preset", "Open a project"]);
        // The card is on the screen, whole.
        const card = await page.locator("#start-hint").boundingBox();
        assert.ok(fits(card, width), `the hint fits: ${JSON.stringify(card)}`);
        // Insert a preset opens the menu, its first item focused (keyboard-ready).
        await press(page, "#start-hint-insert", tap);
        await until(page, () => !document.getElementById("insert-menu").hidden, null, "the menu open");
        assert.equal(await page.evaluate(() => document.activeElement?.id), "insert-box");
        const menu = await page.locator("#insert-menu").boundingBox();
        assert.ok(fits(menu, width), `the menu fits the screen: ${JSON.stringify(menu)}`);
        await page.keyboard.press("Escape");
        await until(page, () => document.getElementById("insert-menu").hidden, null, "Escape closes it");
        // Create sketch from the hint starts a sketch, and the hint gets out of the way; Escape out of it brings it back.
        await press(page, "#start-hint-sketch", tap);
        await until(page, () => document.getElementById("start-hint").hidden, null, "the hint hidden while a sketch is started");
        assert.equal(await page.isVisible("#sketch-plane-XY"), true, "the plane choice is showing");
        await page.keyboard.press("Escape");
        await until(page, () => !document.getElementById("start-hint").hidden, null, "the hint back once the sketch is left");
        // ✕ closes it; it stays closed through Undo, Start fresh and switching, until the page loads again.
        await press(page, "#start-hint-close", tap);
        assert.equal(await page.isVisible("#start-hint"), false);
        await press(page, '[data-workspace="image"]', tap);
        await press(page, '[data-workspace="design"]', tap);
        await until(page, () => document.querySelector("#start-hint") !== null, null, "Design back");
        assert.equal(await page.isVisible("#start-hint"), false, "still closed after switching");
        await page.reload();
        await page.waitForSelector("#start-hint", { state: "visible" });
      } finally {
        await page.context().close();
      }
    });

    await check(`${at}: Insert ▾ adds each preset as a new body, never changing one there, one undo step each; the panel shows its sizes; Community is off`, async () => {
      const page = await fresh(width, tap);
      try {
        await press(page, "#insert", tap);
        // Presets in the command's order, then Community, off and saying why.
        assert.deepEqual(await page.$$eval("#insert-menu .menu-button-heading", (hs) => hs.map((h) => h.textContent)), ["Presets", "From Community"]);
        assert.deepEqual(await page.$$eval("#insert-menu [role=menuitem]", (bs) => bs.map((b) => b.textContent)), ["Box", "Cylinder", "Sphere", "L-bracket", "Plate", "Slot", "Star", "Community models"]);
        assert.equal(await page.getAttribute("#insert-community", "aria-disabled"), "true");
        assert.match(await page.getAttribute("#insert-community", "title"), /Community isn't built yet/);
        // Forced: Playwright waits for an aria-disabled item to be enabled; a person can still press it.
        await (tap ? page.tap("#insert-community", { force: true }) : page.click("#insert-community", { force: true }));
        assert.equal(await page.isVisible("#insert-menu"), true, "an off item does nothing and leaves the menu open");
        await press(page, "#insert-box", tap);
        // 40 × 30 × 20 = 24,000 mm³.
        await until(page, () => document.querySelector("#volume")?.textContent === "24,000 mm³", null, "the box");
        assert.equal(await page.isVisible("#insert-menu"), false, "a choice closes the menu");
        assert.equal(await page.isVisible("#start-hint"), false, "no hint once there is a body");
        assert.equal(await undoTitle(page), "Undo Insert Box (Ctrl+Z)");
        // The panel shows the new body's sizes (opened for them on a wide screen).
        assert.equal(await page.isVisible("#width"), true);
        assert.deepEqual([await page.inputValue("#width"), await page.inputValue("#depth"), await page.inputValue("#height")], ["40", "30", "20"]);
        assert.equal(await page.inputValue("#shape"), "box");
        // A cylinder: a second body (⌀40 × 20: π · 20² · 20 ≈ 25,133 mm³), the box untouched.
        await insertPreset(page, "cylinder", tap);
        await until(page, () => document.querySelectorAll("#timeline [data-item]").length === 2, null, "two items");
        assert.deepEqual(await items(page), ["feature-1", "feature-2"]);
        assert.equal(await page.textContent("#browser [data-node=feature-1]"), "1. Box: 40 × 30 × 20 mm", "the box is as it was");
        assert.equal(await undoTitle(page), "Undo Insert Cylinder (Ctrl+Z)");
        assert.equal(await page.inputValue("#shape"), "cylinder", "the panel edits the new body");
        // One Undo takes only the cylinder away.
        await press(page, "#undo", tap);
        await until(page, () => document.querySelectorAll("#timeline [data-item]").length === 1, null, "the cylinder undone");
        assert.equal(await undoTitle(page), "Undo Insert Box (Ctrl+Z)");
        await press(page, "#undo", tap);
        await until(page, () => document.querySelectorAll("#timeline [data-item]").length === 0, null, "empty again");
        await until(page, () => !document.getElementById("start-hint").hidden, null, "the hint back for the empty design");
      } finally {
        await page.context().close();
      }
    });

    await check(`${at}: the Shape choice changes the part in place (the toolbar's shape buttons until U0d)`, async () => {
      const page = await fresh(width, tap);
      try {
        await insertPreset(page, "box", tap);
        await until(page, () => document.querySelector("#volume")?.textContent === "24,000 mm³", null, "the box");
        await pinProperties(page);
        await page.selectOption("#shape", "sphere");
        // A sphere of diameter 40: 4/3 · π · 20³ ≈ 33,510 mm³; still one item, feature-1.
        await until(page, () => document.querySelector("#viewport").dataset.shape === "sphere", null, "a sphere");
        assert.deepEqual(await items(page), ["feature-1"], "changed in place, not added");
        assert.equal(await undoTitle(page), "Undo Change shape to Sphere (Ctrl+Z)");
        assert.equal(await page.isVisible("#depth"), false, "a sphere has no depth");
      } finally {
        await page.context().close();
      }
    });
  }

  await check("the menu by keyboard: ArrowDown opens it on Box, End goes to Star past the off Community item, Enter inserts; a press outside closes it", async () => {
    const page = await fresh(1280, false);
    try {
      await page.focus("#insert");
      await page.keyboard.press("ArrowDown");
      assert.equal(await page.evaluate(() => document.activeElement?.id), "insert-box");
      await page.keyboard.press("End");
      assert.equal(await page.evaluate(() => document.activeElement?.id), "insert-star", "the off item is skipped");
      await page.keyboard.press("ArrowDown");
      assert.equal(await page.evaluate(() => document.activeElement?.id), "insert-box", "and the list wraps");
      await page.keyboard.press("ArrowUp");
      await page.keyboard.press("Enter");
      await until(page, () => document.querySelector("#viewport").dataset.shape === "star", null, "a star inserted");
      assert.equal(await undoTitle(page), "Undo Insert Star (Ctrl+Z)");
      await page.click("#insert");
      assert.equal(await page.isVisible("#insert-menu"), true);
      await page.mouse.click(640, 400);
      assert.equal(await page.isVisible("#insert-menu"), false, "a press outside closes it");
      // Escape in the menu never also clears the selection (its keys are its own).
      await page.click('#browser .tree-row[data-node^="body-"]');
      await until(page, () => document.querySelector("#selection-list li") !== null, null, "the body selected");
      await page.focus("#insert");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Escape");
      assert.equal(await page.evaluate(() => document.activeElement?.id), "insert", "the focus is back on the button");
      assert.ok(await page.$("#selection-list li"), "the selection is still there");
    } finally {
      await page.context().close();
    }
  });

  await check("deliberate breaks fail: a hint shown on a design with a body, and a menu pushed off a phone's screen", async () => {
    const page = await fresh(375, true);
    try {
      await insertPreset(page, "box", true);
      await until(page, () => document.querySelector("#volume")?.textContent === "24,000 mm³", null, "the box");
      assert.equal(await page.isVisible("#start-hint"), false);
      // The hint forced on: the check that it is hidden with a body sees it.
      await page.evaluate(() => (document.getElementById("start-hint").hidden = false));
      assert.equal(await page.isVisible("#start-hint"), true, "a hint on a design with a body is caught");
      // The menu moved 300 px right on a 375 px screen: the fit check fails on it.
      await page.tap("#insert");
      await page.evaluate(() => (document.getElementById("insert-menu").style.left = "300px"));
      assert.equal(fits(await page.locator("#insert-menu").boundingBox(), 375), false, "a menu off the screen is caught");
    } finally {
      await page.context().close();
    }
  });

  await check("no errors in the console", () => assert.deepEqual(errors, []));
} finally {
  await browser.close();
  server.httpServer.close();
}
if (failed) {
  console.log(`${failed} insert check(s) failed`);
  process.exit(1);
}
