// The row of workspace tabs at the top of the app.

export interface SwitcherEntry {
  id: string;
  title: string;
  summary: string;
  placeholder: boolean;
}

/**
 * Fills `bar` with one tab per workspace and calls `choose` when one is
 * clicked. Returns a function that marks the active tab.
 */
export function workspaceSwitcher(bar: HTMLElement, entries: SwitcherEntry[], choose: (id: string) => void): (id: string) => void {
  bar.setAttribute("role", "tablist");
  bar.replaceChildren(
    ...entries.map((e) => {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.setAttribute("role", "tab");
      tab.dataset.workspace = e.id;
      tab.title = e.placeholder ? `${e.summary} (coming soon)` : e.summary;
      tab.textContent = e.title;
      if (e.placeholder) tab.classList.add("soon");
      tab.addEventListener("click", () => choose(e.id));
      return tab;
    }),
  );
  return (id) => {
    for (const tab of bar.querySelectorAll<HTMLButtonElement>("[role=tab]")) {
      const active = tab.dataset.workspace === id;
      tab.setAttribute("aria-selected", String(active));
    }
  };
}
