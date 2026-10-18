import { test } from "node:test";
import assert from "node:assert/strict";
import { createMenuRows, menuMove, sketchToolbar, FINISH_TITLE, type MenuEntry } from "../src/sketch-toolbar.ts";
import { sketchPanel } from "../src/sketch-panel.ts";
import type { ToolKind } from "../src/sketch-tool.ts";

test("the Create menu lists every tool with its key, in the tools' order, the three arcs under one Arc row", () => {
  // Written out by hand: Line L, Rectangle R, Circle C, then Arc opening
  // 3-point arc A, Centre arc (no key) and Tangent arc T.
  const show = (e: MenuEntry): string => ("group" in e ? `${e.group} ▸ [${e.rows.map(show).join(", ")}]` : `${e.label}${e.key ? ` ${e.key}` : ""}`);
  assert.deepEqual(createMenuRows().map(show), ["Line L", "Rectangle R", "Circle C", "Arc ▸ [3-point arc A, Centre arc, Tangent arc T]"]);
});

test("menu keys by hand: Down and Up wrap round five rows, Home and End jump, other keys don't move", () => {
  // Five rows, 0 to 4. Down from 4 wraps to 0 and Up from 0 wraps to 4
  // ((0 - 1 + 5) mod 5 = 4); Down from 2 is 3, Up from 2 is 1.
  assert.equal(menuMove(4, "ArrowDown", 5), 0);
  assert.equal(menuMove(0, "ArrowUp", 5), 4);
  assert.equal(menuMove(2, "ArrowDown", 5), 3);
  assert.equal(menuMove(2, "ArrowUp", 5), 1);
  assert.equal(menuMove(3, "Home", 5), 0);
  assert.equal(menuMove(1, "End", 5), 4);
  assert.equal(menuMove(1, "Enter", 5), null);
  assert.equal(menuMove(1, "l", 5), null);
  assert.equal(menuMove(0, "ArrowDown", 0), null, "an empty menu moves nowhere");
});

const { Window } = await import("happy-dom");

/** A toolbar slot holding a modelling button, then the sketch toolbar, in a real DOM (happy-dom stands in for the browser). */
function bar() {
  const window = new Window();
  const doc = window.document as unknown as Document;
  const slot = doc.createElement("div");
  slot.id = "toolbar";
  const modelling = doc.createElement("div");
  modelling.className = "tool-group";
  modelling.id = "modelling";
  slot.append(modelling);
  doc.body.append(slot);
  const chosen: ToolKind[] = [];
  let finished = 0;
  const t = sketchToolbar(slot, { tool: (k) => chosen.push(k), finish: () => finished++ });
  const $ = (id: string) => doc.getElementById(id) as HTMLElement;
  return { doc, slot, t, $, chosen, finished: () => finished };
}

test("hidden until shown; shown, the Create group comes first and Finish Sketch last, around the modelling buttons", () => {
  const { slot, t, $ } = bar();
  assert.equal($("sketch-create").closest<HTMLElement>(".tool-group")!.hidden, true);
  assert.equal($("finish-sketch").closest<HTMLElement>(".tool-group")!.hidden, true);
  t.show("line");
  const groups = [...slot.children].map((g) => (g as HTMLElement).getAttribute("aria-label") ?? g.id);
  assert.deepEqual(groups, ["Create", "modelling", "Finish"]);
  assert.equal($("sketch-create").closest<HTMLElement>(".tool-group")!.hidden, false);
  assert.equal($("finish-sketch").closest<HTMLElement>(".tool-group")!.hidden, false);
  assert.equal($("finish-sketch").title, FINISH_TITLE);
  t.hide();
  assert.equal($("finish-sketch").closest<HTMLElement>(".tool-group")!.hidden, true);
});

