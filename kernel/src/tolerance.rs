//! The single home of every tolerance in the kernel. Model units are millimetres.
//!
//! Nothing outside this module may hard-code an epsilon. Float comparisons
//! (in code and in tests) go through the helpers here, and orientation /
//! in-out decisions go through the exact predicates at the bottom.

use glam::{DVec2, DVec3};

/// Two points closer than this are the same point (10 nm). Chosen with the
/// owner from measurements (`examples/precision_budget.rs`, and the test
/// `intersect::tests::the_modelling_range_leaves_room_for_rounding`, which
/// fails if LINEAR or MAX_SIZE move past what doubles can support): at
/// MAX_SIZE a meeting point lands within 7.5e-9 of both pieces, but a
/// shallow crossing (0.06° to 0.6°) can slide 3.9e-6 along the curve. At
/// 1 nm with a 10 km limit, a part was 18× over in one intersection.
pub const LINEAR: f64 = 1e-5;

/// Two directions whose angle is below this (radians) are parallel.
pub const ANGULAR: f64 = 1e-9;

/// Faces with less area than this are degenerate.
pub const AREA: f64 = LINEAR * LINEAR;

/// Allowed relative error of extrapolated mass properties (volume, area).
/// See `mesh::mass_properties` for why tessellation-based values are this good.
pub const MASS_PROPS_REL: f64 = 1e-6;

/// Allowed relative error for results that are exact in real arithmetic
/// and only differ by floating-point rounding (e.g. the volume of a box).
pub const FP_REL: f64 = 1e-12;

/// Smallest feature size accepted (1 µm), 100× LINEAR.
pub const MIN_FEATURE: f64 = 1e-3;

/// Largest feature size accepted (1 km). Positions may go further out
/// (MAX_COORD) because a body's shape is kept apart from its placement.
pub const MAX_SIZE: f64 = 1e6;

/// Every point must stay within ±MAX_COORD (100 km) of the origin. There a
/// double resolves ~15 nm, about LINEAR: fine for placing a body, too
/// coarse to intersect there, so geometry is intersected in a body's own
/// frame, near its local origin.
pub const MAX_COORD: f64 = 1e8;

/// How many units in the last place a short chain of arithmetic may drift.
/// Used to bound rounding when values are moved around model space.
pub const ROUNDING_ULPS: f64 = 64.0;

/// Largest rounding error expected in a coordinate of magnitude `scale`
/// after a transform: ROUNDING_ULPS units in the last place.
pub fn rounding_slack(scale: f64) -> f64 {
    scale.abs().max(1.0) * ROUNDING_ULPS * f64::EPSILON
}

/// a ≈ b to FP_REL, plus an absolute allowance for rounding that does not
/// shrink with the values themselves (e.g. a tiny part far from the origin).
pub fn measure_eq(a: f64, b: f64, abs_slack: f64) -> bool {
    a.is_finite() && b.is_finite() && (a - b).abs() <= FP_REL * a.abs().max(b.abs()) + abs_slack
}

/// Allowed relative error when comparing results that went through f32
/// (STL files store single-precision floats).
pub const F32_REL: f64 = 1e-6;

/// Default chord height (mm) and maximum angle per segment (radians) for
/// display tessellation.
pub const DISPLAY_CHORD: f64 = 0.01;
pub const DISPLAY_ANGLE: f64 = 0.2;

/// Hard cap on chords per full turn of a circle, before `refine`. Keeps
/// tessellation cost bounded for any legal size: without it a 1 km sphere
/// at a 0.01 mm chord needs millions of triangles and stalls the kernel.
/// At the cap, chord height is r(1 − cos(π/256)) ≈ 7.5e-5·r.
pub const MAX_SEGMENTS_PER_TURN: f64 = 256.0;

/// Hard cap on the corners of an extrude profile (all loops together). The
/// profile check compares every corner with every segment, so this bounds
/// its cost at ~MAX_PROFILE_CORNERS² ≈ 4·10^6 distance tests.
pub const MAX_PROFILE_CORNERS: usize = 2000;

