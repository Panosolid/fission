// Browser check of the AI assistant (AI2): a request becomes Design's own
// set_part command, shown as a preview that changes nothing; Accept is one
// "AI: …" undo step, Reject and a stale preview change nothing; a remote
// provider is shown exactly what it will be sent before the first request,
// and the key goes only to its own provider. No model is used: the
// browser's requests to Ollama and to the API are answered here
// (page.route), so the real provider code runs and nothing leaves this
// machine. Volumes are worked out by hand from V = width · depth · height.
// AI6: opening the panel picks an AI that runs on this computer (the
// browser's built-in model first, then a running Ollama), greys out what
// can't run, asks Ollama nothing until the user looks for it and lists it
// only once it answers, recognises a pasted key
// and lists the models it can use. WebGPU is taken away in every page so
// the in-browser model is never found, whatever the machine running this.
// Run with `npm run e2e` (after `npm run build`).
import assert from "node:assert/strict";
import { launch } from "./browser.mjs";
import { preview } from "vite";

const server = await preview({ preview: { port: 4181, strictPort: true }, logLevel: "error" });
const url = "http://localhost:4181/";
const browser = await launch();
const errors = [];
const KEY = "sk-ant-test-e2e-0123456789";
const REMOTE_OLLAMA = "http://192.168.1.50:11434"; // another computer on the local network
const OPENAI_KEY = "sk-proj-test-e2e-0123456789";

/**
 * A fresh page with a fake Ollama and fake Anthropic and OpenAI APIs;
 * `answers` are what the model says, in order. `ollama: false` refuses
 * Ollama's address as if nothing listens there; `builtIn` gives the page a
 * built-in model that answers from `answers` too. Model lists asked for
 * are recorded in `listed`, requests to a model in `asked`.
 */
