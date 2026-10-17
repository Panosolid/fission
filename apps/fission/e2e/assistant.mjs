// Browser check of the AI assistant (AI2): a request becomes Design's own
// set_part command, shown as a preview that changes nothing; Accept is one
// "AI: …" undo step, Reject and a stale preview change nothing; a remote
// provider is shown exactly what it will be sent before the first request,
// and the key goes only to its own provider. No model is used: the
// browser's requests to Ollama and to the API are answered here
// (page.route), so the real provider code runs and nothing leaves this
// machine. Volumes are worked out by hand from V = width · depth · height.
// Run with `npm run e2e` (after `npm run build`).
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { preview } from "vite";

const server = await preview({ preview: { port: 4181, strictPort: true }, logLevel: "error" });
const url = "http://localhost:4181/";
const sandboxChromium = "/opt/pw-browsers/chromium";
const browser = await chromium.launch(existsSync(sandboxChromium) ? { executablePath: sandboxChromium } : {});
const errors = [];
const KEY = "sk-ant-test-e2e-0123456789";

/** A fresh page with a fake Ollama and a fake Anthropic API; `answers` are what the model says, in order. */
async function fresh(answers = []) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.addInitScript(() => indexedDB.deleteDatabase("fission"));
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  const asked = [];
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "content-type": "application/json" };
  await context.route("http://localhost:11434/**", async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    if (req.url().endsWith("/api/tags")) return route.fulfill({ headers: cors, body: JSON.stringify({ models: [{ name: "qwen2.5:1.5b" }] }) });
    asked.push({ url: req.url(), headers: req.headers(), body: req.postDataJSON() });
    return route.fulfill({ headers: cors, body: JSON.stringify({ message: { role: "assistant", content: answers.shift() ?? "{}" } }) });
  });
  await context.route("https://api.anthropic.com/**", async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    asked.push({ url: req.url(), headers: req.headers(), body: req.postDataJSON() });
    const input = JSON.parse(answers.shift() ?? "{}");
    return route.fulfill({ headers: cors, body: JSON.stringify({ content: [{ type: "tool_use", name: "answer", input }] }) });
  });
  await page.goto(url + "#design");
  await volume(page, "24,000 mm³"); // the default box: 40 · 30 · 20
  await page.click("#assistant-toggle");
  return { page, asked };
}
async function volume(page, text) {
  try {
    await page.waitForFunction((t) => document.querySelector("#volume")?.textContent === t, text, { timeout: 5000 });
  } catch {
    assert.fail(`volume: expected ${text}, saw ${await page.textContent("#volume")}`);
  }
}
const undoTitle = (page) => page.getAttribute("#undo", "title");
const setPart = (shape, width, depth, height) => JSON.stringify({ commands: [{ op: "set_part", shape, width, depth, height }] });
async function useOllama(page) {
  await page.selectOption("#ai-provider", "ollama");
  await page.fill("#ai-model", "qwen2.5:1.5b");
  await page.dispatchEvent("#ai-model", "change");
}
async function ask(page, words) {
  await page.fill("#ai-prompt", words);
  await page.click("#ai-ask-button");
}

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
  await check("off until chosen: nothing to ask with, nothing sent; Ollama's check finds the model", async () => {
    const { page, asked } = await fresh();
    try {
      assert.equal(await page.textContent("#assistant-toggle"), "AI off");
      assert.equal(await page.isDisabled("#ai-ask-button"), true);
      assert.match(await page.textContent("#ai-ask-note"), /Choose a provider/);
      await useOllama(page);
      assert.equal(await page.textContent("#assistant-toggle"), "AI Ollama");
      assert.match(await page.textContent("#ai-status-detail"), /nothing leaves your machine/);
      await page.click("#ai-check");
      await page.waitForFunction(() => document.querySelector("#ai-check-result").textContent === "Ready.");
      assert.equal(asked.length, 0, "a check asks the model nothing");
    } finally {
      await page.close();
    }
  });

  await check("ask, preview (nothing changes), accept as one AI step, undo and redo it whole", async () => {
    const { page, asked } = await fresh([setPart("box", 50, 30, 20)]);
    try {
      await useOllama(page);
      await ask(page, "Make it 10 mm wider.");
      await page.waitForSelector("#ai-preview");
      // What was sent: the part as its command, the user's words, held to the schema.
      const body = asked[0].body;
      assert.equal(asked[0].url, "http://localhost:11434/api/chat");
      assert.match(body.messages[0].content, /"op":"set_part","shape":"box","width":40,"depth":30,"height":20/);
      assert.deepEqual(body.messages[1], { role: "user", content: "Make it 10 mm wider." });
      assert.deepEqual(body.format.properties.commands.items.oneOf.map((s) => s.properties.op.const), ["set_part"], "only set_part: the AI can't download files");
      // The preview: only width moves, 40 → 50; the part is untouched.
      assert.equal(await page.textContent("#ai-preview .ai-label"), "AI: box 50 × 30 × 20 mm");
      assert.deepEqual(await page.$$eval("#ai-preview tr", (rows) => rows.map((r) => r.textContent)), ["width40→50"]);
      await volume(page, "24,000 mm³");
      assert.equal(await undoTitle(page), "Nothing to undo");
      await page.screenshot({ path: "e2e/assistant-preview.png" });
      await page.click("#ai-accept");
      await volume(page, "30,000 mm³"); // 50 · 30 · 20
      assert.equal(await page.inputValue("#width"), "50");
      assert.equal(await undoTitle(page), "Undo AI: box 50 × 30 × 20 mm (Ctrl+Z)");
      await page.click("#undo");
      await volume(page, "24,000 mm³");
      assert.equal(await undoTitle(page), "Nothing to undo", "one step, taken back whole");
      await page.click("#redo");
      await volume(page, "30,000 mm³");
    } finally {
      await page.close();
    }
  });

  await check("reject changes nothing and adds no step; a cylinder preview shows only the sizes it uses", async () => {
    const { page } = await fresh([setPart("cylinder", 25, 30, 60)]);
    try {
      await useOllama(page);
      await ask(page, "I need a cylinder 25 mm across and 60 mm tall.");
      await page.waitForSelector("#ai-preview");
      // A cylinder ignores depth: shape box → cylinder, width 40 → 25, height 20 → 60.
      assert.deepEqual(await page.$$eval("#ai-preview tr", (rows) => rows.map((r) => r.dataset.param)), ["shape", "width", "height"]);
      assert.equal(await page.textContent("#ai-preview .ai-label"), "AI: cylinder ⌀25 × 60 mm");
      await page.click("#ai-reject");
      assert.match(await page.textContent("#ai-result"), /Rejected: nothing was changed/);
      await volume(page, "24,000 mm³");
      assert.equal(await undoTitle(page), "Nothing to undo");
    } finally {
      await page.close();
    }
  });

  await check("an answer that leaves sizes out keeps them: only the width changes, and a sphere needs no depth", async () => {
    const { page } = await fresh([JSON.stringify({ commands: [{ op: "set_part", shape: "box", width: 50 }] }), JSON.stringify({ commands: [{ op: "set_part", shape: "sphere", width: 30 }] })]);
    try {
      await useOllama(page);
      await ask(page, "Make it 10 mm wider.");
      await page.waitForSelector("#ai-preview");
      // Only width is named, so only width changes: 40 → 50, depth 30 and height 20 kept.
      assert.deepEqual(await page.$$eval("#ai-preview tr", (rows) => rows.map((r) => r.dataset.param)), ["width"]);
      assert.equal(await page.textContent("#ai-preview .ai-label"), "AI: box 50 × 30 × 20 mm");
      await page.click("#ai-accept");
      await volume(page, "30,000 mm³"); // 50 · 30 · 20
      assert.equal(await page.inputValue("#depth"), "30");
      await ask(page, "Turn it into a ball 30 mm across.");
      await page.waitForSelector("#ai-preview");
      assert.equal(await page.textContent("#ai-preview .ai-label"), "AI: sphere ⌀30 mm");
      await page.click("#ai-accept");
      await page.waitForFunction(() => document.querySelector("#viewport").dataset.shape === "sphere");
      await page.click("#undo");
      await volume(page, "30,000 mm³");
    } finally {
      await page.close();
    }
  });

  await check("a preview made stale by the user's own edit is refused on Accept", async () => {
    const { page } = await fresh([setPart("box", 50, 30, 20)]);
    try {
      await useOllama(page);
      await ask(page, "Make it 10 mm wider.");
      await page.waitForSelector("#ai-preview");
      await page.fill("#depth", "10");
      await volume(page, "8,000 mm³"); // 40 · 10 · 20
      await page.click("#ai-accept");
      assert.match(await page.textContent("#ai-result"), /changed after this preview.*nothing was changed/s);
      await volume(page, "8,000 mm³");
      assert.equal(await undoTitle(page), "Undo Change depth (Ctrl+Z)");
    } finally {
      await page.close();
    }
  });

  await check("two unusable answers: a clear message, nothing changed", async () => {
    const { page, asked } = await fresh(["not json", setPart("box", -5, 30, 20)]);
    try {
      await useOllama(page);
      await ask(page, "Make it smaller.");
      await page.waitForSelector("#ai-result .ai-error");
      assert.match(await page.textContent("#ai-result"), /even after one retry.*Nothing was changed/s);
      assert.equal(asked.length, 2);
      await volume(page, "24,000 mm³");
      assert.equal(await undoTitle(page), "Nothing to undo");
    } finally {
      await page.close();
    }
  });

  await check("own API key: shown exactly what will be sent first; Don't send sends nothing; the key goes only to its provider", async () => {
    const { page, asked } = await fresh([JSON.stringify({ commands: [{ op: "set_part", shape: "sphere", width: 30, depth: 30, height: 20 }] })]);
    try {
      await page.selectOption("#ai-provider", "api-key");
      assert.match(await page.textContent("#ai-key-state"), /No key saved for https:\/\/api.anthropic.com/);
      await page.fill("#ai-key", KEY);
      await page.click("#ai-key-save");
      assert.match(await page.textContent("#ai-key-state"), /A key is saved for https:\/\/api.anthropic.com, in this browser only/);
      assert.equal(await page.inputValue("#ai-key"), "", "the box is emptied once saved");
      assert.equal(await page.textContent("#assistant-toggle"), "AI API key");
      await ask(page, "A ball with a radius of 15 mm.");
      await page.waitForSelector("#ai-consent");
      const shown = await page.textContent("#ai-consent");
      assert.match(shown, /first request to https:\/\/api.anthropic.com/);
      assert.match(shown, /"content": "A ball with a radius of 15 mm."/);
      assert.match(shown, /x-api-key/);
      assert.equal(shown.includes(KEY), false, "the key itself is never shown");
      await page.click("#ai-cancel");
      await page.waitForSelector("#ai-result .ai-error");
      assert.match(await page.textContent("#ai-result"), /nothing was sent/);
      assert.equal(asked.length, 0);
      await ask(page, "A ball with a radius of 15 mm.");
      await page.click("#ai-send");
      await page.waitForSelector("#ai-preview");
      assert.equal(asked.length, 1);
      assert.equal(asked[0].url, "https://api.anthropic.com/v1/messages");
      assert.equal(asked[0].headers["x-api-key"], KEY);
      assert.equal(JSON.stringify(asked[0].body).includes(KEY), false);
      // A sphere uses only its diameter: 15 mm radius → width 30.
      assert.equal(await page.textContent("#ai-preview .ai-label"), "AI: sphere ⌀30 mm");
      await page.click("#ai-accept");
      await page.waitForFunction(() => document.querySelector("#viewport").dataset.shape === "sphere");
      // The key is only in its own storage slot, never in the project or the page.
      const stored = await page.evaluate(() => Object.fromEntries(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)])));
      assert.deepEqual(Object.entries(stored).filter(([, v]) => v.includes(KEY)).map(([k]) => k), ["fission.ai.key:https://api.anthropic.com"]);
      assert.equal((await page.content()).includes(KEY), false);
      // The second request needs no new confirmation (the first one was agreed to).
      await page.click("#undo");
      await volume(page, "24,000 mm³");
    } finally {
      await page.close();
    }
  });

  await check("settings survive a reload; outside Design there is nothing to ask yet", async () => {
    const { page } = await fresh();
    try {
      await useOllama(page);
      await page.reload();
      await volume(page, "24,000 mm³");
      assert.equal(await page.textContent("#assistant-toggle"), "AI Ollama");
      await page.click("#assistant-toggle");
      assert.equal(await page.inputValue("#ai-model"), "qwen2.5:1.5b");
      await page.click('[data-workspace="laser"]');
      assert.equal(await page.isDisabled("#ai-ask-button"), true);
      assert.match(await page.textContent("#ai-ask-note"), /can change Design's part/);
      assert.match(await page.textContent("#assistant"), /Planned in Laser.*finger-joint boxes/s);
    } finally {
      await page.close();
    }
  });

  await check("in the browser without a usable graphics card: the check says so and suggests another way", async () => {
    const { page } = await fresh();
    try {
      await page.selectOption("#ai-provider", "in-browser");
      await page.click("#ai-check");
      await page.waitForFunction(() => /Not ready/.test(document.querySelector("#ai-check-result").textContent));
      assert.match(await page.textContent("#ai-check-result"), /WebGPU|graphics card/);
      assert.match(await page.textContent("#ai-check-result"), /Ollama on your computer, or an API key, will work instead/);
    } finally {
      await page.close();
    }
  });

  assert.deepEqual(errors, [], "no page errors or console errors");
} catch (e) {
  failed = true;
  console.log(`FAIL ${e.message}`);
} finally {
  await browser.close();
  await new Promise((r) => server.httpServer.close(r));
}
if (failed) process.exit(1);
