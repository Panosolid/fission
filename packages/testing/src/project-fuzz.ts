// Fuzzing the project loader (projectFromJson with every workspace's
// reader, what Open and the browser's saved projects go through), against
// a simple model. Each case starts from a real project (Design's part
// document for a random shape and sizes, a random name and units, other
// workspaces' data the loader must keep as it is, sometimes an old format
// 1 file) and breaks it: in the text (cut short, bytes deleted, inserted
// or flipped, a range repeated, a byte-order mark, a number too big for a
// double, "__proto__" keys, nesting 10,000 deep) or in the tree (a value
// swapped for the wrong type, a key removed or added, an array emptied or
// repeated). Then it checks:
// - only an Error is thrown, with one of the loader's own messages, never
//   an engine message ("Cannot read properties of null") or another type;
// - text JSON.parse refuses is refused as "not valid JSON", and only it;
// - the outer layout is accepted exactly when the model accepts it (an
//   object, formatVersion an integer 1..FORMAT_VERSION, then name a
//   string, units.length one of the units, materials and links arrays,
//   workspaces an object), refused with the model's reason otherwise;
// - a project that opens can be shown (Design's partOf and specOf), saved
//   (projectToJson) and opened again to the same text, and saving keeps
//   everything the file had (after the format upgrade), key for key.
// Seeded: the same seed gives the same cases. A failure is shrunk to the
// shortest text that fails the same way.

import { FORMAT_VERSION, MAX_NESTING, emptyProject, projectFromJson, projectToJson, type DataReader, type Project } from "@fission/core";
import { addSketch, designWorkspace, drawArc, drawCircle, drawLine, extrudeSketch, insertPreset, migrateDesignV1, migrateDesignV2, partDocument, partFeature, partOf, specOf, withPart, type DesignDocument } from "@fission/design";
import { renderWorkspace } from "@fission/render";
import { simulateWorkspace } from "@fission/simulate";
import { manufactureWorkspace } from "@fission/manufacture";
import { laserWorkspace } from "@fission/laser";
import { sliceWorkspace } from "@fission/slice";
import { circuitWorkspace } from "@fission/circuit";
import { vectorWorkspace } from "@fission/vector";
import { imageWorkspace } from "@fission/image";
import { layoutWorkspace } from "@fission/layout";
import { seeded, type SeededRandom } from "./index.ts";

/** Every workspace's reader, as the app passes them. */
export const READERS: readonly DataReader[] = [designWorkspace, renderWorkspace, simulateWorkspace, manufactureWorkspace, laserWorkspace, sliceWorkspace, circuitWorkspace, vectorWorkspace, imageWorkspace, layoutWorkspace];

const pick = <T>(r: SeededRandom, xs: readonly T[]): T => xs[Math.floor(r.next() * xs.length)];
const below = (r: SeededRandom, n: number) => Math.floor(r.next() * n);

// ---- The model of the outer layout, written from docs/project-format.md.

const UNITS = ["mm", "cm", "m", "in"];
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** Why the model refuses the parsed file's outer layout, or null; and the file after upgrading. */
export function outerModel(data: unknown): { refusal: string | null; upgraded?: Record<string, unknown> } {
  // Anywhere in the file: no number past a double's range (JSON.parse
  // gives ±Infinity), no nesting past MAX_NESTING.
  const todo: [unknown, number][] = [[data, 1]];
  while (todo.length) {
    const [x, depth] = todo.pop()!;
    if (x === Infinity || x === -Infinity) return { refusal: "is too big a number" };
    if (typeof x === "object" && x !== null) {
      if (depth > MAX_NESTING) return { refusal: `is nested more than ${MAX_NESTING} deep` };
      for (const v of Object.values(x)) todo.push([v, depth + 1]);
    }
  }
  if (!isObj(data)) return { refusal: "expected an object" };
  const v = data.formatVersion;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) return { refusal: "no format version" };
  if (v > FORMAT_VERSION) return { refusal: "saved by a newer Panoshape" };
  // The one upgrade so far, 1 → 2: links arrive, empty.
  const p = v === 1 ? { ...data, formatVersion: 2, links: [] } : data;
  for (const key of ["name", "units", "materials", "links", "workspaces"]) if (!Object.hasOwn(p, key)) return { refusal: `"${key}" is missing` };
  if (typeof p.name !== "string") return { refusal: '"name" must be text' };
  if (!isObj(p.units) || !UNITS.includes(p.units.length as string)) return { refusal: '"units" must give a length unit' };
  if (!Array.isArray(p.materials)) return { refusal: '"materials" must be a list' };
  if (!Array.isArray(p.links)) return { refusal: '"links" must be a list' };
  if (!isObj(p.workspaces)) return { refusal: '"workspaces" must be an object' };
  return { refusal: null, upgraded: p };
}

