// Files from the outside world (X6, docs/integration.md principle 8):
// dropping or pasting a file anywhere routes it through the representation
// registry. identifyFile says what a file is from its first bytes and its
// name; routeFiles finds the workspace that registered an importer for that
// format, or refuses with a message saying why: a type SpindleLabs will open
// later names the workspace that will take it, a damaged or renamed file
// says so, and an unknown one lists what SpindleLabs opens today.
//
// What a file is, in order:
// 1. Contents with a strong signature decide alone, whatever the name says:
//    PNG (its 8 signature bytes), JPEG (FF D8 FF), PDF ("%PDF-"), STEP
//    ("ISO-10303-21;"), a SpindleLabs project (a JSON object with
//    "formatVersion" near the start) and SVG (its first element is <svg).
// 2. STL and DXF have weak signatures (an ASCII STL starts with "solid",
//    which plenty of text does; a binary STL has no signature at all, only
//    a size that must equal 84 + 50 × its triangle count), so they count
//    only when the name also says .stl or .dxf.
// 3. A name that claims a format its contents don't match is refused as
//    damaged or renamed; anything else is unknown.

import { tooBig, type WorkspaceId } from "./project.ts";
import { workspaceName } from "./feature.ts";
import type { RepresentationKind, RepresentationRegistry } from "./representation.ts";

export type FileFormat = "project" | "png" | "jpeg" | "svg" | "dxf" | "stl" | "step" | "pdf";

export interface FileFormatInfo {
  format: FileFormat;
  /** "a PNG image", for a file named like one. */
  one: string;
  /** "PNG images", for lists. */
  many: string;
  /** Lower case, with the dot; the first is the usual one. */
  extensions: readonly string[];
  /** The representation its contents arrive in (null: a whole project, not one object). */
  representation: RepresentationKind | null;
  /** Who will take it once an importer exists, and as what (docs/roadmap.md: STL X10, SVG V2/L2, DXF L2, STEP 71, PDF Y3). */
  planned: { workspaces: readonly WorkspaceId[]; as: string };
}

/** Every format SpindleLabs knows, in the order lists name them. */
export const FILE_FORMATS: readonly FileFormatInfo[] = [
  { format: "project", one: "a SpindleLabs project", many: "SpindleLabs projects (.spindlelabs.json)", extensions: [".spindlelabs.json", ".panosolid.json", ".fission.json"], representation: null, planned: { workspaces: [], as: "projects" } },
  { format: "png", one: "a PNG image", many: "PNG images", extensions: [".png"], representation: "image", planned: { workspaces: ["image"], as: "images" } },
  { format: "jpeg", one: "a JPEG image", many: "JPEG images", extensions: [".jpg", ".jpeg"], representation: "image", planned: { workspaces: ["image"], as: "images" } },
  { format: "svg", one: "an SVG drawing", many: "SVG drawings", extensions: [".svg"], representation: "outline", planned: { workspaces: ["vector", "laser"], as: "outlines" } },
  { format: "dxf", one: "a DXF drawing", many: "DXF drawings", extensions: [".dxf"], representation: "outline", planned: { workspaces: ["laser"], as: "outlines" } },
  { format: "stl", one: "an STL mesh", many: "STL meshes", extensions: [".stl"], representation: "mesh", planned: { workspaces: ["design"], as: "mesh bodies" } },
  { format: "step", one: "a STEP model", many: "STEP models", extensions: [".step", ".stp"], representation: "solid", planned: { workspaces: ["design"], as: "exact solids" } },
  { format: "pdf", one: "a PDF document", many: "PDF documents", extensions: [".pdf"], representation: "outline", planned: { workspaces: ["layout"], as: "pages" } },
];

export const formatInfo = (format: FileFormat): FileFormatInfo => FILE_FORMATS.find((f) => f.format === format)!;

/** How much of a file identifyFile looks at; the shell reads this much before routing. */
export const HEAD_BYTES = 64 * 1024;

/** A file's name, its full size in bytes and its first bytes (up to HEAD_BYTES). */
export interface FileHead {
  name: string;
  size: number;
  head: Uint8Array;
}

export type Identified = { ok: true; format: FileFormat } | { ok: false; reason: "renamed"; claimed: FileFormat } | { ok: false; reason: "unknown" };

