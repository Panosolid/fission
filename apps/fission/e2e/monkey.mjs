// The monkey tester: a seeded chaotic user driving the real Design app in
// the browser (the bug hunt's new angle, after the kernel fuzzers). Each
// step it picks what a careless user might do from whatever the page offers
// right then: a button, a menu row or a fold; junk typed into a size or
// angle box (negatives, 1e308, NaN, empty…); clicks, drags and the wheel on
// the view; keys (the sketch tools, Escape, Ctrl+Z…); a right-click on a
// browser row; a phone-sized window; the last saved file opened again,
// sometimes edited first (an item suppressed, the rollback marker moved,
// two items swapped, one dropped, a size broken, the file cut short);
// a reload. Then it checks, after every step:
//   - no uncaught error and nothing written to the console as an error;
//   - Save gives a file, and its Design data keeps its rules (ids unique and
//     never reused, the marker on an item, nothing built from a later item),
//     and every id new since the last step comes from the counter, unless
//     the document is one seen before (Undo and Redo bring old ids back);
//   - an Edit feature OK changed that item's sizes and nothing else;
//   - the timeline bar and the Bodies group show what that file says, by a
//     model written apart from Design's own (`expectedView`, monkey-core.mjs);
//   - the kernel holds no more bodies than the Bodies group lists (a leak);
//   - the page never scrolls sideways.
// And, as steps of their own: Undo then Redo gives the same file and the
// same Undo label; Save, Open that file gives the same file back; a reload
// brings the same file back from the browser's store; selecting each body
// in turn selects that body, names its feature, shows its volume (worked
// from the file) and lights only its own block of faces; Escape closes every
// dialog and a sketch can always be finished, leaving Create sketch ready.
//
// Every run is seeded. A failure prints the seed and the actions; the
// shrinker (delta debugging) replays shorter lists in fresh pages until it
// has a short list that still fails the same way, written to
// e2e/monkey-results/. Kept in e2e/regressions/monkey-*.json, a list
// replays on every run and must pass.
//
// Environment: FISSION_SEED (one seed) or MONKEY_SEEDS ("1-40" or "3,7"),
// default 1-3; MONKEY_STEPS, default 60; MONKEY_REPLAY=<file> replays one
// action list; MONKEY_SHRINK=0 skips shrinking; MONKEY_KNOWN=0 fails on the
// known bugs too (KNOWN_BUGS); MONKEY_FOCUS=edit picks item menus and
// double-clicks four times as often (hunts on editing early items, 25a5);
// MONKEY_PORT (default 4210);
// MONKEY_OUT serves another build folder than dist (the plants build there).
// Run after `npm run build`: node e2e/monkey.mjs
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { preview } from "vite";
import { launch } from "./browser.mjs";
import { documentRules, editFile, editLeaks, expectedView, kernelVerdict, modelVolume, nextAction, reusedIds, rng, shrink, signature } from "./monkey-core.mjs";

const PORT = Number(process.env.MONKEY_PORT || 4210);
const STEPS = Number(process.env.MONKEY_STEPS || 60);
const url = `http://localhost:${PORT}/?test-hooks#design`;
const here = (p) => new URL(p, import.meta.url);

/** "1-3,7" as [1, 2, 3, 7]. */
const seedList = (text) => text.split(",").flatMap((part) => {
  const [a, b] = part.split("-").map(Number);
  return b === undefined ? [a] : Array.from({ length: b - a + 1 }, (_, i) => a + i);
});

/**
 * App bugs already reported and being fixed, by name: the check that finds
 * one still runs, and a run where it shows says so at the end instead of
 * failing, so the hunt carries on past it; once the bug no longer shows,
 * the run fails until the mark is removed (as sketch-tool.mjs's `known`).
 * MONKEY_KNOWN=0 turns every mark off, to see the bug fail.
 */
const KNOWN_BUGS = process.env.MONKEY_KNOWN === "0" ? {} : { /* none open */ };
/** Known bugs that show as an uncaught error, by the error's words. */
const KNOWN_ERRORS = {};

class Failure extends Error {
  constructor(check, message) {
    super(`${check}: ${message}`);
    this.check = check;
    this.detail = message;
  }
}
const fail = (check, message) => {
  throw new Failure(check, message);
};