/** A value as text with keys sorted at every level (own keys, so a "__proto__" key counts). */
export function canonical(x: unknown): string {
  if (Array.isArray(x)) return `[${x.map(canonical).join(",")}]`;
  if (isObj(x)) return `{${Object.keys(x).sort().map((k) => `${JSON.stringify(k)}:${canonical(x[k])}`).join(",")}}`;
  return JSON.stringify(x) ?? "undefined";
}

// ---- Inputs.

const SHAPES = ["box", "cylinder", "sphere", "l-bracket", "plate", "slot", "star"] as const;

function randomJson(r: SeededRandom, depth = 0): unknown {
  const n = r.next();
  if (depth > 3 || n < 0.4) return pick(r, [0, 1, -1, 2.5, 1e300, "", "text", "ünïcødé ✓", true, false, null]);
  if (n < 0.7) return Array.from({ length: below(r, 4) }, () => randomJson(r, depth + 1));
  return Object.fromEntries(Array.from({ length: below(r, 4) }, (_, i) => [pick(r, ["a", "id", "version", "items", `k${i}`]), randomJson(r, depth + 1)]));
}

/**
 * Design's data as Panoshape saves it: sometimes with sketches (lines, some
 * chained, so they share points, circles (22b), some round a point
 * already there, and arcs (23a), some from a point already there;
 * sometimes the part extrudes one; from 24d1 several solid features and a
 * rollback marker; from 24f4 sometimes nothing built: the marker at the
 * start, every solid suppressed, or everything deleted), sometimes as the
 * version 1 data saved before step 21b
 * (no sketches, no counter), sometimes as version 2 (steps 21b to 24c,
 * which a save upgrades: its earlier solid features suppressed).
 */
function designData(r: SeededRandom, part: DesignDocument): unknown {
  const n = r.next();
  if (n < 0.15) {
    const { nextId: _, sketches: __, ...v1 } = part;
    return { ...v1, version: 1 };
  }
  let doc = part;
  if (n < 0.6) return doc;
  for (let s = 0; s < 1 + below(r, 2); s++) {
    const sketch = addSketch(doc);
    doc = sketch.doc;
    for (let l = 0; l < below(r, 5); l++) {
      const points = doc.sketches.find((x) => x.id === sketch.id)!.points;
      const from = points.length > 0 && r.next() < 0.6 ? pick(r, points).id : ([below(r, 100) - 50, below(r, 100) / 10] as const);
      const k = r.next();
      if (k < 0.2) doc = drawCircle(doc, sketch.id, from, (1 + below(r, 1000)) / 10).doc;
      else if (k < 0.4) doc = drawArc(doc, sketch.id, from, [below(r, 100), -below(r, 1000) / 100], [-1 - below(r, 100), below(r, 100) / 7]).doc;
      else doc = drawLine(doc, sketch.id, from, [below(r, 100), -below(r, 1000) / 100]).doc;
    }
  }
  // Sometimes the part is an extrude of one of them (step 21d), open or
  // closed (the kernel judges that when it builds), sometimes a preset again after it.
  if (r.next() < 0.5) {
    doc = extrudeSketch(doc, pick(r, doc.sketches).id, below(r, 1000) / 10).doc;
    if (r.next() < 0.3) doc = withPart(doc, pick(r, SHAPES), 1 + below(r, 50), 1 + below(r, 50), 1 + below(r, 50));
  }
  // More bodies (24d1): presets added; as version 2 saved it (no marker),
  // or some suppressed and a marker. The first item is the first preset,
  // never suppressed, so something always builds.
  for (let k = below(r, 3); k > 0; k--) doc = insertPreset(doc, pick(r, SHAPES), 1 + below(r, 50), 1 + below(r, 50), 1 + below(r, 50)).doc;
  if (r.next() < 0.2) return { ...doc, version: 2 };
  if (r.next() < 0.2) doc = { ...doc, timeline: { ...doc.timeline, features: doc.timeline.features.map((f, i) => (i > 0 && r.next() < 0.3 ? { ...f, suppressed: true } : f)) } };
  if (r.next() < 0.3) doc = { ...doc, timeline: { ...doc.timeline, marker: pick(r, doc.timeline.features).id } };
  // Nothing built (24f4): opens as a design with no body.
  const none = r.next();
  if (none < 0.05) doc = { ...doc, timeline: { ...doc.timeline, marker: "start" } };
  else if (none < 0.1) doc = { ...doc, timeline: { ...doc.timeline, features: doc.timeline.features.map((f) => (f.intent.type === "sketch" ? f : { ...f, suppressed: true })) } };
  else if (none < 0.13) {
    const { kept: _, ...rest } = doc;
    doc = { ...rest, profiles: [], sketches: [], timeline: { features: [] } };
  }
  return doc;
}

