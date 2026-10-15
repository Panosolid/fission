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
    if axis.length() <= ANGULAR {
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
