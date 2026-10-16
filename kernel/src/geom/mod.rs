//! Analytic curves and surfaces, plus the similarity transforms that move them.

pub mod curve;
pub mod placement;
pub mod surface;
pub mod transform;

pub use curve::Curve;
pub use placement::Placement;
pub use surface::Surface;
pub use transform::Transform;

use glam::DVec3;

/// Unit vector in the direction of `v`, safe for huge and tiny components:
/// scaling by the largest component first keeps the length from
/// overflowing to infinity (or underflowing to zero) on the way. Returns
/// None for zero or non-finite vectors.
pub fn unit(v: DVec3) -> Option<DVec3> {
    let m = v.abs().max_element();
    if !v.is_finite() || m == 0.0 {
        return None;
    }
    let u = (v / m).normalize();
    u.is_finite().then_some(u)
}

/// Any unit vector perpendicular to `n`.
pub fn any_perpendicular(n: DVec3) -> DVec3 {
    let helper = if n.x.abs() < 0.9 { DVec3::X } else { DVec3::Y };
    n.cross(helper).normalize()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tolerance::points_eq;

    #[test]
    fn unit_by_hand() {
        // (3, 4, 0)/5 = (0.6, 0.8, 0), at any scale that doesn't hit zero.
        let e = DVec3::new(0.6, 0.8, 0.0);
        for s in [1.0, 1e300, 1e-300, f64::MAX / 4.0, 1e-310] {
            assert!(points_eq(unit(DVec3::new(3.0, 4.0, 0.0) * s).unwrap(), e), "scale {s:e}");
        }
        assert_eq!(unit(DVec3::ZERO), None);
        assert_eq!(unit(DVec3::new(f64::NAN, 1.0, 0.0)), None);
        assert_eq!(unit(DVec3::new(f64::INFINITY, 1.0, 0.0)), None);
    }
}
