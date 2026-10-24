// A new project starts empty (U0c, the owner's ask): checks that need a
// part to work on add one first, as a person would, with Insert ▾ (U0d).

import { pinProperties } from "./properties.mjs";

/** Adds a preset as a new body by Insert ▾ (`kind`: box, cylinder, sphere, l-bracket, plate, slot, star). */
export async function insertPreset(page, kind = "box", tap = false) {
  const press = (sel) => (tap ? page.tap(sel) : page.click(sel));
  await press("#insert");
  await press(`#insert-${kind}`);
}

/**
 * The part most checks start from: the 40 × 30 × 20 mm box (V = 40 · 30 · 20
 * = 24,000 mm³), inserted into the empty design a fresh page opens with
 * (its hint showing says it is empty) and built.
 */
export async function startWithBox(page, tap = false) {
  await page.waitForSelector("#start-hint", { state: "visible" });
  await insertPreset(page, "box", tap);
  await page.waitForFunction(() => document.querySelector("#volume")?.textContent === "24,000 mm³");
}

/** Changes the part's shape with the properties' Shape choice (the toolbar's shape buttons until U0d). */
export async function chooseShape(page, kind) {
  await pinProperties(page);
  await page.selectOption("#shape", kind);
}