/// When a span is within this fraction of a segment of a whole number of
/// segments, it rounds down. Rounding noise (e.g. after a rotation) must not
/// add a sliver segment and make two copies of a shape mesh differently.
pub const SEGMENT_COUNT_SLACK: f64 = 1e-9;

/// Maximum angle per segment used for mass-property tessellation.
pub const MASS_PROPS_ANGLE: f64 = 0.02;

/// Values this small are snapped to zero before triangulation. The CDT
/// rejects non-zero coordinates below 2^-142 ≈ 1.8e-43, and anything this
/// far below LINEAR is rounding residue anyway. Must stay above the CDT's
/// floor (checked by a test in tessellate.rs).
pub const SNAP_TO_ZERO: f64 = 1e-40;

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

/// Relative comparison: |a - b| <= rel * max(|a|, |b|). Never true unless
/// both are finite (otherwise ∞ ≤ rel·∞ would let an infinite result
/// pass). There is no absolute floor: one (LINEAR² = 1e-12) used to make
/// every comparison of values below ~1 looser than asked, e.g. 1e-3
/// relative for a 1 µm cube's volume, and any two values under 1e-12
/// "equal". Compare against zero with an explicit bound instead.
pub fn rel_eq(a: f64, b: f64, rel: f64) -> bool {
    let scale = a.abs().max(b.abs());
    a.is_finite() && b.is_finite() && (a - b).abs() <= rel * scale
}

// ---------------------------------------------------------------------------
// Exact predicates (Shewchuk, via the `robust` crate).

/// Positive if c is left of a→b, negative if right, exactly 0 if collinear.
pub fn orient2d(a: DVec2, b: DVec2, c: DVec2) -> f64 {
    robust::orient2d(c2(a), c2(b), c2(c))
}

/// Sign of orient2d: 1, −1 or 0, exact.
pub fn side(a: DVec2, b: DVec2, c: DVec2) -> i8 {
    let o = orient2d(a, b, c);
    (o > 0.0) as i8 - (o < 0.0) as i8
}

