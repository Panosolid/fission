// The sketch's own toolbar (sketch feel SF3b): while a sketch is edited the
// toolbar becomes the sketch's, as the sketch tab of a CAD suite does. A
// Create menu at the left lists every tool with its key, the tools sit
// beside it as buttons (the one in use pressed), and a big Finish Sketch
// stands at the right. Modify and Inspect groups join as their tools
// arrive (trim and offset: steps 31 to 33); none is shown before it has a
// tool. The workspace drives it; the toolbar only shows what it is given
// and reports clicks. Styles: src/styles/sketchbar.css.

import { SKETCH_TOOLS, type ToolKind } from "./sketch-tool.ts";

export interface SketchToolbarEvents {
  /** A tool chosen, from its button or the Create menu. */
  tool(kind: ToolKind): void;
  /** Finish Sketch: back to modelling, the camera at the home view. */
  finish(): void;
}

/** One row of the Create menu: the tool's name and the key that chooses it. */
export interface MenuRow {
  kind: ToolKind;
  label: string;
  key: string;
}

/** The Create menu's rows, in the tools' order. */
export function createMenuRows(): MenuRow[] {
  return SKETCH_TOOLS.map((t) => ({ kind: t.kind, label: t.label, key: t.key }));
}

/** Finish Sketch's tooltip. */
export const FINISH_TITLE = "Finish Sketch: back to modelling, with the camera at the home view. The sketch stays as drawn.";

/**
 * Which menu row a key moves to from row `at` of `count` (the menu
 * pattern: Down and Up wrap round, Home and End jump to the ends); null
 * for a key the menu does not move on.
 */
export function menuMove(at: number, key: string, count: number): number | null {
  if (count <= 0) return null;
  if (key === "ArrowDown") return (at + 1) % count;
  if (key === "ArrowUp") return (at - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

export interface SketchToolbar {
  /** Shows the sketch's toolbar with this tool pressed. */
  show(tool: ToolKind): void;
  /** The tool in use: its button pressed and its menu row ticked. */
  showTool(kind: ToolKind): void;
  /** Takes the sketch's toolbar away (the menu too). */
  hide(): void;
  /** Whether the Create menu is open (Escape closes it first). */
  readonly menuOpen: boolean;
  closeMenu(): void;
}

export function sketchToolbar(slot: HTMLElement, on: SketchToolbarEvents): SketchToolbar {
  const document = slot.ownerDocument;
  const group = (extra: string, label: string) => {
    const g = document.createElement("div");
    g.className = `tool-group sketchbar ${extra}`;
    g.setAttribute("role", "group");
    g.setAttribute("aria-label", label);
    g.hidden = true;
    return g;
  };
  const button = (text: string, id: string) => {
    const b = document.createElement("button");
    b.type = "button";
    b.id = id;
    b.textContent = text;
    return b;
  };

  // Create: the menu button (the group's name), then a button per tool.
  const create = group("sketchbar-create", "Create");
  const menuButton = button("Create ▾", "sketch-create");
  menuButton.className = "sketchbar-menu-button";
  menuButton.title = "Every sketch tool, with its key";
  menuButton.setAttribute("aria-haspopup", "menu");
  menuButton.setAttribute("aria-expanded", "false");
  menuButton.setAttribute("aria-controls", "sketch-create-menu");
  create.append(menuButton);
  const tools = SKETCH_TOOLS.map((t) => {
    const b = button(t.label, `sketch-tool-${t.kind}`); // ids read by the e2e tests
    b.title = `${t.label} (${t.key})`;
    b.setAttribute("aria-keyshortcuts", t.key);
    b.addEventListener("click", () => on.tool(t.kind));
    create.append(b);
    return { kind: t.kind, button: b };
  });

  // The menu: fixed to the page under its button, so the toolbar's sideways
  // scroll at phone width never clips it.
  const menu = document.createElement("div");
  menu.className = "sketchbar-menu";
  menu.id = "sketch-create-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "Create");
  menu.hidden = true;
  const rows = createMenuRows().map((r) => {
    const item = document.createElement("button");
    item.type = "button";
    item.id = `sketch-menu-${r.kind}`;
    item.setAttribute("role", "menuitemradio");
    item.setAttribute("aria-checked", "false");
    item.tabIndex = -1;
    const name = document.createElement("span");
    name.textContent = r.label;
    const key = document.createElement("kbd");
    key.textContent = r.key;
    item.append(name, key);
    item.addEventListener("click", () => {
      closeMenu();
      on.tool(r.kind);
    });
    menu.append(item);
    return { kind: r.kind, item };
  });
  create.append(menu);

  // Finish Sketch, at the far right.
  const finishGroup = group("sketchbar-finish", "Finish");
  const finish = button("✓ Finish Sketch", "finish-sketch");
  finish.title = FINISH_TITLE;
  finish.addEventListener("click", () => {
    closeMenu();
    on.finish();
  });
  finishGroup.append(finish);

  slot.prepend(create);
  slot.append(finishGroup);

  /** A press anywhere but the menu and its button closes the menu. */
  const outside = (e: Event) => {
    const t = e.target as Node | null;
    if (t && (menu.contains(t) || menuButton.contains(t))) return;
    closeMenu();
  };
  function openMenu() {
    const r = menuButton.getBoundingClientRect();
    menu.style.left = `${Math.max(0, r.left)}px`;
    menu.style.top = `${r.bottom + 2}px`;
    menu.hidden = false;
    menuButton.setAttribute("aria-expanded", "true");
    document.addEventListener("pointerdown", outside, true);
    const checked = rows.find((r) => r.item.getAttribute("aria-checked") === "true") ?? rows[0];
    checked.item.focus();
  }
  function closeMenu() {
    if (menu.hidden) return;
    menu.hidden = true;
    menuButton.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", outside, true);
  }
  menuButton.addEventListener("click", () => (menu.hidden ? openMenu() : closeMenu()));
  menu.addEventListener("keydown", (e) => {
    const at = rows.findIndex((r) => r.item === document.activeElement);
    const next = menuMove(at < 0 ? 0 : at, e.key, rows.length);
    if (next !== null) {
      e.preventDefault();
      e.stopPropagation();
      rows[next].item.focus();
    } else if (e.key === "Escape") {
      // The menu's own: the line being drawn is not ended.
      e.preventDefault();
      e.stopPropagation();
      closeMenu();
      menuButton.focus();
    }
  });

  const showTool = (kind: ToolKind) => {
    for (const t of tools) t.button.setAttribute("aria-pressed", String(t.kind === kind));
    for (const r of rows) r.item.setAttribute("aria-checked", String(r.kind === kind));
  };
  return {
    show(tool) {
      showTool(tool);
      create.hidden = finishGroup.hidden = false;
    },
    showTool,
    hide() {
      closeMenu();
      create.hidden = finishGroup.hidden = true;
    },
    get menuOpen() {
      return !menu.hidden;
    },
    closeMenu,
  };
}
