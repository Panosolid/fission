// The properties panel: the part's parameters (size inputs labelled for its
// shape), the feature's intent and provenance, and the built body's numbers
// with their validation, staleness and STL notes. The workspace drives it;
// the panel only shows what it is given.

import { describeProvenance, type BodyView, type Feature } from "@fission/core";
import { downstreamChip, formatQuantity as fmt, type ChipInfo } from "@fission/ui";
import type { PartKind } from "./document.ts";
import { NAME_NOTE } from "./references.ts";
import type { SelectionRow } from "./selection.ts";

export type SizeKey = "width" | "depth" | "height";
export const SIZE_KEYS: SizeKey[] = ["width", "depth", "height"];

export interface ParameterRow {
  key: SizeKey;
  label: string;
  shown: boolean;
}

/**
 * Which size inputs a shape uses and what they are called: round shapes
 * take a diameter and no depth, a sphere no height either, and an extruded
 * outline's height is how far it is extruded. An extrude of a sketch has
 * only that distance: the sketch gives its outline.
 */
export function parameterRows(shape: PartKind): ParameterRow[] {
  const round = shape === "cylinder" || shape === "sphere";
  const primitive = round || shape === "box";
  const sketched = shape === "sketch-extrude";
  return [
    { key: "width", label: round ? "Diameter" : "Width", shown: !sketched },
    { key: "depth", label: "Depth", shown: !round && !sketched },
    { key: "height", label: primitive ? "Height" : "Extrude by", shown: shape !== "sphere" },
  ];
}

// The ids are read by the e2e test (#width, #stats[data-stale], #action-note…).
const DEFAULT_SIZES: Record<SizeKey, string> = { width: "40", depth: "30", height: "20" };
const HTML = `
  <h2>Selection</h2>
  <p id="selection-empty">Nothing selected: click a face or an edge, or Body 1 in the browser.</p>
  <ul id="selection-list" class="selection-list"></ul>
  <p id="selection-note" class="bad" hidden></p>
  <div id="selection-actions" class="verbs" role="group" aria-label="Actions for the selection" hidden></div>
  <p id="action-note"></p>
  <h2>Parameters</h2>
  ${SIZE_KEYS.map((k) => `<label id="${k}-row"><span id="${k}-label"></span> <input id="${k}" type="number" value="${DEFAULT_SIZES[k]}" step="any" /> mm</label>`).join("\n  ")}
  <h2>Feature</h2>
  <dl id="feature-info">
    <dt>Feature</dt><dd id="intent">…</dd>
    <dt>Made from</dt><dd id="provenance">…</dd>
  </dl>
  <h2>Body</h2>
  <dl id="stats">
    <dt>Volume</dt><dd id="volume">…</dd>
    <dt>Area</dt><dd id="area">…</dd>
    <dt>Topology</dt><dd id="topology">…</dd>
    <dt>Validation</dt><dd id="status">…</dd>
  </dl>
  <p id="stale-note" hidden>Out of date: these numbers are for the last part that built.</p>
  <p id="error"></p>
  <p id="kept-warning" class="kept kept-warning" role="status" hidden></p>
  <section id="downstream" hidden>
    <h2>Downstream</h2>
    <div id="downstream-chips" role="group" aria-label="What other workspaces make from this design"></div>
  </section>`;

/** A verb as a button shows it: the action's id, label and one-line title. */
export interface Verb {
  id: string;
  label: string;
  title: string;
}

