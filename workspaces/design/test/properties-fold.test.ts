import { test } from "node:test";
import assert from "node:assert/strict";
import { FOLDED_AT_START, HANDLE_ID, PIN_KEY, propertiesFold, panelShown, pressed, readPinned, revealed, withReasons, writePinned, type FoldState, type PinStorage } from "../src/properties-fold.ts";

const at = (s: Partial<FoldState>): FoldState => ({ ...FOLDED_AT_START, ...s });

test("hand-worked: when the panel shows, for every set of reasons", () => {
  // Shown = pinned, or revealed, or (selected or tool) and not dismissed. All 32 states, written out from that rule.
  const rows: [Partial<FoldState>, boolean][] = [];
  for (const pinned of [false, true])
    for (const revealedNow of [false, true])
      for (const selected of [false, true])
        for (const tool of [false, true])
          for (const dismissed of [false, true]) {
            const want = pinned || revealedNow || ((selected || tool) && !dismissed);
            rows.push([{ pinned, revealed: revealedNow, selected, tool, dismissed }, want]);
          }
  assert.equal(rows.length, 32);
  for (const [s, want] of rows) assert.equal(panelShown(at(s)), want, JSON.stringify(s));
  // The four that matter most, by hand: a new project shows nothing; a selection shows it; folded by the user, it stays folded; pinned, always shown.
  assert.equal(panelShown(FOLDED_AT_START), false);
  assert.equal(panelShown(at({ selected: true })), true);
  assert.equal(panelShown(at({ selected: true, dismissed: true })), false);
  assert.equal(panelShown(at({ pinned: true, dismissed: true })), true);
});

test("a session: select, fold it away, select something else, clear", () => {
  let s = FOLDED_AT_START;
  s = withReasons(s, { selected: true });
  assert.equal(panelShown(s), true, "a click on a face opens it");
  s = pressed(s);
  assert.equal(panelShown(s), false, "Fold folds it, though the face is still selected");
  s = withReasons(s, { selected: true });
  assert.equal(s.dismissed, true, "the same reasons again change nothing (a rebuild redraws the selection)");
  s = withReasons(s, { selected: false });
  assert.equal(panelShown(s), false, "cleared: folded, and the dismissal is over");
  assert.equal(s.dismissed, false);
  s = withReasons(s, { selected: true });
  assert.equal(panelShown(s), true, "the next selection opens it again");
});

test("a session: a tool opens it and folds it after; the button pins it through both", () => {
  let s = withReasons(FOLDED_AT_START, { tool: true });
  assert.equal(panelShown(s), true, "Create sketch's box opens it");
  s = withReasons(s, { tool: false });
  assert.equal(panelShown(s), false, "Finish sketch folds it");
  s = pressed(s);
  assert.deepEqual(s, at({ pinned: true }), "the button on a folded panel pins it");
  s = withReasons(withReasons(s, { tool: true }), { tool: false });
  assert.equal(panelShown(s), true, "pinned, a tool's end keeps it shown");
  s = pressed(s);
  assert.equal(panelShown(s), false, "the button on a shown panel folds it and ends the pin");
  assert.equal(s.pinned, false);
});

test("words the user must see open a folded panel until the user moves on", () => {
  let s = revealed(FOLDED_AT_START);
  assert.equal(panelShown(s), true, "an action's note opens it");
  assert.equal(revealed(s), s, "more words change nothing");
  s = withReasons(s, { selected: true });
  s = withReasons(s, { selected: false });
  assert.equal(panelShown(s), false, "a selection made and cleared ends the reveal");
  s = pressed(revealed(FOLDED_AT_START));
  assert.equal(panelShown(s), false, "Fold folds a revealed panel");
  assert.equal(s.pinned, false, "and does not pin it");
  const shown = at({ selected: true });
  assert.equal(revealed(shown), shown, "a shown panel needs no reveal");
});

