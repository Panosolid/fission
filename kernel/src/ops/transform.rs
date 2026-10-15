//! Moving and rotating bodies.

use super::{finish, KernelError};
use crate::geom::Transform;
use crate::tolerance::{ANGULAR, MAX_COORD};
use crate::topology::Body;
use glam::DVec3;
use std::f64::consts::TAU;

/// Moves a body by `offset`.
pub fn translate(body: &Body, offset: DVec3) -> Result<Body, KernelError> {
    if !offset.is_finite() {
        return Err(KernelError::InvalidInput(format!("move distance must be finite, got {offset}")));
    }
    apply(body, &Transform::translation(offset))
}

/// Rotates a body by `angle` radians about the line through `pivot` along `axis`
/// (counter-clockwise looking down the axis).
pub fn rotate(body: &Body, pivot: DVec3, axis: DVec3, angle: f64) -> Result<Body, KernelError> {
    if !pivot.is_finite() || !axis.is_finite() || !angle.is_finite() {
        return Err(KernelError::InvalidInput("rotation pivot, axis and angle must be finite".into()));
    }
    // Lengths can overflow (1e300, 1e300, 0) or underflow, so judge the
    // axis by its largest component.
    if axis.abs().max_element() <= ANGULAR || crate::geom::unit(axis).is_none() {
        return Err(KernelError::InvalidInput("rotation axis must not be zero".into()));
    }
    // Reduce huge angles first so sin/cos stay accurate.
    let tf = Transform::translation(-pivot)
        .then(Transform::rotation(axis, angle.rem_euclid(TAU)))
        .then(Transform::translation(pivot));
    apply(body, &tf)
}

fn apply(body: &Body, tf: &Transform) -> Result<Body, KernelError> {
    let moved = body.transformed(tf);
    check_in_model_space(&moved)?;
    finish(moved)
}

