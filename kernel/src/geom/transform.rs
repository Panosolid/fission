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

    pub fn rotation(axis: DVec3, angle: f64) -> Self {
        Self { affine: DAffine3::from_quat(DQuat::from_axis_angle(axis.normalize(), angle)), scale: 1.0 }
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
