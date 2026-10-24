//! The single home of every tolerance in the kernel. Model units are millimetres.
//!
//! Nothing outside this module may hard-code an epsilon. Float comparisons
//! (in code and in tests) go through the helpers here, and orientation /
//! in-out decisions go through the exact predicates at the bottom.
//!
//! Mutation testing (`cargo mutants -f src/tolerance.rs`) leaves these
//! survivors, all equivalent (no input can tell them apart):
//! - `<` vs `<=` in either half of `segments_touch`'s proper-crossing test
//!   (`o1·o2 < 0 && o3·o4 < 0`). The mutant also answers true early when
//!   one product is 0 and the other negative. Take o1 = 0 and o3·o4 < 0:
//!   a and b lie strictly on opposite sides of line cd, so line ab
//!   crosses line cd at one point strictly between a and b; c is on both
//!   lines (o1 = 0, exact), so c is that point, on segment ab, and the
//!   collinear clause (`o1 == 0 && on(a, b, c)`) returns true anyway. The
//!   same holds for o2 = 0 (d), and with the roles of the segments swapped
//!   for the other `<`. The predicates are exact, so there is no rounding
//!   case.

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

/// How far a placement frame's axes may be from unit length and from
/// square to each other (`ops::place`: |‖x‖ − 1|, |‖n‖ − 1| and |x·n|, the
/// cosine of their angle, each at most this): 64 ulps of 1, ≈ 1.42e-14. Two
/// points of model space are at most 2√3·MAX_COORD ≈ 3.5e8 mm apart, so an
/// axis this far off moves a point at the far side of model space from the
/// frame's origin by at most ~5e-6 mm (0.5 LINEAR) from where the frame
/// read literally would put it. A frame worked out in doubles (normalised,
/// crossed, turned) is off by a few ulps, so this leaves room for any
/// honest one; a frame off by more is the caller's bug, refused rather than
/// silently squared up. A whole number of ulps, so a vector exactly on the
/// boundary (length 1 ± 64 ulps) exists and the boundary can be tested.
pub const FRAME_SQUARE: f64 = 64.0 * f64::EPSILON;

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
/// double resolves 2⁻²⁶ mm, ~15 pm, a thousandth of LINEAR: fine for
/// placing a body, but shallow crossings magnify that rounding many times
/// over, so geometry is intersected in a body's own frame, near its local
/// origin.
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

/// Twice the signed area of the closed polygon through `corners` (the
/// shoelace sum Σ xᵢyᵢ₊₁ − xᵢ₊₁yᵢ), positive when they run
/// counter-clockwise. Every product and sum is kept exactly
/// (`accurate::Exact`), so the sign is exact, and exactly 0 only for a
/// polygon whose area is exactly 0; the value is within a few ulps.
/// Nothing is shifted to a nearer origin first: that subtraction would
/// round, and it isn't needed when nothing else does.
pub fn twice_area(corners: &[DVec2]) -> f64 {
    shoelace(corners).value()
}

/// The exact sign of `twice_area`: 1, −1 or 0.
pub fn area_sign(corners: &[DVec2]) -> i8 {
    shoelace(corners).sign()
}

fn shoelace(corners: &[DVec2]) -> crate::accurate::Exact {
    let mut sum = crate::accurate::Exact::default();
    for (i, &p) in corners.iter().enumerate() {
        let q = corners[(i + 1) % corners.len()];
        sum.add_product(p.x, q.y);
        sum.add_product(-q.x, p.y);
    }
    sum
}

fn c2(p: DVec2) -> robust::Coord<f64> {
    robust::Coord { x: p.x, y: p.y }
}

fn c3(p: DVec3) -> robust::Coord3D<f64> {
    robust::Coord3D { x: p.x, y: p.y, z: p.z }
}

#[cfg(test)]
mod tests {
    use crate::fmath;
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
        let tilt = |angle: f64| DVec3::new(fmath::cos(angle), fmath::sin(angle), 0.0);
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
    fn measure_eq_scales_with_the_larger_value() {
        // With no slack the allowance is FP_REL·max(|a|, |b|): at 1e6 that
        // is 1e-12 · 1e6 = 1e-6, a million times what it is at 1 (the
        // boundary test above uses a = 1, where FP_REL·1 = FP_REL/1).
        let allowed = FP_REL * 1e6;
        assert!(measure_eq(1e6, 1e6 + allowed * 0.9, 0.0));
        assert!(!measure_eq(1e6, 1e6 + allowed * 1.1, 0.0));
        assert!(measure_eq(-1e6, -1e6 - allowed * 0.9, 0.0), "magnitudes, not signed values");
    }

