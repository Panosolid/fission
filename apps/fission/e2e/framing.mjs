// Browser check of the frame refusal and the Content Security Policy (audit
// S10). A page on another origin frames the app: the frame shows only the
// refusal and a link that opens the app on its own, no kernel worker starts,
// nothing is fetched beyond the page's own scripts and styles and the
// project store is never opened; the same holds for a frame on the app's own
// origin and for ?guide. Unframed, the app runs as before (the controls for
// every refusal check: each one fails there). Under the CSP, an inline
// script, a script from another origin, a plugin and a <base> are refused
// with the right directive, while the kernel's WebAssembly still runs.
// 375 px too. Run with `npm run e2e`, after `npm run build`; `E2E_SHOTS`
// saves screenshots.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { launch } from "./browser.mjs";
import { preview } from "vite";

const server = await preview({ preview: { port: 4230, strictPort: true }, logLevel: "error" });
const app = "http://localhost:4230/";
// The other site: 127.0.0.1 is another origin than localhost (the host differs).
const other = createServer((req, res) => {
  const target = new URL(req.url, "http://x").searchParams.get("src") ?? app;
  if (req.url.startsWith("/evil.js")) {
    res.writeHead(200, { "content-type": "text/javascript" });
    res.end("window.evilRan = true;");
    return;
  }
  res.writeHead(200, { "content-type": "text/html" });
  // An invisible frame over a button, as a clickjacking page would place it.
  res.end(`<!doctype html><title>Other site</title><button id="bait" style="position:absolute;left:40px;top:40px">Win a prize</button>
<iframe id="app" src="${target}" style="position:absolute;inset:0;width:100%;height:100%;border:0;opacity:${new URL(req.url, "http://x").searchParams.get("opacity") ?? "1"}"></iframe>`);
});
await new Promise((done) => other.listen(0, "127.0.0.1", done));
const otherOrigin = `http://127.0.0.1:${other.address().port}`;

const FRAMED_MESSAGE = "SpindleLabs doesn't run inside another page's frame, so no other site can catch your clicks or reach your projects.";
const shots = process.env.E2E_SHOTS;
const browser = await launch();
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}\n  ${e.message.split("\n").join("\n  ")}`);
  }
}

/** Polls `fn` in the page until it is true. waitForFunction can't be used here: it evaluates a string in the page, which the CSP refuses. */
async function waitUntil(page, fn, timeout = 15000) {
  const end = Date.now() + timeout;
  while (!(await page.evaluate(fn))) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${fn}`);
    await page.waitForTimeout(100);
  }
}

/** A fresh page that records every request, page error and CSP refusal. */
async function openPage(viewport = { width: 1280, height: 800 }, hasTouch = false) {
  // The real policy: this check is the one that doesn't bypass it (browser.mjs).
  const context = await browser.newContext({ viewport, hasTouch, bypassCSP: false });
  const page = await context.newPage();
  const seen = { requests: [], errors: [] };
  page.on("request", (r) => seen.requests.push(r.url()));
  page.on("pageerror", (e) => seen.errors.push(e.message));
  return { context, page, seen };
}

/** What the framed app shows and started, read once its frame has loaded. */
async function framedState(page, seen) {
  const frame = page.frame({ url: (u) => u.href.startsWith(app) });
  assert.ok(frame, "the app's frame loaded");
  await frame.waitForSelector("#framed", { timeout: 15000 }).catch(() => {});
  // Long enough for the app to have mounted Design and started its kernel (well under a second unframed).
  await page.waitForTimeout(1500);
  return {
    frame,
    framed: await frame.$eval("#framed", (m) => ({ text: m.querySelector("p")?.textContent, href: m.querySelector("a")?.href, target: m.querySelector("a")?.target, rel: m.querySelector("a")?.rel })).catch(() => null),
    topbar: await frame.$("#topbar"),
    canvas: await frame.$("canvas"),
    guide: await frame.$(".guide, [class^='guide']"),
    workers: page.workers().length,
    wasm: seen.requests.filter((u) => u.endsWith(".wasm")),
    workerScripts: seen.requests.filter((u) => /worker/i.test(u)),
    databases: await frame.evaluate(async () => (await indexedDB.databases()).map((d) => d.name)),
    errors: seen.errors,
  };
}

