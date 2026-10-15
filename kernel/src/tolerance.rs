//! The single home of every tolerance in the kernel. Model units are millimetres.
//!
//! Nothing outside this module may hard-code an epsilon. Float comparisons
//! (in code and in tests) go through the helpers here, and orientation /
//! in-out decisions go through the exact predicates at the bottom.

use glam::{DVec2, DVec3};

/// Two points closer than this are the same point (1 nm).
pub const LINEAR: f64 = 1e-6;

/// Two directions whose angle is below this (radians) are parallel.
pub const ANGULAR: f64 = 1e-9;

/// Faces with less area than this are degenerate.
pub const AREA: f64 = LINEAR * LINEAR;

/// Allowed relative error of extrapolated mass properties (volume, area).
/// See `mesh::mass_properties` for why tessellation-based values are this good.
pub const MASS_PROPS_REL: f64 = 1e-6;

/// Allowed relative error when comparing results that went through f32
/// (STL files store single-precision floats).
pub const F32_REL: f64 = 1e-6;

/// Default chord height (mm) and maximum angle per segment (radians) for
/// display tessellation.
pub const DISPLAY_CHORD: f64 = 0.01;
pub const DISPLAY_ANGLE: f64 = 0.2;

/// Maximum angle per segment used for mass-property tessellation.
pub const MASS_PROPS_ANGLE: f64 = 0.02;

/// Values this small are snapped to zero before triangulation (the CDT
/// rejects subnormal-ish coordinates).
pub const SNAP_TO_ZERO: f64 = 1e-100;

pub fn eq(a: f64, b: f64) -> bool {
    (a - b).abs() <= LINEAR
}

pub fn is_zero(a: f64) -> bool {
    a.abs() <= LINEAR
}

pub fn points_eq(a: DVec3, b: DVec3) -> bool {
    a.distance(b) <= LINEAR
}

pub fn points2_eq(a: DVec2, b: DVec2) -> bool {
    a.distance(b) <= LINEAR
}

/// Unit vectors pointing the same way.
pub fn dirs_eq(a: DVec3, b: DVec3) -> bool {
    a.cross(b).length() <= ANGULAR && a.dot(b) > 0.0
}

pub fn angle_eq(a: f64, b: f64) -> bool {
    (a - b).abs() <= ANGULAR
}

/// Relative comparison: |a - b| <= rel * max(|a|, |b|), falling back to
/// `LINEAR` near zero.
pub fn rel_eq(a: f64, b: f64, rel: f64) -> bool {
    let scale = a.abs().max(b.abs());
    (a - b).abs() <= (rel * scale).max(LINEAR * LINEAR)
}

// ---------------------------------------------------------------------------
// Exact predicates (Shewchuk, via the `robust` crate).

/// Positive if c is left of a→b, negative if right, exactly 0 if collinear.
pub fn orient2d(a: DVec2, b: DVec2, c: DVec2) -> f64 {
    robust::orient2d(c2(a), c2(b), c2(c))
}

/// Positive if d is below the plane through a, b, c (counter-clockwise seen
/// from above), negative if above, exactly 0 if coplanar.
pub fn orient3d(a: DVec3, b: DVec3, c: DVec3, d: DVec3) -> f64 {
    robust::orient3d(c3(a), c3(b), c3(c), c3(d))
}

fn c2(p: DVec2) -> robust::Coord<f64> {
    robust::Coord { x: p.x, y: p.y }
}

fn c3(p: DVec3) -> robust::Coord3D<f64> {
    robust::Coord3D { x: p.x, y: p.y, z: p.z }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_orientation_of_nearly_collinear_points() {
        // Classic case where naive floating point gets the sign wrong.
        let a = DVec2::new(0.5, 0.5);
        let b = DVec2::new(12.0, 12.0);
        let c = DVec2::new(24.0, 24.0);
        assert!(orient2d(a, b, c) == 0.0, "exactly collinear must give exactly 0");
        let c2 = DVec2::new(24.0, 24.000000000000004);
        assert!(orient2d(a, b, c2) > 0.0);
    }

    #[test]
    fn rel_eq_scales_with_magnitude() {
        assert!(rel_eq(1e5, 1e5 + 1e-2, 1e-6));
        assert!(!rel_eq(1.0, 1.0 + 1e-3, 1e-6));
    }
}
