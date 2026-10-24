// Browser check of big files and the reopen guard (security audit S2): a
// dropped project over 64 MB is refused by its size with the exact message
// and Design stays as it was; a project the last visit started opening and
// never finished (its mark left in localStorage, as a frozen or crashed tab
// leaves it) is skipped once with a message, a new project shown, and the
// visit after opens it again; a project that opens fine clears its mark
// within a few seconds. A project slow to open (the kernel's answers held on
// purpose) offers Start fresh instead after 1.5 s: the last project stays
// kept for the next visit, an opened file is never stored, and nothing of
// the slow one is left in the kernel. 1280 px and 375 px; `E2E_SHOTS` saves
// screenshots.
// Run with `npm run e2e` (after `npm run build`).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { launch } from "./browser.mjs";
import { preview } from "vite";

const server = await preview({ preview: { port: 4219, strictPort: true }, logLevel: "error" });
const url = "http://localhost:4219/";
const browser = await launch();
const shots = process.env.E2E_SHOTS;
const errors = [];
const OPENING_KEY = "panoshape.opening"; // packages/storage/src/reopen.ts
const MAX_PROJECT_BYTES = 64 * 1024 * 1024; // packages/core/src/model/project.ts
const plate = readFileSync(resolve(import.meta.dirname, "../../../workspaces/design/test/files/v2-plate.fission.json"), "latin1");

let failed = false;
async function check(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    failed = true;
    console.log(`FAIL ${name}\n  ${e.stack ?? e}`);
  }
}

/** A page with a context of its own (its own IndexedDB and localStorage), the app open on the fresh box. */
async function fresh(width) {
  const context = await browser.newContext({ viewport: { width, height: 800 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector("#volume")?.textContent === "24,000 mm³");
  return { context, page };
}

/**
 * Run in the page before the app: wraps the kernel worker so its answers can
 * be held (window.holdKernel) and let through in order (window.releaseKernel),
 * making a project slow to build on purpose. With "hold-kernel" in
 * sessionStorage they are held from the start (a reload of a slow project).
 */
function kernelValve() {
  let holding = sessionStorage.getItem("hold-kernel") !== null;
  sessionStorage.removeItem("hold-kernel");
  const held = [];
  window.holdKernel = () => void (holding = true);
  window.releaseKernel = () => {
    holding = false;
    for (const go of held.splice(0)) go();
  };
  window.Worker = class extends Worker {
    set onmessage(fn) {
      super.onmessage = (e) => (holding ? held.push(() => fn.call(this, e)) : fn.call(this, e));
    }
    get onmessage() {
      return super.onmessage;
    }
  };
}

/** As `fresh`, with the kernel's valve in the page and the test hooks on. */
async function freshValved(width) {
  const context = await browser.newContext({ viewport: { width, height: 800 } });
  await context.addInitScript(kernelValve);
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto(url + "?test-hooks#design");
  await page.waitForFunction(() => document.querySelector("#volume")?.textContent === "24,000 mm³");
  return { context, page };
}

/** The ids of the projects kept in this browser. */
const keptProjects = (page) =>
  page.evaluate(async () => {
    const db = await new Promise((ok, no) => Object.assign(indexedDB.open("fission"), { onsuccess: (e) => ok(e.target.result), onerror: no }));
    const store = db.transaction(db.objectStoreNames[0]).objectStore(db.objectStoreNames[0]);
    const keys = await new Promise((ok) => (store.getAllKeys().onsuccess = (e) => ok(e.target.result)));
    db.close();
    return keys.map(String).filter((k) => k.startsWith("project/")).sort();
  });

const dropText = (page, name, text) =>
  page.evaluate(
    ([name, text]) => {
      const dt = new DataTransfer();
      dt.items.add(new File([text], name));
      document.querySelector("#viewport").dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
    },
    [name, text],
  );

/** The top bar's notice fits the window, with no sideways scroll. */
async function noticeFits(page, width) {
  const notice = await page.$eval("#file-notice", (el) => ({ ...el.getBoundingClientRect().toJSON(), cut: el.scrollWidth > el.clientWidth }));
  assert.ok(notice.width > 0 && notice.left >= 0 && notice.right <= width && !notice.cut, JSON.stringify(notice));
  const button = await page.$eval("#opening-fresh", (el) => el.getBoundingClientRect().toJSON());
  assert.ok(button.width > 0 && button.left >= 0 && button.right <= width, JSON.stringify(button));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width, "no sideways scroll");
}

const volume = (page) => page.textContent("#volume");
const status = (page) => page.textContent("#file-status");
const mark = (page) => page.evaluate((key) => localStorage.getItem(key), OPENING_KEY);

/** Drops one file, made in the page: `text` then zero bytes up to `size` (so a big file never crosses the wire). */
const dropMade = (page, name, text, size) =>
  page.evaluate(
    ([name, text, size]) => {
      const head = new TextEncoder().encode(text);
      const file = new File([head, new Uint8Array(Math.max(0, size - head.length))], name);
      const dt = new DataTransfer();
      dt.items.add(file);
      const over = new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt });
      document.querySelector("#viewport").dispatchEvent(over);
      const drop = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt });
      document.querySelector("#viewport").dispatchEvent(drop);
      return [file.size, drop.defaultPrevented];
    },
    [name, text, size],
  );

