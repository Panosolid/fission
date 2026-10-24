import { test } from "node:test";
import assert from "node:assert/strict";
import { MENU_GAP, menuButton, menuPlace, type MenuSection } from "../src/menu-button.ts";

const { Window } = await import("happy-dom");

test("hand-worked: the menu goes under the button, moved in from the window's edges", () => {
  // A button at x 100, y 40 to 70 in a 1280 × 720 window; a 200 × 300 menu fits under it: left 100, top 70 + 4.
  assert.deepEqual(menuPlace({ left: 100, top: 40, bottom: 70 }, { width: 200, height: 300 }, { width: 1280, height: 720 }), { left: 100, top: 74 });
  // At x 300 on a 375 px phone the 200 px menu would end at 500: moved left to 375 − 200 − 4 = 171.
  assert.deepEqual(menuPlace({ left: 300, top: 40, bottom: 70 }, { width: 200, height: 300 }, { width: 375, height: 667 }), { left: 171, top: 74 });
  // A button near the bottom (y 600 to 630) of a 720 px window: 630 + 4 + 300 = 934 > 716, so above it: 600 − 4 − 300 = 296.
  assert.deepEqual(menuPlace({ left: 10, top: 600, bottom: 630 }, { width: 200, height: 300 }, { width: 1280, height: 720 }), { left: 10, top: 296 });
  // A menu wider than the window keeps its left edge on the screen.
  assert.equal(menuPlace({ left: 10, top: 0, bottom: 30 }, { width: 500, height: 100 }, { width: 375, height: 667 }).left, MENU_GAP);
});

function made(sections: () => MenuSection[]) {
  const window = new Window();
  const doc = window.document as unknown as Document;
  const m = menuButton(doc, { id: "insert", label: "Insert", title: "Add a ready-made shape", sections });
  doc.body.append(m.element);
  const key = (el: Element, k: string) => el.dispatchEvent(new window.KeyboardEvent("keydown", { key: k, bubbles: true }) as unknown as Event);
  return { doc, m, key, window };
}

test("a click opens and closes it; choosing runs the item and closes; an off item does nothing", () => {
  const ran: string[] = [];
  const { doc, m } = made(() => [
    { heading: "Presets", items: [{ id: "insert-box", label: "Box", data: { shape: "box" }, run: () => ran.push("box") }] },
    { heading: "From Community", items: [{ id: "insert-community", label: "Community models", off: "Comes with Community", run: () => ran.push("community") }] },
  ]);
  assert.equal(m.button.textContent, "Insert ▾");
  assert.equal(m.menu.hidden, true);
  m.button.click();
  assert.equal(m.menu.hidden, false);
  assert.equal(m.button.getAttribute("aria-expanded"), "true");
  assert.deepEqual([...m.menu.querySelectorAll(".menu-button-heading")].map((h) => h.textContent), ["Presets", "From Community"]);
  const box = doc.getElementById("insert-box")!;
  assert.equal(box.dataset.shape, "box");
  const off = doc.getElementById("insert-community")!;
  assert.equal(off.getAttribute("aria-disabled"), "true");
  assert.equal(off.getAttribute("title"), "Comes with Community", "an off item says why");
  off.click();
  assert.deepEqual(ran, [], "an off item runs nothing");
  assert.equal(m.isOpen, true, "and leaves the menu open");
  box.click();
  assert.deepEqual(ran, ["box"]);
  assert.equal(m.isOpen, false, "a choice closes it");
  m.button.click();
  m.button.click();
  assert.equal(m.isOpen, false, "a second click closes it");
});

test("the keyboard: ArrowDown opens on the first item, arrows wrap past the off one, Escape closes and gives the focus back", () => {
  const { doc, m, key } = made(() => [{ items: ["a", "b", "c"].map((id) => ({ id, label: id.toUpperCase(), off: id === "b" ? "off" : undefined, run: () => {} })) }]);
  let leaked = 0;
  doc.addEventListener("keydown", () => leaked++);
  m.button.focus();
  key(m.button, "ArrowDown");
  assert.equal(m.isOpen, true);
  assert.equal(doc.activeElement?.id, "a");
  key(doc.activeElement!, "ArrowDown");
  assert.equal(doc.activeElement?.id, "c", "the off item is skipped");
  key(doc.activeElement!, "ArrowDown");
  assert.equal(doc.activeElement?.id, "a", "and the list wraps");
  key(doc.activeElement!, "End");
  assert.equal(doc.activeElement?.id, "c");
  key(doc.activeElement!, "Escape");
  assert.equal(m.isOpen, false);
  assert.equal(doc.activeElement, m.button, "the focus goes back to the button");
  assert.equal(leaked, 0, "the menu's own keys never reach the app's shortcuts (Escape would clear the selection too)");
  key(m.button, "Escape");
  assert.equal(leaked, 1, "with the menu closed, Escape is the app's again");
});

test("a press outside closes it; the sections are read again each time it opens", () => {
  let n = 1;
  const { doc, m, window } = made(() => [{ items: [{ id: `item-${n}`, label: `Item ${n}`, run: () => {} }] }]);
  m.open();
  assert.ok(doc.getElementById("item-1"));
  doc.body.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true }) as unknown as Event);
  assert.equal(m.isOpen, false);
  n = 2;
  m.open();
  assert.equal(doc.getElementById("item-1"), null);
  assert.ok(doc.getElementById("item-2"), "a section's items as they are now");
  m.menu.querySelector("button")!.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true }) as unknown as Event);
  assert.equal(m.isOpen, true, "a press inside keeps it open");
});
