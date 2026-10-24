// One project file holds everything: the design timeline, render scenes,
// simulation studies, CAM setups, laser jobs and print plates. Each
// workspace stores its own data under its id and refers to other
// workspaces' objects only through links and references, never copies.
//
// The format is open and documented in docs/project-format.md: a version
// number, and a migration for every version change, so a file saved by an
// older SpindleLabs always opens in a newer one.

import type { Link } from "./links.ts";
import type { Material } from "./material.ts";

export type WorkspaceId = "design" | "render" | "simulate" | "manufacture" | "laser" | "slice" | "circuit" | "vector" | "image" | "layout";

/** One units system for every workspace. The kernel always works in mm. */
export type LengthUnit = "mm" | "cm" | "m" | "in";

/** The version this build writes. Bump it only together with a new entry in MIGRATIONS. */
export const FORMAT_VERSION = 2;

/** Deepest nesting of lists and objects a file may have (JSON.stringify fails somewhere past ~5,000; real projects are about 10 deep). */
export const MAX_NESTING = 256;

/**
 * Largest project file opened, in bytes (security audit S2): reading a far
 * bigger one could freeze the tab, and the app reopens the last project on
 * every visit. Real projects are well under 1 MB; the biggest design Design
 * itself opens is about 40 MB.
 */
export const MAX_PROJECT_BYTES = 64 * 1024 * 1024;

/** A size in MB as the messages say it, rounded up to a tenth so a size over a limit never reads as the limit: "64 MB", "64.1 MB" (1 MB = 1024 × 1024 bytes, as MAX_PROJECT_BYTES counts). */
export const megabytes = (bytes: number): string => `${Math.ceil((bytes / (1024 * 1024)) * 10) / 10} MB`;

/** Why a project of this many bytes (or UTF-16 code units, which a UTF-8 file never has more of than bytes) isn't opened, or null when it is. */
export function tooBig(size: number): string | null {
  return size > MAX_PROJECT_BYTES ? `it is ${megabytes(size)}, and a SpindleLabs project may be at most ${megabytes(MAX_PROJECT_BYTES)}` : null;
}

export interface Project {
  formatVersion: typeof FORMAT_VERSION;
  name: string;
  units: { length: LengthUnit };
  materials: Material[];
  /** Live links and frozen copies between workspaces (links.ts). */
  links: Link[];
  /** Each workspace's own data, with its own version inside (e.g. Design's DesignDocument). */
  workspaces: Partial<Record<WorkspaceId, unknown>>;
}

/** A new, empty project. */
export function emptyProject(name = "Untitled"): Project {
  return { formatVersion: FORMAT_VERSION, name, units: { length: "mm" }, materials: [], links: [], workspaces: {} };
}

type Json = Record<string, unknown>;

/**
 * MIGRATIONS[n] turns a version-n file into version n + 1. Never edit an
 * old entry: files in that version exist on people's machines.
 */
const MIGRATIONS: Record<number, (old: Json) => Json> = {
  // 1 → 2: live links arrive (I9). Old files had none.
  1: (old) => ({ ...old, formatVersion: 2, links: [] }),
};

/**
 * Reads a saved project (already parsed from JSON), upgrading older
 * versions step by step. A file from a newer SpindleLabs, or one that is not a
 * project, is refused with a clear message rather than half-read.
 */
export function readProject(data: unknown): Project {
  if (typeof data !== "object" || data === null || Array.isArray(data)) throw new Error("not a SpindleLabs project: expected an object");
  let p = data as Json;
  const v = p.formatVersion;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) throw new Error("not a SpindleLabs project: no format version");
  if (v > FORMAT_VERSION) throw new Error(`this project was saved by a newer SpindleLabs (format ${v}; this one reads up to ${FORMAT_VERSION})`);
  for (let n = v; n < FORMAT_VERSION; n++) p = MIGRATIONS[n](p);
  for (const key of ["name", "units", "materials", "links", "workspaces"])
    if (!(key in p)) throw new Error(`not a SpindleLabs project: "${key}" is missing`);
  if (typeof p.name !== "string") throw new Error('not a SpindleLabs project: "name" must be text');
  if (!isObject(p.units) || !LENGTH_UNITS.includes(p.units.length as LengthUnit)) throw new Error(`not a SpindleLabs project: "units" must give a length unit (${LENGTH_UNITS.join(", ")})`);
  if (!Array.isArray(p.materials)) throw new Error('not a SpindleLabs project: "materials" must be a list');
  if (!Array.isArray(p.links)) throw new Error('not a SpindleLabs project: "links" must be a list');
  if (!isObject(p.workspaces)) throw new Error('not a SpindleLabs project: "workspaces" must be an object');
  return p as unknown as Project;
}