    #[test]
    fn a_zero_vector_has_no_direction() {
        // dirs_eq is for unit vectors, but a degenerate one (a zero normal
        // from a collapsed face, say) must not match every direction: its
        // cross product with anything is 0, which is within ANGULAR, so
        // only the dot product (0, not > 0) refuses it.
        assert!(!dirs_eq(DVec3::ZERO, DVec3::X));
        assert!(!dirs_eq(DVec3::Y, DVec3::ZERO));
        assert!(!dirs_eq(DVec3::ZERO, DVec3::ZERO));
    }

    #[test]
    fn side_by_hand() {
        // a→b along +X: (0, 1) is to the left, (0, −1) to the right, and
        // (7, 0) on the line, exactly 0 (not −1: the mirror image of a left
        // point must not be confused with a point on the line).
        let (a, b) = (DVec2::ZERO, DVec2::X);
        assert_eq!(side(a, b, DVec2::new(0.0, 1.0)), 1);
        assert_eq!(side(a, b, DVec2::new(0.0, -1.0)), -1);
        assert_eq!(side(a, b, DVec2::new(7.0, 0.0)), 0);
        assert_eq!(side(a, b, a), 0);
        // Exact: the nearly collinear case from orient2d's test, and the
        // point one step either side of the line (the smallest positive
        // double), are decided correctly, not rounded to "on".
        let (p, q) = (DVec2::new(0.5, 0.5), DVec2::new(12.0, 12.0));
        assert_eq!(side(p, q, DVec2::new(24.0, 24.0)), 0);
        assert_eq!(side(p, q, DVec2::new(24.0, 24.000000000000004)), 1);
        let tiny = f64::from_bits(1);
        assert_eq!(side(a, b, DVec2::new(3.0, tiny)), 1);
        assert_eq!(side(a, b, DVec2::new(3.0, -tiny)), -1);
    }

    #[test]
    fn segments_touch_by_hand() {
        let p = |x: f64, y: f64| DVec2::new(x, y);
        let ab = (p(0.0, 0.0), p(4.0, 0.0));
        // A proper crossing: the diagonals of a square meet at its centre.
        assert!(segments_touch((p(0.0, 0.0), p(4.0, 4.0)), (p(0.0, 4.0), p(4.0, 0.0))));
        // T-junctions: cd stands on ab at (2, 0), with its first end on ab
        // (c), then with its second (d). Neither is a proper crossing (one
        // side test is 0), so each relies on its own collinear clause.
        assert!(segments_touch(ab, (p(2.0, 0.0), p(2.0, 3.0))));
        assert!(segments_touch(ab, (p(2.0, 3.0), p(2.0, 0.0))));
        // And with ab's ends on cd (a, then b).
        assert!(segments_touch((p(2.0, 0.0), p(2.0, 3.0)), ab));
        assert!(segments_touch((p(2.0, 3.0), p(2.0, 0.0)), ab));
        // Lifting the foot by the smallest positive double: no longer
        // touching (exact, so there is no tolerance band either way).
        let tiny = f64::from_bits(1);
        assert!(!segments_touch(ab, (p(2.0, tiny), p(2.0, 3.0))));
        assert!(!segments_touch(ab, (p(2.0, 3.0), p(2.0, tiny))));
        // Ends meeting: touch. Collinear: overlapping touch, apart don't.
        assert!(segments_touch(ab, (p(4.0, 0.0), p(5.0, 1.0))));
        assert!(segments_touch(ab, (p(3.0, 0.0), p(6.0, 0.0))));
        assert!(!segments_touch(ab, (p(5.0, 0.0), p(6.0, 0.0))));
        // Parallel, one unit apart: no.
        assert!(!segments_touch(ab, (p(0.0, 1.0), p(4.0, 1.0))));
    }

    #[test]
    fn orient3d_sign_by_hand() {
        // a, b, c on the z = 0 plane, counter-clockwise seen from above.
        let (a, b, c) = (DVec3::ZERO, DVec3::X, DVec3::Y);
        assert!(orient3d(a, b, c, DVec3::new(0.3, 0.3, -1.0)) > 0.0, "below the plane is positive");
        assert!(orient3d(a, b, c, DVec3::new(0.3, 0.3, 1.0)) < 0.0, "above the plane is negative");
        assert!(orient3d(a, b, c, DVec3::new(7.0, -2.0, 0.0)) == 0.0, "coplanar is exactly zero");
    }