test("breaking the rule fails: a rule that ignores the dismissal differs on a folded selection", () => {
  const broken = (s: FoldState) => s.pinned || s.revealed || s.selected || s.tool;
  const s = pressed(withReasons(FOLDED_AT_START, { selected: true }));
  assert.notEqual(broken(s), panelShown(s));
});

test("the pin is kept for the next visit, and storage that throws only loses the pin", () => {
  const kept = new Map<string, string>();
  const storage: PinStorage = { getItem: (k) => kept.get(k) ?? null, setItem: (k, v) => void kept.set(k, v), removeItem: (k) => void kept.delete(k) };
  assert.equal(readPinned(storage), false, "nothing kept: folded");
  writePinned(true, storage);
  assert.deepEqual([...kept], [[PIN_KEY, "true"]]);
  assert.equal(readPinned(storage), true);
  writePinned(false, storage);
  assert.equal(kept.size, 0, "unpinned removes the key");
  // A value some other code wrote is not a pin.
  kept.set(PIN_KEY, "yes");
  assert.equal(readPinned(storage), false);
  const refusing: PinStorage = {
    getItem: () => {
      throw new Error("SecurityError");
    },
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
    removeItem: () => {
      throw new Error("SecurityError");
    },
  };
  assert.equal(readPinned(refusing), false);
  assert.doesNotThrow(() => writePinned(true, refusing));
  assert.equal(readPinned(null), false, "no storage at all");
});

const { Window } = await import("happy-dom");
/** A tick for the MutationObserver's records to be delivered. */
const settle = () => new Promise((r) => setTimeout(r, 0));

test("in a real DOM: folded at the start, a tool's box opens it, the button pins it and the pin is kept", async () => {
  const doc = new Window().document as unknown as Document;
  const slot = doc.createElement("aside");
  slot.id = "properties";
  const boxes = ["sketch-panel", "extrude-panel", "feature-edit"].map((id) => {
    const b = doc.createElement("section");
    b.id = id;
    b.hidden = true;
    slot.append(b);
    return b;
  });
  doc.body.append(slot);
  const kept = new Map<string, string>();
  const storage: PinStorage = { getItem: (k) => kept.get(k) ?? null, setItem: (k, v) => void kept.set(k, v), removeItem: (k) => void kept.delete(k) };
  const fold = propertiesFold(slot, boxes, FOLDED_AT_START, storage);
  const handle = slot.querySelector<HTMLButtonElement>(`#${HANDLE_ID}`)!;
  assert.equal(slot.firstElementChild, handle, "the button comes first, above the tool boxes");
  assert.equal(slot.hasAttribute("data-folded"), true);
  assert.equal(handle.getAttribute("aria-expanded"), "false");
  assert.equal(handle.textContent, "Properties ‹");
  boxes[1].hidden = false; // the Extrude panel opens
  await settle();
  assert.equal(slot.hasAttribute("data-folded"), false, "a tool's box shown opens the panel");
  assert.equal(handle.textContent, "Fold ›");
  boxes[1].hidden = true;
  await settle();
  assert.equal(slot.hasAttribute("data-folded"), true, "and its end folds it");
  fold.update({ selected: true });
  assert.equal(slot.hasAttribute("data-folded"), false, "a selection opens it");
  fold.update({ selected: false });
  handle.click();
  assert.equal(slot.hasAttribute("data-folded"), false, "the button opens it with nothing selected");
  assert.equal(kept.get(PIN_KEY), "true", "and the pin is kept for the next visit");
  slot.dispatchEvent(new (doc.defaultView as unknown as { Event: typeof Event }).Event("properties-words"));
  handle.click();
  assert.equal(slot.hasAttribute("data-folded"), true, "the button folds it");
  assert.equal(kept.has(PIN_KEY), false);
  slot.dispatchEvent(new (doc.defaultView as unknown as { Event: typeof Event }).Event("properties-words"));
  assert.equal(slot.hasAttribute("data-folded"), false, "new words open a folded panel");
  fold.close();
  boxes[0].hidden = false;
  await settle();
  assert.equal(fold.state.tool, false, "closed, it watches nothing");
});
