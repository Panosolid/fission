// Browser check of Undo and Redo (step 20b): the top bar's buttons say what
// they would take back and are off at the ends; Ctrl+Z undoes, Ctrl+Shift+Z
// and Ctrl+Y redo; typing in one box is one step; inside a text field the
// browser's own undo runs, not the project's; undo survives a workspace
// switch; a default Design fills in when first shown is never a step.
// Every volume is worked out by hand from V = width · depth · height with
// the default depth 30 and height 20.
// Run with `npm run e2e` (after `npm run build`).
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { preview } from "vite";

const server = await preview({ preview: { port: 4180, strictPort: true }, logLevel: "error" });
const url = "http://localhost:4180/";
const sandboxChromium = "/opt/pw-browsers/chromium";
const browser = await chromium.launch(existsSync(sandboxChromium) ? { executablePath: sandboxChromium } : {});
const errors = [];

async function fresh(hash = "#design") {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.addInitScript(() => indexedDB.deleteDatabase("fission"));
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto(url + hash);
  if (hash === "#design") await volume(page, "24,000 mm³"); // 40 · 30 · 20
  return page;
}
/** Waits until the readout shows `text`, and says what it showed if it never does. */
async function volume(page, text) {
  try {
    await page.waitForFunction((t) => document.querySelector("#volume")?.textContent === t, text, { timeout: 5000 });
  } catch {
    assert.fail(`volume: expected ${text}, saw ${await page.textContent("#volume")}`);
  }
}
/** Each button's state: [disabled, title]. */
const buttons = (page) => page.evaluate(() => ["undo", "redo"].map((id) => [document.getElementById(id).disabled, document.getElementById(id).title]));
const width = (page) => page.inputValue("#width");
/** Types into the width box key by key, as a person does (one input event per key). */
async function typeWidth(page, text) {
  await page.click("#width");
  await page.keyboard.press("Control+A");
  await page.keyboard.type(text);
}
/** Takes focus out of any field, so keys go to the app. */
const blur = (page) => page.evaluate(() => document.activeElement?.blur());

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
  await check("buttons: off at the start, then Undo Change width puts back the old volume and size box, Redo brings it again", async () => {
    const page = await fresh();
    try {
      // Design filled in its default box while it was first shown: not a step.
      assert.deepEqual(await buttons(page), [[true, "Nothing to undo"], [true, "Nothing to redo"]]);
      await page.fill("#width", "50");
      await volume(page, "30,000 mm³"); // 50 · 30 · 20
      assert.deepEqual(await buttons(page), [[false, "Undo Change width (Ctrl+Z)"], [true, "Nothing to redo"]]);
      await page.click("#undo");
      await volume(page, "24,000 mm³");
      assert.equal(await width(page), "40");
      assert.deepEqual(await buttons(page), [[true, "Nothing to undo"], [false, "Redo Change width (Ctrl+Shift+Z)"]]);
      await page.screenshot({ path: "e2e/undo.png", clip: { x: 0, y: 0, width: 1280, height: 120 } });
      await page.click("#redo");
      await volume(page, "30,000 mm³");
      assert.equal(await width(page), "50");
      assert.deepEqual(await buttons(page), [[false, "Undo Change width (Ctrl+Z)"], [true, "Nothing to redo"]]);
      // Clicking an off button does nothing.
      await page.click("#redo", { force: true });
      await volume(page, "30,000 mm³");
    } finally {
      await page.close();
    }
  });

  await check("typing 6 then 0 in one box is one step; a shape is a step of its own; the walk ends at the start", async () => {
    const page = await fresh();
    try {
      await typeWidth(page, "60"); // the box shows 6, then 60: two input events, well under a second apart
      await volume(page, "36,000 mm³"); // 60 · 30 · 20
      await page.click('[data-shape="cylinder"]');
      assert.deepEqual((await buttons(page))[0], [false, "Undo Change shape to Cylinder (Ctrl+Z)"]);
      await page.click("#undo"); // back to the box, 60 wide
      await volume(page, "36,000 mm³");
      await page.click("#undo"); // the whole typed 60 at once, back to 40
      await volume(page, "24,000 mm³");
      assert.equal(await width(page), "40");
      assert.deepEqual(await buttons(page), [[true, "Nothing to undo"], [false, "Redo Change width (Ctrl+Shift+Z)"]]);
    } finally {
      await page.close();
    }
  });

  await check("keys: Ctrl+Z undoes, Ctrl+Shift+Z and Ctrl+Y redo (Cmd on a Mac is the same chord)", async () => {
    const page = await fresh();
    try {
      await page.fill("#width", "50");
      await volume(page, "30,000 mm³");
      await page.fill("#width", "10"); // the same box within a second: the same step, 40 → 10
      await volume(page, "6,000 mm³"); // 10 · 30 · 20
      await blur(page);
      await page.keyboard.press("Control+z");
      await volume(page, "24,000 mm³"); // back to 40 in one step
      await page.keyboard.press("Control+Shift+Z");
      await volume(page, "6,000 mm³");
      await page.keyboard.press("Control+z");
      await volume(page, "24,000 mm³");
      await page.keyboard.press("Control+y");
      await volume(page, "6,000 mm³");
      await page.keyboard.press("Meta+z");
      await volume(page, "24,000 mm³");
    } finally {
      await page.close();
    }
  });

  await check("inside a text field Ctrl+Z is the browser's own undo of the typing, not the project's", async () => {
    const page = await fresh();
    try {
      await page.fill("#width", "50");
      await volume(page, "30,000 mm³");
      await page.waitForTimeout(1100); // past the merge time: the next typing is a step of its own
      await typeWidth(page, "70");
      await volume(page, "42,000 mm³"); // 70 · 30 · 20
      // Mark the box: the project's undo mounts Design afresh, which would make a new one.
      await page.$eval("#width", (el) => (el.dataset.mark = "same"));
      await page.keyboard.press("Control+z");
      assert.equal(await page.$eval("#width", (el) => el.dataset.mark ?? "remounted"), "same", "the shell's undo ran inside the field");
      assert.notEqual(await width(page), "70", "the browser's own undo took the typing back");
    } finally {
      await page.close();
    }
  });

  await check("undo survives a workspace switch, and works from another workspace", async () => {
    const page = await fresh();
    try {
      await page.fill("#width", "50");
      await volume(page, "30,000 mm³");
      await page.click("[data-workspace=laser]");
      await page.click("[data-workspace=design]");
      assert.deepEqual((await buttons(page))[0], [false, "Undo Change width (Ctrl+Z)"]);
      await page.click("[data-workspace=laser]");
      await blur(page);
      await page.keyboard.press("Control+z"); // undone while Laser is on screen
      await page.click("[data-workspace=design]");
      await volume(page, "24,000 mm³");
      assert.equal(await width(page), "40");
    } finally {
      await page.close();
    }
  });

  await check("starting in another workspace: Design's default box, filled in when it is first shown, is no step", async () => {
    const page = await fresh("#laser");
    try {
      assert.deepEqual(await buttons(page), [[true, "Nothing to undo"], [true, "Nothing to redo"]]);
      await page.click("[data-workspace=design]");
      await volume(page, "24,000 mm³");
      assert.deepEqual(await buttons(page), [[true, "Nothing to undo"], [true, "Nothing to redo"]]);
    } finally {
      await page.close();
    }
  });

  await check("phone width: Undo and Redo are the first row of Menu, inside the screen, with no sideways scroll", async () => {
    const page = await fresh();
    try {
      await page.setViewportSize({ width: 375, height: 740 });
      await page.fill("#width", "50");
      await volume(page, "30,000 mm³");
      assert.equal(await page.isVisible("#undo"), false, "folded behind Menu");
      await page.click("#menu-toggle");
      for (const id of ["undo", "redo"]) {
        const b = await page.$eval(`#${id}`, (el) => el.getBoundingClientRect().toJSON());
        assert.ok(b.width > 0 && b.left >= 0 && b.right <= 375 && b.height >= 32, `${id} ${JSON.stringify(b)}`);
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 375);
      await page.screenshot({ path: "e2e/undo-375-menu.png" });
      await page.click("#undo");
      await volume(page, "24,000 mm³");
      assert.equal(await page.getAttribute("#menu-toggle", "aria-expanded"), "false", "choosing Undo closes the menu");
    } finally {
      await page.close();
    }
  });

  assert.deepEqual(errors, [], "no page errors or console errors");
} catch (e) {
  failed = true;
  console.log(`FAIL ${e.message}`);
} finally {
  await browser.close();
  await new Promise((r) => server.httpServer.close(r));
}
if (failed) process.exit(1);