    /// The shoelace sum as the kernel took it before `twice_area`: plain
    /// doubles, each corner taken relative to the first.
    fn float_twice_area(c: &[DVec2]) -> f64 {
        let o = c[0];
        (0..c.len()).map(|i| (c[i] - o).perp_dot(c[(i + 1) % c.len()] - o)).sum()
    }

    #[test]
    fn a_sliver_plain_doubles_turn_the_wrong_way_by_hand() {
        // Corners o = (0, 0), A = (1 + t, 1), B = (1, 1 − t), C = (0, t²/2)
        // with t = 2⁻³⁰. Shoelace terms: o×A = 0, C×o = 0,
        // A×B = (1 + t)(1 − t) − 1·1 = −t², B×C = 1·t²/2 − (1 − t)·0 = t²/2.
        // Twice the area is −t² + t²/2 = −t²/2 = −2⁻⁶¹: clockwise.
        // In doubles (1 + t)(1 − t) = 1 − 2⁻⁶⁰ rounds to 1 (the gap below 1
        // is 2⁻⁵³), so A×B comes out 0 and the sum is +2⁻⁶¹: the loop reads
        // as counter-clockwise, the wrong way round.
        let t = (2f64).powi(-30);
        let c = [DVec2::ZERO, DVec2::new(1.0 + t, 1.0), DVec2::new(1.0, 1.0 - t), DVec2::new(0.0, t * t / 2.0)];
        assert_eq!(float_twice_area(&c), (2f64).powi(-61)); // the failure
        assert_eq!(twice_area(&c), -(2f64).powi(-61));
        assert_eq!(area_sign(&c), -1);
        // Walked the other way it is counter-clockwise, +2⁻⁶¹ exactly.
        let mut r = c;
        r.reverse();
        assert_eq!((twice_area(&r), area_sign(&r)), ((2f64).powi(-61), 1));
        // Starting from another corner changes nothing (a closed sum).
        r.rotate_left(1);
        assert_eq!(twice_area(&r), (2f64).powi(-61));
    }

    #[test]
    fn areas_by_hand() {
        let p = |x: f64, y: f64| DVec2::new(x, y);
        // A 2 × 3 rectangle with a corner at (10, 20), counter-clockwise:
        // twice the area is 2·6 = 12.
        let rect = [p(10.0, 20.0), p(12.0, 20.0), p(12.0, 23.0), p(10.0, 23.0)];
        assert_eq!((twice_area(&rect), area_sign(&rect)), (12.0, 1));
        // The L of corners (0,0) (2,0) (2,1) (1,1) (1,2) (0,2): a 2 × 2
        // square less the unit square at (1,1), area 3, so 6.
        let l = [p(0.0, 0.0), p(2.0, 0.0), p(2.0, 1.0), p(1.0, 1.0), p(1.0, 2.0), p(0.0, 2.0)];
        assert_eq!(twice_area(&l), 6.0);
        // A figure eight (0,0) (1,1) (1,0) (0,1): two triangles of area 1/4
        // turning opposite ways, so exactly 0, and the sign says so.
        let eight = [p(0.0, 0.0), p(1.0, 1.0), p(1.0, 0.0), p(0.0, 1.0)];
        assert_eq!((twice_area(&eight), area_sign(&eight)), (0.0, 0));
        // Collinear corners, and fewer than three: no area.
        assert_eq!(area_sign(&[p(0.5, 0.5), p(12.0, 12.0), p(24.0, 24.0)]), 0);
        assert_eq!((area_sign(&[p(3.0, 4.0)]), area_sign(&[])), (0, 0));
        // 100 km out (x = y = 1e8), a right triangle with legs 2⁻¹⁰ mm
        // (~1 µm) and 2⁻²⁶ mm (~15 pm, the spacing of doubles there, so
        // every coordinate is exact): twice the area is the product of the
        // legs, 2⁻³⁶, while the shoelace products are ~1e16 and cancel.
        let (b, h) = ((2f64).powi(-10), (2f64).powi(-26));
        let far = [p(1e8, 1e8), p(1e8 + b, 1e8), p(1e8, 1e8 + h)];
        assert_eq!(twice_area(&far), (2f64).powi(-36));
        assert_eq!(area_sign(&[far[0], far[2], far[1]]), -1);
    }

