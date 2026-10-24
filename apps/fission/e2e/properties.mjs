// Design's properties panel folds away on a wide screen until something is
// selected or a tool runs (U0b, workspaces/design/src/properties-fold.ts).
// Checks that type into its size boxes or press its buttons with nothing
// selected pin it open first, as a person would with its button; the pin is
// kept in the browser's storage, so it holds through reloads in that context.
// At phone width (and in split view) there is no button and nothing folds.

/** Pins the panel open when it is folded; a no-op where it does not fold. */
export async function pinProperties(page) {
  const handle = page.locator("#properties-handle");
  if (!(await handle.isVisible())) return;
  if ((await handle.getAttribute("aria-expanded")) === "false") await handle.click();
  await page.waitForFunction(() => !document.querySelector("#properties")?.hasAttribute("data-folded"));
}

/**
 * Runs `clicks` with the panel folded away (its button's Fold), as a person
 * folds it to see the part under it: on a wide screen the sketch's panel
 * floats over the view's right side, where some checks click. A panel
 * that was shown is shown again afterwards with its button, as the person
 * would to reach the sketch's Extrude: that pins it (folding a pinned panel
 * unpins it, and pressing a folded one pins it). A no-op where nothing folds.
 */
export async function withPropertiesFolded(page, clicks) {
  const handle = page.locator("#properties-handle");
  if (!(await handle.isVisible())) return clicks();
  const shown = (await handle.getAttribute("aria-expanded")) === "true";
  if (shown) await handle.click();
  await page.waitForFunction(() => document.querySelector("#properties")?.hasAttribute("data-folded"));
  await clicks();
  if (shown) await pinProperties(page);
}
