// DRAFT: will change as the real workspaces are built.
//
// One materials library for the whole project: a Design appearance, a
// Render material, Simulate's mechanical properties and the Slice / Laser
// process presets are all views of the same Material.

export interface Material {
  id: string;
  name: string;
  /** How it looks in Design and Render. */
  appearance: { colour: string; roughness: number; metalness: number };
  /** What Simulate needs, in SI units. Absent until someone fills it in. */
  mechanical?: { density: number; youngsModulus: number; poissonsRatio: number; yieldStrength: number };
  /** Presets for the making workspaces, keyed by printer or machine profile. */
  processes?: {
    /** Slice: print settings, per printer profile. */
    print?: Record<string, unknown>;
    /** Laser: power and speed for cut, engrave and score, per machine. */
    laser?: Record<string, { power: number; speed: number; passes: number }>;
  };
  /** Manufacture: stock sizes and how it machines. */
  stock?: { forms: string[]; surfaceSpeed?: number };
}

/** The one materials library: every workspace reads the same Material. */
export interface MaterialLibrary {
  all(): Material[];
  get(id: string): Material | undefined;
  add(material: Material): void;
  update(id: string, change: Partial<Material>): void;
}

/** The project's materials library. Not implemented yet (with step 62, I3). */
export function materialLibrary(): MaterialLibrary {
  throw new Error("not implemented");
}
