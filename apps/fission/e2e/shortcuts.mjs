// Browser check of the one shortcut table (X7b): ? shows every key, the workspace on screen first; the list is modal (Escape
// closes it and nothing else); keys reach only a workspace on screen, never
// a sleeping one; typing in a field is never taken over; split view sends a
// workspace's keys to it in either pane.
// Run with `npm run e2e` (after `npm run build`).
import assert from "node:assert/strict";
import { launch } from "./browser.mjs";
import { preview } from "vite";

const server = await preview({ preview: { port: 4179, strictPort: true }, logLevel: "error" });
const url = "http://localhost:4179/";
const browser = await launch();
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
const selection = (page) => page.evaluate(() => document.body.dataset.selection ?? "");
const listOpen = (page) => page.evaluate(() => document.getElementById("shortcuts")?.open ?? false);
/** Each section's heading and its rows as "keys: label". */
const listed = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("#shortcuts section")].map((s) => ({
      title: s.querySelector("h3").textContent,
      rows: [...s.querySelectorAll("dl > div")].map((d) => `${d.querySelector("kbd").textContent}: ${d.querySelector("dd").textContent}`),
    })),
  );

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
  await check("? shows every key, Design's first; the list is modal: Escape closes it and clears nothing", async () => {
    const page = await fresh();
    try {
      await page.click("#browser [data-node=body-1]");
      assert.equal(await selection(page), "body:feature-1");
      await page.keyboard.press("?");
      assert.equal(await listOpen(page), true, "? opens the list");
      // Worked out from the table: Design is on screen, so it comes first, then the
      // app's keys; no placeholder binds a key and Image binds none yet.
      assert.deepEqual(await listed(page), [
        { title: "Design on screen", rows: ["Esc: Clear the selection", "Ctrl+C: Copy the selected profile as SVG", "L: Line tool (in a sketch)", "R: Rectangle tool (in a sketch)", "C: Circle tool (in a sketch)"] },
        { title: "Everywhere", rows: ["?: Show the keyboard shortcuts", "Ctrl+V: Paste files into the project (a project file, an image…)", "Ctrl+Z: Undo", "Ctrl+Shift+Z: Redo", "Ctrl+Y: Redo"] },
      ]);
      await page.screenshot({ path: "e2e/shortcuts.png" });
      await page.keyboard.press("Escape");
      assert.equal(await listOpen(page), false, "Escape closes the list");
      assert.equal(await selection(page), "body:feature-1", "that Escape was the list's alone");
      await page.keyboard.press("Escape");
      assert.equal(await selection(page), "", "the next Escape clears the selection");
      // Close closes it too.
      await page.keyboard.press("?");
      assert.equal(await listOpen(page), true);
      await page.click("#shortcuts .close");
      assert.equal(await listOpen(page), false);
    } finally {
      await page.close();
    }
  });

  await check("a sleeping workspace hears no key; typing ? in a field types it", async () => {
    const page = await fresh();
    try {
      await page.click("#browser [data-node=body-1]");
      await page.click('#workspaces [data-workspace="image"]');
      await page.waitForFunction(() => document.body.dataset.activeWorkspace === "image");
      await page.keyboard.press("Escape");
      assert.equal(await selection(page), "body:feature-1", "Design is asleep: Escape in Image leaves its selection alone");
      // The list from Image: Design is not on screen, so the app's keys come first.
      await page.keyboard.press("?");
      assert.deepEqual((await listed(page)).map((s) => s.title), ["Everywhere", "Design"]);
      await page.keyboard.press("Escape");
      await page.click('#workspaces [data-workspace="design"]');
      await page.waitForFunction(() => document.body.dataset.activeWorkspace === "design");
      await page.keyboard.press("Escape");
      assert.equal(await selection(page), "", "awake again: Escape clears");
      // In a text field ? is a character, not the list (Design's own fields take numbers, so add one).
      await page.evaluate(() => document.getElementById("properties").append(Object.assign(document.createElement("input"), { id: "probe", type: "text" })));
      await page.click("#probe");
      await page.keyboard.press("?");
      assert.equal(await listOpen(page), false, "? typed in a text field does not open the list");
      assert.equal(await page.inputValue("#probe"), "?");
    } finally {
      await page.close();
    }
  });

  await check("split view: Design's keys reach it in the second pane, with a placeholder in use beside it", async () => {
    const page = await fresh();
    try {
      // Render in the first pane, Design beside it in the second.
      await page.click('#workspaces [data-workspace="render"]');
      await page.waitForFunction(() => document.body.dataset.activeWorkspace === "render");
      await page.click("#split-toggle");
      await page.waitForFunction(() => document.body.dataset.split !== "");
      await page.selectOption("#split-choice", "design");
      await page.waitForFunction(() => document.body.dataset.split === "design");
      await page.click("#split-browser [data-node=body-1]");
      assert.equal(await selection(page), "body:feature-1");
      await page.click("#properties"); // the first pane (Render, no keys) is now the one in use
      await page.keyboard.press("Escape");
      assert.equal(await selection(page), "", "Design is on screen in the second pane, so Escape still reaches it");
      await page.keyboard.press("?");
      assert.deepEqual((await listed(page)).map((s) => s.title), ["Design on screen", "Everywhere"]);
    } finally {
      await page.close();
    }
  });

  assert.deepEqual(errors, [], "no page errors or console errors (a shortcut clash logs one)");
} catch (e) {
  failed = true;
  console.log(`FAIL ${e.message}`);
} finally {
  await browser.close();
  await new Promise((r) => server.httpServer.close(r));
}
if (failed) process.exit(1);
