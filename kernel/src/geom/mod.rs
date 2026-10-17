//! Analytic curves and surfaces, plus the similarity transforms that move them.
//!
//! Mutation testing (`cargo mutants -f src/geom/mod.rs`) leaves these
//! survivors, all equivalent (no input can tell them apart):
//! - `||` vs `&&` in `unit`'s early return: the guard only saves work.
//!   Every vector it turns away also fails the final `is_finite` check: a
//!   NaN component stays NaN through `v / m` and `normalize`; an infinite
//!   one makes m infinite and ∞/∞ = NaN; the zero vector gives 0/0 = NaN.
//!   So `unit` returns None for exactly the same inputs either way.

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

    #[test]
    fn any_perpendicular_by_hand() {
        // n × helper, normalised, with helper X unless |n.x| ≥ 0.9 (then n
        // is too close to X and Y is used). Z × X = Y; X × Y = Z.
        assert!(points_eq(any_perpendicular(DVec3::Z), DVec3::Y));
        assert!(points_eq(any_perpendicular(DVec3::X), DVec3::Z));
        // At the switch, n = (0.9, √0.19, 0) uses Y: n × Y = (−n.z, 0, n.x)
        // = (0, 0, 0.9), so +Z. Just below it, n = (0.89, √(1 − 0.89²), 0)
        // still uses X: n × X = (0, n.z, −n.y) = (0, 0, −n.y), so −Z. The
        // two helpers give opposite answers here, so this pins where the
        // switch is (a different perpendicular moves every seam built
        // from it).
        assert!(points_eq(any_perpendicular(DVec3::new(0.9, 0.19f64.sqrt(), 0.0)), DVec3::Z));
        assert!(points_eq(any_perpendicular(DVec3::new(0.89, (1.0 - 0.89f64 * 0.89).sqrt(), 0.0)), DVec3::NEG_Z));
        // Either way the result is a unit vector square to n.
        for n in [DVec3::new(0.9, 0.19f64.sqrt(), 0.0), DVec3::new(-0.6, 0.0, 0.8), DVec3::NEG_X] {
            let p = any_perpendicular(n);
            assert!(crate::tolerance::eq(p.length(), 1.0) && crate::tolerance::is_zero(p.dot(n)), "{n} → {p}");
        }
    }
}
