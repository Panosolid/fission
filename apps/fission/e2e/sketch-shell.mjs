// Browser check of the app shell with a sketch open (step 25c4): files
// dropped, pasted or opened while sketching (an image opens Image and
// Design comes back with the sketch as it was, its chain still going; a
// refused file changes nothing; a project replaces the design and leaves
// the sketch), split view beside a sketch (the sketch keeps drawing and its
// keys still reach it), and the shortcut list naming the sketch keys while
// one is open. At 1280 px with the mouse and 375 px with taps (Menu's Open
// for files, as a phone has no drag). Run with `npm run e2e` (after `npm
// run build`); CI's browsers job runs it in Firefox and WebKit too.
import assert from "node:assert/strict";
import { crc32, deflateSync } from "node:zlib";
import { launch } from "./browser.mjs";
import { clickPlane, TOP } from "./sketch-screen.mjs";
import { preview } from "vite";

/** A 20 × 10 RGBA PNG, all mid grey, with no size in mm (Image shows it at 96 DPI). */
function grey() {
  const be32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const chunk = (type, data) => {
    const body = Buffer.from([...Buffer.from(type, "ascii"), ...data]);
    return Buffer.from([...be32(data.length), ...body, ...be32(crc32(body))]);
  };
  const rows = [];
  for (let y = 0; y < 10; y++) {
    rows.push(0);
    for (let x = 0; x < 20; x++) rows.push(128, 128, 128, 255);
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", [...be32(20), ...be32(10), 8, 6, 0, 0, 0]), chunk("IDAT", [...deflateSync(Buffer.from(rows))]), chunk("IEND", [])]);
}
const png = grey();

const server = await preview({ preview: { port: 4201, strictPort: true }, logLevel: "error" });
const url = "http://localhost:4201/";
const browser = await launch();
const errors = [];

async function fresh(width = 1280, touch = false) {
  const context = await browser.newContext({ viewport: { width, height: 800 }, hasTouch: touch, acceptDownloads: true });
  const page = await context.newPage();
  await page.addInitScript(() => indexedDB.deleteDatabase("fission"));
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto(url + "#design");
  await page.waitForFunction(() => document.querySelector("#volume")?.textContent === "24,000 mm³");
  return page;
}

/** Fires a drag of `files` over the viewport and drops it there, as a desktop drag would. */
const drop = (page, files) =>
  page.evaluate(
    (files) => {
      const dt = new DataTransfer();
      for (const f of files) dt.items.add(new File([new Uint8Array(f.bytes)], f.name));
      const el = document.querySelector("#viewport");
      el.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
      const d = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt });
      el.dispatchEvent(d);
      return d.defaultPrevented ? "taken" : "drop not taken";
    },
    files.map((f) => ({ name: f.name, bytes: [...f.bytes] })),
  );
/** Pastes `files` with nothing focused, as Ctrl+V with files on the clipboard would. */
const paste = (page, files) =>
  page.evaluate(
    (files) => {
      const dt = new DataTransfer();
      for (const f of files) dt.items.add(new File([new Uint8Array(f.bytes)], f.name));
      document.activeElement?.blur();
      const e = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt });
      document.body.dispatchEvent(e);
      return e.defaultPrevented;
    },
    files.map((f) => ({ name: f.name, bytes: [...f.bytes] })),
  );

/** What the shell and the sketch show: the workspace on screen, whether a sketch is edited and its points, its status, the undo step, the timeline. */
const state = (page) =>
  page.evaluate(() => ({
    workspace: document.body.dataset.activeWorkspace,
    sketching: document.querySelector("#viewport").dataset.sketching ?? "",
    points: document.querySelector("#viewport").dataset.sketchPoints ?? "",
    status: document.querySelector("#sketch-status")?.textContent ?? "",
    undo: document.getElementById("undo").title,
    timeline: [...document.querySelectorAll("#timeline [data-item]")].map((i) => i.dataset.item).join(" "),
  }));
const until = (page, fn, arg, what) => page.waitForFunction(fn, arg, { timeout: 8000 }).catch(async () => assert.fail(`${what}: timed out (${JSON.stringify(await state(page))})`));
const points = (page, want) => until(page, (w) => document.querySelector("#viewport").dataset.sketchPoints === w, want, `points ${want}`);
const onScreen = (page, id) => until(page, (w) => document.body.dataset.activeWorkspace === w, id, `${id} on screen`);
const press = (page, sel, tap) => (tap ? page.tap(sel) : page.click(sel));

