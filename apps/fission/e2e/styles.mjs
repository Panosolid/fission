// Browser check that the feature style files (src/styles/<feature>.css, one
// per feature, loaded by main.ts without a list) reach the built app: a link
// badge, a downstream chip and a change note placed on the page take their
// styles. Run with `npm run e2e`, after `npm run build`.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { preview } from "vite";

const server = await preview({ preview: { port: 4175, strictPort: true }, logLevel: "error" });
const sandboxChromium = "/opt/pw-browsers/chromium";
const browser = await chromium.launch(existsSync(sandboxChromium) ? { executablePath: sandboxChromium } : {});
try {
  const page = await browser.newPage();
  await page.goto("http://localhost:4175/");
  const style = (cls, prop) =>
    page.evaluate(([cls, prop]) => {
      const el = document.createElement(cls === "change-note" ? "div" : "span");
      el.className = cls;
      document.body.append(el);
      const value = getComputedStyle(el)[prop];
      el.remove();
      return value;
    }, [cls, prop]);
  // Values from the style files: link-badge.css border-radius 8px,
  // downstream-chip.css 10px, change-note.css a 3px left border; an unstyled
  // element has 0px for all three.
  assert.equal(await style("link-badge", "borderRadius"), "8px");
  assert.equal(await style("downstream-chip", "borderRadius"), "10px");
  assert.equal(await style("change-note", "borderLeftWidth"), "3px");
  assert.equal(await style("no-such-feature", "borderRadius"), "0px");
  console.log("PASS feature style files reach the built app (3 checked, 1 unstyled control)");
} finally {
  await browser.close();
  await server.close();
}