function assertRefused(state, href) {
  assert.ok(state.framed, "the refusal is shown");
  assert.equal(state.framed.text, FRAMED_MESSAGE);
  assert.equal(state.framed.href, href, "the link opens the app itself");
  assert.equal(state.framed.target, "_blank");
  assert.equal(state.framed.rel, "noopener noreferrer");
  assert.equal(state.topbar, null, "no top bar");
  assert.equal(state.canvas, null, "no viewport");
  assert.equal(state.guide, null, "no guide");
  assert.equal(state.workers, 0, "no kernel worker");
  assert.deepEqual(state.wasm, [], "the kernel's .wasm is never fetched");
  assert.deepEqual(state.workerScripts, [], "the worker script is never fetched");
  assert.ok(!state.databases.includes("fission"), `the project store is never opened (databases: ${JSON.stringify(state.databases)})`);
  // The two entry scripts stop at the guard and nothing else fails.
  assert.ok(state.errors.length >= 1 && state.errors.every((e) => e.includes("refused to run inside a frame")), `only the refusal is thrown: ${JSON.stringify(state.errors)}`);
}

try {
  await check("unframed, the app runs: top bar, viewport, one kernel worker, its .wasm, the project store (the controls)", async () => {
    const { context, page, seen } = await openPage();
    await page.goto(app);
    await page.waitForSelector("#topbar #save");
    await page.waitForSelector("#viewport canvas");
    await waitUntil(page, () => indexedDB.databases().then((d) => d.some((x) => x.name === "fission")));
    assert.equal(await page.$("#framed"), null);
    assert.equal(page.workers().length, 1, "one kernel worker");
    assert.ok(seen.requests.some((u) => u.endsWith(".wasm")), "the kernel's .wasm was fetched");
    assert.deepEqual(seen.errors, []);
    await context.close();
  });

  await check("framed by another site, invisibly over its button: only the refusal, nothing started", async () => {
    const { context, page, seen } = await openPage();
    await page.goto(`${otherOrigin}/?opacity=0`);
    const state = await framedState(page, seen);
    assertRefused(state, app);
    await context.close();
  });

  await check("framed by another site with ?guide: the guide doesn't open either", async () => {
    const { context, page, seen } = await openPage();
    await page.goto(`${otherOrigin}/?src=${encodeURIComponent(`${app}?guide`)}`);
    const state = await framedState(page, seen);
    assertRefused(state, `${app}?guide`);
    await context.close();
  });

  await check("framed on the app's own origin: refused the same way, while the page around it runs", async () => {
    const { context, page, seen } = await openPage();
    await page.goto(app);
    await page.waitForSelector("#viewport canvas");
    const before = page.workers().length;
    const wasmBefore = seen.requests.filter((u) => u.endsWith(".wasm")).length;
    await page.evaluate((src) => {
      const f = document.createElement("iframe");
      f.src = src;
      f.name = "inner";
      document.body.append(f);
    }, `${app}#design`);
    const frame = await (await page.waitForSelector("iframe[name=inner]")).contentFrame();
    await frame.waitForSelector("#framed", { timeout: 15000 });
    await page.waitForTimeout(1500);
    assert.equal(await frame.$eval("#framed p", (p) => p.textContent), FRAMED_MESSAGE);
    assert.equal(await frame.$("#topbar"), null);
    assert.equal(page.workers().length, before, "no second kernel worker");
    assert.equal(seen.requests.filter((u) => u.endsWith(".wasm")).length, wasmBefore, "no second .wasm fetch");
    assert.ok(await page.$("#topbar #save"), "the page around the frame keeps running");
    assert.ok(seen.errors.every((e) => e.includes("refused to run inside a frame")), JSON.stringify(seen.errors));
    await context.close();
  });

  await check("at 375 px framed: the refusal fits the width and the link opens the app in a page of its own", async () => {
    const { context, page, seen } = await openPage({ width: 375, height: 700 }, true);
    await page.goto(otherOrigin);
    const { frame } = await framedState(page, seen);
    const fits = await frame.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    assert.ok(fits, "no sideways scroll");
    const box = await (await frame.$("#framed a")).boundingBox();
    assert.ok(box && box.width > 0 && box.y + box.height < 700, "the link is on screen");
    if (shots) await page.screenshot({ path: `${shots}/framed-375.png` });
    const [opened] = await Promise.all([context.waitForEvent("page"), frame.tap("#framed a")]);
    await opened.waitForSelector("#viewport canvas"); // Save is behind Menu at this width
    assert.equal(await opened.evaluate(() => window.top === window.self), true);
    assert.equal(await opened.evaluate(() => window.opener), null, "noopener: the framing site gets no handle on it");
    await context.close();
  });

  await check("the CSP refuses an inline script, another site's script, a plugin and a <base>, naming each directive, and lets fetch reach another site", async () => {
    const { context, page, seen } = await openPage();
    await page.goto(app);
    await page.waitForSelector("#viewport canvas");
    const result = await page.evaluate(async (evilSrc) => {
      const violations = [];
      document.addEventListener("securitypolicyviolation", (e) => violations.push(e.effectiveDirective));
      const inline = document.createElement("script");
      inline.textContent = "window.inlineRan = true;";
      document.body.append(inline);
      const remote = document.createElement("script");
      remote.src = evilSrc;
      const remoteDone = new Promise((done) => {
        remote.onload = () => done("loaded");
        remote.onerror = () => done("refused");
      });
      document.body.append(remote);
      const plugin = document.createElement("object");
      plugin.data = evilSrc;
      document.body.append(plugin);
      const base = document.createElement("base");
      base.href = "https://example.com/";
      document.head.append(base);
      const baseAfter = document.baseURI;
      const remoteResult = await remoteDone;
      // connect-src stays open: the AI assistant fetches whatever address the user typed (no-cors, so only the CSP can refuse it).
      const fetched = await fetch(evilSrc, { mode: "no-cors" }).then(() => "fetched", (e) => String(e));
      await new Promise((r) => setTimeout(r, 300));
      return { inlineRan: window.inlineRan === true, evilRan: window.evilRan === true, remoteResult, baseAfter, fetched, violations };
    }, `${otherOrigin}/evil.js`);
    assert.equal(result.inlineRan, false, "inline script didn't run");
    assert.equal(result.evilRan, false, "another site's script didn't run");
    assert.equal(result.remoteResult, "refused");
    assert.equal(result.fetched, "fetched", "another address can still be reached by fetch (the AI providers)");
    assert.ok(result.baseAfter.startsWith(app), `<base> didn't move the page's links (${result.baseAfter})`);
    for (const directive of ["script-src-elem", "object-src", "base-uri"]) assert.ok(result.violations.includes(directive), `${directive} reported: ${JSON.stringify(result.violations)}`);
    assert.deepEqual(seen.errors, []);
    await context.close();
  });

  await check("under the CSP WebAssembly runs: on the page (the in-browser AI model's) and the kernel's, a 40 × 30 × 20 box's volume is 24,000 mm³", async () => {
    const { context, page, seen } = await openPage();
    const violations = [];
    page.on("console", (m) => /Content Security Policy/i.test(m.text()) && violations.push(m.text()));
    await page.goto(app);
    // 40 × 30 × 20 = 24,000, the default box, worked out by hand; the kernel computes it in its worker.
    await waitUntil(page, () => document.querySelector("#volume")?.textContent === "24,000 mm³");
    if (shots) await page.screenshot({ path: `${shots}/unframed-1280.png` });
    // The kernel's worker has a policy of its own (a worker from this site's URL doesn't take the page's meta
    // policy), so the page compiles a module itself: the 8-byte header of an empty one ("\0asm", version 1).
    const compiled = await page.evaluate(() => WebAssembly.compile(new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0])).then(() => "compiled", (e) => String(e)));
    assert.equal(compiled, "compiled");
    assert.deepEqual(violations, []);
    assert.deepEqual(seen.errors, []);
    await context.close();
  });
} finally {
  await browser.close();
  await server.close();
  other.close();
}
if (failed) {
  console.log(`${failed} framing check(s) failed`);
  process.exit(1);
}
