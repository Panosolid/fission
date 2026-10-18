// The one launcher every browser test uses: Chromium by default, or the
// engine E2E_BROWSER names (chromium, firefox or webkit), so CI runs the
// same tests in all three (testing catch-up TC4). In this sandbox Chromium
// comes from /opt/pw-browsers; elsewhere Playwright's own builds are used
// (`npx playwright install --with-deps chromium firefox webkit`).
import { existsSync } from "node:fs";
import { chromium, firefox, webkit } from "playwright";

const ENGINES = { chromium, firefox, webkit };
export const browserName = process.env.E2E_BROWSER || "chromium";
if (!(browserName in ENGINES)) throw new Error(`E2E_BROWSER must be chromium, firefox or webkit, not ${browserName}`);

/** Launches the chosen browser. */
export function launch() {
  const sandboxChromium = "/opt/pw-browsers/chromium";
  const options = browserName === "chromium" && existsSync(sandboxChromium) ? { executablePath: sandboxChromium } : {};
  // Headless Firefox on a CI machine with no graphics card refuses WebGL
  // ("AllowWebgl2:false restricts context creation"), so nothing would be
  // drawn; these let it use its software renderer, as Chromium does.
  // Headless, it still found no GL driver ("Exhausted GL driver options"),
  // so CI runs it with a window on a virtual screen (xvfb-run, E2E_HEADED=1)
  // and Mesa's software GL.
  if (browserName === "firefox") options.firefoxUserPrefs = { "webgl.force-enabled": true, "webgl.disabled": false, "webgl.enable-webgl2": true };
  if (process.env.E2E_HEADED) options.headless = false;
  return ENGINES[browserName].launch(options).then(underTestCSP);
}

/**
 * The app's Content Security Policy (index.html, audit S10) refuses strings
 * run as script, and Playwright's waitForFunction polls by evaluating one in
 * the page, so every context these tests open bypasses the policy unless it
 * passes `bypassCSP: false`. e2e/framing.mjs does, and checks the app under
 * the real policy there (the kernel's WebAssembly, what it refuses).
 */
function underTestCSP(browser) {
  const newContext = browser.newContext.bind(browser);
  const newPage = browser.newPage.bind(browser);
  browser.newContext = (options = {}) => newContext({ bypassCSP: true, ...options });
  browser.newPage = (options = {}) => newPage({ bypassCSP: true, ...options });
  return browser;
}