async function fresh(answers = [], { ollama = true, builtIn = false, open = true } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.addInitScript(() => indexedDB.deleteDatabase("fission"));
  await page.addInitScript(() => Object.defineProperty(Navigator.prototype, "gpu", { get: () => undefined, configurable: true }));
  const builtInAsked = [];
  if (builtIn) {
    await page.exposeFunction("builtInAnswer", (input) => (builtInAsked.push(input), answers.shift() ?? "{}"));
    await page.addInitScript(() => {
      globalThis.LanguageModel = {
        availability: async () => "available",
        create: async () => ({ prompt: (input) => globalThis.builtInAnswer(input), destroy() {} }),
      };
    });
  }
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    // With no Ollama the browser logs the refused connection to it; that is the point of the check.
    if (m.type() === "error" && !(ollama === false && /Failed to load resource/.test(m.text()))) errors.push(m.text());
  });
  const asked = [];
  const listed = [];
  const ollamaHits = [];
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "content-type": "application/json" };
  const fakeOllama = (hits) => async (route) => {
    const req = route.request();
    hits.push(req.url());
    if (!ollama) return route.abort("connectionrefused");
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    if (req.url().endsWith("/api/tags")) return route.fulfill({ headers: cors, body: JSON.stringify({ models: [{ name: "qwen2.5:1.5b" }] }) });
    asked.push({ url: req.url(), headers: req.headers(), body: req.postDataJSON() });
    return route.fulfill({ headers: cors, body: JSON.stringify({ message: { role: "assistant", content: answers.shift() ?? "{}" } }) });
  };
  await context.route("http://localhost:11434/**", fakeOllama(ollamaHits));
  await context.route("http://127.0.0.1:11434/**", fakeOllama(ollamaHits)); // the same Ollama by its address
  // Ollama on another computer on the local network (audit S3).
  const remoteHits = [];
  await context.route(`${REMOTE_OLLAMA}/**`, fakeOllama(remoteHits));
  await context.route("https://api.anthropic.com/**", async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    if (req.method() === "GET" && new URL(req.url()).pathname === "/v1/models") {
      listed.push({ url: req.url(), headers: req.headers() });
      return route.fulfill({ headers: cors, body: JSON.stringify({ data: [{ id: "claude-opus-5-5" }, { id: "claude-haiku-5-5" }], has_more: false }) });
    }
    asked.push({ url: req.url(), headers: req.headers(), body: req.postDataJSON() });
    const input = JSON.parse(answers.shift() ?? "{}");
    return route.fulfill({ headers: cors, body: JSON.stringify({ content: [{ type: "tool_use", name: "answer", input }] }) });
  });
  await context.route("https://api.openai.com/**", async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    if (req.method() === "GET" && new URL(req.url()).pathname === "/v1/models") {
      listed.push({ url: req.url(), headers: req.headers() });
      return route.fulfill({ headers: cors, body: JSON.stringify({ data: [{ id: "gpt-5-mini" }, { id: "whisper-1" }, { id: "gpt-5" }] }) });
    }
    asked.push({ url: req.url(), headers: req.headers(), body: req.postDataJSON() });
    return route.fulfill({ headers: cors, body: JSON.stringify({ choices: [{ message: { content: answers.shift() ?? "{}" } }] }) });
  });
  await page.goto(url + "#design");
  await volume(page, "24,000 mm³"); // the default box: 40 · 30 · 20
  if (open) await page.click("#assistant-toggle");
  return { page, asked, listed, builtInAsked, ollamaHits, remoteHits };
}
const looked = (page) => page.waitForFunction(() => !/Looking/.test(document.querySelector("#ai-found").textContent) && document.querySelector("#ai-found").textContent !== "");
/** Pastes `text` into the key box the way a real paste arrives (an input event of type insertFromPaste). */
async function paste(page, selector, text) {
  await page.evaluate(
    ([sel, t]) => {
      const input = document.querySelector(sel);
      input.value = t;
      input.dispatchEvent(new InputEvent("input", { inputType: "insertFromPaste", data: t, bubbles: true }));
    },
    [selector, text],
  );
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
/** Look for Ollama: it is found running and, with nothing chosen yet, chosen with the model it has. */
async function useOllama(page) {
  await looked(page);
  await page.click("#ai-detect");
  await page.waitForFunction(() => document.querySelector("#assistant-toggle").textContent === "AI Ollama");
  await page.waitForFunction(() => document.querySelector("#ai-model-pick").value === "qwen2.5:1.5b");
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
  await check("opening the panel asks Ollama nothing; Look for Ollama finds it and picks it with the model it has, asking the model nothing", async () => {
    const { page, asked, ollamaHits } = await fresh([], { open: false });
    try {
      assert.equal(await page.textContent("#assistant-toggle"), "AI off", "nothing is looked for before the panel opens");
      await page.click("#assistant-toggle");
      await looked(page);
      assert.deepEqual(ollamaHits, [], "no request to an address on this computer until the user asks");
      assert.equal(await page.$eval('#ai-provider option[value="ollama"]', (o) => o.hidden), true);
      await useOllama(page);
      await looked(page);
      assert.match(await page.textContent("#ai-found"), /Chose Ollama on your computer for you/);
      assert.equal(await page.isVisible("#ai-model"), false, "the model comes from the list, not a typed name");
      assert.equal(await page.isDisabled("#ai-ask-button"), false);
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
    const { page, asked, listed } = await fresh([JSON.stringify({ commands: [{ op: "set_part", shape: "sphere", width: 30, depth: 30, height: 20 }] })]);
    try {
      await useOllama(page);
      await page.selectOption("#ai-provider", "api-key");
      assert.match(await page.textContent("#ai-key-state"), /No key saved for https:\/\/api.anthropic.com. Saving one asks https:\/\/api.anthropic.com which models it can use; only the key is sent/);
      await page.fill("#ai-key", KEY);
      assert.match(await page.textContent("#ai-key-state"), /This is an Anthropic key: Save key to use it/, "a typed key waits for Save key");
      assert.equal(listed.length, 0);
      await page.click("#ai-key-save");
      await page.waitForFunction(() => document.querySelector("#ai-model-pick").value === "claude-haiku-5-5");
      assert.deepEqual(listed.map((l) => [l.url, l.headers["x-api-key"]]), [["https://api.anthropic.com/v1/models?limit=1000", KEY]]);
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
      assert.equal(asked[0].body.model, "claude-haiku-5-5", "the model chosen from the list");
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

  await check("Ollama at another computer's address: said so, its check asks nothing, the first question is shown before it is sent", async () => {
    const { page, asked, remoteHits } = await fresh([setPart("box", 50, 30, 20), setPart("box", 60, 30, 20)]);
    try {
      await useOllama(page);
      await page.fill("#ai-endpoint", REMOTE_OLLAMA);
      await page.press("#ai-endpoint", "Tab"); // a change event, as leaving the box gives
      await page.waitForFunction(() => document.querySelector("#ai-model-pick").value === "qwen2.5:1.5b");
      assert.equal(
        await page.textContent("#ai-status-detail"),
        `Using Ollama at ${REMOTE_OLLAMA}, which is not this computer: your requests go there, and the first one is shown to you before it is sent.`,
      );
      assert.match(await page.getAttribute("#assistant-toggle", "title"), /sends requests to the provider/);
      // The check only asks it which models it has (GET /api/tags, nothing of the user's), so no box.
      await page.click("#ai-check");
      await page.waitForFunction(() => document.querySelector("#ai-check-result").textContent === "Ready.");
      assert.equal(await page.isVisible("#ai-consent"), false);
      assert.deepEqual(remoteHits.filter((u) => !u.endsWith("/api/tags")), [], "only model lists so far");
      // The first question: shown exactly, no key mentioned, and Don't send sends nothing.
      await ask(page, "Make it 10 mm wider.");
      await page.waitForSelector("#ai-consent");
      const shown = await page.textContent("#ai-consent");
      assert.match(shown, new RegExp(`first request to ${REMOTE_OLLAMA}\\. Exactly this will be sent to ${REMOTE_OLLAMA}/api/chat \\(headers: content-type\\)`));
      assert.match(shown, /"content": "Make it 10 mm wider."/);
      assert.equal(shown.includes("your key"), false, "no key goes to Ollama, so none is mentioned");
      await page.click("#ai-cancel");
      await page.waitForSelector("#ai-result .ai-error");
      assert.match(await page.textContent("#ai-result"), /nothing was sent/);
      assert.equal(asked.length, 0);
      // Asked again and sent: it goes to that address only; the next question needs no box.
      await ask(page, "Make it 10 mm wider.");
      await page.click("#ai-send");
      await page.waitForSelector("#ai-preview");
      assert.deepEqual(asked.map((a) => a.url), [`${REMOTE_OLLAMA}/api/chat`]);
      await page.click("#ai-reject");
      await ask(page, "Make it 20 mm wider.");
      await page.waitForSelector("#ai-preview");
      assert.equal(await page.isVisible("#ai-consent"), false);
      assert.deepEqual(asked.map((a) => a.url), [`${REMOTE_OLLAMA}/api/chat`, `${REMOTE_OLLAMA}/api/chat`]);
      if (process.env.E2E_SHOTS) await page.screenshot({ path: `${process.env.E2E_SHOTS}/remote-ollama.png` });
      // Back to this computer: said so again.
      await page.fill("#ai-endpoint", "http://127.0.0.1:11434");
      await page.press("#ai-endpoint", "Tab"); // a change event, as leaving the box gives
      assert.match(await page.textContent("#ai-status-detail"), /nothing leaves your machine/);
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
      await page.waitForFunction(() => document.querySelector("#ai-model-pick").value === "qwen2.5:1.5b");
      await page.click('[data-workspace="laser"]');
      assert.equal(await page.isDisabled("#ai-ask-button"), true);
      assert.match(await page.textContent("#ai-ask-note"), /can change Design's part/);
      assert.match(await page.textContent("#assistant"), /Planned in Laser.*finger-joint boxes/s);
    } finally {
      await page.close();
    }
  });

  await check("without a usable graphics card the in-browser option is greyed out with the reason and another way", async () => {
    const { page } = await fresh();
    try {
      await looked(page);
      const option = await page.$eval('#ai-provider option[value="in-browser"]', (o) => ({ disabled: o.disabled, text: o.textContent }));
      assert.deepEqual(option, { disabled: true, text: "In your browser (can't run here)" });
      assert.match(await page.textContent("#ai-found"), /In your browser can't run here: this browser has no WebGPU/);
      assert.match(await page.textContent("#ai-found"), /Ollama on your computer, or an API key, will work instead/);
    } finally {
      await page.close();
    }
  });

  await check("nothing local found: stays off and says what would work; Ollama isn't listed even when looked for; the API key still is", async () => {
    const { page, asked, ollamaHits } = await fresh([], { ollama: false });
    try {
      await looked(page);
      assert.equal(ollamaHits.length, 0);
      assert.doesNotMatch(await page.textContent("#ai-found"), /OLLAMA_ORIGINS/, "no Ollama set-up talk until the user looks for it");
      await page.click("#ai-detect");
      await page.waitForFunction(() => /OLLAMA_ORIGINS/.test(document.querySelector("#ai-found").textContent));
      assert.equal(ollamaHits.length, 1);
      assert.equal(await page.textContent("#assistant-toggle"), "AI off");
      assert.equal(await page.isDisabled("#ai-ask-button"), true);
      assert.match(await page.textContent("#ai-ask-note"), /Choose a provider/);
      assert.match(await page.textContent("#ai-found"), /No AI that runs on this computer was found/);
      assert.equal(await page.$eval('#ai-provider option[value="ollama"]', (o) => o.hidden && o.disabled), true, "Ollama is listed only while it runs");
      assert.equal(await page.$eval('#ai-provider option[value="api-key"]', (o) => o.disabled || o.hidden), false);
      assert.equal(asked.length, 0);
    } finally {
      await page.close();
    }
  });

  await check("the browser's built-in model is picked first, and asking it works with nothing sent anywhere", async () => {
    const { page, asked, builtInAsked } = await fresh([setPart("box", 50, 30, 20)], { builtIn: true });
    try {
      await page.waitForFunction(() => document.querySelector("#assistant-toggle").textContent === "AI built-in");
      assert.match(await page.textContent("#ai-found"), /Chose Your browser's built-in AI for you/);
      assert.equal(await page.isVisible("#ai-model-pick"), false, "the built-in model has no model to choose");
      await ask(page, "Make it 50 wide.");
      await page.waitForSelector("#ai-preview");
      await page.click("#ai-accept");
      await volume(page, "30,000 mm³"); // 50 · 30 · 20
      assert.deepEqual(builtInAsked, ["Make it 50 wide."]);
      assert.equal(asked.length, 0, "nothing went to Ollama or an API");
    } finally {
      await page.close();
    }
  });

  await check("choosing Off is kept: the next visit doesn't pick for the user again", async () => {
    const { page } = await fresh();
    try {
      await useOllama(page);
      await page.selectOption("#ai-provider", "");
      assert.equal(await page.textContent("#assistant-toggle"), "AI off");
      await page.reload();
      await volume(page, "24,000 mm³");
      await page.click("#assistant-toggle");
      await looked(page);
      await page.click("#ai-detect");
      await page.waitForFunction(() => document.querySelector('#ai-provider option[value="ollama"]').hidden === false);
      assert.equal(await page.textContent("#assistant-toggle"), "AI off", "Ollama is offered, not chosen");
    } finally {
      await page.close();
    }
  });

  await check("a pasted OpenAI key switches to OpenAI, is saved at once and lists its chat models; a typed name still works", async () => {
    const { page, listed } = await fresh();
    try {
      await useOllama(page);
      await page.selectOption("#ai-provider", "api-key");
      assert.equal(await page.inputValue("#ai-vendor"), "anthropic");
      await paste(page, "#ai-key", OPENAI_KEY);
      await page.waitForFunction(() => document.querySelector("#ai-model-pick").value === "gpt-5-mini");
      assert.equal(await page.inputValue("#ai-vendor"), "openai");
      assert.match(await page.textContent("#ai-key-state"), /A key is saved for https:\/\/api.openai.com/);
      assert.equal(await page.inputValue("#ai-key"), "");
      // whisper-1 can't chat, so it is left out: gpt-5 and gpt-5-mini, sorted, then the typed choice.
      assert.deepEqual(await page.$$eval("#ai-model-pick option", (os) => os.map((o) => o.textContent)), ["gpt-5", "gpt-5-mini", "Another (type its name)"]);
      assert.deepEqual(listed.map((l) => [l.url, l.headers.authorization]), [["https://api.openai.com/v1/models", `Bearer ${OPENAI_KEY}`]]);
      await page.selectOption("#ai-model-pick", "");
      assert.equal(await page.isVisible("#ai-model"), true);
      await page.fill("#ai-model", "my-tuned-model");
      await page.dispatchEvent("#ai-model", "change");
      await page.reload();
      await volume(page, "24,000 mm³");
      await page.click("#assistant-toggle");
      await page.waitForFunction(() => document.querySelector("#ai-model").value === "my-tuned-model");
      assert.equal(await page.isVisible("#ai-model"), true, "a name not in the list stays a typed name");
    } finally {
      await page.close();
    }
  });

  await check("a key that can't be told apart isn't guessed: nothing is saved or sent until Save key", async () => {
    const { page, listed } = await fresh();
    try {
      await useOllama(page);
      await page.selectOption("#ai-provider", "api-key");
      await page.selectOption("#ai-vendor", "openai");
      await paste(page, "#ai-key", "sk-0123456789abcdef0123456789abcdef");
      assert.equal(await page.inputValue("#ai-vendor"), "openai", "the chosen provider is left as it is");
      assert.equal(await page.inputValue("#ai-key"), "sk-0123456789abcdef0123456789abcdef", "not saved by itself");
      assert.equal(listed.length, 0, "the key went nowhere");
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
