//! Similarity transforms (rotation, translation, uniform scale). Non-uniform
//! scale is not allowed: it would turn circles into ellipses.

use glam::{DAffine3, DMat3, DQuat, DVec3};

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Transform {
    affine: DAffine3,
    scale: f64,
}

impl Default for Transform {
    fn default() -> Self {
        Self::IDENTITY
    }
}

impl Transform {
    pub const IDENTITY: Transform = Transform { affine: DAffine3::IDENTITY, scale: 1.0 };

    pub fn translation(t: DVec3) -> Self {
        Self { affine: DAffine3::from_translation(t), scale: 1.0 }
    }

    /// Rotation about `axis` through the origin. Panics if the axis is zero
    /// or not finite: callers check user input first (see ops::transform).
    pub fn rotation(axis: DVec3, angle: f64) -> Self {
        let axis = super::unit(axis).expect("rotation axis must be a non-zero finite vector");
        Self { affine: DAffine3::from_quat(DQuat::from_axis_angle(axis, angle)), scale: 1.0 }
    }

    /// Rotation by the unit quaternion `q`, then translation by `t`.
    pub fn rigid(q: DQuat, t: DVec3) -> Self {
        Self { affine: DAffine3::from_rotation_translation(q, t), scale: 1.0 }
    }

    /// Rotation from XYZ Euler angles in degrees (applied X, then Y, then Z).
    pub fn rotation_euler_deg(deg: DVec3) -> Self {
        let q = DQuat::from_euler(
            glam::EulerRot::ZYX,
            deg.z.to_radians(),
            deg.y.to_radians(),
            deg.x.to_radians(),
        );
        Self { affine: DAffine3::from_quat(q), scale: 1.0 }
    }

    pub fn uniform_scale(s: f64) -> Self {
        assert!(s > 0.0, "scale must be positive");
        Self { affine: DAffine3::from_mat3(DMat3::from_diagonal(DVec3::splat(s))), scale: s }
    }

    /// Apply `self` first, then `next`.
    pub fn then(self, next: Transform) -> Transform {
        Transform { affine: next.affine * self.affine, scale: self.scale * next.scale }
    }

    pub fn point(&self, p: DVec3) -> DVec3 {
        self.affine.transform_point3(p)
    }

    /// Transforms a direction and renormalises it.
    pub fn dir(&self, v: DVec3) -> DVec3 {
        self.affine.transform_vector3(v).normalize()
    }

    pub fn length(&self, l: f64) -> f64 {
        l * self.scale
    }

    pub fn scale(&self) -> f64 {
        self.scale
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tolerance::{eq, points_eq};
    use std::f64::consts::FRAC_PI_2;

    #[test]
    fn transforms_by_hand() {
        // Quarter turn about +Z (counter-clockwise from above): X → Y, Y → -X.
        let r = Transform::rotation(DVec3::Z, FRAC_PI_2);
        assert!(points_eq(r.point(DVec3::new(1.0, 0.0, 0.0)), DVec3::new(0.0, 1.0, 0.0)));
        assert!(points_eq(r.point(DVec3::new(0.0, 2.0, 5.0)), DVec3::new(-2.0, 0.0, 5.0)));
        // Translation moves points but not directions.
        let t = Transform::translation(DVec3::new(1.0, 2.0, 3.0));
        assert!(points_eq(t.point(DVec3::ZERO), DVec3::new(1.0, 2.0, 3.0)));
        assert!(points_eq(t.dir(DVec3::X), DVec3::X));
        // Scale by 2: (1, 2, 3) → (2, 4, 6); lengths double; directions stay unit.
        let s = Transform::uniform_scale(2.0);
        assert!(points_eq(s.point(DVec3::new(1.0, 2.0, 3.0)), DVec3::new(2.0, 4.0, 6.0)));
        assert!(eq(s.length(1.5), 3.0));
        assert!(eq(s.scale(), 2.0));
        assert!(points_eq(s.dir(DVec3::Z), DVec3::Z));
    }

    #[test]
    fn then_applies_in_order_by_hand() {
        // Rotate X a quarter turn about Z → (0,1,0), then move by (10,0,0) → (10,1,0).
        let rt = Transform::rotation(DVec3::Z, FRAC_PI_2).then(Transform::translation(DVec3::new(10.0, 0.0, 0.0)));
        assert!(points_eq(rt.point(DVec3::X), DVec3::new(10.0, 1.0, 0.0)));
        // Other order: move to (11,0,0), then rotate → (0,11,0).
        let tr = Transform::translation(DVec3::new(10.0, 0.0, 0.0)).then(Transform::rotation(DVec3::Z, FRAC_PI_2));
        assert!(points_eq(tr.point(DVec3::X), DVec3::new(0.0, 11.0, 0.0)));
        // Scales multiply: 2 then 3 is 6.
        let s = Transform::uniform_scale(2.0).then(Transform::uniform_scale(3.0));
        assert!(eq(s.scale(), 6.0));
        assert!(eq(s.length(1.0), 6.0));
    }

    #[test]
    fn euler_angles_by_hand() {
        // 90° about X takes +Y to +Z.
        let x90 = Transform::rotation_euler_deg(DVec3::new(90.0, 0.0, 0.0));
        assert!(points_eq(x90.point(DVec3::Y), DVec3::Z));
        // 90° about X then 90° about Z: Y → Z (X turn) → Z (Z turn leaves Z alone),
        // and X → X → Y.
        let xz = Transform::rotation_euler_deg(DVec3::new(90.0, 0.0, 90.0));
        assert!(points_eq(xz.point(DVec3::Y), DVec3::Z));
        assert!(points_eq(xz.point(DVec3::X), DVec3::Y));
    }
}
