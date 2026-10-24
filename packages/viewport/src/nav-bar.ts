// The navigation bar along the bottom of each view (SF3a): what a left-drag
// does (Orbit, Pan, Zoom), Fit, Look at, Home and the standard views, and
// Full screen (SF3d) where the browser allows it. Small
// icon buttons of our own drawing, each named for screen readers and with a
// tooltip saying how to do the same with the mouse.
import type { ViewName } from "./views.ts";
import type { NavMode } from "./navigation.ts";

export interface NavBarActions {
  mode(mode: NavMode): void;
  fit(): void;
  lookAt(): void;
  view(name: ViewName): void;
}

/** 18 px line icons on a 24-unit grid, in the button's text colour. */
const ICONS: Record<string, string> = {
  orbit: '<path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M18.5 3v4h-4"/><circle cx="12" cy="12" r="2"/>',
  pan: '<path d="M12 3v18M3 12h18M12 3l-2.5 2.5M12 3l2.5 2.5M12 21l-2.5-2.5M12 21l2.5-2.5M3 12l2.5-2.5M3 12l2.5 2.5M21 12l-2.5-2.5M21 12l-2.5 2.5"/>',
  zoom: '<circle cx="10" cy="10" r="6"/><path d="M14.5 14.5L21 21M7 10h6M10 7v6"/>',
  fit: '<path d="M3 8V3h5M16 3h5v5M21 16v5h-5M8 21H3v-5"/><rect x="8" y="8" width="8" height="8"/>',
  "look-at": '<path d="M5 6l7-3 7 3v9l-7 3-7-3z"/><path d="M12 21v-6"/><circle cx="12" cy="10" r="1.5"/>',
  home: '<path d="M3 11l9-7 9 7M6 9v11h12V9"/>',
  "full-screen": '<path d="M4 9V4h5M4 4l5 5M20 9V4h-5M20 4l-5 5M4 15v5h5M4 20l5-5M20 15v5h-5M20 20l-5-5"/>',
  "exit-full-screen": '<path d="M9 4v5H4M9 9L3 3M15 4v5h5M15 9l6-6M9 20v-5H4M9 15l-6 6M15 20v-5h5M15 15l6 6"/>',
};
const svg = (name: string) => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

const MODES: readonly [NavMode, string, string][] = [
  ["orbit", "Orbit", "Orbit: left-drag turns the view (Shift+middle-drag any time)"],
  ["pan", "Pan", "Pan: left-drag slides the view (middle-drag any time)"],
  ["zoom", "Zoom", "Zoom: drag up to zoom in toward where you pressed (scroll wheel any time)"],
];
const VIEWS: readonly [ViewName, string, string][] = [
  ["top", "Top", "Look down on the body"],
  ["front", "Front", "Look at the body from the front"],
  ["right", "Right", "Look at the body from the right"],
];

/** Builds the bar; `showMode` lights the mode in use, `canLookAt` turns Look at on while there is a sketch plane to look at. */
export function navBar(actions: NavBarActions): { element: HTMLElement; showMode(mode: NavMode): void; canLookAt(can: boolean): void } {
  const bar = document.createElement("div");
  bar.className = "view-controls";
  bar.setAttribute("role", "toolbar");
  bar.setAttribute("aria-label", "View");
  const button = (label: string, title: string, icon: string | null) => {
    const b = Object.assign(document.createElement("button"), { type: "button", title });
    b.className = "nav-button";
    b.setAttribute("aria-label", label);
    if (icon) b.innerHTML = svg(icon);
    else b.textContent = label;
    return b;
  };
  const group = () => bar.appendChild(Object.assign(document.createElement("span"), { className: "nav-group" }));

  const modes = group();
  const modeButtons = new Map<NavMode, HTMLButtonElement>();
  for (const [mode, label, title] of MODES) {
    const b = button(label, title, mode);
    b.dataset.nav = mode;
    b.setAttribute("aria-pressed", String(mode === "orbit"));
    b.addEventListener("click", () => actions.mode(mode));
    modes.append(b);
    modeButtons.set(mode, b);
  }

  const frame = group();
  const fit = button("Fit", "Fit: frame the selection, or the whole body when nothing is selected", "fit");
  fit.dataset.view = "fit";
  fit.addEventListener("click", () => actions.fit());
  const look = button("Look at", "Look at: straight onto the sketch's plane (open a sketch first)", "look-at");
  look.dataset.view = "look-at";
  look.disabled = true;
  look.addEventListener("click", () => actions.lookAt());
  frame.append(fit, look);

  const views = group();
  const home = button("Home", "Home: three-quarter view of the whole body", "home");
  home.dataset.view = "home";
  home.addEventListener("click", () => actions.view("home"));
  views.append(home);
  for (const [name, label, title] of VIEWS) {
    const b = button(label, title, null);
    b.dataset.view = name;
    b.addEventListener("click", () => actions.view(name));
    views.append(b);
  }

  // Full screen: the whole app, as F11 would but with the page's own bars
  // kept; Escape (the browser's) or the button again leaves it. Left out
  // where the page can't go full screen (iPhone Safari), never a dead button.
  if (document.fullscreenEnabled) {
    const screen = group();
    const full = button("Full screen", "", "full-screen");
    full.dataset.view = "full-screen";
    const show = () => {
      const on = document.fullscreenElement !== null;
      full.setAttribute("aria-pressed", String(on));
      full.setAttribute("aria-label", on ? "Exit full screen" : "Full screen");
      full.title = on ? "Exit full screen (Escape)" : "Full screen: the whole window for SpindleLabs";
      full.innerHTML = svg(on ? "exit-full-screen" : "full-screen");
    };
    // A refusal (no click to allow it, a policy) changes nothing and the button stays as it was.
    full.addEventListener("click", () => void (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => show()));
    document.addEventListener("fullscreenchange", show);
    show();
    screen.append(full);
  }

  return {
    element: bar,
    showMode(mode) {
      for (const [m, b] of modeButtons) b.setAttribute("aria-pressed", String(m === mode));
    },
    canLookAt(can) {
      if (look.disabled === can) look.disabled = !can;
    },
  };
}
