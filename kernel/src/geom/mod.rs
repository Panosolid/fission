//! Analytic curves and surfaces, plus the similarity transforms that move them.

pub mod curve;
pub mod surface;
pub mod transform;

pub use curve::Curve;
pub use surface::Surface;
pub use transform::Transform;

use glam::DVec3;

/// Any unit vector perpendicular to `n`.
pub fn any_perpendicular(n: DVec3) -> DVec3 {
    let helper = if n.x.abs() < 0.9 { DVec3::X } else { DVec3::Y };
    n.cross(helper).normalize()
}
