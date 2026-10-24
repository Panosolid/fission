// A button that drops down a menu (U0d): Design's Insert ▾ and the top
// bar's File ▾, and from U0f each group of the Fusion-style toolbar. The
// menu lists sections, each with an optional heading, of items with a
// name, an optional shortcut key at the right and a tooltip; an item that
// is off says why in its tooltip and can't be chosen. It opens with a
// click or tap, or ArrowDown from the button; ArrowUp and ArrowDown, Home
// and End move through the items; Escape, Tab, a choice or a press
// outside closes it, Escape giving the focus back to the button. The menu
// is placed under the button with fixed positioning, so a toolbar that
// scrolls sideways (phones) never clips it, and kept on the screen.
// Styles: src/styles/menu-button.css.

export interface MenuItem {
  /** The item's element id (read by the e2e tests). */
  id: string;
  label: string;
  title?: string;
  /** The shortcut key shown at the right, e.g. "E". */
  key?: string;
  /** Extra data-* attributes for the item (e.g. the shape a preset adds). */
  data?: Record<string, string>;
  /** Why the item is off; an off item can't be chosen. */
  off?: string;
  run(): void;
}

export interface MenuSection {
  heading?: string;
  items: MenuItem[];
}

export interface MenuButton {
  /** The wrapper to put in the page: the button and its menu. */
  element: HTMLElement;
  button: HTMLButtonElement;
  menu: HTMLElement;
  readonly isOpen: boolean;
  open(focusFirst?: boolean): void;
  close(refocus?: boolean): void;
}

export interface MenuButtonOptions {
  id: string;
  /** The button's words; " ▾" is added after them. */
  label: string;
  title: string;
  /** The sections, read each time the menu opens (so an item's off state is current). */
  sections: () => readonly MenuSection[];
}

/** The gap between the button and its menu, and the least room kept to the window's edges, in px. */
export const MENU_GAP = 4;

/** Where the menu goes: under the button's left edge, moved left or above when it would leave the window. Pure, so it is tested by hand. */
export function menuPlace(button: { left: number; bottom: number; top: number }, menu: { width: number; height: number }, window: { width: number; height: number }): { left: number; top: number } {
  const left = Math.max(MENU_GAP, Math.min(button.left, window.width - menu.width - MENU_GAP));
  const below = button.bottom + MENU_GAP;
  const top = below + menu.height <= window.height - MENU_GAP ? below : Math.max(MENU_GAP, button.top - MENU_GAP - menu.height);
  return { left, top };
}

/** Makes a menu button in `doc`. */
export function menuButton(doc: Document, options: MenuButtonOptions): MenuButton {
  const element = doc.createElement("div");
  element.className = "menu-button";
  const button = doc.createElement("button");
  button.type = "button";
  button.id = options.id;
  button.className = "menu-button-toggle";
  button.textContent = `${options.label} ▾`;
  button.title = options.title;
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", "false");
  const menu = doc.createElement("div");
  menu.className = "menu-button-menu";
  menu.id = `${options.id}-menu`;
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", options.label);
  menu.hidden = true;
  button.setAttribute("aria-controls", menu.id);
  element.append(button, menu);

  const items = () => [...menu.querySelectorAll<HTMLButtonElement>("[role=menuitem]")];
  const usable = () => items().filter((b) => b.getAttribute("aria-disabled") !== "true");

  function fill() {
    menu.replaceChildren();
    for (const section of options.sections()) {
      if (section.items.length === 0) continue;
      const group = doc.createElement("div");
      group.className = "menu-button-section";
      group.setAttribute("role", "group");
      if (section.heading) {
        const heading = doc.createElement("div");
        heading.className = "menu-button-heading";
        heading.textContent = section.heading;
        heading.id = `${menu.id}-${section.heading.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
        group.setAttribute("aria-labelledby", heading.id);
        group.append(heading);
      }
      for (const item of section.items) {
        const b = doc.createElement("button");
        b.type = "button";
        b.id = item.id;
        b.className = "menu-button-item";
        b.setAttribute("role", "menuitem");
        b.tabIndex = -1;
        for (const [k, v] of Object.entries(item.data ?? {})) b.dataset[k] = v;
        const name = doc.createElement("span");
        name.className = "menu-button-name";
        name.textContent = item.label;
        b.append(name);
        if (item.key) {
          const key = doc.createElement("kbd");
          key.className = "menu-button-key";
          key.textContent = item.key;
          b.append(key);
        }
        if (item.off) {
          b.setAttribute("aria-disabled", "true");
          b.title = item.off;
        } else if (item.title) b.title = item.title;
        b.addEventListener("click", () => {
          if (item.off) return;
          close(false);
          item.run();
        });
        group.append(b);
      }
      menu.append(group);
    }
  }

  function place() {
    const view = doc.defaultView;
    const r = button.getBoundingClientRect();
    const m = menu.getBoundingClientRect();
    const at = menuPlace({ left: r.left, bottom: r.bottom, top: r.top }, { width: m.width, height: m.height }, { width: view?.innerWidth ?? 0, height: view?.innerHeight ?? 0 });
    menu.style.left = `${at.left}px`;
    menu.style.top = `${at.top}px`;
  }

  let isOpen = false;
  function open(focusFirst = false) {
    if (isOpen) return;
    fill();
    menu.hidden = false;
    isOpen = true;
    button.setAttribute("aria-expanded", "true");
    place();
    doc.addEventListener("pointerdown", outside, true);
    if (focusFirst) usable()[0]?.focus();
  }
  function close(refocus = false) {
    if (!isOpen) return;
    menu.hidden = true;
    isOpen = false;
    button.setAttribute("aria-expanded", "false");
    doc.removeEventListener("pointerdown", outside, true);
    if (refocus) button.focus();
  }
  function outside(e: Event) {
    if (!element.contains(e.target as Node)) close(false);
  }
  button.addEventListener("click", () => (isOpen ? close(false) : open(false)));
  element.addEventListener("keydown", (e) => {
    const list = usable();
    const at = list.indexOf(doc.activeElement as HTMLButtonElement);
    const focus = (i: number) => list[(i + list.length) % list.length]?.focus();
    let handled = true;
    if (e.key === "Escape" && isOpen) close(true);
    else if (e.key === "ArrowDown") isOpen ? focus(at + 1) : open(true);
    else if (e.key === "ArrowUp" && isOpen) focus(at < 0 ? list.length - 1 : at - 1);
    else if (e.key === "Home" && isOpen) focus(0);
    else if (e.key === "End" && isOpen) focus(list.length - 1);
    else if (e.key === "Tab" && isOpen) {
      close(false);
      handled = false; // the focus moves on as Tab says
    } else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation(); // the menu's keys are its own: Escape here never also clears Design's selection
    }
  });
  return {
    element,
    button,
    menu,
    get isOpen() {
      return isOpen;
    },
    open,
    close,
  };
}
