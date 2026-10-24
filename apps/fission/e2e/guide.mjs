// Browser check of the guide (How SpindleLabs works): opened from the top bar's
// Guide button (inside Menu at 375 px) and from a ?guide link; Next walks
// through every chapter in order and each chapter's 3D scene really draws
// (the stage with the canvas differs from the stage with it hidden); keys
// jump between chapters and never reach the app's shortcuts behind it; the
// B-rep bracket comes apart with the scroll and its VERTEX, EDGE and FACE
// labels appear only then, pinned on screen; Escape and Close return to
// the app unchanged with focus back on Guide; nothing spills sideways at
// 375 px; under reduced motion the picture holds still; with no WebGL the
// words still work and the drawing check fails, as it must. Next glides
// (no jump) and stops exactly where the next chapter's words come to rest;
// every card fits on screen with no scroll bar of its own, both faces, at
// laptop and phone sizes; and one scene fades into the next with no
// frame-to-frame jump (stepped frame by frame on a hand-turned clock).
// Run with `npm run e2e` (after `npm run build`), or alone with `node e2e/guide.mjs`.
import assert from "node:assert/strict";
import { launch } from "./browser.mjs";
import { compareImages, decodePng } from "./png.mjs";
import { preview } from "vite";
import { startWithBox } from "./start.mjs";

const server = await preview({ preview: { port: 4183, strictPort: true }, logLevel: "error" });
const url = "http://localhost:4183/";
const browser = await launch();
const errors = [];

// Every check's pages are closed when it ends: a guide left open keeps drawing every frame, and a run's worth of them
// starves the machine (page loads then time out).
const open = [];
async function fresh({ width = 1280, height = 800, touch = false, reducedMotion = "no-preference", query = "", init, clock = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, hasTouch: touch, isMobile: touch, reducedMotion });
  open.push(context);
  const page = await context.newPage();
  // A hand-turned clock for frame-by-frame checks: until window.stepper.hold() the page runs as normal; after it, the
  // page's time stands still and its animation frames wait until the test calls window.stepper.step(ms), which moves
  // time on and runs them once (the browser's own frames still draw the result on screen).
  if (clock)
    await page.addInitScript(() => {
      const realFrame = requestAnimationFrame.bind(window);
      const realNow = performance.now.bind(performance);
      let held = null;
      let waiting = [];
      window.requestAnimationFrame = (f) => (held === null ? realFrame(f) : (waiting.push(f), waiting.length));
      performance.now = () => (held === null ? realNow() : held);
      window.stepper = {
        // Frames already asked of the browser still run once on real time; waiting two real frames lets them run and ask
        // again, so from then on every frame of the page's waits for step().
        hold: () => {
          held = realNow();
          return new Promise((r) => realFrame(() => realFrame(r)));
        },
        step: (ms) => {
          held += ms;
          const run = waiting;
          waiting = [];
          run.forEach((f) => f(held));
        },
        presented: () => new Promise((r) => realFrame(() => realFrame(r))),
        /** Lets time run again; frames that were waiting run on the browser's next real one. */
        release: () => {
          held = null;
          const run = waiting;
          waiting = [];
          run.forEach((f) => realFrame(f));
        },
        /** Steps `n` frames of `ms` and returns the scroll after each (fast: no waiting for the screen). */
        run: (n, ms = 16) => {
          if (waiting.length === 0) throw new Error("no frame is waiting to be stepped");
          const sc = document.querySelector(".guide-scroll");
          const ys = [];
          for (let k = 0; k < n; k++) {
            window.stepper.step(ms);
            ys.push(sc.scrollTop);
          }
          return ys;
        },
      };
    });
  await page.addInitScript(() => indexedDB.deleteDatabase("fission"));
  if (init) await page.addInitScript(init);
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto(url + query);
  // A new project starts empty (U0c): the 40 × 30 × 20 box, inserted; with ?guide the guide is over the app, so the design stays empty.
  if (query.includes("guide")) await page.waitForFunction(() => document.querySelector("#start-hint") !== null);
  else await startWithBox(page);
  return page;
}