/** A fresh page on the app, its errors collected. */
async function open(browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(`uncaught: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && errors.push(`console error: ${m.text()}`));
  page.on("dialog", (d) => d.dismiss().catch(() => {}));
  await page.goto(url);
  // A new project starts empty (U0c): ready once the kernel has said its version and the start hint shows.
  await page.waitForFunction(() => /kernel v/.test(document.getElementById("version")?.textContent ?? "") && document.querySelector("#start-hint")?.hidden === false, null, { timeout: 20000 });
  return { context, page, errors, saved: null, savedName: "Untitled.spindlelabs.json", known: new Set(), design: null, seen: new Set() };
}

/** In the page: what can be clicked, typed into and right-clicked now, each with a selector a replay can find again. */
function offered() {
  // The modelling flow (sketch, draw, extrude, delete, start fresh) is picked more often than the other workspaces' tabs.
  const HOT = '#create-sketch, [id^="sketch-"], [id^="extrude"], [id^="start-fresh"], [id^="delete-ask"], [id^="row-menu"], #finish-sketch, [data-workspace="design"], #extrude-panel button, #sketch-panel button, #feature-edit button';
  const COLD = '[data-workspace]:not([data-workspace="design"]), #community, #split-toggle';
  // The controls of the mode the app is in (a sketch, the Extrude panel, the Edit feature panel (25a5), a dialog, a menu): a user mostly works there.
  const LOCAL = "#sketch-panel, .sketchbar, #typed-entry, #extrude-panel, dialog[open], #row-menu, #feature-edit";
  const KEYS = ["workspace", "op", "shape", "node", "nav", "view", "item", "field", "kind"];
  const sel = (e) => {
    if (e.id) return `#${CSS.escape(e.id)}`;
    const attrs = KEYS.filter((k) => e.dataset[k] !== undefined).map((k) => `[data-${k}="${e.dataset[k]}"]`);
    if (attrs.length) return `${e.tagName.toLowerCase()}${attrs.join("")}`;
    const text = e.textContent.trim().replace(/\s+/g, " ").slice(0, 40);
    return text ? `${e.tagName.toLowerCase()}:text-is("${text.replace(/"/g, '\\"')}")` : null;
  };
  const usable = (e) => {
    const r = e.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0 || e.disabled || e.closest("[inert], [hidden]")) return false;
    const cx = Math.min(Math.max(r.left + r.width / 2, 0), innerWidth - 1);
    const cy = Math.min(Math.max(r.top + r.height / 2, 0), innerHeight - 1);
    const top = document.elementFromPoint(cx, cy);
    return top !== null && (top === e || e.contains(top) || top.contains(e));
  };
  const all = [...document.querySelectorAll("button, summary, [role=menuitem], input, select, li[data-item]")].filter(usable);
  const targets = [];
  const inputs = [];
  for (const e of all) {
    const s = sel(e);
    if (!s) continue;
    const local = e.closest(LOCAL) !== null;
    if (e.tagName === "INPUT" && e.type !== "button" && e.type !== "file") inputs.push({ sel: s, type: e.type, local });
    else if (e.tagName !== "INPUT" && e.tagName !== "SELECT") targets.push({ sel: s, hot: e.matches(HOT), cold: e.matches(COLD), local });
  }
  // Browser rows and the timeline bar's items (24f3: a right-click opens the item's menu: marker here, suppress, delete).
  const rows = [...document.querySelectorAll("#browser .tree-row[data-node], #timeline li[data-item]")].filter(usable).map((e) => ({ sel: sel(e), sketch: (e.dataset.node ?? e.dataset.item).startsWith("sketch"), body: /^body-\d+$/.test(e.dataset.node ?? "") }));
  const prompt = [...document.querySelectorAll('[id^="sketch-plane-"]')].some(usable);
  return { targets, inputs, rows, prompt, sketching: document.querySelector("#viewport")?.dataset.sketching === "true" };
}

