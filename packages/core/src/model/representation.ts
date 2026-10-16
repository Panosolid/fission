// "Anything can go anywhere": every object can describe itself in one or
// more standard representations, each workspace declares which ones it
// can accept, and the registry picks what to hand over. Copy/paste and
// drag-and-drop between any two workspaces go through deliver() below, so
// no pair of workspaces needs its own conversion code.
//
// Solid, Mesh and Outline are built for real (Design produces them).
// Image and Data are typed now and get their first producers with the
// Image workspace and with parameters / analysis results.

import type { BodySpec, Outline } from "../kernel/kernel-types.ts";

export type RepresentationKind = "solid" | "outline" | "mesh" | "image" | "data";

/**
 * Most exact first. Solid, Outline and Data carry everything their source
 * knows; Mesh and Image are approximations (facets, pixels), used only
 * when the target can't take anything better.
 */
export const EXACTNESS: readonly RepresentationKind[] = ["solid", "outline", "data", "mesh", "image"];
export const isExact = (kind: RepresentationKind) => kind === "solid" || kind === "outline" || kind === "data";

/** A plane in model space (mm): origin, in-plane x axis and normal, both unit length. */
export interface Plane {
  origin: [number, number, number];
  xAxis: [number, number, number];
  normal: [number, number, number];
}

/** The ground plane, z = 0, seen from above. */
export const XY_PLANE: Plane = { origin: [0, 0, 0], xAxis: [1, 0, 0], normal: [0, 0, 1] };

/** Exact B-rep: what the kernel builds, described so it can be rebuilt exactly. */
export interface SolidRep {
  kind: "solid";
  spec: BodySpec;
}

/** 2D paths with exact curves (lines and arcs today; Béziers/NURBS at step 65), on a plane. */
export interface OutlineRep {
  kind: "outline";
  plane: Plane;
  outline: Outline;
}

/** Triangles in mm, for display, printing and scans. */
export interface MeshRep {
  kind: "mesh";
  positions: number[];
  indices: number[];
}

/** DRAFT: raster pixels with a physical size. */
export interface ImageRep {
  kind: "image";
  width: number;
  height: number;
  /** Physical size of one pixel. */
  mmPerPixel: number;
  /** RGBA, row by row. */
  rgba: Uint8ClampedArray;
}

/** DRAFT: structured values such as parameters, BOM lines and analysis results. */
export interface DataRep {
  kind: "data";
  values: Record<string, unknown>;
}

export type Representation = SolidRep | OutlineRep | MeshRep | ImageRep | DataRep;
export type RepresentationOf<K extends RepresentationKind> = Extract<Representation, { kind: K }>;

/** Anything a workspace can hand to another: its type names who knows how to describe it. */
export interface Producible {
  /** e.g. "design.feature", "design.profile"; later "design.sketch", "vector.path". */
  type: string;
  id: string;
}

/** Describes one type of object in one representation. */
export type Producer = (object: Producible) => Representation | Promise<Representation>;

/** Turns one representation into another (e.g. outline → image for a raster engraving). */
export interface Converter {
  from: RepresentationKind;
  to: RepresentationKind;
  convert(rep: Representation): Representation | Promise<Representation>;
}

/** What deliver() handed over, and a note for the user when something was lost on the way. */
export interface Delivery {
  representation: Representation;
  /** Set when a lossy representation was used although the source had an exact one. */
  note: string | null;
}

/** What a lossy representation loses. */
const losses: Partial<Record<RepresentationKind, string>> = {
  mesh: "curved faces become flat facets",
  image: "edges become pixels",
};

const nouns: Record<RepresentationKind, string> = {
  solid: "an exact solid",
  outline: "an exact outline",
  mesh: "a triangle mesh",
  image: "an image",
  data: "data",
};

export class RepresentationRegistry {
  private producers = new Map<string, Map<RepresentationKind, Producer>>();
  private converters: Converter[] = [];

  /** Says that objects of `type` can describe themselves as `kind`. */
  registerProducer(type: string, kind: RepresentationKind, producer: Producer): void {
    let byKind = this.producers.get(type);
    if (!byKind) this.producers.set(type, (byKind = new Map()));
    if (byKind.has(kind)) throw new Error(`${type} already has a ${kind} producer`);
    byKind.set(kind, producer);
  }

  registerConverter(converter: Converter): void {
    this.converters.push(converter);
  }

  /** The representations an object of this type can give directly, most exact first. */
  produces(type: string): RepresentationKind[] {
    const byKind = this.producers.get(type);
    return EXACTNESS.filter((k) => byKind?.has(k));
  }

  /** The representation an object would arrive in, without producing it; null if none fits. */
  plan(type: string, accepts: readonly RepresentationKind[]): { kind: RepresentationKind; via: RepresentationKind | null } | null {
    const direct = this.produces(type);
    const reachable: { kind: RepresentationKind; via: RepresentationKind | null }[] = [];
    for (const kind of direct) reachable.push({ kind, via: null });
    for (const c of this.converters)
      if (direct.includes(c.from) && !direct.includes(c.to)) reachable.push({ kind: c.to, via: c.from });
    for (const kind of EXACTNESS) {
      if (!accepts.includes(kind)) continue;
      // Prefer a direct producer; otherwise convert from the most exact source kind.
      const options = reachable.filter((r) => r.kind === kind);
      if (options.length === 0) continue;
      const best = options.find((r) => r.via === null) ?? options.sort((a, b) => EXACTNESS.indexOf(a.via!) - EXACTNESS.indexOf(b.via!))[0];
      return best;
    }
    return null;
  }

  /**
   * Hands `object` over in the most exact representation the target
   * accepts. Falls back to a lossy one (e.g. solid → mesh) only when the
   * target can't take better, and says so in the note.
   */
  async deliver(object: Producible, accepts: readonly RepresentationKind[]): Promise<Delivery> {
    const route = this.plan(object.type, accepts);
    if (!route) {
      const has = this.produces(object.type);
      throw new Error(
        has.length === 0
          ? `nothing knows how to describe a ${object.type}`
          : `a ${object.type} can be ${has.map((k) => nouns[k]).join(" or ")}, but the target only takes ${accepts.map((k) => nouns[k]).join(" or ")}`,
      );
    }
    const source = route.via ?? route.kind;
    let representation = await this.producers.get(object.type)!.get(source)!(object);
    if (route.via) {
      const c = this.converters.find((c) => c.from === route.via && c.to === route.kind)!;
      representation = await c.convert(representation);
    }
    if (representation.kind !== route.kind) throw new Error(`the ${source} producer for ${object.type} returned ${representation.kind}`);
    const bestExact = this.produces(object.type).find(isExact);
    const note =
      !isExact(route.kind) && bestExact
        ? `Sent as ${nouns[route.kind]}: the target can't take ${nouns[bestExact]}, so ${losses[route.kind]}.`
        : null;
    return { representation, note };
  }
}
