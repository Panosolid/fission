// What the AI assistant is told about the design (25c3): the part as the
// set_part that makes it, the sizes a set_part leaves out keeps (the
// panel's), the timeline in build order with each item's state, and what an
// accepted set_part does: changes the part when it is a preset, else adds a
// new body at the marker (`withPart`), which the preview then says.

import type { AIView, Command } from "@fission/core";
import { bodyFeatures } from "./browser.ts";
import { insertAt, isSketchItem, keptOf, partFeature, partOf, type DesignDocument } from "./document.ts";
import { timelineBarItems } from "./timeline-bar.ts";

/** The most timeline items the prompt lists: a small local model's prompt stays short. The last ones are kept. */
export const AI_TIMELINE_ITEMS = 40;

/** The sizes the panel holds, which a set_part keeps for each size it leaves out (workspace.ts `run`). */
export type PanelSizes = { width: number; depth: number; height: number };

/**
 * The AI's view of `doc` with the last rebuild's failures (`failed`) and
 * the panel's sizes. Pure: the same document, failures and sizes give the
 * same words.
 */
export function designAIView(doc: DesignDocument | undefined, failed: ReadonlySet<string>, sizes: PanelSizes): AIView {
  const keeps: Record<string, unknown> = { ...sizes };
  if (!doc) return { setup: [], keeps, notes: [], adds: null };
  // The part (the last body that builds) and what makes it; an extruded sketch has no set_part that does.
  const shape = partOf(doc);
  const preset = shape !== null && shape.shape !== "sketch-extrude";
  const setup: Command[] = preset ? [{ op: "set_part", shape: shape.shape, ...shape.sizes }] : [];
  const { features } = doc.timeline;
  const at = insertAt(doc);
  const adds = preset ? null : `a new body as item ${at + 1}, ${at === 0 ? "at the start of the timeline" : `after ${at}. ${features[at - 1].intent.summary}`}`;
  return { setup, keeps, notes: timelineNotes(doc, failed, sizes, adds), adds };
}

/** The prompt's lines about the timeline: each item and its state, the marker, and what set_part does now. */
function timelineNotes(doc: DesignDocument, failed: ReadonlySet<string>, sizes: PanelSizes, adds: string | null): string[] {
  const { features, marker } = doc.timeline;
  const { items } = timelineBarItems(doc, failed);
  const bodies = bodyFeatures(doc);
  const part = partFeature(doc);
  const lines = features.map((f, i) => {
    const item = items[i];
    const label = `${i + 1}. ${f.intent.summary}.`;
    if (item.suppressed) return `${label} Suppressed: builds nothing.`;
    if (item.rolledBack) return `${label} After the timeline marker: not built.`;
    // 26e (Q3): built on a suppressed item, it is greyed with it.
    if (item.greyed !== null) return `${label} Greyed: builds nothing while ${item.greyed}, which it is built on, is suppressed.`;
    if (isSketchItem(f)) return `${label} A sketch: builds no body.`;
    if (item.failed) return `${label} Failed: builds no body${failed.has(f.id) ? "" : " (its sketch is gone)"}.`;
    const kept = keptOf(doc, f) ? " Its sketch is lost (deleted, or no longer a closed outline), so it builds from the shape it kept." : "";
    return `${label} Builds Body ${bodies.indexOf(f) + 1}.${kept}${f === part && adds === null ? " This is the part set_part changes." : ""}`;
  });
  const shown = lines.length > AI_TIMELINE_ITEMS ? [`(${lines.length - AI_TIMELINE_ITEMS} earlier item${lines.length - AI_TIMELINE_ITEMS === 1 ? "" : "s"} left out)`, ...lines.slice(-AI_TIMELINE_ITEMS)] : lines;
  const where =
    marker === undefined ? "The timeline marker is at the end: every item is built." : marker === "start" ? "The timeline marker is at the start: nothing is built." : `The timeline marker is after item ${features.findIndex((f) => f.id === marker) + 1}: items after it are not built.`;
  // The part an extruded sketch: named, so the model knows what the user calls "it" and that set_part leaves it as it is.
  const what = part === null ? "Nothing builds a body, so" : `The part (the last body) is ${features.indexOf(part) + 1}. ${part.intent.summary}, an extruded sketch, which no command you can use changes, so`;
  const does = adds === null ? "set_part changes the part in place." : `${what} set_part adds ${adds}; nothing already in the timeline changes.`;
  return [
    "The design's timeline, in build order:",
    ...shown,
    where,
    does,
    `A size set_part leaves out keeps the value it has now: width ${sizes.width}, depth ${sizes.depth}, height ${sizes.height}.`,
  ];
}