/** In the page: what the Design view shows now (null when Design is not on screen). */
function shown() {
  const bar = document.querySelector("#timeline .timeline-bar");
  const view = document.querySelector("#viewport");
  return {
    design: bar !== null,
    items: [...document.querySelectorAll("#timeline li[data-item]")].map((li) => ({ id: li.dataset.item, suppressed: li.dataset.suppressed === "true", rolledBack: li.dataset.rolledBack === "true" })),
    failed: [...document.querySelectorAll("#timeline li[data-item][data-failed]")].map((li) => li.dataset.item),
    bodies: document.querySelectorAll('#browser .tree-row[data-node^="body-"]').length,
    rows: [...document.querySelectorAll('#browser .tree-row[data-node^="body-"]')].map((r) => `${r.dataset.node} ${r.textContent}`),
    sketching: view?.dataset.sketching === "true",
    // A rebuild still running: the bar's failed marks and the Bodies rows are not the last edit's yet.
    rebuilding: view?.dataset.rebuilding === "true",
    data: { ...(view?.dataset ?? {}) },
    undo: document.getElementById("undo")?.title,
    redo: document.getElementById("redo")?.title,
    dialogs: [...document.querySelectorAll("dialog[open]")].map((d) => d.id || "a dialog"),
    sideways: document.documentElement.scrollWidth - innerWidth,
    extruding: document.getElementById("extrude-panel") !== null && document.getElementById("extrude-panel").getClientRects().length > 0,
  };
}

/** Waits until the page stops changing (two reads 150 ms apart agree, no rebuild running), at most 6 s; a page still changing then is a failure. */
async function settle(page) {
  let last = "";
  const until = Date.now() + 6000;
  while (Date.now() < until) {
    const now = JSON.stringify(await page.evaluate(shown));
    if (now === last && !JSON.parse(now).rebuilding) return JSON.parse(now);
    last = now;
    await page.waitForTimeout(150);
  }
  fail("settles", "the page was still changing 6 s after the action");
}

/** Save: the file's text, which also becomes the file `open` reopens. */
async function save(s) {
  const [download] = await Promise.all([s.page.waitForEvent("download", { timeout: 8000 }).catch(() => null), s.page.evaluate(() => document.getElementById("save").click())]);
  if (!download) fail("save", "Save gave no file");
  const text = readFileSync(await download.path(), "utf8");
  try {
    JSON.parse(text);
  } catch (e) {
    fail("save", `Save wrote a file that is not JSON (${e.message})`);
  }
  s.saved = text;
  s.savedName = download.suggestedFilename();
  return text;
}

/** Opens `text` as a file through Open's file picker. */
async function openFile(s, text, name) {
  const [chooser] = await Promise.all([s.page.waitForEvent("filechooser", { timeout: 5000 }), s.page.evaluate(() => document.getElementById("open").click())]);
  await chooser.setFiles({ name, mimeType: "application/json", buffer: Buffer.from(text) });
}

/** JSON with every object's keys sorted, so key order (which the writer sorts anyway) never counts as a change. */
const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v);
const canonical = (text) => JSON.stringify(sortKeys(JSON.parse(text)));
/** The first place two JSON values differ, for a message. */
function firstDifference(a, b, path = "") {
  if (JSON.stringify(a) === JSON.stringify(b)) return null;
  if (a && b && typeof a === "object" && typeof b === "object") {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const d = firstDifference(a[k], b[k], `${path}/${k}`);
      if (d) return d;
    }
  }
  return `${path || "/"}: ${JSON.stringify(a)?.slice(0, 120)} became ${JSON.stringify(b)?.slice(0, 120)}`;
}
function same(check, before, after) {
  if (canonical(before) !== canonical(after)) fail(check, firstDifference(JSON.parse(before), JSON.parse(after)));
}