test("the tool in use: exactly its button pressed and its menu row ticked, keys in the titles", () => {
  const { t, $ } = bar();
  t.show("line");
  const pressed = () => ["line", "rectangle", "circle", "arc", "centre", "tangent"].filter((k) => $(`sketch-tool-${k}`).getAttribute("aria-pressed") === "true");
  const ticked = () => ["line", "rectangle", "circle", "arc", "centre", "tangent"].filter((k) => $(`sketch-menu-${k}`).getAttribute("aria-checked") === "true");
  assert.deepEqual([pressed(), ticked()], [["line"], ["line"]]);
  t.showTool("arc");
  assert.deepEqual([pressed(), ticked()], [["arc"], ["arc"]]);
  assert.equal($("sketch-tool-circle").title, "Circle (C)");
  assert.equal($("sketch-tool-tangent").getAttribute("aria-keyshortcuts"), "T");
  assert.equal($("sketch-menu-rectangle").textContent, "RectangleR", "the row's name, then its key");
  assert.equal($("sketch-tool-centre").title, "Centre arc", "no key, so none named");
  assert.equal($("sketch-tool-centre").hasAttribute("aria-keyshortcuts"), false);
  // The Arc row is lit while one of its arcs is in use.
  assert.equal($("sketch-menu-group-arc").classList.contains("sketchbar-menu-holds"), true);
  t.showTool("line");
  assert.equal($("sketch-menu-group-arc").classList.contains("sketchbar-menu-holds"), false);
  t.showTool("centre");
  assert.deepEqual([pressed(), ticked()], [["centre"], ["centre"]]);
  assert.equal($("sketch-menu-group-arc").classList.contains("sketchbar-menu-holds"), true);
});

test("a tool button reports its tool; Finish Sketch reports finish", () => {
  const { t, $, chosen, finished } = bar();
  t.show("line");
  $("sketch-tool-circle").click();
  $("sketch-tool-tangent").click();
  assert.deepEqual(chosen, ["circle", "tangent"]);
  assert.equal(finished(), 0);
  $("finish-sketch").click();
  assert.equal(finished(), 1);
});

test("the Create menu: opens on its button with the tool in use focused, a row chooses and closes, the button toggles", () => {
  const { doc, t, $, chosen } = bar();
  t.show("circle");
  assert.equal(t.menuOpen, false);
  assert.equal($("sketch-create").getAttribute("aria-expanded"), "false");
  $("sketch-create").click();
  assert.equal(t.menuOpen, true);
  assert.equal($("sketch-create-menu").hidden, false);
  assert.equal($("sketch-create").getAttribute("aria-expanded"), "true");
  assert.equal(doc.activeElement?.id, "sketch-menu-circle", "the ticked row has the focus");
  assert.equal($("sketch-arc-menu").hidden, true, "the arcs' menu waits for its row");
  $("sketch-menu-group-arc").click();
  assert.equal($("sketch-arc-menu").hidden, false, "a press on Arc opens the arcs");
  assert.equal($("sketch-menu-group-arc").getAttribute("aria-expanded"), "true");
  assert.equal(t.menuOpen, true);
  $("sketch-menu-group-arc").click();
  assert.equal($("sketch-arc-menu").hidden, true, "a second press closes them");
  $("sketch-menu-group-arc").click();
  $("sketch-menu-centre").click();
  assert.deepEqual(chosen, ["centre"]);
  assert.equal(t.menuOpen, false, "a choice closes both menus");
  assert.equal($("sketch-arc-menu").hidden, true);
  $("sketch-create").click();
  $("sketch-menu-group-arc").click();
  $("sketch-menu-arc").click();
  assert.deepEqual(chosen, ["centre", "arc"]);
  assert.equal(t.menuOpen, false, "a choice closes the menu");
  $("sketch-create").click();
  $("sketch-create").click();
  assert.equal(t.menuOpen, false, "a second press closes it");
});

