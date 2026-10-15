use super::Transform;
use glam::{DVec2, DVec3};
use std::f64::consts::{FRAC_PI_2, TAU};

/// An unbounded analytic surface. The "natural" normal is `∂u × ∂v`, which
/// points outward for cylinders and spheres. Faces flip it with `sense`.
#[derive(Debug, Clone, PartialEq)]
pub enum Surface {
    /// `origin + u x_dir + v y_dir`, `y_dir = normal × x_dir`.
    Plane { origin: DVec3, normal: DVec3, x_dir: DVec3 },
    /// `origin + r (cos u x_dir + sin u y_dir) + v axis`, `y_dir = axis × x_dir`.
    Cylinder { origin: DVec3, axis: DVec3, x_dir: DVec3, radius: f64 },
    /// `center + r (cos v (cos u x_dir + sin u y_dir) + sin v axis)`;
    /// `u` is longitude, `v` latitude in [-π/2, π/2].
    Sphere { center: DVec3, axis: DVec3, x_dir: DVec3, radius: f64 },
}

impl Surface {
    pub fn eval(&self, uv: DVec2) -> DVec3 {
        let (u, v) = (uv.x, uv.y);
        match *self {
            Surface::Plane { origin, normal, x_dir } => origin + x_dir * u + normal.cross(x_dir) * v,
            Surface::Cylinder { origin, axis, x_dir, radius } => {
                origin + (x_dir * u.cos() + axis.cross(x_dir) * u.sin()) * radius + axis * v
            }
            Surface::Sphere { center, axis, x_dir, radius } => {
                let ring = x_dir * u.cos() + axis.cross(x_dir) * u.sin();
                center + (ring * v.cos() + axis * v.sin()) * radius
            }
        }
    }

    /// Unit natural normal at `uv`.
    pub fn normal(&self, uv: DVec2) -> DVec3 {
        match *self {
            Surface::Plane { normal, .. } => normal,
            Surface::Cylinder { axis, x_dir, .. } => x_dir * uv.x.cos() + axis.cross(x_dir) * uv.x.sin(),
            Surface::Sphere { center, radius, .. } => (self.eval(uv) - center) / radius,
        }
    }

    /// Unit natural normal at the point of the surface closest to `p`.
    pub fn normal_at(&self, p: DVec3) -> DVec3 {
        self.normal(self.project(p))
    }

    /// Parameters of the closest point. Periodic `u` is returned in [0, 2π).
    pub fn project(&self, p: DVec3) -> DVec2 {
        match *self {
            Surface::Plane { origin, normal, x_dir } => {
                let d = p - origin;
                DVec2::new(d.dot(x_dir), d.dot(normal.cross(x_dir)))
            }
            Surface::Cylinder { origin, axis, x_dir, .. } => {
                let d = p - origin;
                let y_dir = axis.cross(x_dir);
                DVec2::new(d.dot(y_dir).atan2(d.dot(x_dir)).rem_euclid(TAU), d.dot(axis))
            }
            Surface::Sphere { center, axis, x_dir, .. } => {
                let d = p - center;
                let y_dir = axis.cross(x_dir);
                let h = d.dot(axis);
                let ring = (d - axis * h).length();
                DVec2::new(d.dot(y_dir).atan2(d.dot(x_dir)).rem_euclid(TAU), h.atan2(ring).clamp(-FRAC_PI_2, FRAC_PI_2))
            }
        }
    }

    pub fn distance(&self, p: DVec3) -> f64 {
        match *self {
            Surface::Plane { origin, normal, .. } => (p - origin).dot(normal).abs(),
            Surface::Cylinder { origin, axis, radius, .. } => {
                let d = p - origin;
                ((d - axis * d.dot(axis)).length() - radius).abs()
            }
            Surface::Sphere { center, radius, .. } => (p.distance(center) - radius).abs(),
        }
    }

    /// Period of `u`, if the surface wraps around.
    pub fn u_period(&self) -> Option<f64> {
        match self {
            Surface::Plane { .. } => None,
            Surface::Cylinder { .. } | Surface::Sphere { .. } => Some(TAU),
        }
    }

    /// Scale that turns `u` into a length near the given point, so a uv
    /// domain is not badly stretched when triangulated.
    pub fn u_metric(&self) -> f64 {
        match *self {
            Surface::Plane { .. } => 1.0,
            Surface::Cylinder { radius, .. } | Surface::Sphere { radius, .. } => radius,
        }
    }

    pub fn transformed(&self, tf: &Transform) -> Surface {
        match *self {
            Surface::Plane { origin, normal, x_dir } => {
                Surface::Plane { origin: tf.point(origin), normal: tf.dir(normal), x_dir: tf.dir(x_dir) }
            }
            Surface::Cylinder { origin, axis, x_dir, radius } => Surface::Cylinder {
                origin: tf.point(origin),
                axis: tf.dir(axis),
                x_dir: tf.dir(x_dir),
                radius: tf.length(radius),
            },
            Surface::Sphere { center, axis, x_dir, radius } => Surface::Sphere {
                center: tf.point(center),
                axis: tf.dir(axis),
                x_dir: tf.dir(x_dir),
                radius: tf.length(radius),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tolerance::{eq, points2_eq, points_eq};

    fn surfaces() -> Vec<Surface> {
        let axis = DVec3::new(1.0, 2.0, 2.0) / 3.0;
        let x_dir = crate::geom::any_perpendicular(axis);
        let o = DVec3::new(3.0, -1.0, 2.0);
        vec![
            Surface::Plane { origin: o, normal: axis, x_dir },
            Surface::Cylinder { origin: o, axis, x_dir, radius: 2.5 },
            Surface::Sphere { center: o, axis, x_dir, radius: 4.0 },
        ]
    }

    #[test]
    fn project_inverts_eval() {
        for s in surfaces() {
            for (u, v) in [(0.3, 0.2), (2.0, -0.7), (5.9, 1.1)] {
                let uv = DVec2::new(u, v);
                assert!(points2_eq(s.project(s.eval(uv)), uv), "{s:?} at {uv}");
            }
        }
    }

    #[test]
    fn points_on_surface_have_zero_distance() {
        for s in surfaces() {
            let p = s.eval(DVec2::new(1.0, 0.5));
            assert!(eq(s.distance(p), 0.0));
            assert!(eq(s.distance(p + s.normal(DVec2::new(1.0, 0.5)) * 0.75), 0.75));
        }
    }

    #[test]
    fn natural_normal_matches_du_cross_dv() {
        // Finite differences of eval, compared with the analytic normal.
        let h = 1e-6;
        for s in surfaces() {
            let uv = DVec2::new(1.2, 0.4);
            let du = (s.eval(uv + DVec2::X * h) - s.eval(uv - DVec2::X * h)) / (2.0 * h);
            let dv = (s.eval(uv + DVec2::Y * h) - s.eval(uv - DVec2::Y * h)) / (2.0 * h);
            let n = du.cross(dv).normalize();
            assert!(points_eq(n, s.normal(uv)), "{s:?}");
        }
    }

    #[test]
    fn cylinder_and_sphere_normals_point_outward() {
        for s in surfaces().into_iter().skip(1) {
            let uv = DVec2::new(0.8, 0.3);
            let p = s.eval(uv);
            assert!(s.distance(p + s.normal(uv) * 0.1) > 0.0);
            let c = match s {
                Surface::Cylinder { origin, .. } => origin,
                Surface::Sphere { center, .. } => center,
                _ => unreachable!(),
            };
            assert!(s.normal(uv).dot(p - c) > 0.0);
        }
    }
}