try {
  for (const width of [1280, 375]) {
    await check(`${width} px: a project over 64 MB is refused by its size, and Design stays as it was`, async () => {
      const { context, page } = await fresh(width);
      try {
        const empty = JSON.stringify({ formatVersion: 2, name: "Big", units: { length: "mm" }, materials: [], links: [], workspaces: {} });
        // 64 MB + 1 byte: 67,108,865 bytes, 64.000001 MB, shown rounded up to a tenth.
        assert.deepEqual(await dropMade(page, "big.fission.json", empty, MAX_PROJECT_BYTES + 1), [MAX_PROJECT_BYTES + 1, true]);
        await page.waitForFunction(() => document.querySelector("#file-status").textContent !== "");
        assert.equal(await status(page), "Couldn't open “big.fission.json”: it is 64.1 MB, and a SpindleLabs project may be at most 64 MB.");
        assert.equal(await page.isVisible("#file-status"), true);
        assert.equal(await volume(page), "24,000 mm³");
        if (shots) await page.screenshot({ path: `${shots}/too-big-${width}.png` });
      } finally {
        await context.close();
      }
    });

    await check(`${width} px: a project left half-opened is skipped once with a message, then opens again`, async () => {
      const { context, page } = await fresh(width);
      try {
        // Open the plate, so it is the newest kept project, and note what it shows.
        await page.evaluate(([text]) => {
          const dt = new DataTransfer();
          dt.items.add(new File([text], "plate.fission.json"));
          document.querySelector("#viewport").dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
        }, [plate]);
        // The plate's own volume: not the box's, and not "—", shown while the plate's rebuild is still with the kernel.
        await page.waitForFunction(() => !["24,000 mm³", "—"].includes(document.querySelector("#volume")?.textContent ?? "—"));
        const plateVolume = await volume(page);
        await page.waitForFunction(() => document.querySelector("#save-status")?.dataset.state === "saved");
        // A visit that opens it fine: the mark names it while it opens, and is gone a few seconds after.
        // Every write of the mark is recorded as it happens: the mark lives only from the start of opening
        // to 3 s after it shows (SETTLED_MS), which a slow reload can outlast before a poll would begin.
        const id = await page.evaluate(() => document.body.dataset.projectId);
        await context.addInitScript((key) => {
          const setItem = Storage.prototype.setItem;
          Storage.prototype.setItem = function (k, v) {
            if (this === localStorage && k === key) window.openingMarks = [...(window.openingMarks ?? []), v];
            return setItem.call(this, k, v);
          };
        }, OPENING_KEY);
        await page.reload();
        await page.waitForFunction((v) => document.querySelector("#volume")?.textContent === v, plateVolume);
        assert.deepEqual(await page.evaluate(() => window.openingMarks), [id], "the mark named the plate while it opened");
        await page.waitForFunction((key) => localStorage.getItem(key) === null, OPENING_KEY, { timeout: 10_000 });
        assert.equal(await status(page), "");
        // The next visit froze while opening it: its mark is still there when this one starts.
        await page.evaluate(([key, id]) => sessionStorage.setItem("froze", JSON.stringify([key, id])), [OPENING_KEY, id]);
        await context.addInitScript(() => {
          const froze = sessionStorage.getItem("froze");
          if (froze) {
            sessionStorage.removeItem("froze");
            localStorage.setItem(...JSON.parse(froze));
          }
        });
        await page.reload();
        await page.waitForFunction(() => document.querySelector("#file-status").textContent !== "");
        assert.equal(
          await status(page),
          "The last project didn't finish opening on your last visit, so a new one was started. The old one is still kept in this browser: reload the page now, before changing anything, to try it again.",
        );
        // The new project's box, once its first build is back from the kernel (the panel shows "—" until then).
        await page.waitForFunction(() => document.querySelector("#volume")?.textContent !== "—");
        assert.equal(await volume(page), "24,000 mm³");
        assert.equal(await mark(page), null, "the mark is cleared, so the next visit tries again");
        if (shots) await page.screenshot({ path: `${shots}/skipped-${width}.png` });
        // The visit after opens it again.
        await page.reload();
        await page.waitForFunction((v) => document.querySelector("#volume")?.textContent === v, plateVolume);
        assert.equal(await status(page), "");
      } finally {
        await context.close();
      }
    });
  }

  for (const width of [1280, 375]) {
    await check(`${width} px: a last project slow to open offers Start fresh instead, which keeps it for the next visit`, async () => {
      const { context, page } = await freshValved(width);
      try {
        await dropText(page, "plate.fission.json", plate);
        // The plate's own volume: not the box's, and not "—", shown while the plate's rebuild is still with the kernel.
        await page.waitForFunction(() => !["24,000 mm³", "—"].includes(document.querySelector("#volume")?.textContent ?? "—"));
        const plateVolume = await volume(page);
        await page.waitForFunction(() => document.querySelector("#save-status")?.dataset.state === "saved");
        const plateId = await page.evaluate(() => document.body.dataset.projectId);
        const kept = await keptProjects(page);
        assert.ok(kept.includes(`project/${plateId}`), JSON.stringify(kept));
        // A normal reopen says nothing and offers nothing.
        await page.reload();
        await page.waitForFunction((v) => document.querySelector("#volume")?.textContent === v, plateVolume);
        await page.waitForTimeout(2000); // past the 1.5 s the offer waits for
        assert.equal(await status(page), "");
        assert.equal(await page.isVisible("#opening-fresh"), false);
        // Reopened with the kernel's answers held: still building after 1.5 s, so the offer shows.
        await page.evaluate(() => sessionStorage.setItem("hold-kernel", "1"));
        await page.reload();
        await page.waitForFunction(() => document.querySelector("#file-status").textContent !== "", null, { timeout: 10_000 });
        assert.equal(await status(page), "Opening the last project…");
        assert.equal(await page.isVisible("#opening-fresh"), true);
        assert.equal(await page.textContent("#opening-fresh"), "Start fresh instead");
        assert.equal(await mark(page), plateId, "not counted as reopened while it builds");
        await noticeFits(page, width);
        if (shots) await page.screenshot({ path: `${shots}/opening-${width}.png` });
        await page.click("#opening-fresh");
        await page.evaluate(() => window.releaseKernel());
        // The new project, built once the plate's held answers are through; the plate's late bodies are freed.
        await page.waitForFunction(() => document.querySelector("#volume")?.textContent === "24,000 mm³");
        assert.equal(await status(page), "Started a new project instead. The last one is still kept in this browser: reload the page, before changing anything, to try it again.");
        assert.equal(await page.isVisible("#opening-fresh"), false);
        assert.equal(await mark(page), null, "the plate didn't freeze the tab: the next visit opens it");
        await page.waitForFunction(async () => (await window.fissionTest.bodyCount()) === 1, null, { timeout: 10_000 });
        await page.waitForTimeout(1000);
        assert.equal(await volume(page), "24,000 mm³", "the plate never replaced it");
        assert.equal(await page.evaluate(() => window.fissionTest.bodyCount()), 1, "only the new box: none of the plate's bodies left in the kernel");
        assert.deepEqual(await keptProjects(page), kept, "nothing stored until the new project changes");
        if (shots) await page.screenshot({ path: `${shots}/started-instead-${width}.png` });
        // The next visit opens the plate, as the message says, even after a pause.
        await page.reload();
        await page.waitForFunction((v) => document.querySelector("#volume")?.textContent === v, plateVolume);
        assert.equal(await status(page), "");
        // Started instead again, then changed: now it is kept, and the visit after opens it.
        await page.evaluate(() => sessionStorage.setItem("hold-kernel", "1"));
        await page.reload();
        await page.waitForSelector("#opening-fresh", { state: "visible", timeout: 10_000 });
        await page.click("#opening-fresh");
        await page.evaluate(() => window.releaseKernel());
        await page.waitForFunction(() => document.querySelector("#volume")?.textContent === "24,000 mm³");
        await page.fill("#width", "50");
        // V = 50·30·20 = 30000.
        await page.waitForFunction(() => document.querySelector("#volume")?.textContent === "30,000 mm³");
        await page.waitForFunction(() => document.querySelector("#save-status")?.dataset.state === "saved");
        assert.equal((await keptProjects(page)).length, kept.length + 1);
        await page.reload();
        await page.waitForFunction(() => document.querySelector("#volume")?.textContent === "30,000 mm³");
        // That box's body is asked of the kernel at once (no outline first), so with its answer held,
        // Start fresh closes Design while the box is still being built: it must be freed when it lands.
        await page.evaluate(() => sessionStorage.setItem("hold-kernel", "1"));
        await page.reload();
        await page.waitForSelector("#opening-fresh", { state: "visible", timeout: 10_000 });
        await page.click("#opening-fresh");
        await page.evaluate(() => window.releaseKernel());
        await page.waitForFunction(() => document.querySelector("#volume")?.textContent === "24,000 mm³");
        await page.waitForTimeout(1000);
        assert.equal(await page.evaluate(() => window.fissionTest.bodyCount()), 1, "the 50 mm box built late was freed, not left in the kernel");
      } finally {
        await context.close();
      }
    });

    await check(`${width} px: an opened file is kept only once it has shown, and Start fresh instead leaves it unkept`, async () => {
      const { context, page } = await freshValved(width);
      try {
        await page.waitForFunction(() => document.querySelector("#save-status")?.dataset.state === "saved");
        const first = await keptProjects(page);
        assert.equal(first.length, 1, "the new browser's box");
        // Opened with the kernel's answers held: offered after 1.5 s, and not stored meanwhile.
        await page.evaluate(() => window.holdKernel());
        await dropText(page, "plate.fission.json", plate);
        await page.waitForSelector("#opening-fresh", { state: "visible", timeout: 10_000 });
        assert.equal(await status(page), "Opening the project…");
        await noticeFits(page, width);
        assert.deepEqual(await keptProjects(page), first, "not stored before it has shown");
        await page.click("#opening-fresh");
        await page.evaluate(() => window.releaseKernel());
        await page.waitForFunction(() => document.querySelector("#volume")?.textContent === "24,000 mm³");
        assert.equal(await status(page), "Started a new project instead. The file was not opened: open it again to try again.");
        await page.waitForTimeout(1500);
        assert.deepEqual(await keptProjects(page), first, "the file was never stored");
        // Opened again at full speed: shown, then stored as a new project.
        const boxId = await page.evaluate(() => document.body.dataset.projectId);
        await dropText(page, "plate.fission.json", plate);
        // The plate's own volume: not the box's, and not "—", shown while the plate's rebuild is still with the kernel.
        await page.waitForFunction(() => !["24,000 mm³", "—"].includes(document.querySelector("#volume")?.textContent ?? "—"));
        await page.waitForFunction((old) => document.body.dataset.projectId !== old, boxId);
        await page.waitForFunction(() => document.querySelector("#save-status")?.dataset.state === "saved");
        assert.equal((await keptProjects(page)).length, 2);
        assert.equal(await status(page), "");
      } finally {
        await context.close();
      }
    });
  }

  await check("no page errors", async () => assert.deepEqual(errors, []));
} finally {
  await browser.close();
  await new Promise((r) => server.httpServer.close(r));
}
if (failed) process.exit(1);
console.log("reopen checks passed");