export interface PropertiesPanel {
  /** The size inputs, in SIZE_KEYS order. */
  inputs: HTMLInputElement[];
  /** Labels and shows the size inputs for this shape. */
  setShape(shape: PartKind): void;
  showFeature(feature: Feature): void;
  /** What is selected: one row per item, or the empty note. */
  showSelection(rows: readonly SelectionRow[]): void;
  /** Says what the last rebuild took out of the selection ("" hides the note). */
  showSelectionNote(text: string): void;
  /** The built body's numbers and validation; clears the error line. */
  showBody(view: BodyView): void;
  showError(message: string): void;
  /** An extrude built from its kept shape (step 24d2): what happened and why, or "" for none. */
  showWarning(message: string): void;
  /** Dims the body's numbers while stale; says so in words when the rebuild failed. */
  markStale(stale: boolean, failed: boolean): void;
  /** The verbs the action registry offers for the selection, as buttons (none hides the row). */
  showActions(verbs: readonly Verb[], onRun: (id: string) => void): void;
  /** What the last action said: a warning or an error, or "" for nothing. */
  showActionNote(text: string, bad: boolean): void;
  /** What other workspaces make from the design, one chip each; a click opens the chip's workspace. None hides the whole section. */
  showDownstream(chips: readonly ChipInfo[], onOpen: (target: string) => void): void;
}

/** Fills the properties slot and returns the handle that updates it. */
export function propertiesPanel(slot: HTMLElement): PropertiesPanel {
  slot.innerHTML = HTML;
  const $ = <T extends HTMLElement>(id: string) => slot.querySelector<T>(`#${id}`)!;
  return {
    inputs: SIZE_KEYS.map((k) => $<HTMLInputElement>(k)),
    setShape(shape) {
      for (const row of parameterRows(shape)) {
        $(`${row.key}-label`).textContent = row.label;
        $(`${row.key}-row`).hidden = !row.shown;
      }
    },
    showFeature(feature) {
      $("intent").textContent = feature.intent.summary;
      $("provenance").textContent = describeProvenance(feature.provenance);
    },
    showSelection(rows) {
      const document = slot.ownerDocument;
      $("selection-empty").hidden = rows.length > 0;
      $("selection-list").replaceChildren(
        ...rows.map((r) => {
          const li = document.createElement("li");
          li.dataset.id = r.id; // read by the e2e test
          const id = document.createElement("code");
          id.textContent = r.id;
          id.title = NAME_NOTE;
          li.append(`${r.name} · ${r.type} `, id);
          return li;
        }),
      );
    },
    showSelectionNote(text) {
      const note = $("selection-note");
      note.textContent = text;
      note.hidden = text === "";
    },
    showBody(view) {
      $("volume").textContent = `${fmt(view.volume)} mm³`;
      $("area").textContent = `${fmt(view.area)} mm²`;
      $("topology").textContent = `${view.vertices} V · ${view.edges} E · ${view.faces} F`;
      const status = $("status");
      status.textContent = view.errors.length === 0 ? "valid" : `${view.errors.length} problem(s)`;
      status.className = view.errors.length === 0 ? "ok" : "bad";
      $("error").textContent = view.errors.join("\n");
    },
    showError(message) {
      $("error").textContent = message;
    },
    showWarning(message) {
      $("kept-warning").textContent = message;
      $("kept-warning").hidden = message === "";
    },
    markStale(stale, failed) {
      $("stats").classList.toggle("stale", stale);
      $("stats").dataset.stale = String(stale);
      $("stale-note").hidden = !(stale && failed);
    },
    showActions(verbs, onRun) {
      const row = $("selection-actions");
      row.hidden = verbs.length === 0;
      row.replaceChildren(
        ...verbs.map((v) => {
          const b = slot.ownerDocument.createElement("button");
          b.type = "button";
          b.textContent = v.label;
          b.title = v.title;
          b.dataset.action = v.id; // read by the e2e test
          b.addEventListener("click", () => onRun(v.id));
          return b;
        }),
      );
    },
    showActionNote(text, bad) {
      const note = $("action-note");
      note.textContent = text;
      note.className = bad ? "bad" : "";
    },
    showDownstream(chips, onOpen) {
      $("downstream").hidden = chips.length === 0;
      const box = $("downstream-chips");
      box.innerHTML = chips.map(downstreamChip).join(""); // the chip escapes what it is given
      for (const b of box.querySelectorAll<HTMLElement>(".downstream-chip")) b.addEventListener("click", () => onOpen(b.dataset.target!));
    },
  };
}