/** A real project's text: what Panoshape saves (sometimes in the old format 1). */
export function validProjectText(r: SeededRandom): string {
  const size = () => Math.round(10 ** (r.next() * 4 - 1) * 1000) / 1000;
  const p: Project = { ...emptyProject(pick(r, ["Untitled", "Bracket", "Gehäuse 2", "", "a\"quote\\and\nnewline"])), units: { length: pick(r, ["mm", "cm", "m", "in"] as const) } };
  if (r.next() < 0.9) p.workspaces.design = designData(r, partDocument(pick(r, SHAPES), size(), size(), size()));
  // Workspaces without a reader yet keep their data as it is.
  for (const id of ["render", "image", "layout"] as const) if (r.next() < 0.3) p.workspaces[id] = randomJson(r);
  if (r.next() < 0.3) p.materials = [{ id: "m1", name: "PLA", density: 1.24 } as never];
  const text = projectToJson(p);
  if (r.next() < 0.15) {
    const { links: _, ...old } = JSON.parse(text);
    return JSON.stringify({ ...old, formatVersion: 1 });
  }
  return text;
}

/** Every path to a value in a tree. */
function paths(x: unknown, at: (string | number)[] = [], out: (string | number)[][] = []) {
  out.push(at);
  if (Array.isArray(x)) x.forEach((v, i) => paths(v, [...at, i], out));
  else if (isObj(x)) for (const k of Object.keys(x)) paths(x[k], [...at, k], out);
  return out;
}

const WRONG: readonly unknown[] = [null, true, 0, -1, 1.5, 1e308, -1e308, "", "x", "1", [], {}, [null], [{}], { version: 1 }, "mm", "box"];

function mutateTree(r: SeededRandom, data: unknown): unknown {
  const all = paths(data);
  const path = pick(r, all);
  const root = { v: structuredClone(data) };
  let parent: Record<string | number, unknown> = root;
  let key: string | number = "v";
  for (const k of path) {
    parent = parent[key] as Record<string | number, unknown>;
    key = k;
  }
  const n = r.next();
  if (n < 0.45) parent[key] = pick(r, WRONG);
  else if (n < 0.6) {
    if (Array.isArray(parent)) parent.splice(key as number, 1);
    else delete parent[key];
  } else if (n < 0.7 && isObj(parent[key])) (parent[key] as Record<string, unknown>)[pick(r, ["extra", "id", "version", "constructor", "toString", "hasOwnProperty"])] = pick(r, WRONG);
  else if (n < 0.8 && Array.isArray(parent[key])) {
    const a = parent[key] as unknown[];
    if (a.length) a.push(...a.map((v) => structuredClone(v)));
    else a.push(pick(r, WRONG));
  } else if (n < 0.9) parent[key] = [parent[key]];
  else parent[key] = typeof parent[key] === "number" ? pick(r, [0, -0, -5, 1e-300, 5e-324, 2 ** 53 + 1]) : randomJson(r);
  return root.v;
}

