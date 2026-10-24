// Browser check of the window's layout (sketch feel SF3d): the browser
// floats over the 3D view's top-left corner instead of taking a column, the
// view runs the full width (from U0b the properties float over its right side and fold away), the timeline is a thin
// row along the very bottom under the view's own buttons (each item in build
// order, the rollback marker between two, rolled-back items greyed, a
// suppressed one crossed out), the browser's rows float as compact blocks
// with the view showing between them and their words readable over a white
// or black view, the browser folds away, and the view bar's
// Full screen button goes in and out of full screen. Each layout check is
// also run on the page with the old layout forced back by a style, and must
// fail there. Split view keeps its browser columns; a workspace with no
// timeline (Image) gives the row back; at 375 px the column layout keeps the
// timeline under the view with nothing wider than the screen. Screenshots
// at 1280 and 375 px go to E2E_SHOTS when set. From U0a the rows are slim
// single lines like Fusion's (a long label ends in "…" with the whole of it
// in the tooltip), the Timeline and Origin groups start folded, a row's ⋯
// shows only under the mouse, and a five-item design needs no scroll bar.
// Run with `npm run e2e` (after `npm run build`).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { launch } from "./browser.mjs";
import { preview } from "vite";
import { startWithBox } from "./start.mjs";

const server = await preview({ preview: { port: 4198, strictPort: true }, logLevel: "error" });
const url = "http://localhost:4198/";
const browser = await launch();
const errors = [];
const shots = process.env.E2E_SHOTS;

async function fresh(width = 1280) {
  const context = await browser.newContext({ viewport: { width, height: 800 }, hasTouch: width < 700 });
  const page = await context.newPage();
  await page.addInitScript(() => indexedDB.deleteDatabase("fission"));
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto(url);
  await startWithBox(page); // a new project starts empty (U0c): the 40 × 30 × 20 box, inserted
  return page;
}

/** The boxes the checks read, in page pixels, and what is on top at a few points. */
const measure = (page) =>
  page.evaluate(() => {
    const box = (sel) => {
      const el = document.querySelector(sel);
      if (!el || getComputedStyle(el).display === "none") return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom };
    };
    const browser = box("#browser");
    const onTop = (x, y) => {
      const el = document.elementFromPoint(x, y);
      return el?.closest("#browser") ? "browser" : el?.tagName === "CANVAS" ? "canvas" : (el?.id || el?.className || el?.tagName);
    };
    return {
      window: { w: innerWidth, h: innerHeight },
      viewport: box("#viewport"),
      browser,
      properties: box("#properties"),
      timeline: box("#timeline"),
      bar: box("#view-controls"),
      // A browser row's middle, and a point 20 px right of the panel.
      atBrowser: browser && onTop(browser.x + 30, browser.y + 12),
      besideBrowser: browser && onTop(browser.right + 20, browser.y + 12),
    };
  });

/** The floating browser at 1280 px: worked from the layout rules (8 px in from the view's corner, the view the whole width left of the properties). */
function checkFloating(m) {
  assert.equal(m.viewport.x, 0, "the view starts at the window's left edge: the browser takes no column");
  // From U0b the properties float over the view too (or fold to one button), so the view is the window's whole width.
  assert.ok(Math.abs(m.viewport.w - m.window.w) <= 1, `the view fills the width: the properties take no column (${m.viewport.w} vs ${m.window.w})`);
  assert.ok(Math.abs(m.browser.x - (m.viewport.x + 8)) <= 1 && Math.abs(m.browser.y - (m.viewport.y + 8)) <= 1, `the browser sits 8 px into the view's corner (${m.browser.x}, ${m.browser.y})`);
  assert.ok(m.browser.right <= m.viewport.right && m.browser.bottom <= m.bar.y, "the browser stays over the view and clear of its buttons");
  assert.equal(m.atBrowser, "browser", "the browser is on top of the view");
  assert.equal(m.besideBrowser, "canvas", "the part shows right beside it");
}

