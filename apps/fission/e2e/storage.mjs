// Browser check of projects kept in this browser (19b): the real IndexedDB
// adapter under the project store. Serves the source with Vite, saves two
// projects, reloads the page (a fresh JavaScript world, same IndexedDB) and
// checks they come back; then a corrupt stored project is refused with its
// message, and removing one forgets it after another reload.
// Run with `npm run e2e`.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = resolve(import.meta.dirname, "..");
const storage = resolve(root, "../../packages/storage/src/index.ts");
const server = await createServer({ root, logLevel: "error", server: { port: 0, host: "127.0.0.1" } });
await server.listen();
const url = server.resolvedUrls.local[0];

const sandboxChromium = "/opt/pw-browsers/chromium";
const browser = await chromium.launch(existsSync(sandboxChromium) ? { executablePath: sandboxChromium } : {});
let passed = 0;
const check = (name, fn) => {
  fn();
  passed++;
  console.log(`PASS ${name}`);
};

try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // A page with nothing on it, served from the app's origin so it has the app's IndexedDB.
  await page.route(`${url}storage-check`, (r) => r.fulfill({ contentType: "text/html", body: "<!doctype html><title>storage check</title>" }));
  const load = () => page.goto(`${url}storage-check`);
  /** Runs `body` in the page with the storage module as `s` and a store for a Design-like reader as `store`. */
  const inPage = (body) =>
    page.evaluate(
      async ([path, body]) => {
        const s = await import(/* @vite-ignore */ `/@fs${path}`);
        const reader = { id: "design", readData: (d) => ({ ...d, read: true }) };
        const store = s.localStore([reader]);
        const kv = s.indexedDbKeyValue();
        return new Function("s", "store", "kv", `return (async () => { ${body} })()`)(s, store, kv);
      },
      [storage, body],
    );

  await load();
  await inPage(`
    const box = (name, w) => ({ formatVersion: 2, name, units: { length: "mm" }, materials: [], links: [], workspaces: { design: { version: 1, width: w } } });
    await store.save("a", box("Bracket", 50));
    await new Promise((r) => setTimeout(r, 5)); // so the two save times differ
    await store.save("b", box("Lid", 20));
  `);

  await load(); // a fresh page: nothing survives but IndexedDB
  const back = await inPage(`
    const list = await store.list();
    const a = await store.open("a");
    return { list: list.map((x) => [x.id, x.name, typeof x.modified.getTime()]), a };
  `);
  check("both saved projects are listed after a reload, newest first", () =>
    assert.deepEqual(back.list, [["b", "Lid", "number"], ["a", "Bracket", "number"]]),
  );
  check("a stored project opens after a reload, read by its workspace", () => {
    assert.equal(back.a.name, "Bracket");
    assert.deepEqual(back.a.workspaces.design, { version: 1, width: 50, read: true });
  });

  const corrupt = await inPage(`
    await kv.set("project/b", '{"formatVersion": 2, "name": "Lid"'); // cut short
    try { await store.open("b"); return "opened"; } catch (e) { return e.message; }
  `);
  check("a corrupt stored project is refused with its message", () =>
    assert.match(corrupt, /^can't open the stored project "b": not a Fission project: the file is not valid JSON/),
  );

  await inPage(`await store.remove("b");`);
  await load();
  const after = await inPage(`
    const ids = (await store.list()).map((x) => x.id);
    try { await store.open("b"); return { ids, open: "opened" }; } catch (e) { return { ids, open: e.message }; }
  `);
  check("a removed project stays gone after a reload", () => {
    assert.deepEqual(after.ids, ["a"]);
    assert.equal(after.open, 'there is no stored project "b" in this browser');
  });
  check("no page errors", () => assert.deepEqual(errors, []));
} finally {
  await browser.close();
  await server.close();
}
console.log(`${passed} storage checks passed`);