/** The checks after every step. */
async function check(s) {
  const view = await settle(s.page);
  for (const [name, words] of Object.entries(KNOWN_ERRORS))
    if (KNOWN_BUGS[name] && s.errors.some((e) => words.test(e))) {
      s.known.add(name);
      s.errors.splice(0, s.errors.length, ...s.errors.filter((e) => !words.test(e)));
    }
  if (s.errors.length) fail("no errors", s.errors.splice(0).join(" | "));
  if (view.sideways > 1) fail("no sideways scrolling", `the page is ${view.sideways} px wider than the window`);
  const text = await save(s);
  const design = JSON.parse(text).workspaces?.design;
  if (!design) fail("save", "the saved file has no Design data");
  const broken = documentRules(design);
  if (broken.length) fail("document rules", broken.join("; "));
  // 25a5: a new id comes from the counter, unless the document is one seen before (Undo, Redo, a fresh start).
  const key = canonical(JSON.stringify(design));
  if (s.design && !s.seen.has(key)) {
    const reused = reusedIds(s.design, design);
    if (reused.length) fail("ids come from the counter", reused.join("; "));
    // A new document whose last step is an Edit feature OK ("Undo Edit Extrude 1"): that item's sizes changed and nothing else.
    if (/^Undo Edit /.test(view.undo ?? "")) {
      const leaks = editLeaks(s.design, design);
      if (leaks.length) fail("an edit changes only its item", `${view.undo}: ${leaks.join("; ")}`);
    }
  }
  s.seen.add(key);
  s.design = design;
  if (view.design) {
    const failed = new Set(view.failed);
    const want = expectedView(design, failed);
    if (JSON.stringify(view.items) !== JSON.stringify(want.items)) fail("timeline bar matches the file", `shown ${JSON.stringify(view.items)}, file says ${JSON.stringify(want.items)}`);
    // The bar's failed marks, where the file alone says whether the kernel builds a solid (kernelVerdict).
    for (const id of want.solids) {
      const f = design.timeline.features.find((x) => x.id === id);
      const verdict = kernelVerdict(f);
      if (verdict !== null && (verdict === "fails") !== failed.has(id)) fail("failed items match the file", `${f.intent.summary} (${id}) ${failed.has(id) ? "is marked failed" : "is not marked failed"}, but by its sizes it ${verdict === "fails" ? "fails" : "builds"}`);
    }
    // Finding 5: a row for each solid that built, none for one that failed, each "Body n" by its place among the solids that build.
    const rows = want.rows.map((r) => `${r.row} Body ${r.place}`);
    if (JSON.stringify(view.rows) !== JSON.stringify(rows)) fail("Bodies group matches the file", `rows ${JSON.stringify(view.rows)}, the file builds ${JSON.stringify(rows)}`);
    // A rebuild still running may hold a body it is about to free, so a count over is read again before it counts as a leak.
    let held = await s.page.evaluate(() => window.fissionTest.bodyCount());
    for (let i = 0; i < 4 && held > view.bodies; i++) {
      await s.page.waitForTimeout(500);
      held = await s.page.evaluate(() => window.fissionTest.bodyCount());
    }
    // Each body built is kept once in the kernel (rebuild.ts's BodyCache; two equal bodies share one), so the kernel never holds more than the Bodies group lists, and one more while the Extrude panel previews.
    const extra = view.extruding ? 1 : 0;
    if (held > view.bodies + extra) fail("no kernel body leaks", `the kernel holds ${held} bodies, the Bodies group lists ${view.bodies}${extra ? " and the Extrude panel is open" : ""}`);
  }
  if (s.errors.length) fail("no errors", s.errors.splice(0).join(" | "));
}

const viewBox = (page) => page.evaluate(() => {
  const r = document.querySelector("#viewport").getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
});