/** The format the name claims, from its extension (no extension in the table ends another, so at most one matches). */
export function claimedFormat(name: string): FileFormat | null {
  const lower = name.toLowerCase();
  return FILE_FORMATS.find((f) => f.extensions.some((ext) => lower.endsWith(ext) && lower.length > ext.length))?.format ?? null;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const startsWith = (bytes: Uint8Array, prefix: readonly number[], at = 0) => bytes.length >= at + prefix.length && prefix.every((b, i) => bytes[at + i] === b);
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

/** The head as Latin-1 text (one character per byte, so nothing can fail to decode), without a UTF-8 byte order mark. */
function text(head: Uint8Array): string {
  const start = startsWith(head, [0xef, 0xbb, 0xbf]) ? 3 : 0;
  let s = "";
  for (let i = start; i < head.length; i++) s += String.fromCharCode(head[i]);
  return s;
}

/** True when the first element of this XML-ish text is <svg (after a declaration, comments, a doctype and whitespace). */
function firstElementIsSvg(t: string): boolean {
  let i = 0;
  for (;;) {
    while (i < t.length && /\s/.test(t[i])) i++;
    if (t.startsWith("<?", i)) {
      const end = t.indexOf("?>", i + 2);
      if (end < 0) return false;
      i = end + 2;
    } else if (t.startsWith("<!--", i)) {
      const end = t.indexOf("-->", i + 4);
      if (end < 0) return false;
      i = end + 3;
    } else if (t.startsWith("<!DOCTYPE", i) || t.startsWith("<!doctype", i)) {
      const end = t.indexOf(">", i);
      if (end < 0) return false;
      i = end + 1;
    } else break;
  }
  return t.startsWith("<svg", i) && (i + 4 === t.length || /[\s>/]/.test(t[i + 4]));
}

/** The format the contents show by themselves, or null (STL and DXF never show here: their signatures are too weak). */
function strongFormat(head: Uint8Array): FileFormat | null {
  if (startsWith(head, PNG_SIGNATURE)) return "png";
  if (startsWith(head, [0xff, 0xd8, 0xff])) return "jpeg";
  if (startsWith(head, ascii("%PDF-"))) return "pdf";
  const t = text(head).trimStart();
  if (t.startsWith("ISO-10303-21;")) return "step";
  if (t.startsWith("{") && t.includes('"formatVersion"')) return "project";
  if (firstElementIsSvg(t)) return "svg";
  return null;
}

/** A binary STL: an 80-byte header, a little-endian triangle count, then exactly 50 bytes per triangle. */
function isBinaryStl(file: FileHead): boolean {
  if (file.size < 84 || file.head.length < 84) return false;
  const count = new DataView(file.head.buffer, file.head.byteOffset + 80, 4).getUint32(0, true);
  return file.size === 84 + 50 * count;
}

/** Checks a weak signature, for a file whose name already says .stl or .dxf. */
function weakMatches(format: FileFormat, file: FileHead): boolean {
  if (format === "stl") return /^\s*solid(\s|$)/.test(text(file.head)) || isBinaryStl(file);
  if (format === "dxf") {
    // Group code 0, then SECTION: the first two lines of every text DXF.
    const lines = text(file.head).split(/\r?\n/).map((l) => l.trim());
    while (lines.length > 0 && lines[0] === "") lines.shift();
    return lines[0] === "0" && lines[1] === "SECTION";
  }
  return false;
}

/** What a file is (rules at the top of this file). Never throws, whatever the bytes. */
export function identifyFile(file: FileHead): Identified {
  const strong = strongFormat(file.head);
  if (strong) return { ok: true, format: strong };
  const claimed = claimedFormat(file.name);
  if (claimed === null) return { ok: false, reason: "unknown" };
  if ((claimed === "stl" || claimed === "dxf") && weakMatches(claimed, file)) return { ok: true, format: claimed };
  return { ok: false, reason: "renamed", claimed };
}

/**
 * Opens files of some formats: the shell for projects (workspace null),
 * a workspace for the rest. `open` gets the whole file; it is called only
 * for a file identifyFile gave one of `formats`.
 */
export interface FileImporter {
  formats: readonly FileFormat[];
  workspace: WorkspaceId | null;
  open(name: string, bytes: Uint8Array): Promise<void>;
}

export type FileRoute = { kind: "open"; format: FileFormat; importer: FileImporter } | { kind: "refused"; message: string };

/** "A", "A and B", "A, B and C". */
const andList = (items: readonly string[]) => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);

/** Routes what was dropped or pasted: one file at a time; null when there was none. */
export function routeFiles(registry: RepresentationRegistry, files: readonly FileHead[]): FileRoute | null {
  if (files.length === 0) return null;
  if (files.length > 1) return { kind: "refused", message: `Drop or paste one file at a time (there were ${files.length}).` };
  const file = files[0];
  const name = `“${file.name}”`;
  const found = identifyFile(file);
  if (!found.ok && found.reason === "renamed")
    return { kind: "refused", message: `Couldn't open ${name}: it is named like ${formatInfo(found.claimed).one}, but its contents aren't one (it may be damaged, or renamed from another type).` };
  if (!found.ok) {
    const opens = FILE_FORMATS.filter((f) => registry.importerFor(f.format)).map((f) => f.many);
    return { kind: "refused", message: `Couldn't open ${name}: SpindleLabs doesn't know this type of file. ${opens.length ? `It opens ${andList(opens)}.` : "It can't open any files yet."}` };
  }
  const importer = registry.importerFor(found.format);
  // Refused by its size alone, before the shell reads the whole file.
  const big = found.format === "project" ? tooBig(file.size) : null;
  if (importer && big) return { kind: "refused", message: `Couldn't open ${name}: ${big}.` };
  if (importer) return { kind: "open", format: found.format, importer };
  const info = formatInfo(found.format);
  if (info.planned.workspaces.length === 0) return { kind: "refused", message: `Couldn't open ${name}: nothing here opens ${info.many}.` };
  const who = andList(info.planned.workspaces.map(workspaceName));
  return { kind: "refused", message: `Couldn't open ${name}: SpindleLabs can't open ${info.many} yet. ${who} will take them as ${info.planned.as}.` };
}