const LENGTH_UNITS: readonly LengthUnit[] = ["mm", "cm", "m", "in"];

const isObject = (x: unknown): x is Json => typeof x === "object" && x !== null && !Array.isArray(x);

/**
 * The project as the text of a .spindlelabs.json file: keys in sorted order at
 * every level (so saving the same project twice gives the same bytes, and
 * diffs stay small), two-space indents. A number JSON can't hold (NaN,
 * Infinity) is refused with where it is, rather than written as null and
 * making a file that no longer opens.
 */
export function projectToJson(project: Project): string {
  const sorted = (x: unknown, path: string): unknown => {
    if (typeof x === "number" && !Number.isFinite(x)) throw new Error(`can't save: ${path} is ${x}, not a number a file can hold`);
    if (Array.isArray(x)) return x.map((v, i) => sorted(v, `${path}[${i}]`));
    if (!isObject(x)) return x;
    // fromEntries defines each key, so a "__proto__" key stays a key
    // (assigning it would set the object's prototype instead).
    return Object.fromEntries(Object.keys(x).sort().filter((key) => x[key] !== undefined).map((key) => [key, sorted(x[key], `${path}.${key}`)]));
  };
  return JSON.stringify(sorted(project, "project"), null, 2) + "\n";
}

/**
 * Refuses what JSON.parse lets through but a file can't hold again: a
 * number too big for a double (1e400 reads as Infinity) and nesting past
 * MAX_NESTING (which saving could not write back). Walks with its own stack,
 * so a file nested a million deep can't overflow this check either.
 */
function checkValues(data: unknown) {
  const stack: [unknown, string, number][] = [[data, "project", 1]];
  while (stack.length) {
    const [x, path, depth] = stack.pop()!;
    if (typeof x === "number" && !Number.isFinite(x)) throw new Error(`not a SpindleLabs project: ${path} is too big a number`);
    if (typeof x !== "object" || x === null) continue;
    if (depth > MAX_NESTING) throw new Error(`not a SpindleLabs project: ${path} is nested more than ${MAX_NESTING} deep`);
    if (Array.isArray(x)) x.forEach((v, i) => stack.push([v, `${path}[${i}]`, depth + 1]));
    else for (const key of Object.keys(x)) stack.push([(x as Json)[key], `${path}.${key}`, depth + 1]);
  }
}

/** The part of a workspace plugin that reads its own data (WorkspacePlugin.readData). */
export interface DataReader {
  id: WorkspaceId;
  readData?(data: unknown): unknown;
}

/**
 * Opens the text of a .spindlelabs.json file: parses it, upgrades the outer
 * layout (readProject), then hands each workspace its own part to read and
 * upgrade. Data of a workspace this build has no reader for is kept as it
 * is. Any failure throws one message saying what is wrong; nothing is
 * returned half-read.
 */
export function projectFromJson(text: string, readers: readonly DataReader[]): Project {
  const big = tooBig(text.length); // before parsing, which is the slow part
  if (big) throw new Error(`can't open this project: ${big}`);
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`not a SpindleLabs project: the file is not valid JSON (${e instanceof Error ? e.message : String(e)})`);
  }
  checkValues(data);
  const project = readProject(data);
  const workspaces: Project["workspaces"] = {};
  for (const [id, part] of Object.entries(project.workspaces) as [WorkspaceId, unknown][]) {
    const reader = readers.find((r) => r.id === id)?.readData;
    try {
      // Defined, not assigned, so even an id "__proto__" stays a key.
      Object.defineProperty(workspaces, id, { value: reader ? reader(part) : part, enumerable: true, writable: true, configurable: true });
    } catch (e) {
      throw new Error(`can't open the ${id} workspace's data: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { ...project, workspaces };
}
