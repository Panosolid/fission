// Phone width with a finger (Chromium CDP touch): a long timeline that scrolls.
import { readFileSync } from "node:fs";
import * as H from "./lib.mjs";
const env = await H.start(4246);
const T = JSON.parse(readFileSync(new URL("./template.json", import.meta.url), "utf8"));
const d = T.workspaces.design;
const box = d.timeline.features[0];
for (let i = 0; i < 9; i++) {
  const id = `feature-${12 + i}`;
  d.timeline.features.push({ ...JSON.parse(JSON.stringify(box)), id, intent: { ...box.intent, parameters: { width: 5 + i, depth: 5, height: 5 }, summary: `Box: ${5 + i} × 5 × 5 mm` }, provenance: { from: [], self: { id, label: `Feature ${4 + i} (box)`, workspace: "design" } } });
}
d.nextId = 30;
const FILE = JSON.stringify(T);
const show = async (page, what) => console.log(what.padEnd(40), "|", await H.bar(page), "|", (await H.undoTitle(page)).replace(" (Ctrl+Z)", ""), "| err:", await H.errLine(page));
const scroll = (page) => page.$eval("#timeline .timeline-bar", (l) => [l.scrollLeft, l.scrollWidth, l.clientWidth]);
try {
  const page = await H.fresh(env, 375, true);
  const cdp = await page.context().newCDPSession(page);
  const touch = async (type, pts) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts });
  await H.openText(page, FILE);
  await show(page, "opened 12 items");
  console.log("  scroll:", await scroll(page), "page overflow:", await page.evaluate(() => document.documentElement.scrollWidth));
  // swipe the row left with a finger on an unpicked item
  const b = await page.locator('#timeline [data-item="feature-14"]').boundingBox();
  const y = b.y + b.height / 2;
  await touch("touchStart", [{ x: 300, y }]);
  for (let k = 1; k <= 10; k++) await touch("touchMove", [{ x: 300 - 25 * k, y }]);
  await touch("touchEnd", []);
  await page.waitForTimeout(400);
  console.log("  scroll after swipe:", await scroll(page));
  await show(page, "after swipe");
  // tap a gap now that the row is scrolled: between the two last visible items
  const gaps = await page.evaluate(() => { const lis = [...document.querySelectorAll("#timeline .timeline-bar-item")]; const out = []; for (let i = 1; i < lis.length; i++) { const a = lis[i - 1].getBoundingClientRect(), c = lis[i].getBoundingClientRect(); const x = (a.right + c.left) / 2; if (x > 20 && x < 355) out.push([i, x, a.top + a.height / 2]); } return out; });
  const [place, gx, gy] = gaps[Math.floor(gaps.length / 2)];
  await page.touchscreen.tap(gx, gy);
  await H.settle(page);
  await show(page, `tapped gap at place ${place}`);
  // two fingers: one on the marker, one on a picked item, both moving
  await page.touchscreen.tap(gaps[0][1] + 0, gaps[0][2]); await H.settle(page);
  const firstItem = await page.$eval("#timeline .timeline-bar-item", (li) => li.dataset.item);
  const ids = await page.$$eval("#timeline .timeline-bar-item", (l) => l.map((x) => x.dataset.item));
  const target = ids.find((id) => id.startsWith("feature-1") && id !== "feature-1" && id !== "feature-11");
  await page.tap(`#timeline [data-item="${target}"]`); await H.settle(page);
  await show(page, `picked ${target}`);
  const ib = await page.locator(`#timeline [data-item="${target}"]`).boundingBox();
  const mb = await page.locator("#timeline .timeline-bar-marker").boundingBox();
  console.log("  item at", Math.round(ib.x), "marker at", Math.round(mb.x));
  const p1 = { x: ib.x + ib.width / 2, y: ib.y + ib.height / 2, id: 1 }, p2 = { x: mb.x + mb.width / 2, y: mb.y + mb.height / 2, id: 2 };
  await touch("touchStart", [p1, p2]);
  for (let k = 1; k <= 8; k++) await touch("touchMove", [{ ...p1, x: p1.x - 12 * k }, { ...p2, x: p2.x + 12 * k }]);
  await touch("touchEnd", []);
  await H.settle(page);
  await show(page, "two-finger: item left, marker right");
  console.log("  menu open:", await page.evaluate(() => document.getElementById("row-menu").open), "errors:", page.errors);
  // long press on an item (contextmenu?)
  const lb = await page.locator('#timeline [data-item="feature-1"]').boundingBox();
  await page.locator('#timeline [data-item="feature-1"]').scrollIntoViewIfNeeded();
  const lb2 = await page.locator('#timeline [data-item="feature-1"]').boundingBox();
  await touch("touchStart", [{ x: lb2.x + 5, y: lb2.y + 5 }]); await page.waitForTimeout(1200); await touch("touchEnd", []);
  await page.waitForTimeout(400);
  console.log("  after long press: menu open:", await page.evaluate(() => document.getElementById("row-menu").open));
  // ⋯ of the last item: does the menu fit the screen?
  const last = ids[ids.length - 1];
  await page.locator(`#timeline [data-item="${last}"]`).scrollIntoViewIfNeeded();
  await page.tap(`#timeline [data-item="${last}"]`).catch((e) => console.log("tap last failed", e.message.slice(0, 80)));
  await H.settle(page);
  await page.locator(`#timeline [data-more="${last}"]`).scrollIntoViewIfNeeded().catch(() => {});
  const more = await page.locator(`#timeline [data-more="${last}"]`).boundingBox().catch(() => null);
  console.log("  last item's ⋯ box:", more && [Math.round(more.x), Math.round(more.x + more.width)]);
  if (more) { await page.tap(`#timeline [data-more="${last}"]`); await page.waitForTimeout(300); console.log("  menu box:", await page.locator("#row-menu").boundingBox()); }
  await page.screenshot({ path: "/tmp/claude-0/hunt/phone-long-menu.png" });
  console.log("  errors:", page.errors, "page width:", await page.evaluate(() => document.documentElement.scrollWidth));
} finally { await env.browser.close(); await env.server.close(); }
