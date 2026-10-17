// The AI assistant's panel: one panel for every workspace, aware of the
// active one. Off until the user picks a provider (nothing is sent
// anywhere, and every feature works without it). In Design it turns a
// request into Design's own command (set_part), shows what would change,
// and an accepted change is one "AI: …" undo step; a rejected one changes
// nothing. A remote provider is shown exactly what it will be sent before
// the first request to it. Opening the panel for the first time picks an
// AI that runs on this computer if one is found (AI6); options that can't
// run here are greyed out with the reason. Ollama is looked for only when
// the user asks (Look for Ollama), never on its own, and is listed only
// once it has answered. Models are chosen from a list (what Ollama has, what the
// API key's provider offers), with a typed name as the fallback.

import {
  AI_FEATURES,
  askForCommands,
  browserKeyStore,
  chooseModel,
  createProvider,
  detectProviders,
  listModels,
  pickLocal,
  vendorFromKey,
  DEFAULT_MODELS,
  IN_BROWSER_MODEL,
  inBrowserDownloadSize,
  apiOrigin,
  proposeAction,
  PROVIDERS,
  systemPrompt,
  type AIAction,
  type AIProviderKind,
  type ApiKeyStore,
  type ApiVendor,
  type Detected,
  type Fetch,
  type Preview,
  type ProviderSettings,
} from "@fission/ai";
import { projectToJson, type Command, type History, type MountedWorkspace, type Project, type WorkspaceId } from "@fission/core";
import { DESIGN_COMMANDS, partOf, type DesignDocument } from "@fission/design";

export interface AssistantHost {
  history: History;
  project(): Project;
  /** Design as mounted, or null while it isn't. */
  design(): MountedWorkspace | null;
}

/** The chosen provider as JSON; "null" when the user chose Off, absent when nothing was ever chosen. */
const SETTINGS_KEY = "fission.ai.settings";
/** The model list's "type a name" choice. */
const TYPED = "";
const CONSENT_KEY = "fission.ai.consent:";
/** The AI may only set the part: Design's one modelling command (export_stl downloads, so it stays the user's). */
const AI_COMMANDS = DESIGN_COMMANDS.filter((c) => c.op === "set_part");
const SHORT: Record<AIProviderKind, string> = { "in-browser": "in browser", ollama: "Ollama", "api-key": "API key", "browser-built-in": "built-in" };

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const list = (items: readonly string[]) => `<ul>${items.map((i) => `<li>${escape(i)}</li>`).join("")}</ul>`;

/** Browser storage that may be missing or full: reads give null, writes are best effort. */
const store = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string | null) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      // private window or full: the setting lasts until the page closes
    }
  },
};

function loadSettings(): ProviderSettings | null {
  try {
    const s = JSON.parse(store.get(SETTINGS_KEY) ?? "null") as ProviderSettings | null;
    return s && PROVIDERS.some((p) => p.kind === s.kind) ? s : null;
  } catch {
    return null;
  }
}

/** The part as the command that makes it, or none for a new project. */
export function partCommand(project: Project): Command[] {
  const doc = project.workspaces.design as DesignDocument | undefined;
  if (!doc) return [];
  try {
    const { shape, sizes } = partOf(doc);
    // An extrude of a sketch (step 21d) has no set_part that makes it.
    if (shape === "sketch-extrude") return [];
    return [{ op: "set_part", shape, ...sizes }];
  } catch {
    return [];
  }
}

/** The sizes a shape uses: a sphere's depth and height, and a cylinder's depth, are ignored. */
const USED: Record<string, string[]> = { sphere: ["shape", "width"], cylinder: ["shape", "width", "height"] };
const used = (shape: unknown, key: string) => (USED[String(shape)] ?? ["shape", "width", "depth", "height"]).includes(key);

/** "box 50 × 30 × 20 mm", "cylinder ⌀25 × 60 mm", "sphere ⌀30 mm": the undo step's name. */
export function describePart(c: Record<string, unknown>): string {
  const n = (k: string) => String(c[k]);
  if (c.shape === "sphere") return `sphere ⌀${n("width")} mm`;
  if (c.shape === "cylinder") return `cylinder ⌀${n("width")} × ${n("height")} mm`;
  return `${String(c.shape).replace("-", " ")} ${n("width")} × ${n("depth")} × ${n("height")} mm`;
}

