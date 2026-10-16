// The AI assistant's panel: one panel for every workspace, aware of the
// active one. PLACEHOLDER: it says what the assistant will do and lists
// the providers to choose from; no provider is active, so nothing is sent
// anywhere and every feature works without it.

import { AI_FEATURES, PROVIDERS } from "@fission/ai";
import type { WorkspaceId } from "@fission/core";

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const list = (items: readonly string[]) => `<ul>${items.map((i) => `<li>${escape(i)}</li>`).join("")}</ul>`;

/** Fills `el` with the assistant panel for the active workspace. */
export function showAssistant(el: HTMLElement, workspace: WorkspaceId | "community", title: string): void {
  const here = workspace === "community" ? [] : AI_FEATURES[workspace];
  const providers = PROVIDERS.map(
    (p) => `<section data-provider="${p.kind}">
      <h4>${escape(p.title)} <span class="where">${p.remote ? "sends your request to the provider" : "stays on your machine"}</span></h4>
      <p>${escape(p.description)}</p>${list(p.notes)}</section>`,
  ).join("");
  el.innerHTML = `
    <div class="placeholder">
      <h2>Assistant</h2>
      <p class="coming-soon">Coming soon</p>
      <p id="ai-status-detail">AI is off. Nothing is sent anywhere, and everything in Fission works without it.</p>
      <p>The assistant is optional. It only uses the same commands you can, shows a preview you accept or reject, and each accepted change is one undo step. It never starts or sends anything to a printer, laser or CNC machine.</p>
      ${here.length ? `<h3>In ${escape(title)}</h3>${list(here)}` : ""}
      <h3>Across the project</h3>${list(AI_FEATURES.suite)}
      <h3>Settings: choose a provider</h3>
      <p>You will pick one of these. Local models are downloaded once, with their size shown first; API keys are kept only in this browser.</p>
      ${providers}
      <p class="starts-after">Work starts now on the architecture; the first real feature, Design commands, comes after CAD step 32 (the timeline).</p>
    </div>`;
}