/// Every part of the body must lie within ±MAX_COORD.
pub(crate) fn check_in_model_space(body: &Body) -> Result<(), KernelError> {
    let (lo, hi) = body.bounds();
    let reach = lo.abs().max(hi.abs()).max_element();
    if !reach.is_finite() || reach > MAX_COORD {
        return Err(KernelError::InvalidInput(format!(
            "result would reach {reach:e} mm from the origin; the limit is {MAX_COORD:e} mm"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ops::primitives::make_box;
    use crate::tolerance::{points_eq, MAX_COORD};
    use std::f64::consts::FRAC_PI_2;

    #[test]
    fn move_by_hand() {
        // A 1×2×3 box moved by (10, 20, 30) spans (10,20,30)..(11,22,33).
        let b = translate(&make_box(1.0, 2.0, 3.0).unwrap(), DVec3::new(10.0, 20.0, 30.0)).unwrap();
        let (lo, hi) = b.bounds();
        assert!(points_eq(lo, DVec3::new(10.0, 20.0, 30.0)));
        assert!(points_eq(hi, DVec3::new(11.0, 22.0, 33.0)));
    }

    #[test]
    fn rotate_about_a_pivot_by_hand() {
        // 2×1×1 box turned 90° about the vertical line through (1, 0, 0):
        // corner (0,0,0) is 1 to the -X of the pivot and swings to 1 to the
        // -Y: (1, -1, 0). Far corner (2,1,1) → (1-1, 0+1, 1) = (0, 1, 1).
        let b = rotate(&make_box(2.0, 1.0, 1.0).unwrap(), DVec3::X, DVec3::Z, FRAC_PI_2).unwrap();
        assert!(points_eq(b.vertices[0].point, DVec3::new(1.0, -1.0, 0.0)));
        assert!(points_eq(b.vertices[7].point, DVec3::new(0.0, 1.0, 1.0)));
    }

    #[test]
    fn long_thin_box_keeps_its_volume_when_rotated() {
        // Regression (stateful harness, seed5eed-ff933607647b9f14.json, a
        // 0.044 × 2228 mm cylinder): 0.01 × 0.01 × 2000 has volume exactly
        // 0.2 and area 2(0.0001 + 20 + 20) = 80.0002 however it is turned.
        // The old volume sum multiplied three ~2000 mm vectors per triangle
        // and lost ~1e-6 to rounding.
        // Second cause, found when the sum moved to the bounding-box centre:
        // the cross product was taken at the first corner even when both its
        // edges were the 2000 mm ones (products ~1e6 cancelling to ~20), and
        // gave 0.20000002445. Now it is taken opposite the longest edge.
        use crate::tessellate::{tessellate, TessOptions};
        use crate::tolerance::{rel_eq, FP_REL};
        let b = make_box(0.01, 0.01, 2000.0).unwrap();
        for (axis, angle) in [(DVec3::new(1.0, -2.0, 3.0), 1.0), (DVec3::new(0.63, -0.37, 0.41), -FRAC_PI_2), (DVec3::X, 0.3)] {
            let r = rotate(&b, DVec3::ZERO, axis, angle).unwrap();
            let m = tessellate(&r, &TessOptions::DISPLAY).unwrap();
            assert!(rel_eq(m.signed_volume(), 0.2, FP_REL), "{axis} {angle}: {}", m.signed_volume());
            // Area can't be better than the rotated coordinates allow: each
            // is rounded by up to δ = rounding_slack(2000), and moving a
            // vertex by δ changes a triangle's area by at most its
            // perimeter × δ. Sum of perimeters: 8 long triangles of about
            // 4000 mm each (plus tiny caps) ≈ 32000 mm.
            let slack = 32_001.0 * crate::tolerance::rounding_slack(2000.0);
            assert!(crate::tolerance::measure_eq(m.area(), 80.0002, slack), "{axis} {angle}: {}", m.area());
        }
    }

    #[test]
    fn huge_axis_vectors_still_rotate() {
        // Regression (found by the OpenCascade oracle): (1e300, 1e300, 0)
        // is the direction (1,1,0)/√2, but its length overflows, so the old
        // code normalised it to (0,0,0) and the "rotation" did nothing.
        // A quarter turn about (1,1,0) through the origin takes (1,0,0) to
        // (1/2, 1/2, -1/√2) (Rodrigues: v cosθ + (k×v) sinθ + k(k·v)(1−cosθ)
        // with k = (1,1,0)/√2: k×v = (0,0,-1/√2), k(k·v) = (1/2,1/2,0)).
        let b = make_box(1.0, 1.0, 1.0).unwrap();
        let expected = DVec3::new(0.5, 0.5, -(0.5f64.sqrt()));
        for axis in [DVec3::new(1.0, 1.0, 0.0), DVec3::new(1e300, 1e300, 0.0), DVec3::new(f64::MAX, f64::MAX, 0.0)] {
            let r = rotate(&b, DVec3::ZERO, axis, FRAC_PI_2).unwrap();
            assert!(points_eq(r.vertices[1].point, expected), "axis {axis}: {}", r.vertices[1].point);
        }
    }

    #[test]
    fn huge_angles_are_reduced_first() {
        // 1000 full turns plus a quarter is a quarter turn.
        let b = make_box(1.0, 1.0, 1.0).unwrap();
        let q = rotate(&b, DVec3::ZERO, DVec3::Z, FRAC_PI_2).unwrap();
        let big = rotate(&b, DVec3::ZERO, DVec3::Z, 1000.0 * TAU + FRAC_PI_2).unwrap();
        for (p, r) in q.vertices.iter().zip(&big.vertices) {
            assert!(points_eq(p.point, r.point));
        }
    }

    #[test]
    fn bad_inputs_are_clean_errors() {
        let b = make_box(1.0, 1.0, 1.0).unwrap();
        assert!(translate(&b, DVec3::new(f64::NAN, 0.0, 0.0)).is_err());
        assert!(translate(&b, DVec3::new(f64::INFINITY, 0.0, 0.0)).is_err());
        assert!(rotate(&b, DVec3::ZERO, DVec3::ZERO, 1.0).is_err());
        assert!(rotate(&b, DVec3::ZERO, DVec3::Z * ANGULAR * 0.9, 1.0).is_err());
        assert!(rotate(&b, DVec3::ZERO, DVec3::Z * ANGULAR * 1.1, 1.0).is_ok());
        assert!(rotate(&b, DVec3::ZERO, DVec3::Z, f64::NAN).is_err());
        assert!(rotate(&b, DVec3::splat(f64::NAN), DVec3::Z, 1.0).is_err());
    }

    #[test]
    fn model_space_boundary() {
        // The unit box's far corner is at offset + 1, so moving by
        // MAX_COORD - 1 lands exactly on the limit (allowed); 0.9×/1.1× of
        // the tolerance either side of it decide in/out.
        let b = make_box(1.0, 1.0, 1.0).unwrap();
        let edge = MAX_COORD - 1.0;
        assert!(translate(&b, DVec3::X * edge).is_ok());
        assert!(translate(&b, DVec3::X * (edge - 0.9 * crate::tolerance::LINEAR)).is_ok());
        assert!(translate(&b, DVec3::X * (edge + 1.1 * MAX_COORD * 1e-9)).is_err());
        assert!(translate(&b, DVec3::X * -(MAX_COORD + 1.0)).is_err());
    }
}
