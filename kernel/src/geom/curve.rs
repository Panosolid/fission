use super::Transform;
use glam::DVec3;
use std::f64::consts::TAU;

/// An unbounded analytic curve. Edges bound it with a parameter range.
#[derive(Debug, Clone, PartialEq)]
pub enum Curve {
    /// `origin + t * dir`, `dir` is unit length so `t` is arc length.
    Line { origin: DVec3, dir: DVec3 },
    /// `center + r (cos t x_dir + sin t y_dir)` with `y_dir = axis × x_dir`,
    /// i.e. counter-clockwise looking down `axis`.
    Circle { center: DVec3, axis: DVec3, x_dir: DVec3, radius: f64 },
}

impl Curve {
    pub fn eval(&self, t: f64) -> DVec3 {
        match *self {
            Curve::Line { origin, dir } => origin + dir * t,
            Curve::Circle { center, axis, x_dir, radius } => {
                let y_dir = axis.cross(x_dir);
                center + (x_dir * t.cos() + y_dir * t.sin()) * radius
            }
        }
    }

    /// First derivative with respect to `t`.
    pub fn derivative(&self, t: f64) -> DVec3 {
        match *self {
            Curve::Line { dir, .. } => dir,
            Curve::Circle { axis, x_dir, radius, .. } => {
                let y_dir = axis.cross(x_dir);
                (y_dir * t.cos() - x_dir * t.sin()) * radius
            }
        }
    }

    pub fn tangent(&self, t: f64) -> DVec3 {
        self.derivative(t).normalize()
    }

    /// Parameter of the closest point. For circles the result is in [0, 2π).
    pub fn closest_param(&self, p: DVec3) -> f64 {
        match *self {
            Curve::Line { origin, dir } => (p - origin).dot(dir),
            Curve::Circle { center, axis, x_dir, .. } => {
                let d = p - center;
                let y_dir = axis.cross(x_dir);
                d.dot(y_dir).atan2(d.dot(x_dir)).rem_euclid(TAU)
            }
        }
    }

    pub fn distance(&self, p: DVec3) -> f64 {
        match *self {
            Curve::Line { .. } => self.eval(self.closest_param(p)).distance(p),
            Curve::Circle { center, axis, radius, .. } => {
                let d = p - center;
                let h = d.dot(axis);
                let radial = (d - axis * h).length();
                ((radial - radius).powi(2) + h * h).sqrt()
            }
        }
    }

    pub fn period(&self) -> Option<f64> {
        match self {
            Curve::Line { .. } => None,
            Curve::Circle { .. } => Some(TAU),
        }
    }

    /// Arc length between parameters.
    pub fn length(&self, t0: f64, t1: f64) -> f64 {
        match *self {
            Curve::Line { .. } => (t1 - t0).abs(),
            Curve::Circle { radius, .. } => (t1 - t0).abs() * radius,
        }
    }

    pub fn transformed(&self, tf: &Transform) -> Curve {
        match *self {
            Curve::Line { origin, dir } => Curve::Line { origin: tf.point(origin), dir: tf.dir(dir) },
            Curve::Circle { center, axis, x_dir, radius } => Curve::Circle {
                center: tf.point(center),
                axis: tf.dir(axis),
                x_dir: tf.dir(x_dir),
                radius: tf.length(radius),
            },
        }
    }

    /// Line parameters scale with the transform, circle parameters (angles) don't.
    pub fn transform_param(&self, t: f64, tf: &Transform) -> f64 {
        match self {
            Curve::Line { .. } => tf.length(t),
            Curve::Circle { .. } => t,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tolerance::{angle_eq, eq, points_eq};
    use std::f64::consts::FRAC_PI_2;

    fn unit_circle() -> Curve {
        Curve::Circle { center: DVec3::ZERO, axis: DVec3::Z, x_dir: DVec3::X, radius: 2.0 }
    }

    #[test]
    fn circle_eval_and_derivative() {
        let c = unit_circle();
        assert!(points_eq(c.eval(0.0), DVec3::new(2.0, 0.0, 0.0)));
        assert!(points_eq(c.eval(FRAC_PI_2), DVec3::new(0.0, 2.0, 0.0)));
        // Counter-clockwise about +Z: moving +Y at t = 0, speed = radius.
        assert!(points_eq(c.derivative(0.0), DVec3::new(0.0, 2.0, 0.0)));
    }

    #[test]
    fn circle_closest_param_round_trips() {
        let c = unit_circle();
        for k in 0..12 {
            let t = k as f64 * 0.5;
            assert!(angle_eq(c.closest_param(c.eval(t) * 1.7), t), "t = {t}");
        }
    }

    #[test]
    fn distances_to_curves() {
        let c = unit_circle();
        assert!(eq(c.distance(DVec3::new(0.0, 0.0, 0.0)), 2.0));
        assert!(eq(c.distance(DVec3::new(5.0, 0.0, 4.0)), 5.0));
        let l = Curve::Line { origin: DVec3::ZERO, dir: DVec3::X };
        assert!(eq(l.distance(DVec3::new(7.0, 3.0, 4.0)), 5.0));
    }

    #[test]
    fn transform_moves_circle_rigidly() {
        let tf = Transform::rotation(DVec3::X, FRAC_PI_2).then(Transform::translation(DVec3::new(1.0, 2.0, 3.0)));
        let c = unit_circle();
        let moved = c.transformed(&tf);
        for k in 0..8 {
            let t = k as f64;
            assert!(points_eq(moved.eval(t), tf.point(c.eval(t))));
        }
    }
}