/// Whether closed segments ab and cd share any point (exact).
pub fn segments_touch((a, b): (DVec2, DVec2), (c, d): (DVec2, DVec2)) -> bool {
    let (o1, o2, o3, o4) = (side(a, b, c), side(a, b, d), side(c, d, a), side(c, d, b));
    if o1 * o2 < 0 && o3 * o4 < 0 {
        return true;
    }
    // Collinear point on the other segment: exact box test.
    let on = |p: DVec2, q: DVec2, r: DVec2| r.cmpge(p.min(q)).all() && r.cmple(p.max(q)).all();
    (o1 == 0 && on(a, b, c)) || (o2 == 0 && on(a, b, d)) || (o3 == 0 && on(c, d, a)) || (o4 == 0 && on(c, d, b))
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
    fn infinite_or_nan_values_never_compare_equal() {
        // Regression (found by mutation testing in mass.rs): |∞ − x| = ∞ is
        // ≤ rel·max(∞, x) = ∞, so rel_eq(∞, x) was true and a test whose
        // result blew up to infinity passed. A measurement that isn't
        // finite is never "equal" to anything, itself included.
        for (a, b) in [(f64::INFINITY, 1.0), (1.0, f64::NEG_INFINITY), (f64::INFINITY, f64::INFINITY), (f64::NAN, 1.0), (f64::NAN, f64::NAN)] {
            assert!(!rel_eq(a, b, FP_REL) && !rel_eq(a, b, 1.0), "rel_eq({a}, {b})");
            assert!(!measure_eq(a, b, 0.0) && !measure_eq(a, b, f64::INFINITY), "measure_eq({a}, {b})");
        }
        // Finite values still compare as before: 1 vs 1 + 1e-13 at FP_REL.
        assert!(rel_eq(1.0, 1.0 + 1e-13, FP_REL) && !rel_eq(1.0, 1.0 + 1e-11, FP_REL));
        // Tiny values are compared relatively too: 1e-15 vs 2e-15 differ.
        assert!(!rel_eq(1e-15, 2e-15, FP_REL) && rel_eq(1e-15, 1e-15 * (1.0 + 1e-13), FP_REL));
        assert!(measure_eq(1.0, 1.5, 0.5) && !measure_eq(1.0, 1.6, 0.5));
    }

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
    fn near_misses_either_side_of_linear_tolerance() {
        let p = DVec3::new(10.0, -3.0, 7.0);
        for dir in [DVec3::X, DVec3::Y, DVec3::Z, DVec3::ONE.normalize()] {
            assert!(points_eq(p, p + dir * LINEAR * 0.9));
            assert!(!points_eq(p, p + dir * LINEAR * 1.1));
        }
        assert!(eq(5.0, 5.0 + LINEAR * 0.9));
        assert!(!eq(5.0, 5.0 + LINEAR * 1.1));
        assert!(is_zero(-LINEAR * 0.9));
        assert!(!is_zero(-LINEAR * 1.1));
        let q = DVec2::new(1.0, 2.0);
        assert!(points2_eq(q, q + DVec2::Y * LINEAR * 0.9));
        assert!(!points2_eq(q, q + DVec2::Y * LINEAR * 1.1));
    }

    #[test]
    fn near_misses_either_side_of_angular_tolerance() {
        let tilt = |angle: f64| DVec3::new(angle.cos(), angle.sin(), 0.0);
        assert!(dirs_eq(DVec3::X, tilt(ANGULAR * 0.9)));
        assert!(!dirs_eq(DVec3::X, tilt(ANGULAR * 1.1)));
        assert!(!dirs_eq(DVec3::X, -DVec3::X), "opposite directions are not equal");
        assert!(angle_eq(1.0, 1.0 + ANGULAR * 0.9));
        assert!(!angle_eq(1.0, 1.0 + ANGULAR * 1.1));
    }

    #[test]
    fn rel_eq_scales_with_magnitude() {
        // Allowed difference is rel × the larger magnitude: 1e-6 × 1e5 = 0.1.
        assert!(rel_eq(1e5, 1e5 + 0.09, 1e-6));
        assert!(!rel_eq(1e5, 1e5 + 0.11, 1e-6));
        assert!(!rel_eq(1e5, 1e5 + 1.0, 1e-6));
        assert!(!rel_eq(1.0, 1.0 + 1e-3, 1e-6));
    }

    #[test]
    fn measure_eq_boundaries_by_hand() {
        // Allowance = FP_REL·max(|a|,|b|) + slack. For a = 1, slack = 1e-9:
        // about 1e-12 + 1e-9 = 1.001e-9.
        let allowed = FP_REL + 1e-9;
        assert!(measure_eq(1.0, 1.0 + allowed * 0.9, 1e-9));
        assert!(!measure_eq(1.0, 1.0 + allowed * 1.1, 1e-9));
        // Rounding slack at 1e6 is 1e6 · 64 · 2.22e-16 ≈ 1.42e-8, and never
        // less than the slack at magnitude 1.
        assert!(rel_eq(rounding_slack(1e6), 1e6 * 64.0 * f64::EPSILON, FP_REL));
        assert!(rel_eq(rounding_slack(1e-3), rounding_slack(1.0), FP_REL));
    }

    #[test]
    fn orient3d_sign_by_hand() {
        // a, b, c on the z = 0 plane, counter-clockwise seen from above.
        let (a, b, c) = (DVec3::ZERO, DVec3::X, DVec3::Y);
        assert!(orient3d(a, b, c, DVec3::new(0.3, 0.3, -1.0)) > 0.0, "below the plane is positive");
        assert!(orient3d(a, b, c, DVec3::new(0.3, 0.3, 1.0)) < 0.0, "above the plane is negative");
        assert!(orient3d(a, b, c, DVec3::new(7.0, -2.0, 0.0)) == 0.0, "coplanar is exactly zero");
    }
}