/** Sketch 1 on the ground plane with an open chain (0, 0) → (40, 0) → (40, 30), on the grid, seen from above. */
async function chain(page, tap = false) {
  await press(page, "#create-sketch", tap);
  await press(page, "#sketch-plane-XY", tap);
  await until(page, () => document.querySelector("#viewport").dataset.sketching === "true", null, "sketching");
  await page.check("#sketch-grid-snap");
  await page.evaluate(() => (document.getElementById("workspace").scrollTop = 0)); // ticking it scrolled the panel into view at phone width
  for (const p of [[0, 0], [40, 0], [40, 30]]) await clickPlane(page, p, TOP, tap);
  await points(page, "0,0 40,0 40,30");
  return state(page);
}

/** The saved default design widened to 50 (50 · 30 · 20 = 30,000 mm³), for dropping as a project, and the page put back to 40. */
async function savedProject(page) {
  await page.fill("#width", "50");
  await until(page, () => document.querySelector("#volume")?.textContent === "30,000 mm³", null, "50 wide");
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#save")]);
  const bytes = await download.path().then((p) => import("node:fs").then((fs) => fs.readFileSync(p)));
  await page.fill("#width", "40");
  await until(page, () => document.querySelector("#volume")?.textContent === "24,000 mm³", null, "back to 40");
  return bytes;
}

let failed = false;
async function check(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (e) {
    failed = true;
    console.log(`not ok - ${name}\n  ${e.message.split("\n").join("\n  ")}`);
  }
}

