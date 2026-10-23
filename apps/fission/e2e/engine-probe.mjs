// Temporary probe for the daily bug hunt 3e (never merged): what Firefox and
// WebKit do where the smoke test fails in them.
import { launch, browserName } from "./browser.mjs";
import { preview } from "vite";

const server = await preview({ preview: { port: 4174, strictPort: true }, logLevel: "error" });
const url = "http://localhost:4174/";
const browser = await launch();
const t0 = Date.now();
const log = (...a) => console.log(`[${browserName} ${((Date.now() - t0) / 1000).toFixed(2)}s]`, ...a);

async function probePage(label, { wipe = true } = {}) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 640 } });
  if (wipe)
    await page.addInitScript(() => {
      indexedDB.deleteDatabase("fission");
      for (const k of Object.keys(localStorage)) if (k.startsWith("panoshape.unsaved/")) localStorage.removeItem(k);
    });
  page.on("console", (m) => log(`${label} console.${m.type()}: ${m.text().slice(0, 300)}`));
  page.on("pageerror", (e) => log(`${label} pageerror: ${e.message}`));
  page.on("requestfailed", (r) => log(`${label} requestfailed: ${r.url()} ${r.failure()?.errorText}`));
  page.on("download", (d) => log(`${label} DOWNLOAD event: ${d.suggestedFilename()}`));
  return page;
}

const state = (page) =>
  page.evaluate(() => ({
    volume: document.querySelector("#volume")?.textContent,
    status: document.querySelector("#status")?.textContent,
    rebuilding: document.querySelector("#viewport")?.dataset.rebuilding,
    save: document.querySelector("#save-status")?.dataset.state,
    project: document.body.dataset.projectId ?? null,
    file: document.querySelector("#file-status")?.textContent,
  }));

async function watch(page, label, ms) {
  let last = "";
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const s = JSON.stringify(await state(page).catch((e) => ({ error: e.message })));
    if (s !== last) log(`${label} state ${s}`);
    last = s;
    await page.waitForTimeout(100);
  }
}

// 1. A fresh load, as the smoke test's first check sees it.
const page = await probePage("A");
await page.goto(url);
await watch(page, "A load", 12000);

// 2. Save: does the anchor get clicked, with user activation, and does a download come?
await page.evaluate(() => {
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    console.log(`anchor click download=${this.download} href=${this.href.slice(0, 40)} activation=${navigator.userActivation?.isActive} connected=${this.isConnected}`);
    return click.call(this);
  };
});
log("A clicking #save");
await page.click("#save");
await page.waitForTimeout(5000);
log("A clicking STL");
await page.click("#toolbar [data-op=export_stl]", { timeout: 5000 }).catch((e) => log("no STL button", e.message.split("\n")[0]));
await page.waitForTimeout(3000);
// A detached anchor clicked with no gesture, and an attached one.
await page.evaluate(() => {
  const mk = (n) => Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob(["x"])), download: n });
  mk("detached-nogesture.txt").click();
  const a = mk("attached-nogesture.txt");
  document.body.append(a);
  a.click();
  a.remove();
});
await page.waitForTimeout(3000);

// 3. Reload, as the Save check does, then Save again.
log("A reload");
await page.reload();
await watch(page, "A reload", 8000);
await page.evaluate(() => {
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    console.log(`anchor click download=${this.download} activation=${navigator.userActivation?.isActive} connected=${this.isConnected}`);
    return click.call(this);
  };
});
log("A clicking #save after reload");
await page.click("#save");
await page.waitForTimeout(5000);

// 4. Phone width tab stops with the browser folded.
await page.setViewportSize({ width: 375, height: 740 });
await page.waitForTimeout(1000);
log("B toggle expanded:", await page.getAttribute("#browser-toggle", "aria-expanded"));
await page.evaluate(() => document.querySelector("#topbar :is(a[href], button, input, select)").focus());
for (let i = 0; i < 40; i++) {
  await page.keyboard.press("Tab");
  const r = await page.evaluate(() => {
    const el = document.activeElement;
    const region = el?.closest("#topbar, #toolbar, #panel-toggles, #browser, #undo-redo, #view-controls, #timeline, #properties")?.id ?? "other";
    const cs = el ? getComputedStyle(el) : null;
    return `${region} <${el?.tagName.toLowerCase()} id=${el?.id} class=${el?.className}> overflow=${cs?.overflow} tabindex=${el?.getAttribute("tabindex")} ${el?.outerHTML.slice(0, 160).replace(/\s+/g, " ")}`;
  });
  log(`B tab ${i}: ${r}`);
  if (r.startsWith("properties")) break;
}
// Layout tab at phone width.
const bar = await page.evaluate(() => {
  const top = document.querySelector("#topbar").getBoundingClientRect();
  return [...document.querySelectorAll("#topbar [role=tab], #topbar .tab, #topbar a, #topbar button")].map((e) => {
    const b = e.getBoundingClientRect();
    return `${e.textContent.trim().slice(0, 14)} x=${b.left.toFixed(0)}..${b.right.toFixed(0)} y=${b.top.toFixed(0)}..${b.bottom.toFixed(0)} out=${b.right > top.right + 0.5 || b.bottom > top.bottom + 0.5} vis=${getComputedStyle(e).visibility}`;
  }).concat(`topbar ${top.left}..${top.right} ${top.top}..${top.bottom} scrollW=${document.documentElement.scrollWidth}`);
});
for (const b of bar) log(`C ${b}`);
await page.setViewportSize({ width: 1000, height: 640 });

// 5. WebKit's wasm fetch error: reloads in a row, while the kernel may still be loading.
for (let i = 0; i < 3; i++) {
  log(`D reload ${i}`);
  await page.reload();
  await page.waitForFunction(() => document.querySelector("#volume")?.textContent === "24,000 mm³", null, { timeout: 15000 }).catch((e) => log("D wait", e.message.split("\n")[0]));
}
log("D goto then reload at once");
await page.goto(url + "#design");
await page.reload();
await page.waitForTimeout(4000);

await browser.close();
await server.close();
log("done");
