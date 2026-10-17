// Browser check of the guide (How Fission works): opened from the top bar's
// Guide button (inside Menu at 375 px) and from a ?guide link; Next walks
// through every chapter in order and each chapter's 3D scene really draws
// (the stage with the canvas differs from the stage with it hidden); keys
// jump between chapters and never reach the app's shortcuts behind it; the
// B-rep bracket comes apart with the scroll and its VERTEX, EDGE and FACE
// labels appear only then, pinned on screen; Escape and Close return to
// the app unchanged with focus back on Guide; nothing spills sideways at
// 375 px; under reduced motion the picture holds still; with no WebGL the
// words still work and the drawing check fails, as it must.
// Run with `npm run e2e` (after `npm run build`).
import assert from "node:assert/strict";
import { launch } from "./browser.mjs";
import { compareImages, decodePng } from "./png.mjs";
import { preview } from "vite";

const server = await preview({ preview: { port: 4183, strictPort: true }, logLevel: "error" });
const url = "http://localhost:4183/";
const browser = await launch();
const errors = [];

async function fresh({ width = 1280, height = 800, touch = false, reducedMotion = "no-preference", query = "", init } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, hasTouch: touch, isMobile: touch, reducedMotion });
  const page = await context.newPage();
  await page.addInitScript(() => indexedDB.deleteDatabase("fission"));
  if (init) await page.addInitScript(init);
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto(url + query);
  await page.waitForFunction(() => document.querySelector("#volume")?.textContent === "24,000 mm³");
  return page;
}

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

const chapters = (page) => page.$$eval(".guide-chapter", (s) => s.map((x) => x.dataset.id));
const chapter = (page) => page.evaluate(() => document.querySelector("dialog.guide")?.dataset.chapter ?? null);
const frames = (page) => page.evaluate(() => Number(document.querySelector("dialog.guide")?.dataset.frames ?? 0));
async function waitChapter(page, id) {
  await page.waitForFunction((id) => document.querySelector("dialog.guide")?.dataset.chapter === id, id, { timeout: 8000 });
}
async function framesAdvance(page) {
  const before = await frames(page);
  await page.waitForFunction((n) => Number(document.querySelector("dialog.guide").dataset.frames) > n + 3, before, { timeout: 5000 });
}
/** Scrolls straight to chapter `i` at progress `p` (0 to 1). */
async function scrollTo(page, i, p) {
  await page.evaluate(
    ([i, p]) => {
      const sc = document.querySelector(".guide-scroll");
      const s = document.querySelectorAll(".guide-chapter")[i];
      sc.scrollTop = s.offsetTop - sc.clientHeight / 2 + p * s.offsetHeight;
    },
    [i, p],
  );
  await page.waitForFunction(([i, p]) => {
    const d = document.querySelector("dialog.guide");
    return d.dataset.chapter === document.querySelectorAll(".guide-chapter")[i].dataset.id && Math.abs(Number(d.dataset.progress) - p) < 0.01;
  }, [i, p]);
  await framesAdvance(page);
}
const shot = async (page, clip) => decodePng(await page.screenshot({ clip }));
/** Pixels of the stage that change when the 3D canvas (and its labels) are hidden: what the scene draws. */
async function drawn(page, clip) {
  const hide = (v) => page.evaluate((v) => document.querySelectorAll(".guide-canvas, .guide-labels, .guide-leaders").forEach((e) => (e.style.visibility = v)), v);
  const withScene = await shot(page, clip);
  await hide("hidden");
  const without = await shot(page, clip);
  await hide("");
  return compareImages(withScene, without, { channel: 24, maxPixels: 0 }).differing;
}
const WIDE_STAGE = { x: 560, y: 80, width: 640, height: 640 };
const NARROW_STAGE = { x: 0, y: 70, width: 375, height: 300 };