/** The panel, built once; `show` points it at the active workspace. */
export function createAssistant(el: HTMLElement, host: AssistantHost, status: HTMLElement) {
  let settings = loadSettings();
  let workspace: WorkspaceId | "community" = "design";
  let pending: AIAction | null = null;
  let keys: ApiKeyStore | null = null;
  try {
    keys = browserKeyStore();
  } catch {
    keys = null; // no storage: API keys can't be kept, so that provider can't be used
  }

  el.classList.add("assistant"); // styles/assistant.css
  el.innerHTML = `
    <h2>Assistant</h2>
    <p id="ai-status-detail"></p>
    <p class="ai-rules">The assistant is optional. It only uses the same commands you can, shows what would change for you to accept or reject, and each accepted change is one undo step. It never starts or sends anything to a printer, laser or CNC machine.</p>
    <form id="ai-ask" class="ai-ask">
      <label for="ai-prompt">Ask</label>
      <textarea id="ai-prompt" rows="3" placeholder="Make it a cylinder 25 mm across and 60 mm tall"></textarea>
      <button id="ai-ask-button" type="submit">Ask</button>
      <p id="ai-ask-note" class="ai-note"></p>
    </form>
    <div id="ai-result" class="ai-result" aria-live="polite"></div>
    <div id="ai-features"></div>
    <section class="ai-settings">
      <h3>Settings</h3>
      <label>Provider <select id="ai-provider">
        <option value="">Off</option>
        ${PROVIDERS.map((p) => `<option value="${p.kind}">${escape(p.title)}</option>`).join("")}
      </select></label>
      <p id="ai-found" class="ai-note"></p>
      <button id="ai-detect" type="button">Look for Ollama</button>
      <label data-for="api-key">Whose API <select id="ai-vendor"><option value="anthropic">Anthropic</option><option value="openai">OpenAI</option><option value="other">Another (OpenAI-compatible)</option></select></label>
      <label data-for="ollama other">Address <input id="ai-endpoint" type="url" spellcheck="false"></label>
      <div data-for="in-browser ollama api-key" class="ai-model">
        <label id="ai-model-list">Model <select id="ai-model-pick"></select></label>
        <label id="ai-model-typed">Model name <input id="ai-model" type="text" spellcheck="false"></label>
        <p id="ai-model-note" class="ai-note"></p>
      </div>
      <div data-for="api-key" class="ai-key">
        <label>API key <input id="ai-key" type="password" autocomplete="off" spellcheck="false" placeholder="Paste your key"></label>
        <button id="ai-key-save" type="button">Save key</button>
        <button id="ai-key-remove" type="button">Remove key</button>
        <p id="ai-key-state" class="ai-note"></p>
      </div>
      <button id="ai-check" type="button">Check</button>
      <p id="ai-check-result" class="ai-note"></p>
      <details class="ai-about"><summary>About the providers</summary>
        ${PROVIDERS.map(
          (p) => `<section data-provider="${p.kind}">
          <h4>${escape(p.title)} <span class="where">${p.remote ? "sends your request to the provider" : "stays on your machine"}</span></h4>
          <p>${escape(p.description)}</p>${list(p.notes)}</section>`,
        ).join("")}
      </details>
    </section>`;

  const $ = <T extends HTMLElement>(id: string) => el.querySelector(`#${id}`) as T;
  const providerSel = $<HTMLSelectElement>("ai-provider");
  const vendorSel = $<HTMLSelectElement>("ai-vendor");
  const endpoint = $<HTMLInputElement>("ai-endpoint");
  const model = $<HTMLInputElement>("ai-model");
  const modelPick = $<HTMLSelectElement>("ai-model-pick");
  /** What this computer can run (null until looked for), and whether the provider was picked for the user. */
  let found: Detected[] | null = null;
  let looking = false;
  let picked = false;
  /** Whether the user asked to look for Ollama (its reason is shown only then). */
  let ollamaAsked = false;
  /** The models the current settings can choose from, and the settings (less the model) they were listed for. */
  let models: string[] = [];
  let modelsFor = "";
  let modelNote = "";
  let listing = 0;
  /** True once the user chose "type a name" while a list is shown. */
  let typing = false;
  const keyInput = $<HTMLInputElement>("ai-key");
  const result = $("ai-result");
  const say = (text: string, bad = false) => {
    result.replaceChildren(Object.assign(document.createElement("p"), { textContent: text, className: bad ? "ai-error" : "ai-note" }));
  };

  /** The settings as the form shows them. */
  function fromForm(): ProviderSettings | null {
    const kind = providerSel.value as AIProviderKind | "";
    if (!kind) return null;
    const s: ProviderSettings = { kind };
    if (model.value.trim()) s.model = model.value.trim();
    if (kind === "api-key") s.vendor = vendorSel.value as ApiVendor;
    if ((kind === "ollama" || (kind === "api-key" && s.vendor === "other")) && endpoint.value.trim()) s.endpoint = endpoint.value.trim();
    return s;
  }

  /** The origin an API key goes to for these settings, or null (not an API key, or a bad address). */
  function keyOrigin(s: ProviderSettings | null): string | null {
    if (s?.kind !== "api-key") return null;
    try {
      return apiOrigin(s.vendor ?? "anthropic", s.endpoint);
    } catch {
      return null;
    }
  }

  function render() {
    const s = settings;
    providerSel.value = s?.kind ?? "";
    vendorSel.value = s?.vendor ?? "anthropic";
    endpoint.value = s?.endpoint ?? "";
    model.value = s?.model ?? "";
    endpoint.placeholder = s?.kind === "ollama" ? "http://localhost:11434" : "https://…/v1";
    model.placeholder =
      s?.kind === "ollama" ? "qwen2.5:1.5b" : s?.kind === "in-browser" ? IN_BROWSER_MODEL : s?.kind === "api-key" && s.vendor !== "other" ? DEFAULT_MODELS[s.vendor ?? "anthropic"] : "";
    const tags = [s?.kind ?? "off", s?.kind === "api-key" && s.vendor === "other" ? "other" : ""];
    for (const f of el.querySelectorAll<HTMLElement>("[data-for]")) f.hidden = !f.dataset.for!.split(" ").some((t) => tags.includes(t));
    for (const option of providerSel.options) {
      const kind = option.value as AIProviderKind | "";
      const d = found?.find((f) => f.kind === kind);
      const cant = kind !== "" && kind !== s?.kind && (kind === "ollama" ? !d?.ok : d?.ok === false);
      // Ollama is listed only while it answers (or while it is the one chosen); the others are greyed out with the reason below.
      option.hidden = kind === "ollama" && cant;
      option.disabled = cant;
      const title = PROVIDERS.find((p) => p.kind === kind)?.title ?? "Off";
      option.textContent = cant && kind !== "ollama" ? `${title} (can't run here)` : title;
    }
    const cannot = (found ?? []).filter((f) => !f.ok && (f.kind !== "ollama" || ollamaAsked));
    $("ai-found").textContent = looking
      ? "Looking for an AI that runs on this computer…"
      : !found
        ? ""
        : [
            picked && s ? `Chose ${PROVIDERS.find((p) => p.kind === s.kind)!.title} for you: it runs on this computer. You can change it here.` : "",
            !s && !pickLocal(found) ? "No AI that runs on this computer was found. In your browser needs WebGPU (a recent Chrome or Edge); if you run Ollama, Look for Ollama; or use your own API key." : "",
            ...cannot.map((f) => `${PROVIDERS.find((p) => p.kind === f.kind)!.title} can't run here: ${f.reason}`),
          ]
            .filter(Boolean)
            .join(" ");
    const listed = models.length > 0 && (s?.kind === "ollama" || s?.kind === "api-key" || s?.kind === "in-browser");
    const current = s?.model ?? "";
    const pickValue = !typing && models.includes(current) ? current : TYPED;
    modelPick.replaceChildren(
      ...models.map((m) => new Option(m, m)),
      new Option("Another (type its name)", TYPED),
    );
    modelPick.value = pickValue;
    $("ai-model-list").hidden = !listed;
    $("ai-model-typed").hidden = listed && pickValue !== TYPED;
    $("ai-model-note").textContent = modelNote;
    const origin = keyOrigin(s);
    $("ai-key-state").textContent =
      s?.kind !== "api-key"
        ? ""
        : !keys
          ? "This browser can't store a key."
          : !origin
            ? "Give the provider's https address first."
            : keys.get(origin)
              ? `A key is saved for ${origin}, in this browser only.`
              : `No key saved for ${origin}. Saving one asks ${origin} which models it can use; only the key is sent, nothing from your project.`;
    const info = s && PROVIDERS.find((p) => p.kind === s.kind)!;
    $("ai-status-detail").textContent = !info
      ? "AI is off. Nothing is sent anywhere, and everything in Fission works without it."
      : info.remote
        ? `Using ${info.title}: your requests go to the provider${origin ? ` at ${origin}` : ""}.`
        : `Using ${info.title}: nothing leaves your machine.`;
    status.textContent = s ? SHORT[s.kind] : "off";
    status.parentElement!.title = s ? `The AI assistant: ${info!.title}${info!.remote ? " (sends requests to the provider)" : " (stays on your machine)"}.` : "The optional AI assistant. No AI provider is active: nothing is sent anywhere.";
    const here = workspace === "design";
    $<HTMLButtonElement>("ai-ask-button").disabled = !s || !here;
    $<HTMLTextAreaElement>("ai-prompt").disabled = !s || !here;
    $("ai-ask-note").textContent = !here ? "The assistant can change Design's part; other workspaces get their AI features when they are built." : !s ? "Choose a provider in Settings below to ask." : "";
    const features = workspace === "community" ? [] : AI_FEATURES[workspace];
    const title = workspaceTitle;
    $("ai-features").innerHTML = `${features.length ? `<h3>Planned in ${escape(title)}</h3>${list(features)}` : ""}<h3>Planned across the project</h3>${list(AI_FEATURES.suite)}`;
  }
  let workspaceTitle = "Design";

  function save(next: ProviderSettings | null) {
    settings = next;
    store.set(SETTINGS_KEY, JSON.stringify(next)); // "null" records that the user chose Off
    discard();
    render();
  }
  for (const input of [providerSel, vendorSel, endpoint]) {
    input.addEventListener("change", () => {
      picked = false;
      typing = false;
      model.value = ""; // a model of one provider means nothing to another: the new list chooses
      save(fromForm());
      void refreshModels();
    });
  }
  model.addEventListener("change", () => save(fromForm()));
  modelPick.addEventListener("change", () => {
    typing = modelPick.value === TYPED;
    if (typing) {
      model.value = "";
      save(fromForm());
      model.focus();
    } else {
      model.value = modelPick.value;
      save(fromForm());
    }
  });

  /**
   * Fills the model list for the current settings (once per provider,
   * vendor and address, unless `again`), and chooses one when none is
   * chosen yet. A failed list says why and leaves the typed name.
   */
  async function refreshModels(again = false) {
    const s = settings;
    const key = s ? JSON.stringify({ ...s, model: undefined }) : "";
    if (key === modelsFor && !again) return render();
    modelsFor = key;
    models = [];
    modelNote = "";
    const ticket = ++listing;
    if (!s || s.kind === "browser-built-in" || (s.kind === "api-key" && !(keyOrigin(s) && keys?.get(keyOrigin(s)!)))) return render();
    modelNote = "Looking for models…";
    render();
    try {
      const list = await listModels(s, { fetch: (url, init) => fetch(url, init), keys: keys ?? undefined });
      if (ticket !== listing) return;
      models = list;
      modelNote = list.length ? "" : s.kind === "ollama" ? "Ollama has no models yet: run `ollama pull qwen2.5:1.5b`, then Look again." : "";
      const choice = chooseModel(s, list);
      if (!s.model && choice) return save({ ...s, model: choice });
    } catch (e) {
      if (ticket !== listing) return;
      modelsFor = ""; // try again next time
      modelNote = `Couldn't list the models (${(e as Error).message}). Type the model's name instead.`;
    }
    render();
  }

  function saveKey() {
    const origin = keyOrigin(fromForm());
    if (!keys || !origin) return render();
    try {
      keys.set(origin, keyInput.value);
      keyInput.value = "";
      void refreshModels(true);
    } catch (e) {
      $("ai-key-state").textContent = (e as Error).message;
    }
  }
  $("ai-key-save").addEventListener("click", saveKey);
  // A pasted key that says whose it is switches to that provider and is saved straight away.
  keyInput.addEventListener("input", (event) => {
    const vendor = vendorFromKey(keyInput.value);
    if (!vendor) return;
    if (vendorSel.value !== vendor) {
      vendorSel.value = vendor;
      model.value = "";
      save(fromForm());
    }
    if ((event as InputEvent).inputType === "insertFromPaste") saveKey();
    else $("ai-key-state").textContent = `This is ${vendor === "anthropic" ? "an Anthropic" : "an OpenAI"} key: Save key to use it.`;
  });
  $("ai-key-remove").addEventListener("click", () => {
    const origin = keyOrigin(fromForm());
    if (keys && origin) keys.remove(origin);
    modelsFor = "";
    void refreshModels();
  });

  /**
   * Looks for what can run on this computer (the browser's built-in model,
   * WebGPU for the in-browser one; Ollama at its usual address only when
   * the user asked or already uses it; nothing leaves the machine), and the
   * first time, with nothing ever chosen, picks the first local one found.
   */
  async function lookAround() {
    if (looking) return;
    looking = true;
    render();
    const withOllama = ollamaAsked || settings?.kind === "ollama";
    try {
      const kinds = PROVIDERS.map((p) => p.kind).filter((k) => k !== "ollama" || withOllama);
      const now = await detectProviders({}, kinds);
      // Ollama's last answer is kept when it wasn't asked this time.
      found = [...now, ...(found ?? []).filter((f) => !kinds.includes(f.kind))];
    } catch {
      found = found ?? [];
    }
    looking = false;
    const choice = pickLocal(found);
    if (store.get(SETTINGS_KEY) === null && choice) {
      picked = true;
      save({ kind: choice });
    }
    render();
    await refreshModels();
  }
  $("ai-detect").addEventListener("click", () => {
    ollamaAsked = true;
    modelsFor = "";
    void lookAround();
  });

  /**
   * The fetch providers use from this panel: the first request to a remote
   * provider's origin waits until the user has seen exactly what it sends
   * (the address and the body; the key's header is named, not shown) and
   * chosen Send.
   */
  const guardedFetch: Fetch = async (url, init) => {
    const s = settings;
    const origin = new URL(url).origin;
    if (s?.kind === "api-key" && store.get(CONSENT_KEY + origin) !== "1") {
      const ok = await confirmSend(url, init);
      if (!ok) throw new Error("you chose not to send it, so nothing was sent");
      store.set(CONSENT_KEY + origin, "1");
    }
    return fetch(url, init);
  };

  function confirmSend(url: string, init: RequestInit): Promise<boolean> {
    return new Promise((resolve) => {
      const box = document.createElement("div");
      box.id = "ai-consent";
      box.className = "ai-consent";
      const headers = Object.keys((init.headers ?? {}) as Record<string, string>).join(", ");
      let body = String(init.body ?? "");
      try {
        body = JSON.stringify(JSON.parse(body), null, 2);
      } catch {
        // shown as it is
      }
      box.innerHTML = `<p>This is the first request to <strong>${escape(new URL(url).origin)}</strong>. Exactly this will be sent to <code>${escape(url)}</code>, with your key in a header (headers: ${escape(headers)}):</p><pre></pre><button id="ai-send" type="button">Send</button> <button id="ai-cancel" type="button">Don't send</button>`;
      box.querySelector("pre")!.textContent = body;
      result.replaceChildren(box);
      box.querySelector("#ai-send")!.addEventListener("click", () => resolve(true), { once: true });
      box.querySelector("#ai-cancel")!.addEventListener("click", () => resolve(false), { once: true });
    });
  }

  /** The in-browser model's download, confirmed once with its size. */
  async function confirmDownload(s: ProviderSettings): Promise<boolean> {
    const id = s.model ?? IN_BROWSER_MODEL;
    if (store.get(`fission.ai.downloaded:${id}`) === "1") return true;
    const bytes = await inBrowserDownloadSize(id);
    const ok = window.confirm(`${id} is downloaded once to run in your browser: ${(bytes / 1e6).toFixed(0)} MB. Download it now?`);
    if (ok) store.set(`fission.ai.downloaded:${id}`, "1");
    return ok;
  }

  const provider = (s: ProviderSettings) =>
    createProvider(s, {
      fetch: guardedFetch,
      keys: keys ?? undefined,
      onProgress: (fraction, text) => say(`Loading the model: ${Math.round(fraction * 100)}% (${text})`),
    });

  $("ai-check").addEventListener("click", async () => {
    const s = fromForm();
    const out = $("ai-check-result");
    if (!s) return void (out.textContent = "AI is off.");
    out.textContent = "Checking…";
    try {
      const r = await provider(s).check();
      out.textContent = r.ok ? "Ready." : `Not ready: ${r.reason}`;
    } catch (e) {
      out.textContent = `Not ready: ${(e as Error).message}`;
    }
  });

  function discard() {
    if (pending && !pending.decided) pending.reject();
    pending = null;
  }

  $("ai-ask").addEventListener("submit", async (event) => {
    event.preventDefault();
    const s = settings;
    const words = $<HTMLTextAreaElement>("ai-prompt").value.trim();
    if (!s || workspace !== "design" || words === "") return;
    discard();
    const button = $<HTMLButtonElement>("ai-ask-button");
    button.disabled = true;
    say("Asking…");
    try {
      if (s.kind === "in-browser" && !(await confirmDownload(s))) return say("Nothing was downloaded or sent.");
      const setup = partCommand(host.project());
      const answer = await askForCommands(provider(s), { system: systemPrompt(setup, AI_COMMANDS), messages: [{ role: "user", content: words }] }, AI_COMMANDS);
      if (!answer.ok) return say(answer.error, true);
      const design = host.design();
      if (!design?.run) return say("Design isn't open, so nothing was changed.", true);
      // The part the commands would make: the current one with each command's sizes over it.
      const after: Record<string, unknown> = { ...(setup[0] ?? {}) };
      for (const c of answer.commands) Object.assign(after, c);
      const action = proposeAction(answer.commands, {
        label: describePart(after),
        history: host.history,
        run: (c) => void design.run!(c),
        current: () => ({ ...(setup[0] ?? {}) }),
        state: () => projectToJson(host.project()),
      });
      pending = action;
      showPreview(action, await action.preview(), after, answer.attempts);
    } catch (e) {
      say((e as Error).message, true);
    } finally {
      button.disabled = !settings || workspace !== "design";
    }
  });

  function showPreview(action: AIAction, preview: Preview, after: Record<string, unknown>, attempts: 1 | 2) {
    const box = document.createElement("div");
    box.id = "ai-preview";
    box.className = "ai-preview";
    const rows = preview.parameterChanges.filter((c) => used(after.shape, c.parameter));
    box.innerHTML = `<p class="ai-label"></p>
      <table>${rows.map((c) => `<tr data-param="${escape(c.parameter)}"><th>${escape(c.parameter)}</th><td>${escape(String(c.before ?? "—"))}</td><td>→</td><td>${escape(String(c.after))}</td></tr>`).join("")}</table>
      <p class="ai-note"></p>
      <details><summary>Commands</summary><pre></pre></details>
      <button id="ai-accept" type="button">Accept</button> <button id="ai-reject" type="button">Reject</button>`;
    box.querySelector(".ai-label")!.textContent = rows.length ? `${preview.label}` : "No change: the part is already like that.";
    box.querySelector(".ai-note")!.textContent = `Nothing has changed yet.${attempts === 2 ? " The first answer couldn't be used; this is the second." : ""}`;
    box.querySelector("pre")!.textContent = JSON.stringify(action.commands, null, 2);
    (box.querySelector("#ai-accept") as HTMLButtonElement).disabled = rows.length === 0;
    result.replaceChildren(box);
    box.querySelector("#ai-accept")!.addEventListener("click", async () => {
      try {
        await action.accept();
        say(`Done: ${preview.label}. Undo takes it back in one step.`);
      } catch (e) {
        say((e as Error).message, true);
      }
      pending = null;
    });
    box.querySelector("#ai-reject")!.addEventListener("click", () => {
      action.reject();
      pending = null;
      say("Rejected: nothing was changed.");
    });
  }

  render();
  return {
    /** The panel was opened: look for what can run here (once per page; Look again repeats it). */
    opened() {
      if (!found) void lookAround();
    },
    /** Points the panel at the active workspace. */
    show(id: WorkspaceId | "community", title: string) {
      if (id !== workspace) discard();
      workspace = id;
      workspaceTitle = title;
      render();
    },
  };
}
