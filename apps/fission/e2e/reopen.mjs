// Browser check of big files and the reopen guard (security audit S2): a
// dropped project over 64 MB is refused by its size with the exact message
// and Design stays as it was; a project the last visit started opening and
// never finished (its mark left in localStorage, as a frozen or crashed tab
// leaves it) is skipped once with a message, a new project shown, and the
// visit after opens it again; a project that opens fine clears its mark
// within a few seconds. 1280 px and 375 px; `E2E_SHOTS` saves screenshots.
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
        assert.equal(await status(page), "Couldn't open “big.fission.json”: it is 64.1 MB, and a Panoshape project may be at most 64 MB.");
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
        await page.waitForFunction(() => document.querySelector("#volume")?.textContent !== "24,000 mm³");
        const plateVolume = await volume(page);
        await page.waitForFunction(() => document.querySelector("#save-status")?.dataset.state === "saved");
        // A visit that opens it fine: the mark names it while it opens, and is gone a few seconds after.
        await page.reload();
        const id = await (await page.waitForFunction((key) => localStorage.getItem(key), OPENING_KEY)).jsonValue();
        await page.waitForFunction((v) => document.querySelector("#volume")?.textContent === v, plateVolume);
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

  await check("no page errors", async () => assert.deepEqual(errors, []));
} finally {
  await browser.close();
  await new Promise((r) => server.httpServer.close(r));
}
if (failed) process.exit(1);
console.log("reopen checks passed");
