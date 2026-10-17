// Browser check of copying out (X6b): a Design profile selected in the
// browser panel offers Copy as SVG from the action registry, and that and
// Ctrl+C both put the profile on the clipboard as SVG (image/svg+xml where
// the browser takes it, and the same text as text/plain), sized in mm. In a
// text field Ctrl+C copies the text as usual; a change to a shape with no
// profile takes the profile out of the selection with a note.
// Run with `npm run e2e` (after `npm run build`).
import assert from "node:assert/strict";
import { launch } from "./browser.mjs";
import { preview } from "vite";

const server = await preview({ preview: { port: 4177, strictPort: true }, logLevel: "error" });
const url = "http://localhost:4177/";
const browser = await launch();
const errors = [];

async function fresh(width = 1000) {
  const context = await browser.newContext({ viewport: { width, height: 640 }, permissions: ["clipboard-read", "clipboard-write"] });
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

/** The clipboard's items: each type and its text. */
const clipboard = (page) =>
  page.evaluate(async () => {
    const out = [];
    for (const item of await navigator.clipboard.read()) for (const type of item.types) out.push([type, await (await item.getType(type)).text()]);
    return out;
  });
const clearClipboard = (page) => page.evaluate(() => navigator.clipboard.writeText("nothing yet"));

// The L-bracket at the panel's 40 × 30 × 20: arms 0.3 of the width and
// depth thick (profiles.ts), so corners (0,0) (40,0) (40,9) (12,9) (12,30)
// (0,30); its area is 40·30 − 28·21 = 612 mm², the volume 612·20 = 12,240 mm³.
// In SVG, y flipped: (0,0) (40,−9)…; the box is 40 × 30 from (0, −30).
const bracketPath = "M0 0L40 0L40 -9L12 -9L12 -30L0 -30Z";
const bracketSvg = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="40mm" height="30mm" viewBox="0 -30 40 30">',
  "<title>L-bracket profile</title>",
  `<path d="${bracketPath}" fill="none" fill-rule="evenodd" stroke="#000" stroke-width="1" vector-effect="non-scaling-stroke"/>`,
  "</svg>",
  "",
].join("\n");

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

try {
  await check("a selected profile offers Copy as SVG, which puts its SVG on the clipboard in mm", async () => {
    const page = await fresh();
    try {
      await page.click("#toolbar [data-shape=l-bracket]");
      await page.waitForFunction(() => document.querySelector("#volume")?.textContent === "12,240 mm³");
      // The new project's box is feature-1 (counter 2); the profile a preset now needs takes the counter's 2 (24d1).
      const row = "#browser [data-node=profile-2]";
      assert.equal(await page.textContent(row), "L-bracket profile");
      assert.equal(await page.isVisible("#selection-actions"), false);
      await page.click(row);
      assert.equal(await page.getAttribute(row, "aria-current"), "true");
      const verbs = await page.$$eval("#selection-actions button", (bs) => bs.map((b) => [b.textContent, b.dataset.action]));
      assert.deepEqual(verbs, [["Copy as SVG", "design.copy-svg"]]);
      await clearClipboard(page);
      await page.click("#selection-actions [data-action='design.copy-svg']");
      await page.waitForFunction(() => document.querySelector("#action-note")?.textContent !== "");
      assert.equal(await page.textContent("#action-note"), "Copied as SVG: L-bracket profile, 40 × 30 mm.");
      const items = await clipboard(page);
      assert.deepEqual(items.map(([t]) => t).sort(), ["image/svg+xml", "text/plain"]);
      const of = (type) => items.find(([t]) => t === type)[1];
      assert.equal(of("text/plain"), bracketSvg);
      // The browser re-writes an image/svg+xml item to make it safe (it drops
      // the self-closing tag and the last newline), so compare what it draws.
      const attrs = (svg) => ["width", "height", "viewBox", "d", "fill-rule"].map((a) => new RegExp(`\\s${a}="([^"]*)"`).exec(svg)?.[1]);
      assert.deepEqual(attrs(of("image/svg+xml")), attrs(bracketSvg));
      assert.deepEqual(attrs(bracketSvg), ["40mm", "30mm", "0 -30 40 30", bracketPath, "evenodd"]);
      // The SVG draws in the browser at its size in mm: 40 mm is 40 × 96/25.4 ≈ 151.18 CSS px.
      const size = await page.evaluate(async (svg) => {
        const img = new Image();
        img.src = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
        await img.decode();
        return [img.naturalWidth, img.naturalHeight];
      }, bracketSvg);
      assert.deepEqual(size, [Math.round((40 * 96) / 25.4), Math.round((30 * 96) / 25.4)]);
      await page.screenshot({ path: "e2e/copy-svg.png" });
    } finally {
      await page.close();
    }
  });

  await check("Ctrl+C copies the selected profile; in a text field it copies the text", async () => {
    const page = await fresh();
    try {
      await page.click("#toolbar [data-shape=slot]");
      await page.click("#browser [data-node=profile-2]");
      await clearClipboard(page);
      await page.keyboard.press("Control+c");
      await page.waitForFunction(() => document.querySelector("#action-note")?.textContent.startsWith("Copied"));
      // The slot fits the panel's 40 × 30: half-circle ends of radius 15, centres at x = 15 and 25.
      assert.equal(await page.textContent("#action-note"), "Copied as SVG: Slot with round ends profile, 40 × 30 mm.");
      const [[, text]] = (await clipboard(page)).filter(([t]) => t === "text/plain");
      assert.match(text, /d="M15 0L25 0A15 15 0 0 0 40 -15A15 15 0 0 0 25 -30L15 -30A15 15 0 0 0 0 -15A15 15 0 0 0 15 0Z"/);
      // In the width field, Ctrl+C copies the selected digits, not the profile.
      await clearClipboard(page);
      await page.click("#width");
      await page.keyboard.press("Control+a");
      await page.keyboard.press("Control+c");
      assert.deepEqual(await page.evaluate(() => navigator.clipboard.readText()), "40");
      // With the body selected instead, Ctrl+C leaves the clipboard alone (no verb copies a body yet).
      await page.click("#browser [data-node=body-1]");
      await clearClipboard(page);
      const note = await page.textContent("#action-note");
      await page.keyboard.press("Control+c");
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "nothing yet");
      await page.waitForTimeout(100); // a verb run by mistake would answer in the note by now
      assert.equal(await page.textContent("#action-note"), note, "no verb ran");
    } finally {
      await page.close();
    }
  });

  await check("a change to a box takes the profile out of the selection, with a note", async () => {
    const page = await fresh();
    try {
      await page.click("#toolbar [data-shape=star]");
      await page.click("#browser [data-node=profile-2]");
      assert.deepEqual(await page.$$eval("#selection-actions button", (bs) => bs.map((b) => b.textContent)), ["Copy as SVG"]);
      await page.click("#toolbar [data-shape=box]");
      await page.waitForFunction(() => document.querySelector("#volume")?.textContent === "24,000 mm³");
      await page.waitForFunction(() => document.querySelector("#selection-note")?.textContent !== "");
      assert.equal(await page.textContent("#selection-note"), "Taken out of the selection: the profile. The part has no profile now.");
      assert.equal(await page.isVisible("#selection-actions"), false);
      assert.equal(await page.$("#browser [data-node=profile-2]"), null);
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
console.log("copy checks passed");