try {
  await check("files while sketching (1280 px): an image opens Image and Design comes back with the sketch as it was; a refused file changes nothing; a project replaces the design and leaves the sketch", async () => {
    const page = await fresh();
    try {
      const project = await savedProject(page);
      const before = await chain(page);
      assert.equal(before.timeline, "feature-1 sketch-2");
      assert.match(before.status, /^2 lines, not closed/);
      // A dropped PNG: Image opens it; the sketch waits in Design, unchanged, the undo step still the last line.
      assert.equal(await drop(page, [{ name: "grey.png", bytes: png }]), "taken");
      await onScreen(page, "image");
      await until(page, () => document.querySelector("#layer-list")?.textContent.includes("Layer 1"), null, "the image's layer");
      await page.click("[data-workspace=design]");
      await onScreen(page, "design");
      assert.deepEqual(await state(page), before, "Design comes back with the sketch as it was");
      // The chain is still going: the next click is its third line, (40, 30) → (0, 30).
      await clickPlane(page, [0, 30], TOP);
      await points(page, "0,0 40,0 40,30 0,30");
      const three = await state(page);
      assert.match(three.status, /^3 lines, not closed/);
      // A refused file (a drop and a paste): said in the top bar; the sketch, its chain and the undo step are as they were.
      for (const how of [drop, paste]) {
        await page.evaluate(() => (document.querySelector("#file-status").textContent = ""));
        await how(page, [{ name: "part.stl", bytes: Buffer.from("solid x\n") }]);
        await until(page, () => /^Couldn't open “part\.stl”: /.test(document.querySelector("#file-status").textContent), null, "refused");
        assert.deepEqual(await state(page), three, `${how.name}: nothing changed`);
      }
      await clickPlane(page, [0, 0], TOP); // closes the rectangle: the chain survived both
      await until(page, () => document.querySelector("#sketch-status")?.textContent === "4 lines, a closed outline.", null, "closed");
      // A pasted PNG opens Image too, and the closed sketch is still open on return.
      const closed = await state(page);
      assert.equal(await paste(page, [{ name: "pasted.png", bytes: png }]), true);
      await onScreen(page, "image");
      await page.click("[data-workspace=design]");
      await onScreen(page, "design");
      assert.deepEqual(await state(page), closed);
      // A dropped project replaces the design as Open does: the sketch is left (it is not in that project), the toolbar is Design's own again.
      assert.equal(await drop(page, [{ name: "wide.fission.json", bytes: project }]), "taken");
      await until(page, () => document.querySelector("#volume")?.textContent === "30,000 mm³", null, "the project's part");
      const opened = await state(page);
      assert.equal(opened.sketching, "false");
      assert.equal(opened.points, "");
      assert.equal(opened.timeline, "feature-1");
      assert.equal(await page.isVisible("#sketch-panel"), false);
      assert.equal(await page.isVisible("#create-sketch"), true, "the modelling toolbar is back");
      assert.equal(await page.inputValue("#width"), "50");
      await page.screenshot({ path: "e2e/sketch-shell-opened-1280.png" });
    } finally {
      await page.close();
    }
  });

  await check("files while sketching (375 px, taps): Menu's Open takes an image to Image and Design comes back with the sketch; a refused file changes nothing", async () => {
    const page = await fresh(375, true);
    try {
      const before = await chain(page, true);
      await page.tap("#menu-toggle");
      await page.setInputFiles("#open-file", { name: "grey.png", mimeType: "image/png", buffer: png });
      await onScreen(page, "image");
      await page.tap("[data-workspace=design]");
      await onScreen(page, "design");
      assert.deepEqual(await state(page), before);
      await page.setInputFiles("#open-file", { name: "part.stl", mimeType: "model/stl", buffer: Buffer.from("solid x\n") });
      await until(page, () => /^Couldn't open “part\.stl”: /.test(document.querySelector("#file-status").textContent), null, "refused");
      assert.deepEqual(await state(page), before);
      await page.evaluate(() => (document.getElementById("workspace").scrollTop = 0));
      await clickPlane(page, [0, 30], TOP, true);
      await points(page, "0,0 40,0 40,30 0,30");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 375, "no sideways scroll");
      await page.screenshot({ path: "e2e/sketch-shell-375.png" });
    } finally {
      await page.close();
    }
  });

  await check("split view beside a sketch: the sketch keeps its chain, R and L still reach it, Undo takes back its line; closing the split keeps it", async () => {
    const page = await fresh();
    try {
      const before = await chain(page);
      await page.click("#split-toggle");
      await page.waitForSelector("#split-choice");
      await page.selectOption("#split-choice", "image");
      await page.waitForSelector("#split-toolbar #image-open");
      assert.deepEqual(await state(page), before, "opening the split changes nothing in the sketch");
      // The sketch's keys go to Design, the pane in use: R picks the rectangle tool, L the line tool again.
      const pressed = () => page.$$eval("#toolbar [aria-pressed=true]", (bs) => bs.map((b) => b.id).join(" "));
      await page.keyboard.press("r");
      await until(page, () => document.querySelector("#sketch-tool-rectangle")?.getAttribute("aria-pressed") === "true", null, "R in split view");
      await page.keyboard.press("l");
      await until(page, () => document.querySelector("#sketch-tool-line")?.getAttribute("aria-pressed") === "true", null, `L in split view (${await pressed()})`);
      // Choosing the line tool again started a new chain; Undo takes back the last line drawn, (40, 0) → (40, 30).
      await page.keyboard.press("ControlOrMeta+z");
      await points(page, "0,0 40,0");
      assert.equal((await state(page)).sketching, "true", "still in the sketch after Undo");
      await page.click("#split-close");
      await until(page, () => !document.body.dataset.split, null, "split closed");
      const after = await state(page);
      assert.equal(after.sketching, "true");
      assert.equal(after.points, "0,0 40,0");
    } finally {
      await page.close();
    }
  });

  await check("the shortcut list while sketching names the sketch's keys under Design, in split view beside Image too; Escape closes only the list", async () => {
    const page = await fresh();
    try {
      await chain(page);
      const designKeys = async () => {
        await page.keyboard.press("?");
        await until(page, () => document.getElementById("shortcuts")?.open === true, null, "the list open");
        const groups = await page.evaluate(() => [...document.querySelectorAll("#shortcuts section, #shortcuts .shortcut-group")].map((g) => [g.querySelector("h3")?.textContent ?? "", [...g.querySelectorAll("kbd")].map((k) => k.textContent).join(" ")]));
        const design = groups.find(([title]) => /^Design/.test(title));
        assert.ok(design, JSON.stringify(groups));
        for (const key of ["L", "R", "C", "A", "T", "Esc"]) assert.ok(design[1].split(" ").includes(key), `${key} in ${design[1]}`);
        // Escape closes the list and only the list: the sketch is still open with its chain.
        await page.keyboard.press("Escape");
        await until(page, () => document.getElementById("shortcuts")?.open === false, null, "the list closed");
      };
      await designKeys();
      assert.equal((await state(page)).sketching, "true");
      // Not even the chain ended: the next click is its third line.
      await clickPlane(page, [0, 30], TOP);
      await points(page, "0,0 40,0 40,30 0,30");
      // Beside Image in split view, the list still has Design's sketch keys (the pane in use first).
      await page.click("#split-toggle");
      await page.waitForSelector("#split-choice");
      await page.selectOption("#split-choice", "image");
      await page.waitForSelector("#split-toolbar #image-open");
      await designKeys();
      assert.equal((await state(page)).points, "0,0 40,0 40,30 0,30");
    } finally {
      await page.close();
    }
  });

  await check("no page errors", async () => assert.deepEqual(errors, []));
} finally {
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
