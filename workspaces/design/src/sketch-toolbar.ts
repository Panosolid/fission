// The sketch's own toolbar (sketch feel SF3b): while a sketch is edited the
// toolbar becomes the sketch's, as the sketch tab of a CAD suite does. A
// Create menu at the left lists every tool with its key (the three arcs
// under an Arc row that opens a menu of its own), the tools sit
// beside it as buttons (the one in use pressed), and a big Finish Sketch
// stands at the right. Modify and Inspect groups join as their tools
// arrive (trim and offset: step 48); none is shown before it has a
// tool. The workspace drives it; the toolbar only shows what it is given
// and reports clicks. Styles: src/styles/sketchbar.css.

import { SKETCH_TOOLS, type ToolKind } from "./sketch-tool.ts";

export interface SketchToolbarEvents {
  /** A tool chosen, from its button or the Create menu. */
  tool(kind: ToolKind): void;
  /** Finish Sketch: back to modelling, the camera at the home view. */
  finish(): void;
}

/** One row of the Create menu: the tool's name and the key that chooses it (none for a tool without one). */
export interface MenuRow {
  kind: ToolKind;
  label: string;
  key?: string;
}

/** A row of the Create menu that opens a menu of its own: the arcs. */
export interface MenuGroup {
  group: string;
  rows: MenuRow[];
}

export type MenuEntry = MenuRow | MenuGroup;