try {
  await check("Guide in the top bar opens the guide full screen; Next walks every chapter in order and each one's scene draws", async () => {
    const page = await fresh();
    await page.click("#guide-open");
    await page.waitForSelector("dialog.guide[open][data-frames]");
    const box = await page.$eval("dialog.guide", (d) => d.getBoundingClientRect().toJSON());
    assert.deepEqual([box.x, box.y, box.width, box.height], [0, 0, 1280, 800], "full screen");
    assert.equal(await page.$eval("dialog.guide", (d) => d.dataset.webgl), "on");
    const ids = await chapters(page);
    assert.equal(ids.length, 24);
    assert.equal(ids[0], "welcome");
    assert.equal(ids.at(-1), "words");
    assert.equal(await page.isDisabled(".guide-prev"), true, "no previous chapter at the start");
    for (let i = 0; i < ids.length; i++) {
      if (i > 0) {
        await page.click(".guide-next");
        await waitChapter(page, ids[i]);
      }
      await framesAdvance(page);
      assert.equal(await page.$eval(`.guide-chapter[data-id="${ids[i]}"]`, (s) => s.hasAttribute("data-active")), true, `${ids[i]}'s words are the ones shown`);
      if (ids[i] === "words") continue; // the words chapter covers its scene with the full list
      await page.waitForTimeout(150);
      const px = await drawn(page, WIDE_STAGE);
      assert.ok(px > 2000, `${ids[i]}: the scene drew only ${px} pixels`);
    }
    assert.equal(await page.isDisabled(".guide-next"), true, "no next chapter at the end");
    // Every word is listed on the last chapter.
    assert.ok((await page.$$eval('.guide-chapter[data-id="words"] dt', (d) => d.length)) >= 40);
  });

  await check("keys jump chapters and never reach the app behind; Escape returns to the app unchanged with focus on Guide", async () => {
    const page = await fresh();
    const volume = await page.textContent("#volume");
    await page.click("#guide-open");
    await page.waitForSelector("dialog.guide[open][data-frames]");
    await page.keyboard.press("End");
    await waitChapter(page, "words");
    await page.keyboard.press("Home");
    await waitChapter(page, "welcome");
    await page.keyboard.press("ArrowDown");
    await waitChapter(page, "parametric");
    await page.keyboard.press("PageDown");
    await waitChapter(page, "sketch");
    await page.keyboard.press("ArrowUp");
    await waitChapter(page, "parametric");
    // The app's own keys: ? opens its shortcut list, R picks a tool. Neither may fire behind the guide.
    await page.keyboard.press("?");
    await page.keyboard.press("r");
    assert.equal(await page.evaluate(() => document.getElementById("shortcuts")?.open ?? false), false, "? opened the app's shortcut list behind the guide");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector("dialog.guide"));
    assert.equal(await page.evaluate(() => document.activeElement?.id), "guide-open");
    assert.equal(await page.textContent("#volume"), volume);
    // And the app's keys work again once it is closed.
    await page.keyboard.press("?");
    assert.equal(await page.evaluate(() => document.getElementById("shortcuts")?.open ?? false), true);
  });

  await check("B-rep: the bracket comes apart with the scroll; VERTEX, EDGE and FACE appear only then, each pinned to the scene", async () => {
    const page = await fresh();
    await page.click("#guide-open");
    await page.waitForSelector("dialog.guide[data-frames]");
    const i = (await chapters(page)).indexOf("brep");
    const labels = () => page.$$eval(".guide-labels span", (s) => s.map((e) => ({ text: e.textContent, opacity: Number(e.style.opacity), box: e.getBoundingClientRect().toJSON() })));
    await scrollTo(page, i, 0.05);
    const together = await shot(page, WIDE_STAGE);
    assert.deepEqual((await labels()).map((l) => [l.text, l.opacity]), [["VERTEX", 0], ["EDGE", 0], ["FACE", 0]]);
    await scrollTo(page, i, 0.9);
    const apart = await shot(page, WIDE_STAGE);
    const moved = compareImages(together, apart, { channel: 24, maxPixels: 0 }).differing;
    assert.ok(moved > 20000, `the bracket barely changed (${moved} pixels)`);
    const shown = await labels();
    assert.deepEqual(shown.map((l) => [l.text, l.opacity]), [["VERTEX", 1], ["EDGE", 1], ["FACE", 1]]);
    // Each label sits on screen, right of the words, with its leader ending in a dot on screen.
    const card = await page.$eval('.guide-chapter[data-id="brep"] .guide-card', (c) => c.getBoundingClientRect().right);
    for (const l of shown) assert.ok(l.box.x >= card && l.box.x + l.box.width <= 1280 && l.box.y >= 0 && l.box.y + l.box.height <= 800, `${l.text} is off its place: ${JSON.stringify(l.box)}`);
    const dots = await page.$$eval(".guide-leaders circle", (c) => c.map((e) => [Number(e.getAttribute("cx")), Number(e.getAttribute("cy"))]));
    assert.equal(dots.length, 3);
    for (const [x, y] of dots) assert.ok(x > 0 && x < 1280 && y > 0 && y < 800);
    // Scrolling back puts it together again (the scroll drives it both ways).
    await scrollTo(page, i, 0.05);
    const again = await shot(page, WIDE_STAGE);
    assert.ok(compareImages(together, again, { channel: 24, maxPixels: 0 }).differing < moved / 4, "scrolling back should close it up");
  });

  await check("a ?guide link opens it straight away, and it reopens where it was left", async () => {
    const page = await fresh({ query: "?guide" });
    await page.waitForSelector("dialog.guide[open][data-frames]");
    assert.equal(await chapter(page), "welcome");
    const i = (await chapters(page)).indexOf("mesh");
    await scrollTo(page, i, 0.3);
    await page.click(".guide-close");
    await page.waitForFunction(() => !document.querySelector("dialog.guide"));
    await page.click("#guide-open");
    await page.waitForSelector("dialog.guide[data-frames]");
    assert.equal(await chapter(page), "mesh");
  });

  await check("375 px with taps: Guide is in Menu, nothing spills sideways, Next walks every chapter, Close returns", async () => {
    const page = await fresh({ width: 375, height: 740, touch: true });
    await page.tap("#menu-toggle");
    await page.tap("#guide-open");
    await page.waitForSelector("dialog.guide[open][data-frames]");
    const ids = await chapters(page);
    for (let i = 0; i < ids.length; i++) {
      if (i > 0) {
        await page.tap(".guide-next");
        await waitChapter(page, ids[i]);
      }
      const spill = await page.evaluate(() => {
        const sc = document.querySelector(".guide-scroll");
        const card = document.querySelector(".guide-chapter[data-active] .guide-card").getBoundingClientRect();
        return { scroll: sc.scrollWidth - sc.clientWidth, left: card.left, right: card.right };
      });
      assert.equal(spill.scroll, 0, `${ids[i]}: the page scrolls sideways`);
      assert.ok(spill.left >= 0 && spill.right <= 375, `${ids[i]}: the card spills off the screen (${spill.left}–${spill.right})`);
      if (ids[i] !== "words" && i % 4 === 0) {
        await framesAdvance(page);
        const px = await drawn(page, NARROW_STAGE);
        assert.ok(px > 1000, `${ids[i]}: the scene drew only ${px} pixels above the words`);
      }
    }
    await page.tap(".guide-close");
    await page.waitForFunction(() => !document.querySelector("dialog.guide"));
  });

  await check("reduced motion: the picture holds still; with motion allowed it turns slowly", async () => {
    const still = await fresh({ reducedMotion: "reduce", query: "?guide" });
    await still.waitForSelector("dialog.guide[data-frames]");
    await framesAdvance(still);
    const a = await shot(still, WIDE_STAGE);
    await still.waitForTimeout(1200);
    await framesAdvance(still);
    const b = await shot(still, WIDE_STAGE);
    assert.ok(compareImages(a, b, { channel: 24, maxPixels: 0 }).differing < 50, "the scene moved under reduced motion");
    const moving = await fresh({ query: "?guide" });
    await moving.waitForSelector("dialog.guide[data-frames]");
    await moving.waitForTimeout(1000); // let the sky settle
    const c = await shot(moving, WIDE_STAGE);
    await moving.waitForTimeout(1200);
    const d = await shot(moving, WIDE_STAGE);
    assert.ok(compareImages(c, d, { channel: 24, maxPixels: 0 }).differing > 500, "the scene should turn when motion is allowed");
  });

  await check("no WebGL: the guide says so, the words still work, and the drawing check fails as it must", async () => {
    const page = await fresh({
      query: "?guide",
      init: () => {
        const real = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
          if (this.classList.contains("guide-canvas")) return null;
          return real.call(this, type, ...rest);
        };
      },
    });
    await page.waitForSelector("dialog.guide[open]");
    assert.equal(await page.$eval("dialog.guide", (d) => d.dataset.webgl), "off");
    assert.equal(await page.isVisible(".guide-no3d"), true);
    await page.click(".guide-next");
    await waitChapter(page, "parametric");
    assert.ok((await drawn(page, WIDE_STAGE)) < 50, "with no canvas the stage must look the same hidden or not");
  });
} finally {
  await browser.close();
  server.httpServer.close();
}

const unexpected = errors.filter((e) => !/WebGL|getContext|Error creating WebGL context/i.test(e));
if (unexpected.length) {
  failed = true;
  console.log(`FAIL page errors:\n  ${unexpected.join("\n  ")}`);
}
if (failed) process.exit(1);