/** Does one action; returns false when what it names is not on the page now (the step is then a no-op). */
async function act(s, a) {
  const { page } = s;
  const find = async () => {
    const loc = page.locator(a.sel).first();
    return (await loc.count()) && (await loc.isVisible()) && (await loc.isEnabled()) ? loc : null;
  };
  switch (a.do) {
    case "click":
    case "menu": {
      const loc = await find();
      if (!loc) return false;
      await loc.click({ timeout: 2000, button: a.do === "menu" ? "right" : "left" }).catch(() => {});
      return true;
    }
    case "double": {
      const loc = await find();
      if (!loc) return false;
      await loc.dblclick({ timeout: 2000 }).catch(() => {});
      return true;
    }
    case "type": {
      const loc = await find();
      if (!loc) return false;
      await loc.click({ timeout: 2000 }).catch(() => {});
      await page.keyboard.press("Control+a");
      await page.keyboard.press("Backspace"); // emptied first, as a user clearing the box does
      await page.keyboard.type(a.text);
      if (a.finish !== "none") await page.keyboard.press(a.finish);
      return true;
    }
    case "canvas": {
      const b = await viewBox(page);
      const [x, y] = [b.x + a.x * b.w, b.y + a.y * b.h];
      if (a.double) await page.mouse.dblclick(x, y);
      else await page.mouse.click(x, y);
      return true;
    }
    case "drag": {
      const b = await viewBox(page);
      if (a.shift) await page.keyboard.down("Shift");
      await page.mouse.move(b.x + a.x * b.w, b.y + a.y * b.h);
      await page.mouse.down({ button: a.button });
      await page.mouse.move(b.x + a.x2 * b.w, b.y + a.y2 * b.h, { steps: 5 });
      await page.mouse.up({ button: a.button });
      if (a.shift) await page.keyboard.up("Shift");
      return true;
    }
    case "hover": {
      const b = await viewBox(page);
      await page.mouse.move(b.x + a.x * b.w, b.y + a.y * b.h, { steps: 3 });
      return true;
    }
    case "wheel": {
      const b = await viewBox(page);
      await page.mouse.move(b.x + a.x * b.w, b.y + a.y * b.h);
      await page.mouse.wheel(0, a.dy);
      return true;
    }
    case "key":
      await page.keyboard.press(a.key);
      return true;
    case "resize":
      await page.setViewportSize({ width: a.size[0], height: a.size[1] });
      return true;
    case "open": {
      if (!s.saved) return false;
      const before = s.saved;
      const text = editFile(before, a.edit, a.at);
      await openFile(s, text, s.savedName);
      await settle(page);
      s.errors.splice(0, s.errors.length, ...s.errors.filter((e) => !refusal(e)));
      const after = await save(s);
      // Opened, the file's data is shown as it was (a valid edit); refused, the project is as before.
      const valid = (() => {
        try {
          return canonical(text);
        } catch {
          return null;
        }
      })();
      if (canonical(after) !== valid && canonical(after) !== canonical(before))
        fail("open shows the file or keeps the project", `opening a file edited by "${a.edit}" left neither: ${firstDifference(JSON.parse(valid ?? before), JSON.parse(after))}`);
      return true;
    }
    case "reload": {
      const before = await save(s);
      await page.waitForTimeout(800); // the store writes after a change; a user closing the tab at once is another matter
      await page.reload(); // to the workspace on screen (its #link), so the timeline may not be there
      // Ready means the last project is open again, not just the kernel: Save before that writes a file without the design (a bug of its own, found by seed 124 under load, reproduced with the CPU slowed 8×).
      // An empty design has no timeline rows to wait for (seed 32 reloaded one and waited forever), only the bar.
      const design = JSON.parse(before).workspaces?.design;
      const empty = !design || (design.timeline?.features?.length ?? 0) + (design.sketches?.length ?? 0) === 0;
      await page.waitForFunction(
        (empty) => /kernel v/.test(document.getElementById("version")?.textContent ?? "") && (location.hash !== "#design" || document.querySelector(empty ? "#timeline .timeline-marker" : "#timeline li[data-item]") !== null),
        empty,
        { timeout: 20000 },
      );
      if (!(await page.evaluate(() => location.hash === "#design"))) await page.waitForTimeout(1500);
      await settle(page);
      same("a reload brings the project back", before, await save(s));
      return true;
    }
    case "undo-redo": {
      const can = await page.evaluate(() => !document.getElementById("undo").disabled);
      if (!can) return false;
      const before = await save(s);
      const label = (await settle(page)).undo;
      await page.evaluate(() => document.getElementById("undo").click());
      await settle(page);
      const redoable = await page.evaluate(() => !document.getElementById("redo").disabled);
      if (!redoable) fail("undo then redo", `after ${label}, Redo is off`);
      await page.evaluate(() => document.getElementById("redo").click());
      const back = await settle(page);
      same("undo then redo gives the same file", before, await save(s));
      if (back.undo !== label) fail("undo then redo", `the Undo label was "${label}", then "${back.undo}"`);
      return true;
    }
    case "round-trip": {
      const before = await save(s);
      await openFile(s, before, s.savedName);
      await settle(page);
      same("save then open gives the same file", before, await save(s));
      return true;
    }
    case "select-bodies": {
      // Each body in turn, by its Bodies row: the selection, the Feature panel, the Body panel's volume and the highlighted faces must all be that body's.
      const view = await settle(page);
      if (!view.design || view.sketching || view.dialogs.length || view.extruding || !s.saved) return false;
      const design = JSON.parse(s.saved).workspaces.design;
      const { rows } = expectedView(design, new Set(view.failed));
      if (rows.length !== view.bodies) return false; // the per-step check reports that
      const blocks = [];
      const wrong = []; // every disagreement, so the message shows the whole pattern
      for (const { row, place, id } of rows) {
        await page.evaluate((row) => document.querySelector(`#browser .tree-row[data-node="${row}"]`).click(), row);
        await settle(page);
        const got = await page.evaluate(() => ({
          selection: document.body.dataset.selection ?? "",
          intent: document.getElementById("intent")?.textContent ?? "",
          volume: document.getElementById("volume")?.textContent ?? "",
          topology: document.getElementById("topology")?.textContent ?? "",
          stale: document.getElementById("stats")?.dataset.stale === "true",
          highlight: document.querySelector("#viewport").dataset.highlight ?? "",
        }));
        const f = design.timeline.features.find((x) => x.id === id);
        const name = `Body ${place} (${f.intent.summary})`;
        if (got.selection !== `body:${id}`) wrong.push(`clicking ${name} selected "${got.selection}"`);
        if (got.intent !== f.intent.summary) wrong.push(`with ${name} selected the Feature panel says "${got.intent}"`);
        const faces = /faces ([\d,]*)/.exec(got.highlight)?.[1].split(",").filter(Boolean).map(Number) ?? [];
        const shownFaces = Number(/(\d+) F/.exec(got.topology)?.[1]);
        if (!got.stale) {
          const want = modelVolume(design, f);
          const volume = Number(got.volume.replace(/[^\d.]/g, ""));
          // The panel rounds to a few figures (fmt in properties.ts); 0.5% is far inside the gap between any two different bodies the monkey makes, and far outside the kernel's 1e-6 relative volume error.
          if (want !== null && !(Math.abs(volume - want) <= 0.005 * want)) wrong.push(`with ${name} selected the Body panel shows ${got.volume}, but that body is ${want.toPrecision(6)} mm³`);
          // With every body selected (one body alone) the app lights none of them on purpose (scene.ts), so the count is checked from two bodies up.
          if (rows.length > 1 && faces.length !== shownFaces) wrong.push(`with ${name} selected ${faces.length} faces light up, but the Body panel says it has ${shownFaces}`);
        }
        blocks.push(faces);
      }
      // joinBodies (scene.ts) numbers each body's faces after the previous body's, so the bodies' faces are back-to-back blocks in order.
      let next = 0;
      for (const [k, faces] of blocks.entries()) {
        if (!faces.length) continue;
        if (faces.some((x, i) => x !== faces[0] + i) || faces[0] !== next) wrong.push(`Body ${rows[k].place} lights faces ${faces[0]}..${faces.at(-1)}, but its faces should start at ${next}, after the bodies before it`);
        next = faces.at(-1) + 1;
      }
      await page.keyboard.press("Escape");
      if (wrong.length) fail("selection agrees", wrong.join("; "));
      return true;
    }
    case "unstick": {
      for (let i = 0; i < 4; i++) {
        await page.keyboard.press("Escape");
        await settle(page);
      }
      const view = await settle(page);
      if (view.dialogs.length) fail("never stuck", `${view.dialogs.join(", ")} stays open after Escape`);
      if (!view.design) {
        await page.locator('[data-workspace="design"]').first().click({ timeout: 2000 });
        await settle(page);
      }
      if ((await settle(page)).sketching) {
        const out = page.locator("#sketch-cancel:visible, button:visible:has-text('Finish Sketch'), button:visible:has-text('Finish sketch')").first();
        if (!(await out.count())) fail("never stuck", "a sketch is open with no Cancel or Finish Sketch on screen");
        await out.click({ timeout: 2000 });
      }
      const end = await settle(page);
      if (end.sketching) fail("never stuck", "still sketching after Finish Sketch");
      const ready = await page.evaluate(() => {
        const b = document.getElementById("create-sketch");
        return b !== null && !b.disabled;
      });
      if (!ready) fail("never stuck", "Create sketch is missing or off after leaving every mode");
      return true;
    }
  }
  throw new Error(`unknown action ${JSON.stringify(a)}`);
}

