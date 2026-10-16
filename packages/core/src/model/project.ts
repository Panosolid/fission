// One project file holds everything: the design timeline, render scenes,
// simulation studies, CAM setups, laser jobs and print plates. Each
// workspace stores its own data under its id and refers to other
// workspaces' objects only through links and references, never copies.
//
// The format is open and documented in docs/project-format.md: a version
// number, and a migration for every version change, so a file saved by an
// older Fission always opens in a newer one.

import type { Link } from "./links.ts";
import type { Material } from "./material.ts";

export type WorkspaceId = "design" | "render" | "simulate" | "manufacture" | "laser" | "slice" | "circuit" | "vector" | "image" | "layout";

/** One units system for every workspace. The kernel always works in mm. */
export type LengthUnit = "mm" | "cm" | "m" | "in";

/** The version this build writes. Bump it only together with a new entry in MIGRATIONS. */
export const FORMAT_VERSION = 2;

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
 * versions step by step. A file from a newer Fission, or one that is not a
 * project, is refused with a clear message rather than half-read.
 */
export function readProject(data: unknown): Project {
  if (typeof data !== "object" || data === null || Array.isArray(data)) throw new Error("not a Fission project: expected an object");
  let p = data as Json;
  const v = p.formatVersion;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) throw new Error("not a Fission project: no format version");
  if (v > FORMAT_VERSION) throw new Error(`this project was saved by a newer Fission (format ${v}; this one reads up to ${FORMAT_VERSION})`);
  for (let n = v; n < FORMAT_VERSION; n++) p = MIGRATIONS[n](p);
  for (const key of ["name", "units", "materials", "links", "workspaces"])
    if (!(key in p)) throw new Error(`not a Fission project: "${key}" is missing`);
  if (!isObject(p.workspaces)) throw new Error('not a Fission project: "workspaces" must be an object');
  return p as unknown as Project;
}

const isObject = (x: unknown): x is Json => typeof x === "object" && x !== null && !Array.isArray(x);

/**
 * The project as the text of a .fission.json file: keys in sorted order at
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
    const out: Json = {};
    for (const key of Object.keys(x).sort()) if (x[key] !== undefined) out[key] = sorted(x[key], `${path}.${key}`);
    return out;
  };
  return JSON.stringify(sorted(project, "project"), null, 2) + "\n";
}

/** The part of a workspace plugin that reads its own data (WorkspacePlugin.readData). */
export interface DataReader {
  id: WorkspaceId;
  readData?(data: unknown): unknown;
}

/**
 * Opens the text of a .fission.json file: parses it, upgrades the outer
 * layout (readProject), then hands each workspace its own part to read and
 * upgrade. Data of a workspace this build has no reader for is kept as it
 * is. Any failure throws one message saying what is wrong; nothing is
 * returned half-read.
 */
export function projectFromJson(text: string, readers: readonly DataReader[]): Project {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`not a Fission project: the file is not valid JSON (${e instanceof Error ? e.message : String(e)})`);
  }
  const project = readProject(data);
  const workspaces: Project["workspaces"] = {};
  for (const [id, part] of Object.entries(project.workspaces) as [WorkspaceId, unknown][]) {
    const reader = readers.find((r) => r.id === id)?.readData;
    try {
      workspaces[id] = reader ? reader(part) : part;
    } catch (e) {
      throw new Error(`can't open the ${id} workspace's data: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { ...project, workspaces };
}