function mutateText(r: SeededRandom, text: string): string {
  const at = below(r, text.length + 1);
  switch (below(r, 10)) {
    case 0:
      return text.slice(0, at);
    case 1:
      return text.slice(0, at) + text.slice(at + 1 + below(r, 30));
    case 2:
      return text.slice(0, at) + pick(r, ["{", "}", "[", "]", ",", ":", '"', "\\", "\u0000", "\ud800", "null", "1e999", "-", "NaN", " "]) + text.slice(at);
    case 3: {
      const c = text.charCodeAt(at) || 32;
      return text.slice(0, at) + String.fromCharCode(c ^ (1 << below(r, 7))) + text.slice(at + 1);
    }
    case 4: {
      const len = 1 + below(r, 80);
      return text.slice(0, at + len) + text.slice(at, at + len) + text.slice(at + len);
    }
    case 5:
      return "﻿" + text;
    case 6: {
      // A number too big for a double (JSON.parse gives Infinity) or too small (0).
      const numbers = [...text.matchAll(/(?<=[:\[,]\s*)-?\d+(\.\d+)?(?=\s*[,\n}\]])/g)];
      if (!numbers.length) return text;
      const m = pick(r, numbers);
      return text.slice(0, m.index) + pick(r, ["1e400", "-1e400", "1e-400", "123456789012345678901234567890"]) + text.slice(m.index! + m[0].length);
    }
    case 7: {
      // A "__proto__" key, which JSON.parse keeps as an own key.
      const i = text.indexOf("{", at);
      if (i < 0) return text;
      return text.slice(0, i + 1) + `"__proto__": ${pick(r, ["{}", '{"polluted": 1}', "null", "1", "[]"])},` + text.slice(i + 1);
    }
    case 8: {
      // Deep nesting inside a value a reader doesn't look into.
      const depth = pick(r, [100, 254, 255, 1000, 10000]); // "render" is level 3: 254 is the most allowed
      return text.replace('"workspaces": {', `"workspaces": {"render": ${"[".repeat(depth)}${"]".repeat(depth)},`);
    }
    default:
      return Array.from({ length: below(r, 60) }, () => String.fromCharCode(below(r, 0x3000))).join("");
  }
}

/** One case's text: valid, or broken in the tree or the text. */
export function makeCase(r: SeededRandom): string {
  const text = validProjectText(r);
  const n = r.next();
  if (n < 0.1) return text;
  if (n < 0.65) {
    let data: unknown = JSON.parse(text);
    for (let i = 0, k = 1 + below(r, 3); i < k; i++) data = mutateTree(r, data);
    return JSON.stringify(data, null, r.next() < 0.5 ? 2 : undefined) ?? "null";
  }
  let t = text;
  for (let i = 0, k = 1 + below(r, 2); i < k; i++) t = mutateText(r, t);
  return t;
}

// ---- The checks.

const OWN_MESSAGES = [/^not a Panoshape project: /, /^this project was saved by a newer Panoshape /, /^can't open the [a-z]+ workspace's data: /];
const ENGINE_WORDS = /Cannot read propert|Cannot convert|is not a function|is not iterable|Maximum call stack|Invalid array length|Cannot destructure/;

export interface Problem {
  kind: string;
  detail: string;
}

/** Engine messages vary only by the property named; keep the shape of the message. */
const shapeOf = (m: string) => m.replace(/'[^']*'/g, "'…'").replace(/"[^"]*"/g, '"…"').slice(0, 120);

function guard<T>(stage: string, f: () => T): T | Problem {
  try {
    return f();
  } catch (e) {
    const kind = e instanceof Error ? `${e.name}` : typeof e;
    return { kind: `${stage} threw: ${kind}: ${shapeOf(e instanceof Error ? e.message : String(e))}`, detail: String(e) };
  }
}
const isProblem = (x: unknown): x is Problem => isObj(x) && typeof x.kind === "string" && typeof x.detail === "string" && Object.keys(x).length === 2;