test("the menu by keys: Down moves the focus, Escape closes it without reaching the page, and the button gets the focus back", () => {
  const { doc, t, $ } = bar();
  let pageHeard = 0;
  doc.addEventListener("keydown", () => pageHeard++);
  t.show("tangent");
  $("sketch-create").click();
  // The tool in use is an arc, so its group's row has the focus.
  assert.equal(doc.activeElement?.id, "sketch-menu-group-arc");
  const press = (k: string) => {
    const ev = new (doc.defaultView as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
    (doc.activeElement as HTMLElement).dispatchEvent(ev);
    return ev;
  };
  // Arc is top row 3 of 0 to 3: Down wraps to row 0, Line.
  assert.equal(press("ArrowDown").defaultPrevented, true);
  assert.equal(doc.activeElement?.id, "sketch-menu-line");
  press("End");
  assert.equal(doc.activeElement?.id, "sketch-menu-group-arc");
  // Right opens the arcs on the ticked one, Tangent arc (row 2 of 0 to 2);
  // Down wraps to 3-point arc, Down again is Centre arc; Left goes back.
  assert.equal(press("ArrowRight").defaultPrevented, true);
  assert.equal($("sketch-arc-menu").hidden, false);
  assert.equal(doc.activeElement?.id, "sketch-menu-tangent");
  press("ArrowDown");
  assert.equal(doc.activeElement?.id, "sketch-menu-arc");
  press("ArrowDown");
  assert.equal(doc.activeElement?.id, "sketch-menu-centre");
  press("ArrowLeft");
  assert.equal($("sketch-arc-menu").hidden, true);
  assert.equal(doc.activeElement?.id, "sketch-menu-group-arc");
  // Enter opens them too, and Escape inside closes only the arcs.
  press("Enter");
  assert.equal(doc.activeElement?.id, "sketch-menu-tangent");
  press("Escape");
  assert.equal(t.menuOpen, true, "Escape in the arcs closes only them");
  assert.equal($("sketch-arc-menu").hidden, true);
  assert.equal(doc.activeElement?.id, "sketch-menu-group-arc");
  // Moving to another top row closes an open arcs menu.
  press("ArrowRight");
  press("ArrowLeft");
  press("ArrowRight");
  assert.equal($("sketch-arc-menu").hidden, false);
  (doc.activeElement as HTMLElement).blur();
  $("sketch-menu-group-arc").focus();
  press("Home");
  assert.equal(doc.activeElement?.id, "sketch-menu-line");
  assert.equal($("sketch-arc-menu").hidden, true);
  assert.equal(pageHeard, 0, "the menu's keys stay in the menu");
  press("Escape");
  assert.equal(t.menuOpen, false);
  assert.equal(pageHeard, 0, "Escape closed the menu and did not reach the page (which would end the line)");
  assert.equal(doc.activeElement?.id, "sketch-create");
});

test("a press outside closes the menu; a press on a row does not before its click; hide and closeMenu close it", () => {
  const { doc, t, $ } = bar();
  const win = doc.defaultView as unknown as { PointerEvent: typeof PointerEvent };
  const pointerdown = (el: Element) => el.dispatchEvent(new win.PointerEvent("pointerdown", { bubbles: true }));
  t.show("line");
  $("sketch-create").click();
  pointerdown($("sketch-menu-rectangle"));
  assert.equal(t.menuOpen, true, "pressing a row keeps the menu for the row's click");
  pointerdown(doc.body);
  assert.equal(t.menuOpen, false, "a press elsewhere closes it");
  $("sketch-create").click();
  t.closeMenu();
  assert.equal(t.menuOpen, false);
  $("sketch-create").click();
  t.hide();
  assert.equal(t.menuOpen, false, "taking the toolbar away closes its menu");
  assert.equal($("sketch-create-menu").hidden, true);
});

test("the sketch panel no longer has tool buttons (they moved to the toolbar), only the tool's help", () => {
  const window = new Window();
  const doc = window.document as unknown as Document;
  const slot = doc.createElement("aside");
  doc.body.append(slot);
  const noop = () => {};
  const panel = sketchPanel(slot, { pickPlane: noop, cancel: noop, grid: noop, gridSnap: noop, finish: noop, extrude: noop, lookAt: noop });
  panel.showEditing("Sketch 1", "10", false, "circle");
  assert.equal(slot.querySelectorAll("[id^=sketch-tool-]").length, 0);
  assert.match(slot.querySelector("#sketch-help")!.textContent!, /^Click the centre/);
  panel.showTool("arc");
  assert.match(slot.querySelector("#sketch-help")!.textContent!, /^Click the start/);
});
