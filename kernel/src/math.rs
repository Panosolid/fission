//! Basic 3D maths. Later this will wrap `glam`, but for Stage 0 it is written
//! by hand so every operation is easy to read and test.

use std::ops::{Add, Mul, Neg, Sub};

/// Two lengths closer than this count as equal. One global rule, used everywhere.
pub const TOLERANCE: f64 = 1e-9;

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Vec3 {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

impl Vec3 {
    pub const ZERO: Vec3 = Vec3::new(0.0, 0.0, 0.0);
    pub const X: Vec3 = Vec3::new(1.0, 0.0, 0.0);
    pub const Y: Vec3 = Vec3::new(0.0, 1.0, 0.0);
    pub const Z: Vec3 = Vec3::new(0.0, 0.0, 1.0);

    pub const fn new(x: f64, y: f64, z: f64) -> Self {
        Self { x, y, z }
    }

    pub fn dot(self, other: Vec3) -> f64 {
        self.x * other.x + self.y * other.y + self.z * other.z
    }

    pub fn cross(self, other: Vec3) -> Vec3 {
        Vec3::new(
            self.y * other.z - self.z * other.y,
            self.z * other.x - self.x * other.z,
            self.x * other.y - self.y * other.x,
        )
    }

    pub fn length(self) -> f64 {
        self.dot(self).sqrt()
    }

    /// Unit vector in the same direction, or `None` for a (near) zero vector.
    pub fn normalized(self) -> Option<Vec3> {
        let len = self.length();
        if len < TOLERANCE {
            None
        } else {
            Some(self * (1.0 / len))
        }
    }

    pub fn approx_eq(self, other: Vec3) -> bool {
        (self - other).length() < TOLERANCE
    }

    pub fn to_array(self) -> [f64; 3] {
        [self.x, self.y, self.z]
    }
}

impl Add for Vec3 {
    type Output = Vec3;
    fn add(self, o: Vec3) -> Vec3 {
        Vec3::new(self.x + o.x, self.y + o.y, self.z + o.z)
    }
}

impl Sub for Vec3 {
    type Output = Vec3;
    fn sub(self, o: Vec3) -> Vec3 {
        Vec3::new(self.x - o.x, self.y - o.y, self.z - o.z)
    }
}

impl Mul<f64> for Vec3 {
    type Output = Vec3;
    fn mul(self, s: f64) -> Vec3 {
        Vec3::new(self.x * s, self.y * s, self.z * s)
    }
}

impl Neg for Vec3 {
    type Output = Vec3;
    fn neg(self) -> Vec3 {
        Vec3::new(-self.x, -self.y, -self.z)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn add_and_sub_are_inverse() {
        let a = Vec3::new(1.0, 2.0, 3.0);
        let b = Vec3::new(-4.0, 0.5, 9.0);
        assert!((a + b - b).approx_eq(a));
    }

    #[test]
    fn dot_of_perpendicular_axes_is_zero() {
        assert_eq!(Vec3::X.dot(Vec3::Y), 0.0);
        assert_eq!(Vec3::X.dot(Vec3::X), 1.0);
    }

    #[test]
    fn cross_follows_right_hand_rule() {
        assert!(Vec3::X.cross(Vec3::Y).approx_eq(Vec3::Z));
        assert!(Vec3::Y.cross(Vec3::Z).approx_eq(Vec3::X));
        assert!(Vec3::Y.cross(Vec3::X).approx_eq(-Vec3::Z));
    }

    #[test]
    fn cross_is_perpendicular_to_both_inputs() {
        let a = Vec3::new(1.0, 2.0, 3.0);
        let b = Vec3::new(4.0, -5.0, 6.0);
        let c = a.cross(b);
        assert!(c.dot(a).abs() < TOLERANCE);
        assert!(c.dot(b).abs() < TOLERANCE);
    }

    #[test]
    fn normalizing_zero_vector_fails() {
        assert_eq!(Vec3::ZERO.normalized(), None);
        let n = Vec3::new(3.0, 0.0, 4.0).normalized().unwrap();
        assert!((n.length() - 1.0).abs() < TOLERANCE);
    }
}