    /// splitmix64: a small seeded generator, so every run sees the same cases.
    fn splitmix(state: &mut u64) -> u64 {
        *state = state.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = *state;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    #[test]
    fn area_sign_agrees_with_exact_integer_arithmetic() {
        // Model: every coordinate is m·2^e for a random 53-bit m and e from
        // −60 to −55 (so all 53 bits are used, and points mix magnitudes 32×
        // apart, where differences round), then scaled by 2³⁰ to lie 4 km
        // to 270 km out. Unscaled, each is k·2⁻⁶⁰ for an integer k < 2⁵⁸,
        // so twice the area is 2⁻¹²⁰·Σ (kxᵢ·kyᵢ₊₁ − kxᵢ₊₁·kyᵢ) (times
        // 2⁶⁰ once scaled), and that integer sum fits an i128 exactly
        // (products < 2¹¹⁶, at most 16 corners). Two thirds of the polygons
        // are near-degenerate on purpose: corners on a line, rounded to
        // the nearest double (a tiny area left over from ~2¹¹⁰ terms), or
        // exactly on a line through the origin (area exactly 0).
        let seed = 0x5eed_a5ea_u64;
        let mut s = seed;
        let (mut float_wrong, mut float_flipped, mut zero) = (0, 0, 0);
        let scale = (2f64).powi(30);
        for case in 0..30_000 {
            let mut r = |m: u64| splitmix(&mut s) % m;
            let coord = |r: &mut dyn FnMut(u64) -> u64| {
                let m = ((1u64 << 52) | r(1 << 52)) as f64;
                let x = m * (2f64).powi(-60 + r(6) as i32);
                if r(2) == 0 { x } else { -x }
            };
            let n = 3 + r(14) as usize;
            let c: Vec<DVec2> = match case % 3 {
                0 => (0..n).map(|_| DVec2::new(coord(&mut r), coord(&mut r))).collect(),
                1 => {
                    // y = a + b·x in doubles, then onto the model's grid:
                    // each corner within 2⁻⁶⁰ of the line (|b| < 1 and
                    // |a| < 2⁻⁴ keep y inside the model's range).
                    let (a, b) = (coord(&mut r) / 4.0, coord(&mut r) * 2.0);
                    let grid = |y: f64| (y * (2f64).powi(60)).round() * (2f64).powi(-60);
                    (0..n).map(|_| { let x = coord(&mut r); DVec2::new(x, grid(a + b * x)) }).collect()
                }
                _ => {
                    // Multiples of one direction by powers of two: exactly
                    // collinear with the origin, which is a corner too.
                    // (d on a 2⁻⁵⁵ grid, so d/2⁴ stays on the model's.)
                    let on = |x: f64| (x * (2f64).powi(55)).round() * (2f64).powi(-55);
                    let d = DVec2::new(on(coord(&mut r)), on(coord(&mut r))) / 2.0;
                    let mut c: Vec<DVec2> = (0..n - 1).map(|_| d * (2f64).powi(-(r(5) as i32)) * if r(2) == 0 { 1.0 } else { -1.0 }).collect();
                    c.push(DVec2::ZERO);
                    c
                }
            };
            let k = |x: f64| {
                let v = x * (2f64).powi(60);
                assert!(v.fract() == 0.0 && v.abs() < (2f64).powi(58), "{x}");
                v as i128
            };
            let ks: Vec<[i128; 2]> = c.iter().map(|p| [k(p.x), k(p.y)]).collect();
            let model: i128 = (0..n).map(|i| {
                let (a, b) = (ks[i], ks[(i + 1) % n]);
                a[0] * b[1] - b[0] * a[1]
            }).sum();
            let c: Vec<DVec2> = c.iter().map(|&p| p * scale).collect();
            let want = model.signum() as i8;
            assert_eq!(area_sign(&c), want, "seed {seed:#x}, case {case}: {c:?}");
            let exact = model as f64 * (2f64).powi(-120) * scale * scale; // one rounding
            let got = twice_area(&c);
            assert!((got - exact).abs() <= 4.0 * f64::EPSILON * exact.abs(), "seed {seed:#x}, case {case}: {got} vs {exact}");
            let plain = float_twice_area(&c);
            float_wrong += (plain.partial_cmp(&0.0).map(|o| o as i8) != Some(want)) as usize;
            float_flipped += (plain * f64::from(want) < 0.0) as usize;
            zero += (model == 0) as usize;
        }
        // The cases have teeth: plain doubles misjudge a good share of
        // them, hundreds the opposite way round, and thousands are exactly 0.
        println!("plain doubles wrong in {float_wrong} of 30000 ({float_flipped} the opposite way); {zero} exactly 0");
        assert!(float_wrong > 1000 && float_flipped > 100 && zero > 1000, "{float_wrong} wrong, {float_flipped} flipped, {zero} zero");
    }
}