/** The Create menu's rows, in the tools' order, the tools of a group gathered into one row where its first tool comes. */
export function createMenuRows(): MenuEntry[] {
  const entries: MenuEntry[] = [];
  for (const t of SKETCH_TOOLS) {
    const row: MenuRow = t.key ? { kind: t.kind, label: t.label, key: t.key } : { kind: t.kind, label: t.label };
    if (!t.group) {
      entries.push(row);
      continue;
    }
    const at = entries.find((e): e is MenuGroup => "group" in e && e.group === t.group);
    if (at) at.rows.push(row);
    else entries.push({ group: t.group, rows: [row] });
  }
  return entries;
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
    b.title = t.key ? `${t.label} (${t.key})` : t.label;
    if (t.key) b.setAttribute("aria-keyshortcuts", t.key);
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
  /** A tool's row: its name, then its key (if it has one). */
  const toolRow = (r: MenuRow) => {
    const item = document.createElement("button");
    item.type = "button";
    item.id = `sketch-menu-${r.kind}`;
    item.setAttribute("role", "menuitemradio");
    item.setAttribute("aria-checked", "false");
    item.tabIndex = -1;
    const name = document.createElement("span");
    name.textContent = r.label;
    const key = document.createElement("kbd");
    key.textContent = r.key ?? "";
    item.append(name, key);
    item.addEventListener("click", () => {
      closeMenu();
      on.tool(r.kind);
    });
    return { kind: r.kind, item };
  };
  /** The top rows (a tool, or a group's row) and every tool's row, the groups' too. */
  const top: HTMLButtonElement[] = [];
  const rows: { kind: ToolKind; item: HTMLButtonElement }[] = [];
  /** The groups' rows with their own menus (fixed beside the row, so nothing clips them). */
  const groups: { item: HTMLButtonElement; sub: HTMLElement; rows: HTMLButtonElement[]; kinds: ToolKind[] }[] = [];
  for (const e of createMenuRows()) {
    if (!("group" in e)) {
      const r = toolRow(e);
      menu.append(r.item);
      top.push(r.item);
      rows.push(r);
      continue;
    }
    const slug = e.group.toLowerCase();
    const item = document.createElement("button");
    item.type = "button";
    item.id = `sketch-menu-group-${slug}`;
    item.className = "sketchbar-menu-group";
    item.setAttribute("role", "menuitem");
    item.setAttribute("aria-haspopup", "menu");
    item.setAttribute("aria-expanded", "false");
    item.setAttribute("aria-controls", `sketch-${slug}-menu`);
    item.tabIndex = -1;
    const name = document.createElement("span");
    name.textContent = e.group;
    const more = document.createElement("span");
    more.className = "sketchbar-menu-more";
    more.setAttribute("aria-hidden", "true");
    more.textContent = "▸";
    item.append(name, more);
    const sub = document.createElement("div");
    sub.className = "sketchbar-menu sketchbar-submenu";
    sub.id = `sketch-${slug}-menu`;
    sub.setAttribute("role", "menu");
    sub.setAttribute("aria-label", e.group);
    sub.hidden = true;
    const subRows = e.rows.map(toolRow);
    sub.append(...subRows.map((r) => r.item));
    rows.push(...subRows);
    const g = { item, sub, rows: subRows.map((r) => r.item), kinds: subRows.map((r) => r.kind) };
    groups.push(g);
    item.addEventListener("click", () => (sub.hidden ? openGroup(g, false) : closeGroups()));
    item.addEventListener("pointerenter", (ev) => {
      if ((ev as PointerEvent).pointerType === "mouse") openGroup(g, false);
    });
    menu.append(item, sub);
    top.push(item);
  }
  // A mouse moving onto another top row closes a group's menu, as menus do.
  for (const t of top) {
    if (groups.some((g) => g.item === t)) continue;
    t.addEventListener("pointerenter", (ev) => {
      if ((ev as PointerEvent).pointerType === "mouse") closeGroups();
    });
  }
  /** Opens a group's menu beside its row (under it when the screen is too narrow), focusing its ticked row, or its first, when asked. */
  function openGroup(g: (typeof groups)[number], focus: boolean) {
    for (const o of groups) if (o !== g) closeGroup(o);
    g.sub.hidden = false;
    g.item.setAttribute("aria-expanded", "true");
    const r = g.item.getBoundingClientRect();
    const width = g.sub.getBoundingClientRect().width;
    const room = (document.defaultView?.innerWidth ?? Infinity) - r.right - 2;
    if (width <= room) {
      g.sub.style.left = `${r.right + 2}px`;
      g.sub.style.top = `${r.top - 4}px`;
    } else {
      g.sub.style.left = `${Math.max(0, r.left + 12)}px`;
      g.sub.style.top = `${r.bottom}px`;
    }
    if (focus) (g.rows.find((x) => x.getAttribute("aria-checked") === "true") ?? g.rows[0]).focus();
  }
  function closeGroup(g: (typeof groups)[number]) {
    g.sub.hidden = true;
    g.item.setAttribute("aria-expanded", "false");
  }
  const closeGroups = () => groups.forEach(closeGroup);
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
    // The ticked tool's row, or its group's row when it is in one.
    const checked = rows.find((r) => r.item.getAttribute("aria-checked") === "true")?.item;
    const holder = groups.find((g) => checked && g.rows.includes(checked))?.item;
    (holder ?? (checked && top.includes(checked) ? checked : top[0])).focus();
  }
  function closeMenu() {
    if (menu.hidden) return;
    closeGroups();
    menu.hidden = true;
    menuButton.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", outside, true);
  }
  menuButton.addEventListener("click", () => (menu.hidden ? openMenu() : closeMenu()));
  menu.addEventListener("keydown", (e) => {
    // Inside a group's menu its own rows move; Left or Escape goes back to the group's row.
    const inGroup = groups.find((g) => g.rows.includes(document.activeElement as HTMLButtonElement));
    const list = inGroup ? inGroup.rows : top;
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    const next = menuMove(at < 0 ? 0 : at, e.key, list.length);
    const onGroup = groups.find((g) => g.item === document.activeElement);
    if (next !== null) {
      e.preventDefault();
      e.stopPropagation();
      if (!inGroup) closeGroups();
      list[next].focus();
    } else if (onGroup && (e.key === "ArrowRight" || e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      e.stopPropagation();
      openGroup(onGroup, true);
    } else if (inGroup && (e.key === "ArrowLeft" || e.key === "Escape")) {
      e.preventDefault();
      e.stopPropagation();
      closeGroup(inGroup);
      inGroup.item.focus();
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
    for (const g of groups) g.item.classList.toggle("sketchbar-menu-holds", g.kinds.includes(kind));
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
