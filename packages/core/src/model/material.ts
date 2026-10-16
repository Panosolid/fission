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
  processes?: { print?: Record<string, unknown>; laser?: Record<string, unknown> };
}