/** A console message that only reports a refused file (the app saying so is right, not an error). */
const refusal = () => false;

/**
 * Runs `actions` (or, with `random`, makes up `steps` of them) in a fresh
 * page, checking after each. Returns { actions, failure }: the actions done,
 * the last one the one that failed.
 */
async function run(browser, { actions, random, steps }) {
  const s = await open(browser);
  const done = [];
  try {
    await check(s);
    const count = actions ? actions.length : steps;
    for (let i = 0; i < count; i++) {
      let a;
      if (actions) a = actions[i];
      else {
        const page = await s.page.evaluate(offered);
        a = nextAction(random, { ...page, haveSave: s.saved !== null, focus: process.env.MONKEY_FOCUS });
      }
      done.push(a);
      const did = await Promise.race([act(s, a), s.page.waitForTimeout(30000).then(() => fail("settles", "an action took over 30 s"))]);
      if (process.env.MONKEY_VERBOSE) console.log(`  ${i + 1}. ${did ? "" : "(not on the page) "}${JSON.stringify(a)}`);
      await check(s);
    }
    return { actions: done, failure: null, known: [...s.known] };
  } catch (e) {
    const failure = e instanceof Failure ? { check: e.check, message: e.detail } : { check: "the tester itself", message: e.stack ?? String(e) };
    return { actions: done, failure, known: [...s.known] };
  } finally {
    await s.context.close();
  }
}