let failed = false;
// GUIDE_ONLY=<regex> runs just the checks whose names match (the reduced-motion one is timing-sensitive, so run it alone when the machine is busy).
const only = process.env.GUIDE_ONLY ? new RegExp(process.env.GUIDE_ONLY) : null;
async function check(name, fn) {
  if (only && !only.test(name)) return;
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    failed = true;
    console.log(`FAIL ${name}\n  ${e.message.split("\n").join("\n  ")}`);
  } finally {
    await Promise.all(open.splice(0).map((c) => c.close()));
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
/** Waits until no glide is moving the page and no scene is fading into another. */
async function settled(page) {
  await page.waitForFunction(() => {
    const d = document.querySelector("dialog.guide");
    return d && d.dataset.gliding === undefined && d.dataset.blending === undefined;
  }, null, { timeout: 8000 });
}
/**
 * Where chapter `i`'s words come to rest, worked out from the page itself
 * (not from the guide's own numbers): the scroll at which its card's top
 * reaches its sticky place, chapter top + padding above the card − the
 * card's CSS top.
 */
const restOf = (page, i) =>
  page.evaluate((i) => {
    const s = document.querySelectorAll(".guide-chapter")[i];
    const card = s.querySelector(".guide-card");
    return Math.max(0, Math.round(s.offsetTop + parseFloat(getComputedStyle(s).paddingTop) - parseFloat(getComputedStyle(card).top)));
  }, i);
/** Scrolls straight to chapter `i` at progress `p` (0 to 1). */
async function scrollTo(page, i, p) {
  await page.evaluate(
    ([i, p]) => {
      const sc = document.querySelector(".guide-scroll");
      const { rests, leads } = document.querySelector("dialog.guide").stops;
      const stop = i + 1 < rests.length ? rests[i + 1] - leads[i + 1] : sc.scrollHeight - sc.clientHeight;
      sc.scrollTop = rests[i] + p * (stop - rests[i]);
    },
    [i, p],
  );
  await page.waitForFunction(([i, p]) => {
    const d = document.querySelector("dialog.guide");
    return d.dataset.chapter === document.querySelectorAll(".guide-chapter")[i].dataset.id && Math.abs(Number(d.dataset.progress) - p) < 0.01;
  }, [i, p]);
  await settled(page);
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
      await settled(page);
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

  await check("Licences beside Close opens the third-party notices in a new tab: every shipped package, with its licence text", async () => {
    // licences.mjs lists them and its tests check the lists; here the built
    // app serves the file the link names. three's MIT text names its
    // authors; glam ships as MIT; unicode-ident's Unicode licence is the
    // AND half that once went missing; tslib is copied inside web-llm.
    const page = await fresh({ query: "?guide" });
    await page.waitForSelector("dialog.guide[open][data-frames]");
    const link = await page.$eval(".guide-licences", (a) => ({ box: a.getBoundingClientRect().toJSON(), close: document.querySelector(".guide-close").getBoundingClientRect().toJSON(), rel: a.rel, target: a.target }));
    assert.ok(link.box.width > 0 && link.box.right <= link.close.left && link.box.top >= 0, `Licences sits left of Close: ${JSON.stringify(link)}`);
    assert.deepEqual([link.rel, link.target], ["noopener", "_blank"]);
    const [notices] = await Promise.all([page.context().waitForEvent("page"), page.click(".guide-licences")]);
    await notices.waitForLoadState();
    assert.equal(new URL(notices.url()).pathname, "/third-party-licences.txt");
    const text = await notices.evaluate(() => document.body.innerText);
    await notices.close();
    assert.match(text, /^Third-party licences for SpindleLabs/);
    for (const line of [/\nthree 0\.\d+\.\d+: MIT\n/, /three\.js authors/, /\n@mlc-ai\/web-llm [\d.]+: Apache-2\.0\n/, /\nglam [\d.]+: MIT \(offered as MIT OR Apache-2\.0\)\n/, /UNICODE LICENSE V3/, /\ntslib \(TypeScript's helpers\), inside @mlc-ai\/web-llm: 0BSD\n/]) assert.match(text, line);
    const response = await page.request.get(`${url}third-party-licences.txt`);
    assert.equal(response.status(), 200);
    assert.match(response.headers()["content-type"], /^text\/plain/);
    // The guide stays open behind the new tab.
    assert.ok(await page.$("dialog.guide[open]"));
  });

  await check("Privacy beside Licences opens the privacy and terms page in a new tab, and the page says what the app really does", async () => {
    const page = await fresh({ query: "?guide" });
    await page.waitForSelector("dialog.guide[open][data-frames]");
    const link = await page.$eval(".guide-privacy", (a) => ({ box: a.getBoundingClientRect().toJSON(), licences: document.querySelector(".guide-licences").getBoundingClientRect().toJSON(), rel: a.rel, target: a.target }));
    assert.ok(link.box.width > 0 && link.box.right <= link.licences.left && link.box.top >= 0, `Privacy sits left of Licences: ${JSON.stringify(link)}`);
    assert.deepEqual([link.rel, link.target], ["noopener", "_blank"]);
    const [tab] = await Promise.all([page.context().waitForEvent("page"), page.click(".guide-privacy")]);
    await tab.waitForLoadState();
    assert.equal(new URL(tab.url()).pathname, "/privacy.html");
    const headings = await tab.$$eval("h1, h2, h3", (hs) => hs.map((h) => h.textContent));
    await tab.close();
    assert.deepEqual(headings, ["Privacy and terms", "Privacy", "What is kept, and where", "What leaves your device", "Children and students", "Deleting your data", "Terms of use", "Questions"]);
    // The words must match the app: the assistant's Remove key button, the providers it offers, and the licences file it links.
    const words = await (await page.request.get(`${url}privacy.html`)).text();
    const assistant = await import("node:fs").then((fs) => fs.readFileSync(new URL("../src/assistant.ts", import.meta.url), "utf8"));
    assert.match(assistant, />Remove key</);
    for (const said of ["choose Remove key", "Anthropic, OpenAI", "Ollama", "in-browser model", "no analytics", 'href="third-party-licences.txt"', "panosolid.github.io"]) assert.ok(words.includes(said), said);
    assert.ok(await page.$("dialog.guide[open]"));
  });

  await check("The privacy page runs under its own strict policy: no script, no outside request, nothing wider than a 375 px phone", async () => {
    const context = await browser.newContext({ viewport: { width: 375, height: 740 }, bypassCSP: false });
    const tab = await context.newPage();
    const requests = [];
    const problems = [];
    tab.on("request", (r) => requests.push(r.url()));
    tab.on("console", (m) => m.type() === "error" && problems.push(m.text()));
    tab.on("pageerror", (e) => problems.push(e.message));
    await tab.goto(`${url}privacy.html`);
    const csp = await tab.$eval('meta[http-equiv="Content-Security-Policy"]', (m) => m.content);
    assert.match(csp, /default-src 'none'/);
    assert.equal(await tab.$$eval("script", (s) => s.length), 0);
    // A script slipped into the page would be refused by the policy, not run.
    const ran = await tab.evaluate(() => {
      const s = document.createElement("script");
      s.textContent = "window.ranInline = true";
      document.body.append(s);
      return window.ranInline === true;
    });
    assert.equal(ran, false);
    const width = await tab.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(width <= 375, `scrollWidth ${width}`);
    await context.close();
    // The page itself, and at most its icon: the browser asks for the icon in its own time, sometimes
    // after the tab has closed (it was missing in a merge-queue run), so it may or may not be in the list.
    const unexpected = requests.filter((r) => ![`${url}privacy.html`, `${url}favicon.svg`].includes(r));
    assert.deepEqual(unexpected, []);
    assert.ok(requests.includes(`${url}privacy.html`), requests.join("\n"));
    assert.ok(problems.every((p) => /Content Security Policy|Content-Security-Policy/.test(p)), problems.join("\n")); // only the refused test script
  });

  await check("375 px: Privacy, Licences and Close all fit in the guide's bar", async () => {
    const page = await fresh({ width: 375, height: 740, touch: true, query: "?guide" });
    await page.waitForSelector("dialog.guide[open][data-frames]");
    const [title, privacy, link, close] = await page.$$eval(".guide-title, .guide-privacy, .guide-licences, .guide-close", (els) => els.map((e) => e.getBoundingClientRect().toJSON()));
    assert.ok(title.right <= privacy.left && privacy.right <= link.left && link.right <= close.left && close.right <= 375, `${JSON.stringify({ title, privacy, link, close })}`);
    assert.ok(Math.abs((privacy.top + privacy.bottom) / 2 - (link.top + link.bottom) / 2) < 4, "Privacy on Licences' line");
    assert.ok(link.height >= 13 && Math.abs((link.top + link.bottom) / 2 - (close.top + close.bottom) / 2) < 4, "on Close's line");
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
        await settled(page);
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

  for (const [width, height] of [[1280, 800], [375, 667]]) {
    await check(`${width}×${height}: Next glides (no jump) and stops exactly where the next chapter's words come to rest`, async () => {
      // Stepped on the hand-turned clock, 16 ms a frame, so the check is the same on a fast machine and a slow one.
      const page = await fresh({ width, height, query: "?guide", clock: true });
      await page.waitForSelector("dialog.guide[data-frames]");
      const ids = await chapters(page);
      const from = ids.indexOf("sketch");
      await page.evaluate((y) => (document.querySelector(".guide-scroll").scrollTop = y), await restOf(page, from));
      await waitChapter(page, "sketch");
      await settled(page);
      const goal = await restOf(page, from + 1);
      await page.evaluate(() => window.stepper.hold());
      const start = await page.evaluate(() => {
        document.querySelector(".guide-next").click();
        return document.querySelector(".guide-scroll").scrollTop;
      });
      const ys = await page.evaluate(() => window.stepper.run(90)); // 1.44 s, past the longest glide (1 s)
      const distance = goal - start;
      // Lands exactly at rest (to the pixel) and stays there.
      const landed = ys.findIndex((y) => Math.abs(y - goal) <= 1);
      assert.ok(landed >= 0, `never reached ${goal}: ended at ${ys.at(-1)}`);
      assert.ok(ys.slice(landed).every((y) => Math.abs(y - goal) <= 1), "it moved again after landing");
      // A glide, not a jump: forwards only, at least 600 ms of frames (37 at 16 ms) on the way, none moving more than a
      // tenth of the distance (an eased glide of 600 ms or more moves at most 1.5 × distance × 16/600 = 4% a frame).
      const steps = ys.map((y, k) => y - (k ? ys[k - 1] : start));
      assert.ok(steps.every((d) => d >= 0), "it went backwards");
      assert.ok(landed >= 36, `it got there in ${landed + 1} frames (${(landed + 1) * 16} ms): a jump, not a glide`);
      assert.ok(Math.max(...steps) <= distance / 10, `one frame moved ${Math.max(...steps)} of ${distance} px`);
      // Eased: slow at both ends, fastest in the middle.
      const third = Math.floor(landed / 3);
      const mid = Math.max(...steps.slice(third, 2 * third));
      assert.ok(steps[0] < mid / 4 && steps[landed] < mid / 2, `not eased: first ${steps[0]}, middle ${mid}, last ${steps[landed]} px a frame`);
      // At rest the card's top is at its sticky place (its words have just stopped moving), the whole card is on screen,
      // fully shown, and the scene starts from its beginning.
      await page.evaluate(() => window.stepper.release());
      await waitChapter(page, ids[from + 1]);
      await page.waitForTimeout(700); // the words' fade-in
      const card = await page.$eval(".guide-chapter[data-active] .guide-card", (c) => ({ box: c.getBoundingClientRect().toJSON(), place: parseFloat(getComputedStyle(c).top), opacity: Number(getComputedStyle(c).opacity) }));
      assert.ok(Math.abs(card.box.top - card.place) <= 1, `the card's top is at ${card.box.top}, its resting place is ${card.place}`);
      assert.ok(card.box.bottom <= height && card.box.top >= 0, `the card runs off the screen: ${card.box.top}–${card.box.bottom}`);
      assert.equal(card.opacity, 1);
      assert.equal(await page.$eval("dialog.guide", (d) => d.dataset.progress), "0.000");
    });
  }

  await check("Next pressed twice quickly goes two chapters, and lands at the second's resting place", async () => {
    const page = await fresh({ query: "?guide", clock: true });
    await page.waitForSelector("dialog.guide[data-frames]");
    await settled(page);
    await page.evaluate(() => window.stepper.hold());
    await page.evaluate(() => {
      document.querySelector(".guide-next").click();
      window.stepper.run(5);
      document.querySelector(".guide-next").click();
    });
    const ys = await page.evaluate(() => window.stepper.run(90));
    assert.ok(Math.abs(ys.at(-1) - (await restOf(page, 2))) <= 1, `ended at ${ys.at(-1)}, not at chapter 3's words (${await restOf(page, 2)})`);
    await page.evaluate(() => window.stepper.release());
    await waitChapter(page, (await chapters(page))[2]);
  });

  await check("the reader's own scrolling takes over from a glide", async () => {
    const page = await fresh({ query: "?guide" });
    await page.waitForSelector("dialog.guide[data-frames]");
    await page.click(".guide-next");
    await page.waitForFunction(() => document.querySelector(".guide-scroll").scrollTop > 40);
    await page.mouse.move(900, 400);
    await page.mouse.wheel(0, 30);
    await page.waitForFunction(() => document.querySelector("dialog.guide").dataset.gliding === undefined, null, { timeout: 2000 });
    // Well after the glide would have ended, the page is not at the next chapter's words: the wheel's 30 px moved it
    // from part-way, and nothing pulled it on.
    await page.waitForTimeout(1500);
    const y = await page.$eval(".guide-scroll", (s) => s.scrollTop);
    assert.ok(Math.abs(y - (await restOf(page, 1))) > 20, `the glide carried on to ${y} after the wheel`);
  });

  for (const [width, height] of [[1280, 800], [1280, 720], [375, 667], [375, 740]]) {
    await check(`${width}×${height}: every chapter's card fits on screen with no scroll bar of its own, both sides of it`, async () => {
      const page = await fresh({ width, height, reducedMotion: "reduce", query: "?guide" });
      await page.waitForSelector("dialog.guide[data-frames]");
      const ids = await chapters(page);
      const problems = [];
      for (let i = 0; i < ids.length; i++) {
        if (ids[i] === "words") continue; // the full word list is a page of its own that scrolls with the guide
        await page.evaluate((y) => (document.querySelector(".guide-scroll").scrollTop = y), await restOf(page, i));
        await waitChapter(page, ids[i]);
        const sides = await page.evaluate(async () => {
          const card = document.querySelector(".guide-chapter[data-active] .guide-card");
          const look = () => {
            const b = card.getBoundingClientRect();
            const shown = card.querySelector(`.guide-face[data-face="${card.dataset.face === "words" ? "words" : "text"}"]`);
            const fb = shown?.getBoundingClientRect();
            return { top: b.top, bottom: b.bottom, height: b.height, inner: card.scrollHeight - card.clientHeight, overflow: getComputedStyle(card).overflowY, face: fb ? { top: fb.top, bottom: fb.bottom } : null };
          };
          const front = look();
          const flip = card.querySelector('.guide-face[data-face="text"] .guide-flip');
          if (!flip) return [front];
          flip.click();
          const back = look();
          const words = getComputedStyle(card.querySelector('.guide-face[data-face="words"]')).visibility;
          const text = getComputedStyle(card.querySelector('.guide-face[data-face="text"]')).visibility;
          card.querySelector('.guide-face[data-face="words"] .guide-flip').click();
          return [front, { ...back, words, text }];
        });
        sides.forEach((side, k) => {
          const name = `${ids[i]}${k ? " (words side)" : ""}`;
          if (side.inner > 0) problems.push(`${name}: ${side.inner} px hidden inside the card (overflow ${side.overflow})`);
          if (side.top < 0 || side.bottom > height) problems.push(`${name}: the card runs off the screen (${Math.round(side.top)}–${Math.round(side.bottom)} of ${height})`);
          if (side.face && (side.face.top < side.top || side.face.bottom > side.bottom + 0.5)) problems.push(`${name}: its words spill out of the card`);
          if (k && (side.words !== "visible" || side.text !== "hidden")) problems.push(`${name}: turning it over shows ${side.words === "visible" ? "both sides" : "the wrong side"}`);
          if (k && Math.abs(side.height - sides[0].height) > 0.5) problems.push(`${name}: the card changed size when turned over (${sides[0].height} → ${side.height})`);
        });
      }
      assert.deepEqual(problems, []);
      if (width === 1280 && height === 800 || width === 375 && height === 667) {
        // Screenshots for the pull request (the sketch chapter: the one with the most words).
        await page.evaluate((y) => (document.querySelector(".guide-scroll").scrollTop = y), await restOf(page, ids.indexOf("sketch")));
        await waitChapter(page, "sketch");
        await framesAdvance(page);
        await page.screenshot({ path: `${process.env.GUIDE_SHOTS ?? "/tmp"}/guide-sketch-${width}.png` });
      }
    });
  }

  await check("one scene fades into the next: frame by frame, no jump; partway through both are on screen", async () => {
    const page = await fresh({ clock: true, query: "?guide" });
    await page.waitForSelector("dialog.guide[data-frames]");
    // Only the 3D pictures: the sky, words and labels (which change on their own timers) are hidden.
    await page.addStyleTag({ content: ".guide-sky, .guide-scroll, .guide-labels, .guide-leaders, .guide-bar, .guide-rail, .guide-nav { visibility: hidden !important; }" });
    const ids = await chapters(page);
    const from = ids.indexOf("parametric");
    await page.evaluate((y) => (document.querySelector(".guide-scroll").scrollTop = y), await restOf(page, from));
    await waitChapter(page, "parametric");
    await settled(page);
    const step = async () => {
      await page.evaluate(() => window.stepper.step(16));
      await page.evaluate(() => window.stepper.presented());
    };
    // Stop time, then move to the next chapter's words and step one frame (16 ms) at a time.
    await page.evaluate(() => window.stepper.hold());
    await step();
    await step();
    const stage = { x: 0, y: 0, width: 1280, height: 800 };
    let last = await shot(page, stage);
    const first = last;
    await page.evaluate((y) => (document.querySelector(".guide-scroll").scrollTop = y), await restOf(page, from + 1));
    await page.waitForFunction((id) => document.querySelector("dialog.guide").dataset.chapter === id, ids[from + 1], { polling: 50 });
    const jumps = [];
    let both = 0;
    for (let k = 0; k < 60; k++) {
      await step();
      const now = await shot(page, stage);
      jumps.push(compareImages(last, now, { channel: 24, maxPixels: 0 }).differing);
      last = now;
      const opacities = await page.$$eval(".guide-canvas", (c) => c.map((e) => Number(e.style.opacity)));
      if (process.env.GUIDE_DEBUG) console.log(k, jumps.at(-1), opacities, await page.$eval("dialog.guide", (d) => [d.dataset.frames, d.dataset.blend, d.dataset.chapter, performance.now()]));
      if (opacities.every((o) => o > 0.2 && o < 0.8)) both++;
    }
    const total = compareImages(first, last, { channel: 24, maxPixels: 0 }).differing;
    assert.ok(total > 20000, `the scene hardly changed between chapters (${total} pixels)`);
    // The turning alone moves a few hundred pixels a frame; a cut moves most of the picture at once.
    assert.ok(Math.max(...jumps) < total / 8, `one frame changed ${Math.max(...jumps)} of the ${total} pixels that change in all: a cut, not a blend (frames: ${jumps.join(", ")})`);
    assert.ok(both >= 10, `both scenes were on screen together in only ${both} frames`);
    assert.equal(await page.$eval("dialog.guide", (d) => d.dataset.blending ?? "done"), "done", "the blend never finished");
  });

  await check("reduced motion: Next goes straight to the words' resting place and the scene changes at once", async () => {
    const page = await fresh({ reducedMotion: "reduce", query: "?guide" });
    await page.waitForSelector("dialog.guide[data-frames]");
    const ids = await chapters(page);
    const y = await page.evaluate(() => {
      document.querySelector(".guide-next").click();
      return document.querySelector(".guide-scroll").scrollTop;
    });
    assert.equal(y, await restOf(page, 1), "under reduced motion Next should not glide");
    await waitChapter(page, ids[1]);
    assert.equal(await page.$eval("dialog.guide", (d) => d.dataset.blending ?? "none"), "none");
  });

  await check("Space plays the guide at a steady pace and again pauses, even with a button focused; the hint shows at the start and goes once played", async () => {
    const page = await fresh({ query: "?guide", clock: true });
    await page.waitForSelector("dialog.guide[data-frames]");
    await page.waitForTimeout(500); // the hint's fade-in
    const hint = () => page.$eval(".guide-hint", (h) => ({ opacity: Number(getComputedStyle(h).opacity), text: h.innerText }));
    const before = await hint();
    assert.equal(before.opacity, 1, "the hint is not showing at the start");
    assert.match(before.text, /Space.*steady pace/);
    // Next has focus (as after clicking it), yet Space plays instead of pressing Next. Time is stepped 16 ms a frame.
    await page.focus(".guide-next");
    await page.evaluate(() => window.stepper.hold());
    const h = await page.$eval(".guide-scroll", (s) => s.clientHeight);
    const still = await page.evaluate(() => window.stepper.run(20));
    assert.ok(still.every((y) => y === still[0]), "the page moved before Space");
    await page.keyboard.press(" ");
    assert.equal(await page.$eval("dialog.guide", (d) => d.dataset.playing !== undefined), true, "Space did not start playing");
    const ys = await page.evaluate(() => window.stepper.run(125)); // 2 s
    // By hand: 0.15 screens a second on an 800 px view is 120 px a second, so 2 s is 240 px (to a pixel for rounding),
    // 1.92 px a frame: never backwards, never more than 3 px in a frame (no jump to the next chapter), and steady
    // (each half second the same 60 px).
    assert.equal(h, 800);
    assert.ok(Math.abs(ys.at(-1) - still[0] - 240) <= 1, `played ${ys.at(-1) - still[0]} px in 2 s, not 240`);
    const steps = ys.map((y, k) => y - (k ? ys[k - 1] : still[0]));
    assert.ok(steps.every((d) => d >= 0 && d <= 3), `uneven steps: ${steps.join(",")}`);
    for (let k = 31; k < 125; k += 31) assert.ok(Math.abs(ys[k] - ys[k - 31] - 59.52) <= 1, `half a second moved ${ys[k] - ys[k - 31]} px, not 59.5`);
    assert.equal(await page.$eval(".guide-play", (b) => b.getAttribute("aria-pressed")), "true");
    // Space again pauses, and it stays put.
    await page.keyboard.press(" ");
    const after = await page.evaluate(() => window.stepper.run(40));
    assert.ok(after.every((y) => y === after[0]), "still moving after Space paused it");
    assert.equal(await page.$eval(".guide-play", (b) => b.getAttribute("aria-pressed")), "false");
    await page.evaluate(() => window.stepper.release());
    assert.equal(await page.$eval(".guide-hint", (h) => h.hasAttribute("data-shown")), false, "the hint should go once the guide has played");
    await page.waitForFunction(() => getComputedStyle(document.querySelector(".guide-hint")).opacity === "0", null, { timeout: 4000 }); // its fade-out
    // The reader's own wheel stops a play too.
    await page.keyboard.press(" ");
    await page.waitForFunction(() => document.querySelector("dialog.guide").dataset.playing !== undefined);
    await page.mouse.move(900, 400);
    await page.mouse.wheel(0, 20);
    await page.waitForFunction(() => document.querySelector("dialog.guide").dataset.playing === undefined, null, { timeout: 2000 });
  });

  await check("375 px with taps: the hint says to tap Play; Play scrolls steadily and Pause stops it", async () => {
    const page = await fresh({ width: 375, height: 740, touch: true, query: "?guide" });
    await page.waitForSelector("dialog.guide[data-frames]");
    await page.waitForTimeout(500);
    const text = await page.$eval(".guide-hint", (h) => h.innerText);
    assert.match(text, /Tap Play/);
    assert.doesNotMatch(text, /Space/, "a phone has no Space bar to press");
    const box = await page.$eval(".guide-hint", (h) => h.getBoundingClientRect().toJSON());
    assert.ok(box.left >= 0 && box.right <= 375, `the hint spills off the screen (${box.left}–${box.right})`);
    const y0 = await page.$eval(".guide-scroll", (s) => s.scrollTop);
    await page.tap(".guide-play");
    await page.waitForTimeout(1500);
    const y1 = await page.$eval(".guide-scroll", (s) => s.scrollTop);
    // About 0.15 × 740 = 111 px a second: well over 40 px in 1.5 s, and nowhere near a chapter (over 1,000 px).
    assert.ok(y1 - y0 > 40 && y1 - y0 < 400, `moved ${y1 - y0} px in 1.5 s`);
    await page.tap(".guide-play");
    await page.waitForTimeout(100);
    const y2 = await page.$eval(".guide-scroll", (s) => s.scrollTop);
    await page.waitForTimeout(500);
    assert.equal(await page.$eval(".guide-scroll", (s) => s.scrollTop), y2, "Pause did not stop it");
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
