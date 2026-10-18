// Broken and odd project files opened through Open.
import { readFileSync } from "node:fs";
import * as H from "./lib.mjs";
const env = await H.start(4243);
const T = JSON.parse(readFileSync(new URL("./template.json", import.meta.url), "utf8"));
const clone = () => JSON.parse(JSON.stringify(T));
const D = (f) => { const p = clone(); f(p.workspaces.design, p); return JSON.stringify(p); };
const cases = {
  "marker on suppressed item": D((d) => { d.timeline.features[2].suppressed = true; d.timeline.marker = "feature-11"; }),
  "marker null": D((d) => { d.timeline.marker = null; }),
  "marker number": D((d) => { d.timeline.marker = 3; }),
  "marker empty string": D((d) => { d.timeline.marker = ""; }),
  "marker __proto__": D((d) => { d.timeline.marker = "__proto__"; }),
  "marker start on empty timeline": D((d) => { d.timeline.features = []; d.sketches = []; d.timeline.marker = "start"; }),
  "extrude before its sketch": D((d) => { const f = d.timeline.features; [f[1], f[2]] = [f[2], f[1]]; }),
  "dependsOn missing id": D((d) => { d.timeline.features[2].dependsOn = ["sketch-99"]; }),
  "duplicate item ids": D((d) => { d.timeline.features[1].id = "feature-1"; }),
  "suppressed not boolean": D((d) => { d.timeline.features[0].suppressed = "yes"; }),
  "html in summary and label": D((d) => { d.timeline.features[0].intent.summary = '<img src=x onerror="window.__xss=1">Box'; d.timeline.features[0].provenance.self.label = '<img src=x onerror="window.__xss=2">B'; }),
  "huge distance": D((d) => { d.timeline.features[2].intent.parameters.distance = 1e9; }),
  "tiny distance": D((d) => { d.timeline.features[2].intent.parameters.distance = 1e-9; }),
  "negative distance": D((d) => { d.timeline.features[2].intent.parameters.distance = -10; }),
  "distance string": D((d) => { d.timeline.features[2].intent.parameters.distance = "10"; }),
  "kept on box": D((d) => { d.kept = { "feature-1": { curves: [] } }; }),
  "kept garbage": D((d) => { d.kept = { "feature-11": 42 }; }),
  "nextId too small": D((d) => { d.nextId = 2; }),
  "summary missing": D((d) => { delete d.timeline.features[0].intent.summary; }),
  "label very long": D((d) => { d.timeline.features[0].provenance.self.label = "L".repeat(5000); d.timeline.features[0].intent.summary = "S".repeat(5000); }),
  "unknown item type": D((d) => { d.timeline.features[0].intent.type = "fillet"; }),
  "sketch item with no sketch content": D((d) => { d.sketches = []; }),
  "many items (150 boxes)": D((d) => { const box = d.timeline.features[0]; d.timeline.features = Array.from({ length: 150 }, (_, i) => ({ ...JSON.parse(JSON.stringify(box)), id: `feature-${100 + i}`, provenance: { from: [], self: { id: `feature-${100 + i}`, label: `Feature ${i + 1} (box)`, workspace: "design" } } })); d.sketches = []; d.nextId = 400; }),
  "marker on sketch, extrude after": D((d) => { d.timeline.marker = "sketch-2"; }),
};
try {
  for (const [name, text] of Object.entries(cases)) {
    const page = await H.fresh(env);
    await H.openText(page, text);
    await page.waitForTimeout(500);
    const status = await page.evaluate(() => [...document.querySelectorAll("#file-status")].map((e) => e.textContent.trim()).filter(Boolean).join(" / ").slice(0, 200));
    const xss = await page.evaluate(() => window.__xss ?? null);
    console.log(`[${name}]`, "bar:", (await H.bar(page)).slice(0, 100), "| vol", await H.volume(page), "| bodies", (await H.bodyRows(page)).join(","), "k", await H.bodyCount(page), "| err:", (await H.errLine(page)).slice(0, 150), "| status:", status, xss ? "| XSS " + xss : "", page.errors.length ? "| PAGE ERRORS " + JSON.stringify(page.errors).slice(0, 300) : "");
    // Try each menu on the bar: open and close
    await page.context().close();
  }
} finally { await env.browser.close(); await env.server.close(); }