/** WCAG's relative luminance of an sRGB colour [r, g, b], channels 0 to 255. */
function luminance(rgb) {
  const [r, g, b] = rgb.map((c) => (c / 255 <= 0.04045 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
/** WCAG's contrast ratio of two opaque colours, 1 to 21. */
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
/** A colour with alpha [r, g, b, a] laid over an opaque one, channel by channel, as the page composites it. */
const over = ([r, g, b, a], [R, G, B]) => [r * a + R * (1 - a), g * a + G * (1 - a), b * a + B * (1 - a)];
/** "rgb(1, 2, 3)" or "rgba(1, 2, 3, 0.5)" as [r, g, b, a]. */
const rgba = (css) => {
  const [r, g, b, a = 1] = css.match(/[\d.]+/g).map(Number);
  return [r, g, b, a];
};
/** WCAG AA for normal text: the least contrast a row's words may have over the view behind them. */
const READABLE = 4.5;
const WHITE = [255, 255, 255];
const BLACK = [0, 0, 0];

/** The floating browser's title, group and row blocks: their words, colours and boxes, and the panel's own backdrop. */
const browserBlocks = (page) =>
  page.evaluate(() => {
    const panel = document.querySelector("#browser");
    const blocks = [...panel.querySelectorAll(".browser-fold > summary, .tree summary, .tree-row, .delete-ask-more")].map((el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return { text: el.textContent, leaf: el.classList.contains("tree-row"), color: s.color, background: s.backgroundColor, events: s.pointerEvents, x: r.x, y: r.y, w: r.width, h: r.height, right: r.right };
    });
    const p = panel.getBoundingClientRect();
    return { panel: { background: getComputedStyle(panel).backgroundColor, x: p.x, y: p.y, w: p.width, right: p.right }, blocks };
  });

/** Every block's words readable over a white and over a black view (the part and the background can be either, in time). */
function checkReadable({ blocks }) {
  for (const b of blocks)
    for (const [name, view] of [["white", WHITE], ["black", BLACK]]) {
      const c = contrast(rgba(b.color).slice(0, 3), over(rgba(b.background), view));
      assert.ok(c >= READABLE, `"${b.text}" over a ${name} view: contrast ${c.toFixed(2)} is under ${READABLE}`);
    }
}

/** Floating rows: no panel backdrop, each block its own backdrop and clickable, rows sized to their words, the view clickable between them. */
async function checkFloatingRows(page, { panel, blocks }) {
  assert.equal(rgba(panel.background)[3], 0, `the panel has no backdrop of its own (${panel.background})`);
  for (const b of blocks) {
    assert.ok(rgba(b.background)[3] > 0, `"${b.text}" has a backdrop of its own`);
    assert.equal(b.events, "auto", `"${b.text}" takes clicks`);
  }
  const body = blocks.find((b) => b.text === "Body 1");
  assert.ok(body.w < panel.w / 2, `the Body 1 row is sized to its words (${body.w} of ${panel.w} px)`);
  // Past the row's ⋯ too (U0a: a Body row has its feature's menu), which takes clicks though it shows only under the mouse.
  const lineEnd = Math.max(...blocks.filter((b) => Math.abs(b.y - body.y) < 2).map((b) => b.right));
  const gap = { x: lineEnd + 20, y: body.y + body.h / 2 };
  assert.ok(gap.x < panel.right, "that spot is inside the panel's box");
  assert.equal(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName, gap), "CANVAS", "beside a short row, the view takes the click");
}

/** The timeline row: the very bottom of the window, full width, thin, under the view and its buttons. */
function checkTimelineRow(m) {
  assert.ok(m.timeline, "the timeline row is shown");
  assert.ok(Math.abs(m.timeline.bottom - m.window.h) <= 1, `the timeline is the window's last row (bottom ${m.timeline.bottom} of ${m.window.h})`);
  assert.ok(m.timeline.x === 0 && Math.abs(m.timeline.w - m.window.w) <= 1, "the timeline runs the full width");
  assert.ok(m.timeline.h <= 40, `the timeline is a thin row (${m.timeline.h} px)`);
  assert.ok(m.timeline.y >= m.viewport.bottom - 1 && m.timeline.y >= m.bar.bottom, "the timeline is under the view and its buttons");
}

/** What the bar shows: [item id, icon, rolled back, suppressed] in order, "|" for the marker. */
const barItems = (page) =>
  page.$$eval("#timeline .timeline-bar > li", (lis) =>
    lis.map((li) => (li.classList.contains("timeline-bar-marker") ? "|" : [li.dataset.item, li.dataset.icon, li.dataset.rolledBack === "true", li.dataset.suppressed === "true"])),
  );

/** A version 3 Design: Box 1, Sketch 1, then a cylinder that is suppressed, the marker after the box. Written by hand as docs/project-format.md describes. */
const rolledBack = {
  formatVersion: 2,
  name: "Rolled back",
  units: { length: "mm" },
  materials: [],
  links: [],
  workspaces: {
    design: {
      version: 3,
      nextId: 4,
      profiles: [],
      sketches: [{ id: "sketch-2", points: [], curves: [], constraints: [] }],
      timeline: {
        marker: "feature-1",
        features: [
          {
            id: "feature-1",
            intent: { type: "box", parameters: { width: 40, depth: 30, height: 20 }, summary: "Box: 40 × 30 × 20 mm" },
            provenance: { self: { workspace: "design", id: "feature-1", label: "Feature 1 (box)" }, from: [] },
            dependsOn: [],
            suppressed: false,
          },
          {
            id: "sketch-2",
            intent: { type: "sketch", parameters: { plane: "XY" }, summary: "Sketch 1 on the XY plane" },
            provenance: { self: { workspace: "design", id: "sketch-2", label: "Sketch 1" }, from: [] },
            dependsOn: [],
            suppressed: false,
          },
          {
            id: "feature-3",
            intent: { type: "cylinder", parameters: { diameter: 10, height: 5 }, summary: "Cylinder: ⌀10 × 5 mm" },
            provenance: { self: { workspace: "design", id: "feature-3", label: "Feature 3 (cylinder)" }, from: [] },
            dependsOn: [],
            suppressed: true,
          },
        ],
      },
    },
  },
};

/** A real design with long labels: the golden stepped boss (box, two face sketches, two extrudes). */
const steppedBoss = readFileSync(new URL("../../../tests/golden/stepped-boss.panosolid.json", import.meta.url));
/** The tallest a slim row may be: an 18 px line, 1 px padding and a 1 px border above and below (U0a). */
const SLIM_ROW = 22;

/** The browser's groups (open or not) and every shown row: its height, whether its words are cut, how they end, its tooltip. */
const slimRows = (page) =>
  page.evaluate(() => {
    const panel = document.querySelector("#browser");
    const groups = Object.fromEntries([...panel.querySelectorAll(".tree details[data-node]")].map((d) => [d.dataset.node, d.open]));
    const shown = (el) => el.getClientRects().length > 0;
    const rows = [...panel.querySelectorAll(".tree summary, .tree-row")].filter(shown).map((el) => {
      const r = el.getBoundingClientRect();
      return { text: el.textContent, node: el.dataset.node, h: r.height, right: r.right, cut: el.scrollWidth > el.clientWidth, ending: getComputedStyle(el).textOverflow, title: el.getAttribute("title") };
    });
    return { groups, rows, panelRight: panel.getBoundingClientRect().right, scrolls: panel.scrollHeight > panel.clientHeight };
  });

/** Slim rows: every shown row one line at most SLIM_ROW tall inside the panel; a cut label ends in "…" with its whole label as the tooltip. */
function checkSlim({ rows, panelRight }) {
  for (const r of rows) {
    assert.ok(r.h <= SLIM_ROW + 0.5, `"${r.text}" is one slim line (${r.h} px, at most ${SLIM_ROW})`);
    assert.ok(r.right <= panelRight + 0.5, `"${r.text}" stays inside the panel`);
    if (r.cut) {
      assert.equal(r.ending, "ellipsis", `"${r.text}" is cut with "…"`);
      assert.equal(r.title, r.text, `"${r.text}": the tooltip has the whole label`);
    }
  }
}

/** The ⋯ of a row: its opacity with the mouse away from its row and then on the row. */
async function moreShows(page, node) {
  await page.mouse.move(640, 400);
  const away = await page.$eval(`#browser [data-more="${node}"]`, (el) => getComputedStyle(el).opacity);
  await page.hover(`#browser .tree-row[data-node="${node}"]`);
  const on = await page.$eval(`#browser [data-more="${node}"]`, (el) => getComputedStyle(el).opacity);
  return { away, on };
}

/** The properties at 1280 px (U0b): folded or not, the button's words and box, the panel's box, the view's width, the view cube's box. */
const fold = (page) =>
  page.evaluate(() => {
    const box = (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom };
    };
    const panel = document.querySelector("#properties");
    const handle = document.querySelector("#properties-handle");
    const shown = (el) => el && getComputedStyle(el).display !== "none";
    return {
      folded: panel.hasAttribute("data-folded"),
      expanded: handle?.getAttribute("aria-expanded"),
      words: handle && shown(handle) ? handle.textContent + getComputedStyle(handle, "::after").content.replace(/^none$/, "") : null,
      handle: handle && shown(handle) ? box(handle) : null,
      panel: box(panel),
      // What a person sees of the panel: the selection's words, the size boxes.
      sizesShown: shown(document.querySelector("#width")) && document.querySelector("#width").getClientRects().length > 0,
      view: box(document.querySelector("#viewport")),
      cube: box(document.querySelector("#viewport .view-cube")),
    };
  });

/** Folded: one small button under the view cube's corner, nothing else of the panel, the view the whole width. */
function checkFolded(f, width) {
  assert.equal(f.folded, true, "the panel is folded");
  assert.equal(f.expanded, "false");
  assert.ok(f.handle && f.handle.w < 140 && f.handle.h < 30, `only a small button shows (${JSON.stringify(f.handle)})`);
  assert.equal(f.sizesShown, false, "the size boxes are folded away");
  assert.ok(Math.abs(f.view.w - width) <= 1, `the view has the whole width (${f.view.w})`);
  assert.ok(f.handle.y >= f.cube.bottom && Math.abs(f.handle.right - (f.view.right - 8)) <= 1, "the button sits under the view cube, 8 px in from the right");
}

/** Shown: 300 px over the view's right side, 112 px down (under the view cube), the view still the whole width. */
function checkShown(f, width) {
  assert.equal(f.folded, false, "the panel shows");
  assert.equal(f.expanded, "true");
  assert.equal(f.sizesShown, true, "the size boxes show");
  assert.ok(Math.abs(f.panel.w - 300) <= 1 && Math.abs(f.panel.right - (f.view.right - 8)) <= 1 && Math.abs(f.panel.y - (f.view.y + 112)) <= 1, `300 px wide, 8 px in, 112 px down (${JSON.stringify(f.panel)})`);
  assert.ok(Math.abs(f.view.w - width) <= 1, "opening it resized nothing: the view keeps the whole width");
}

/** A Design whose one extrude fails: its sketch has nothing drawn. Written by hand as docs/project-format.md describes. */
const failing = {
  formatVersion: 2,
  name: "Failing",
  units: { length: "mm" },
  materials: [],
  links: [],
  workspaces: {
    design: {
      version: 3,
      nextId: 4,
      profiles: [],
      sketches: [{ id: "sketch-2", points: [], curves: [], constraints: [] }],
      timeline: {
        features: [
          {
            id: "feature-1",
            intent: { type: "box", parameters: { width: 40, depth: 30, height: 20 }, summary: "Box: 40 × 30 × 20 mm" },
            provenance: { self: { workspace: "design", id: "feature-1", label: "Feature 1 (box)" }, from: [] },
            dependsOn: [],
            suppressed: false,
          },
          {
            id: "sketch-2",
            intent: { type: "sketch", parameters: { plane: "XY" }, summary: "Sketch 1 on the XY plane" },
            provenance: { self: { workspace: "design", id: "sketch-2", label: "Sketch 1" }, from: [] },
            dependsOn: [],
            suppressed: false,
          },
          {
            id: "feature-3",
            intent: { type: "extrude", parameters: { sketch: "sketch-2", distance: 5 }, summary: "Extrude Sketch 1 by 5 mm" },
            provenance: { self: { workspace: "design", id: "feature-3", label: "Extrude 1" }, from: [{ workspace: "design", id: "sketch-2", label: "Sketch 1" }] },
            dependsOn: ["sketch-2"],
            suppressed: false,
          },
        ],
      },
    },
  },
};

const check = async (name, fn) => {
  await fn();
  console.log(`ok - ${name}`);
};

try {
  const page = await fresh(1280);

  await check("the browser floats over the view and the timeline is the bottom row (1280 px)", async () => {
    const m = await measure(page);
    checkFloating(m);
    checkTimelineRow(m);
    // The change notes over the view move right of the browser: 8 px in, 240 px wide, 8 px gap, 8 px in from the view.
    assert.equal(await page.$eval("#viewport > .notes-strip", (el) => getComputedStyle(el).left), "264px");
    if (shots) await page.screenshot({ path: `${shots}/layout-1280.png` });
  });

  await check("each check fails on the old layout", async () => {
    // The browser back in a column of its own, as before SF3d.
    const column = await page.addStyleTag({ content: "#workspace #browser:not(#none) { grid-column: 1; margin: 0; }" });
    await assert.rejects(async () => checkFloating(await measure(page)), /the browser takes no column/);
    await column.evaluate((el) => el.remove());
    // The timeline over the view instead of under it.
    const above = await page.addStyleTag({ content: "#workspace #timeline:not(#none) { grid-row: 1; }" });
    await assert.rejects(async () => checkTimelineRow(await measure(page)), /the window's last row/);
    await above.evaluate((el) => el.remove());
    // The browser under the view instead of over it.
    const under = await page.addStyleTag({ content: "#workspace #browser:not(#none) { z-index: auto; } #workspace #viewport:not(#none) { z-index: 3; }" });
    await assert.rejects(async () => checkFloating(await measure(page)), /on top of the view/);
    await under.evaluate((el) => el.remove());
    checkFloating(await measure(page));
  });

  await check("the timeline shows the new project's one item with the marker after it", async () => {
    assert.deepEqual(await barItems(page), [["feature-1", "box", false, false], "|"]);
    assert.equal(await page.getAttribute("#timeline [data-item=feature-1]", "title"), "1. Box: 40 × 30 × 20 mm");
  });

  await check("the browser's rows are slim single lines, the Timeline and Origin folded (U0a)", async () => {
    const start = await slimRows(page);
    // Fusion's browser starts with the origin folded and has no timeline group (its timeline is the bar along the bottom).
    assert.deepEqual(start.groups, { timeline: false, sketches: true, profiles: true, bodies: true, origin: false });
    checkSlim(start);
    // The stepped boss at a laptop's height: its five items stay folded under Timeline, so nothing scrolls.
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.setInputFiles("#open-file", { name: "boss.panosolid.json", mimeType: "application/json", buffer: steppedBoss });
    await page.waitForFunction(() => document.querySelectorAll('#browser [data-node="bodies"] .tree-row').length === 3);
    const boss = await slimRows(page);
    assert.equal(boss.scrolls, false, "the browser needs no scroll bar");
    checkSlim(boss);
    await page.click('#browser details[data-node="timeline"] > summary');
    const open = await slimRows(page);
    checkSlim(open);
    // "2. Sketch 1 on a face of Feature 1 (box)" is about 250 px of 13 px words, wider than the 240 px panel less its ⋯: cut.
    const long = open.rows.find((r) => r.node === "sketch-2");
    assert.equal(long.text, "2. Sketch 1 on a face of Feature 1 (box)");
    assert.ok(long.cut, "the long label is cut");
    if (shots) await page.screenshot({ path: `${shots}/browser-slim-1280.png` });
  });

  await check("a row's ⋯ shows only under the mouse or the keyboard (U0a)", async () => {
    assert.deepEqual(await moreShows(page, "sketch-2"), { away: "0", on: "1" });
    await page.mouse.move(640, 400);
    await page.focus('#browser [data-more="sketch-2"]');
    assert.equal(await page.$eval('#browser [data-more="sketch-2"]', (el) => getComputedStyle(el).opacity), "1", "focused, it shows");
    await page.$eval('#browser [data-more="sketch-2"]', (el) => el.blur());
  });

  await check("the browser's scroll bar is thin and shows only under the pointer (U0a)", async () => {
    await page.mouse.move(640, 400);
    const away = await page.$eval("#browser", (el) => [getComputedStyle(el).scrollbarWidth, getComputedStyle(el).scrollbarColor]);
    assert.deepEqual(away, ["thin", "rgba(0, 0, 0, 0) rgba(0, 0, 0, 0)"], "away from the panel its scroll bar can't be seen");
    await page.hover('#browser .tree-row[data-node="body-1"]');
    const over = await page.$eval("#browser", (el) => getComputedStyle(el).scrollbarColor);
    assert.notEqual(over, "rgba(0, 0, 0, 0) rgba(0, 0, 0, 0)", "over the panel it shows");
  });

  await check("the slim-row checks fail on the old rows", async () => {
    // Rows wrapping onto two lines as before U0a: the long label takes two lines.
    const wrap = await page.addStyleTag({ content: "#workspace #browser .tree-row:not(#none) { white-space: normal !important; }" });
    await assert.rejects(async () => checkSlim(await slimRows(page)), /is one slim line/);
    await wrap.evaluate((el) => el.remove());
    // The old 4 px padding: 18 + 8 + 2 = 28 px rows.
    const tall = await page.addStyleTag({ content: "#workspace #browser .tree-row:not(#none) { padding: 4px 8px !important; }" });
    await assert.rejects(async () => checkSlim(await slimRows(page)), /is one slim line/);
    await tall.evaluate((el) => el.remove());
    // A cut label with no "…".
    const clip = await page.addStyleTag({ content: "#workspace #browser .tree-row:not(#none) { text-overflow: clip !important; }" });
    await assert.rejects(async () => checkSlim(await slimRows(page)), /is cut with "…"/);
    await clip.evaluate((el) => el.remove());
    // The ⋯ always shown, as before.
    const always = await page.addStyleTag({ content: "#workspace #browser .delete-ask-more:not(#none) { opacity: 1 !important; }" });
    assert.notDeepEqual(await moreShows(page, "sketch-2"), { away: "0", on: "1" });
    await always.evaluate((el) => el.remove());
    // Every group open, as before, on a shorter window: the no-scroll-bar check can fail (22 rows of 24 px are 528 px; the panel gets about 440).
    await page.setViewportSize({ width: 1280, height: 620 });
    await page.click('#browser details[data-node="origin"] > summary');
    assert.equal((await slimRows(page)).scrolls, true, "with every group open the rows overflow at 620 px");
    for (const g of ["origin", "timeline"]) await page.click(`#browser details[data-node="${g}"] > summary`);
    checkSlim(await slimRows(page));
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  await check("a rolled-back and a suppressed item, with the marker between", async () => {
    await page.setInputFiles("#open-file", { name: "rolled.fission.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(rolledBack)) });
    await page.waitForFunction(() => document.querySelector("#timeline [data-item=feature-3]"));
    // Worked from the file: the marker is on feature-1, so the sketch and the cylinder after it are rolled back; the cylinder is also suppressed.
    assert.deepEqual(await barItems(page), [["feature-1", "box", false, false], "|", ["sketch-2", "sketch", true, false], ["feature-3", "cylinder", true, true]]);
    const looks = await page.$$eval("#timeline .timeline-bar > li", (lis) =>
      lis.map((li) => ({ x: li.getBoundingClientRect().x, opacity: getComputedStyle(li).opacity, cross: getComputedStyle(li, "::after").content })),
    );
    assert.ok(looks[0].x < looks[1].x && looks[1].x < looks[2].x && looks[2].x < looks[3].x, "the items and the marker run left to right in that order");
    assert.deepEqual(looks.map((l) => l.opacity), ["1", "1", "0.4", "0.4"], "only the items after the marker are greyed");
    assert.equal(looks[3].cross, '""', "the suppressed item is crossed out");
    assert.equal(looks[2].cross, "none", "an item that isn't suppressed is not");
    assert.equal(await page.getAttribute("#timeline [data-item=feature-3]", "title"), "3. Cylinder: ⌀10 × 5 mm (suppressed) (after the marker)");
    checkTimelineRow(await measure(page));
  });

  await check("the properties fold away until something is selected, without resizing the view (U0b)", async () => {
    await page.keyboard.press("Escape");
    await page.mouse.move(640, 400);
    checkFolded(await fold(page), 1280);
    assert.equal((await fold(page)).words, "Properties ‹");
    await page.click('#browser .tree-row[data-node="body-1"]');
    await page.waitForFunction(() => !document.querySelector("#properties").hasAttribute("data-folded"));
    checkShown(await fold(page), 1280);
    assert.equal((await fold(page)).words, "Fold ›");
    if (shots) await page.screenshot({ path: `${shots}/properties-shown-1280.png` });
    // Escape clears the selection: folded again.
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.querySelector("#properties").hasAttribute("data-folded"));
    checkFolded(await fold(page), 1280);
    if (shots) await page.screenshot({ path: `${shots}/properties-folded-1280.png` });
  });

  await check("Fold folds a selection's panel until the selection changes (U0b)", async () => {
    await page.click('#browser .tree-row[data-node="body-1"]');
    await page.waitForFunction(() => !document.querySelector("#properties").hasAttribute("data-folded"));
    await page.click("#properties-handle");
    checkFolded(await fold(page), 1280);
    assert.equal(await page.getAttribute('#browser .tree-row[data-node="body-1"]', "aria-current"), "true", "the body is still selected");
    await page.keyboard.press("Escape");
    await page.click('#browser .tree-row[data-node="body-1"]');
    await page.waitForFunction(() => !document.querySelector("#properties").hasAttribute("data-folded"));
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.querySelector("#properties").hasAttribute("data-folded"));
  });

  await check("a tool's box opens the panel and folds it after (U0b)", async () => {
    await page.click("#create-sketch");
    await page.waitForFunction(() => !document.querySelector("#properties").hasAttribute("data-folded"));
    assert.equal(await page.isVisible("#sketch-panel"), true, "Create sketch's plane choice shows");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.querySelector("#properties").hasAttribute("data-folded"));
    checkFolded(await fold(page), 1280);
  });

  await check("the button pins the panel open, kept after a reload, until folded (U0b)", async () => {
    await page.click("#properties-handle");
    checkShown(await fold(page), 1280);
    await page.reload();
    await startWithBox(page); // each load starts a new, empty project (U0c)
    checkShown(await fold(page), 1280);
    await page.click("#properties-handle");
    checkFolded(await fold(page), 1280);
    // Stored first, so the reload's fresh storage doesn't get the box back from the unsaved-change journal.
    await page.waitForFunction(() => document.querySelector("#save-status")?.dataset.state === "saved");
    await page.reload();
    // Left empty: an insert would open the panel for the new body's sizes, pinned or not.
    await page.waitForSelector("#start-hint", { state: "visible" });
    checkFolded(await fold(page), 1280);
  });

  await check("a failed rebuild opens the folded panel with its words; folded, its button says there is a problem (U0b)", async () => {
    await page.setInputFiles("#open-file", { name: "failing.fission.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(failing)) });
    await page.waitForFunction(() => document.querySelector("#error")?.textContent !== "");
    const open = await fold(page);
    assert.equal(open.folded, false, "the error's words are shown");
    assert.equal(await page.isVisible("#error"), true);
    await page.click("#properties-handle");
    const f = await fold(page);
    assert.equal(f.folded, true);
    assert.equal(f.words, 'Properties ‹" ⚠"', "the folded button carries the warning mark");
    assert.equal(await page.$eval("#properties-handle", (el) => getComputedStyle(el).color), "rgb(245, 177, 76)", "in amber");
    // The design that builds again takes the mark away.
    await page.setInputFiles("#open-file", { name: "rolled.fission.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(rolledBack)) });
    await page.waitForFunction(() => document.querySelector("#error")?.textContent === "" && !document.querySelector("#properties").hasAttribute("data-problem"));
    assert.equal((await fold(page)).words, "Properties ‹");
  });

  await check("the fold checks fail on the old panel", async () => {
    // The panel back in a column of its own, always shown, as before U0b.
    const column = await page.addStyleTag({ content: "#workspace #properties.properties-fold:not(#none) { grid-column: 3; margin: 0; } #workspace #properties[data-folded]:not(#none) > * { display: block !important; }" });
    await assert.rejects(async () => checkFolded(await fold(page), 1280), /the size boxes are folded away|the view has the whole width/);
    await column.evaluate((el) => el.remove());
    // A panel that pushes the view aside when shown.
    await page.click('#browser .tree-row[data-node="body-1"]');
    await page.waitForFunction(() => !document.querySelector("#properties").hasAttribute("data-folded"));
    const pushing = await page.addStyleTag({ content: "#workspace #properties.properties-fold:not(#none) { grid-column: 3; margin: 0; }" });
    await assert.rejects(async () => checkShown(await fold(page), 1280), /8 px in|resized nothing/);
    await pushing.evaluate((el) => el.remove());
    checkShown(await fold(page), 1280);
    await page.keyboard.press("Escape");
  });

  await check("the browser folds away and stays folded through an edit", async () => {
    const open = await measure(page);
    await page.click("#browser .browser-fold > summary");
    const folded = await measure(page);
    assert.ok(folded.browser.h < 40, `folded, the browser is one title row (${folded.browser.h} px)`);
    // Where a row was before folding, the part shows now.
    const spot = { x: open.browser.x + 30, y: open.browser.y + 120 };
    assert.ok(open.browser.h > 140, "the open browser covered that spot");
    assert.equal(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName, spot), "CANVAS");
    await page.click("#properties-handle"); // the size boxes are in the folded panel (U0b): pinned open
    await page.fill("#width", "41");
    await page.press("#width", "Tab");
    await page.waitForFunction(() => document.querySelector("#volume")?.textContent === "24,600 mm³");
    assert.equal(await page.$eval("#browser .browser-fold", (d) => d.open), false, "a rebuild keeps it folded");
    await page.click("#browser .browser-fold > summary");
    assert.equal(await page.$eval("#browser .browser-fold", (d) => d.open), true);
  });

  await check("the contrast sum is right, worked by hand", async () => {
    // #7e7e7e on white: 126/255 = 0.4941, linear ((0.4941 + 0.055) / 1.055)^2.4 = 0.2086;
    // (1 + 0.05) / (0.2086 + 0.05) = 4.06, about 0.9 × 4.5, so it must fail the bar.
    assert.ok(Math.abs(contrast([126, 126, 126], WHITE) - 4.06) < 0.01);
    assert.ok(contrast([126, 126, 126], WHITE) < READABLE);
    // #707070: 112/255 = 0.4392, linear 0.1620; 1.05 / 0.2120 = 4.95, about 1.1 × 4.5, so it passes.
    assert.ok(Math.abs(contrast([112, 112, 112], WHITE) - 4.95) < 0.01);
    assert.ok(contrast([112, 112, 112], WHITE) >= READABLE);
    // Laying over: half-opaque black over white is mid grey 127.5 in every channel.
    assert.deepEqual(over([0, 0, 0, 0.5], WHITE), [127.5, 127.5, 127.5]);
  });

  await check("the browser's rows float as blocks over the view, readable over white or black", async () => {
    const found = await browserBlocks(page);
    await checkFloatingRows(page, found);
    checkReadable(found);
    // Worked by hand for the Body 1 row (words #e6e9ee on rgba(28, 31, 36, 0.84)) over a white view:
    // the backdrop is 0.84 × (28, 31, 36) + 0.16 × 255 = (64.32, 66.84, 71.04), luminance
    // 0.2126 × 0.0518 + 0.7152 × 0.0559 + 0.0722 × 0.0631 = 0.0556; the words' luminance is
    // 0.2126 × 0.7913 + 0.7152 × 0.8150 + 0.0722 × 0.8550 = 0.8129; (0.8129 + 0.05) / (0.0556 + 0.05) = 8.17.
    const body = found.blocks.find((b) => b.text === "Body 1");
    const c = contrast(rgba(body.color).slice(0, 3), over(rgba(body.background), WHITE));
    assert.ok(Math.abs(c - 8.17) < 0.02, `Body 1 over white: ${c.toFixed(3)}`);
    if (shots) await page.screenshot({ path: `${shots}/browser-rows-1280.png` });
  });

  await check("the row checks fail on a see-through backdrop and on the old solid panel", async () => {
    // Backdrops at 0.3: over white the words wash out.
    const faint = await page.addStyleTag({ content: "#workspace #browser .browser-fold:not(#none) { --browser-block: rgba(28, 31, 36, 0.3); }" });
    const washed = await browserBlocks(page);
    assert.throws(() => checkReadable(washed), /over a white view/);
    await faint.evaluate((el) => el.remove());
    // The panel's old solid backdrop, taking every click over its box.
    const solid = await page.addStyleTag({ content: "#workspace #browser:not(#none) { background: rgba(28, 31, 36, 0.92); pointer-events: auto; }" });
    await assert.rejects(async () => checkFloatingRows(page, await browserBlocks(page)), /the panel has no backdrop of its own/);
    await solid.evaluate((el) => el.remove());
    await checkFloatingRows(page, await browserBlocks(page));
  });

  await check("a long browser still scrolls with the wheel over its rows", async () => {
    await page.setViewportSize({ width: 1280, height: 400 });
    for (const g of ["timeline", "origin"]) await page.click(`#browser details[data-node="${g}"] > summary`); // folded at the start (U0a)
    assert.equal(await page.$eval("#browser", (el) => el.scrollHeight > el.clientHeight), true, "at 400 px tall the rows overflow the panel");
    await page.$eval("#browser", (el) => (el.scrollTop = 0));
    const first = await page.$eval("#browser [data-node=timeline] summary", (el) => el.getBoundingClientRect());
    await page.mouse.move(first.x + 10, first.y + first.height / 2);
    await page.mouse.wheel(0, 120);
    await page.waitForFunction(() => document.querySelector("#browser").scrollTop > 0);
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  await check("Full screen goes in and out of full screen", async () => {
    const full = "#view-controls [data-view=full-screen]";
    assert.equal(await page.getAttribute(full, "aria-pressed"), "false");
    assert.equal(await page.getAttribute(full, "aria-label"), "Full screen");
    await page.click(full);
    await page.waitForFunction(() => document.fullscreenElement === document.documentElement);
    assert.equal(await page.getAttribute(full, "aria-pressed"), "true");
    assert.equal(await page.getAttribute(full, "aria-label"), "Exit full screen");
    await page.click(full);
    await page.waitForFunction(() => document.fullscreenElement === null);
    assert.equal(await page.getAttribute(full, "aria-pressed"), "false");
    assert.equal(await page.getAttribute(full, "aria-label"), "Full screen");
  });

  await check("split view keeps the browser in its column and the timeline under its own pane", async () => {
    await page.click("#split-toggle");
    await page.waitForFunction(() => document.querySelector("#workspace").dataset.split === "on");
    const m = await measure(page);
    assert.equal(m.browser.x, 0, "the browser is back in its column");
    assert.ok(m.viewport.x >= m.browser.right - 1, "the view starts after it");
    assert.equal(rgba(await page.$eval("#browser", (el) => getComputedStyle(el).backgroundColor))[3], 1, "in its column the browser keeps its solid backdrop");
    assert.ok(m.timeline.x === 0 && Math.abs(m.timeline.right - m.viewport.right) <= 1, "the timeline spans Design's own pane");
    assert.ok(Math.abs(m.timeline.bottom - m.window.h) <= 1, "still the bottom row");
    assert.equal(await page.$eval("#viewport > .notes-strip", (el) => getComputedStyle(el).left), "8px", "with no browser over it, the notes keep the corner");
    await page.click("#split-close");
    await page.waitForFunction(() => document.querySelector("#workspace").dataset.split !== "on");
    checkFloating(await measure(page));
  });

  await check("a workspace with no timeline gives the row back to the view", async () => {
    await page.click("#workspaces [role=tab] >> text=Image");
    await page.waitForFunction(() => document.body.dataset.activeWorkspace === "image");
    const m = await measure(page);
    assert.equal(m.timeline, null, "no timeline row");
    assert.ok(Math.abs(m.viewport.bottom - m.window.h) <= 1, "the view reaches the bottom");
    await page.click("#workspaces [role=tab] >> text=Design");
    await page.waitForFunction(() => document.querySelector("#timeline .timeline-bar"));
    checkTimelineRow(await measure(page));
  });
  await page.context().close();

  const phone = await fresh(375);
  await check("at 375 px the timeline is under the view and nothing is wider than the screen", async () => {
    const m = await measure(phone);
    assert.equal(m.browser, null, "the browser waits behind its toggle");
    assert.ok(Math.abs(m.timeline.y - m.viewport.bottom) <= 1, `the timeline is right under the view (${m.timeline.y} vs ${m.viewport.bottom})`);
    assert.ok(m.timeline.x === 0 && Math.abs(m.timeline.w - 375) <= 1 && m.timeline.h <= 40, "full width and thin");
    assert.ok(m.bar.right <= m.viewport.right && m.bar.bottom <= m.viewport.bottom, "the view bar, Full screen and all, stays in the view");
    const undo = await phone.$eval("#undo-redo", (el) => el.getBoundingClientRect().left);
    assert.ok(m.bar.right <= undo, "and clear of Undo and Redo");
    assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth), 375, "nothing spills sideways");
    if (shots) await phone.screenshot({ path: `${shots}/layout-375.png`, fullPage: true });
    await phone.tap("#browser-toggle");
    const open = await measure(phone);
    assert.ok(open.browser.bottom <= open.viewport.y + 1, "opened, the browser sits above the view in the column, not over it");
    assert.equal(rgba(await phone.$eval("#browser", (el) => getComputedStyle(el).backgroundColor))[3], 1, "in the column the browser keeps its solid backdrop");
    await phone.tap("[data-view=full-screen]");
    await phone.waitForFunction(() => document.fullscreenElement === document.documentElement);
    await phone.evaluate(() => document.exitFullscreen());
  });
  await phone.context().close();

  assert.deepEqual(errors, [], "no page errors");
  console.log("layout: all checks passed");
} finally {
  await browser.close();
  await server.close();
}