/** null if the loader behaves on this text; otherwise what went wrong. */
export function checkText(text: string, readers: readonly DataReader[] = READERS): Problem | null {
  let parsed: unknown;
  let parses = true;
  try {
    parsed = JSON.parse(text);
  } catch {
    parses = false;
  }
  let project: Project;
  try {
    project = projectFromJson(text, readers);
  } catch (e) {
    if (!(e instanceof Error) || e.constructor !== Error) return { kind: `threw a ${e instanceof Error ? e.name : typeof e}, not an Error`, detail: String(e) };
    const m = e.message;
    if (!OWN_MESSAGES.some((re) => re.test(m))) return { kind: `refused with a message that is not the loader's: ${shapeOf(m)}`, detail: m };
    if (ENGINE_WORDS.test(m)) return { kind: `refused with an engine message: ${shapeOf(m.replace(/^[^:]*: /, ""))}`, detail: m };
    if (!parses) return m.includes("not valid JSON") ? null : { kind: "invalid JSON refused for another reason", detail: m };
    if (m.includes("not valid JSON")) return { kind: "valid JSON refused as invalid", detail: m };
    const want = outerModel(parsed);
    if (want.refusal === null && !m.startsWith("can't open the ")) return { kind: "refused a well-formed outer layout", detail: m };
    if (want.refusal !== null && !m.includes(want.refusal)) return { kind: `refused for the wrong reason (model: ${want.refusal})`, detail: m };
    return null;
  }
  if (!parses) return { kind: "accepted text that is not valid JSON", detail: "" };
  const want = outerModel(parsed);
  if (want.refusal !== null) return { kind: `accepted a file the model refuses: ${want.refusal}`, detail: "" };
  const design = project.workspaces.design as DesignDocument | undefined;
  if (design) {
    const shown = guard("showing the Design part", () => {
      // An extrude of a sketch needs the kernel for its outline; readDesignDocument checked its sketch and distance.
      // A design with no body (24f4) has no part to show.
      const part = partOf(design);
      if (part === null || part.shape === "sketch-extrude") return null;
      return specOf(design, partFeature(design)!);
    });
    if (isProblem(shown)) return shown;
  }
  const saved = guard("saving the opened project", () => projectToJson(project));
  if (isProblem(saved)) return saved;
  const again = guard("opening the saved project", () => projectToJson(projectFromJson(saved, readers)));
  if (isProblem(again)) return again;
  if (again !== saved) return { kind: "saving, opening and saving again changed the text", detail: "" };
  // Design's own upgrades (version 1 → 2 → 3, docs/project-format.md) are the one change a save may make.
  const upgraded = structuredClone(want.upgraded) as { workspaces: Record<string, unknown> };
  const old = upgraded.workspaces.design;
  if (isObj(old) && old.version === 1) upgraded.workspaces.design = migrateDesignV2(migrateDesignV1(old));
  if (isObj(old) && old.version === 2) upgraded.workspaces.design = migrateDesignV2(old);
  if (canonical(JSON.parse(saved)) !== canonical(upgraded)) return { kind: "saving lost or changed something the file had", detail: "" };
  return null;
}

/** The shortest text (by deleting runs of characters) that still fails the same way. */
export function shrink(text: string, kind: string, readers: readonly DataReader[] = READERS): string {
  const same = (t: string) => checkText(t, readers)?.kind === kind;
  let chunk = 2 ** Math.ceil(Math.log2(Math.max(1, text.length)));
  while (chunk >= 1) {
    let at = 0;
    while (at < text.length) {
      const fewer = text.slice(0, at) + text.slice(at + chunk);
      if (same(fewer)) text = fewer;
      else at += chunk;
    }
    chunk = Math.floor(chunk / 2);
  }
  return text;
}

export interface Failure extends Problem {
  index: number;
  input: string;
}

/** One round: `cases` texts from `seed`; one shrunk failure per kind, and how the cases fell. */
export function fuzzRound(seed: bigint, cases: number, readers: readonly DataReader[] = READERS) {
  const r = seeded(seed);
  const failures: Failure[] = [];
  const counts = { opened: 0, openedNoBody: 0, refusedInvalidJson: 0, refusedOuter: 0, refusedByReader: 0, nested: 0, proto: 0 };
  for (let index = 0; index < cases; index++) {
    const text = makeCase(r);
    if (text.includes("[[[[[[[[[[")) counts.nested++;
    if (text.includes('"__proto__"')) counts.proto++;
    const problem = checkText(text, readers);
    if (problem) {
      if (!failures.some((f) => f.kind === problem.kind)) failures.push({ ...problem, index, input: shrink(text, problem.kind, readers) });
      continue;
    }
    try {
      const design = projectFromJson(text, readers).workspaces.design as DesignDocument | undefined;
      counts.opened++;
      if (design && partFeature(design) === null) counts.openedNoBody++;
    } catch (e) {
      const m = (e as Error).message;
      if (m.includes("not valid JSON")) counts.refusedInvalidJson++;
      else if (m.startsWith("can't open the ")) counts.refusedByReader++;
      else counts.refusedOuter++;
    }
  }
  return { failures, counts };
}

/** The report the nightly workflow files issues from: one "failure:" line per kind. */
export function fuzzReport(seed: bigint, cases: number, failures: readonly Failure[]): string {
  const lines = [`Project loader fuzzing, seed ${seed}, ${cases} inputs: ${failures.length} kind(s) of failure`];
  for (const f of failures) lines.push(`failure: ${f.kind} | case ${f.index} | shrunk input: input-${f.index}.json (${f.input.length} characters)`);
  return lines.join("\n") + "\n";
}
