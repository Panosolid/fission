// Refuses to run the app inside a frame (audit S10). Another site could
// show the app in an invisible frame over its own buttons and catch the
// clicks meant for them (clickjacking), or drive the app's storage and AI
// key from a page the user never meant to trust. A header (frame-ancestors,
// X-Frame-Options) is the usual guard, but GitHub Pages sends none and a
// meta CSP cannot set frame-ancestors, so the script checks for itself.
//
// Both entry scripts (main.ts, guide-button.ts) import this module before
// anything else. When framed it empties the page, says why with a link that
// opens the app on its own, and throws, so neither entry runs a line of its
// own: no workspace mounts, no kernel worker starts, storage is never read.

/** The message shown in place of the app, so a framing page can't pass it off as broken. */
export const FRAMED_MESSAGE = "Panosolid doesn't run inside another page's frame, so no other site can catch your clicks or reach your projects.";

/** Thrown to stop the entry scripts. */
export class FramedError extends Error {
  constructor() {
    super("Panosolid refused to run inside a frame (audit S10).");
    this.name = "FramedError";
  }
}

/**
 * When `win` is not its own top window (it is inside a frame, from any
 * origin), replaces the page with the refusal and a link that opens the app
 * as a page of its own, then throws `FramedError`. At the top, does nothing.
 */
export function refuseIfFramed(win: Window): void {
  if (win.top === win.self) return;
  const doc = win.document;
  const note = doc.createElement("p");
  note.textContent = FRAMED_MESSAGE;
  const open = doc.createElement("a");
  open.href = win.location.href;
  open.target = "_blank";
  open.rel = "noopener noreferrer";
  open.textContent = "Open Panosolid on its own";
  const main = doc.createElement("main");
  main.id = "framed";
  // Styled here, with the theme's colours, so it reads the same whichever stylesheets loaded.
  Object.assign(main.style, { font: "16px system-ui, sans-serif", padding: "16px", color: "#e6e8eb", background: "#14161a", minHeight: "100vh", boxSizing: "border-box" });
  Object.assign(open.style, { color: "#4aa8ff" });
  main.append(note, open);
  doc.body.replaceChildren(main);
  doc.body.style.margin = "0";
  throw new FramedError();
}

refuseIfFramed(window);