async function main() {
  const server = await preview({ preview: { port: PORT, strictPort: true }, logLevel: "error", ...(process.env.MONKEY_OUT ? { build: { outDir: process.env.MONKEY_OUT } } : {}) });
  const browser = await launch();
  const results = here("./monkey-results/");
  let failed = 0;
  const report = async (name, seed, out) => {
    const known = out.known.length ? `; known bug seen: ${out.known.join(", ")}` : "";
    if (!out.failure) return console.log(`${name}: pass (${out.actions.length} actions${known})`);
    failed++;
    console.log(`${name}: FAIL at action ${out.actions.length}: ${out.failure.check}: ${out.failure.message}`);
    let list = out.actions;
    if (process.env.MONKEY_SHRINK !== "0" && out.failure.check !== "the tester itself") {
      const want = signature(out.failure);
      const shrunk = await shrink(out.actions, async (candidate) => {
        const again = await run(browser, { actions: candidate });
        return again.failure !== null && signature(again.failure) === want;
      });
      list = shrunk.list;
      console.log(`  shrunk to ${list.length} actions in ${shrunk.tries} replays:`);
      for (const a of list) console.log(`    ${JSON.stringify(a)}`);
    }
    mkdirSync(results, { recursive: true });
    writeFileSync(new URL("./.gitignore", results), "*\n"); // results are for the person running it; a kept case goes in regressions/
    const file = new URL(`./${name.replace(/[^\w.-]+/g, "-")}.json`, results);
    writeFileSync(file, JSON.stringify({ seed, failure: out.failure, actions: list }, null, 2) + "\n");
    console.log(`  saved to ${file.pathname}`);
  };
  try {
    if (process.env.MONKEY_REPLAY) {
      const saved = JSON.parse(readFileSync(process.env.MONKEY_REPLAY, "utf8"));
      await report(`replay ${process.env.MONKEY_REPLAY.split("/").at(-1)}`, saved.seed, await run(browser, { actions: saved.actions }));
    } else {
      const regressions = here("./regressions/");
      for (const f of existsSync(regressions) && !process.env.MONKEY_NO_REGRESSIONS ? readdirSync(regressions).filter((f) => /^monkey-.*\.json$/.test(f)) : []) {
        const saved = JSON.parse(readFileSync(new URL(f, regressions), "utf8"));
        await report(`regression ${f}`, saved.seed, await run(browser, { actions: saved.actions }));
      }
      const seeds = process.env.FISSION_SEED ? [Number(process.env.FISSION_SEED)] : seedList(process.env.MONKEY_SEEDS || "1-3");
      for (const seed of seeds) await report(`seed ${seed}`, seed, await run(browser, { random: rng(seed), steps: STEPS }));
    }
  } finally {
    await browser.close();
    await server.close();
  }
  console.log(failed ? `monkey: ${failed} failed` : "monkey: all passed");
  process.exitCode = failed ? 1 : 0;
}

await main();
