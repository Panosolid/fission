//! Where a body sits in the world: a rigid motion (rotation, then shift)
//! kept apart from the body's geometry.
//!
//! Moving and rotating a body only changes its placement, never its
//! geometry, so a part moved 40 km out and back, or turned a thousand
//! times, has exactly the shape (and volume and area) it started with. Its
//! position carries the rounding of the shift: at 100 km out that is at most
//! half of 2⁻²⁶ mm (~7.5 pm), far below LINEAR. Placements are baked into geometry only where two
//! bodies must share coordinates (booleans, step 35).
//!
//! The rotation is a unit quaternion, renormalised after every composition,
//! so it stays a true rotation however many turns are composed (a 3×3
//! matrix would slowly stop being orthogonal and start to scale and shear).

use super::Transform;
use glam::{DMat3, DQuat, DVec3};

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Placement {
    /// Applied first, about the world origin.
    pub rotation: DQuat,
    /// Applied after the rotation.
    pub shift: DVec3,
}

impl Default for Placement {
    fn default() -> Self {
        Self::IDENTITY
    }
}

impl Placement {
    pub const IDENTITY: Placement = Placement { rotation: DQuat::IDENTITY, shift: DVec3::ZERO };

    /// Where the local point `p` is in the world: R p + shift. R is applied
    /// as the matrix of the quaternion (three products and two sums per
    /// coordinate), which rounds less than the quaternion sandwich product
    /// and matches baking (`transform`) exactly.
    pub fn point(&self, p: DVec3) -> DVec3 {
        DMat3::from_quat(self.rotation) * p + self.shift
    }

    /// A local direction in the world (rotation only).
    pub fn dir(&self, v: DVec3) -> DVec3 {
        DMat3::from_quat(self.rotation) * v
    }

    /// This placement followed by a move of `by`.
    pub fn moved(self, by: DVec3) -> Placement {
        Placement { rotation: self.rotation, shift: self.shift + by }
    }

    /// This placement followed by a turn of `angle` radians about the line
    /// through `pivot` along the unit vector `axis`: x → Q(x − c) + c, so
    /// the shift becomes Q(shift − c) + c, measured from the pivot so a far
    /// pivot does not add its own rounding twice.
    pub fn turned(self, pivot: DVec3, axis: DVec3, angle: f64) -> Placement {
        let q = DQuat::from_axis_angle(axis, angle);
        Placement { rotation: (q * self.rotation).normalize(), shift: q * (self.shift - pivot) + pivot }
    }

    /// This placement followed by `outer`: x → outer(self(x)), the
    /// rotation composed and renormalised as in `turned`, the shift carried
    /// by `outer` as a point (the matrix form, as `point` rounds).
    pub fn then(self, outer: Placement) -> Placement {
        Placement { rotation: (outer.rotation * self.rotation).normalize(), shift: outer.point(self.shift) }
    }

    pub fn is_identity(&self) -> bool {
        *self == Self::IDENTITY
    }

    /// The same motion as a Transform, for baking it into geometry.
    pub fn transform(&self) -> Transform {
        Transform::rigid(self.rotation, self.shift)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tolerance::points_eq;
    use std::f64::consts::{FRAC_PI_2, PI, TAU};

    #[test]
    fn placements_by_hand() {
        // A quarter turn about +Z through the origin takes (1, 0, 0) to
        // (0, 1, 0); then moving by (10, 0, 0) gives (10, 1, 0).
        let p = Placement::IDENTITY.turned(DVec3::ZERO, DVec3::Z, FRAC_PI_2).moved(DVec3::new(10.0, 0.0, 0.0));
        assert!(points_eq(p.point(DVec3::X), DVec3::new(10.0, 1.0, 0.0)));
        // Moving first: (1,0,0) → (11,0,0), then turning → (0, 11, 0).
        let q = Placement::IDENTITY.moved(DVec3::new(10.0, 0.0, 0.0)).turned(DVec3::ZERO, DVec3::Z, FRAC_PI_2);
        assert!(points_eq(q.point(DVec3::X), DVec3::new(0.0, 11.0, 0.0)));
        // About a pivot: a half turn about the vertical line through
        // (5, 0, 0) takes the origin to (10, 0, 0) (mirror through the pivot)
        // and leaves the pivot itself where it is.
        let h = Placement::IDENTITY.turned(DVec3::new(5.0, 0.0, 0.0), DVec3::Z, PI);
        assert!(points_eq(h.point(DVec3::ZERO), DVec3::new(10.0, 0.0, 0.0)));
        assert!(points_eq(h.point(DVec3::new(5.0, 0.0, 7.0)), DVec3::new(5.0, 0.0, 7.0)));
        // Directions turn but do not shift.
        assert!(points_eq(p.dir(DVec3::X), DVec3::Y));
        // Only the identity is the identity.
        assert!(Placement::IDENTITY.is_identity() && Placement::default().is_identity());
        assert!(!p.is_identity() && !Placement::IDENTITY.moved(DVec3::new(0.0, 0.0, 1e-300)).is_identity());
    }

    #[test]
    fn far_away_and_back_lands_within_rounding() {
        // Out 37.8 km and back: the shift is 0 up to one rounding at 3.78e7
        // (ulp 7.5e-9), whatever the geometry.
        let out = DVec3::new(3.78e7, -1.2e7, 5e6);
        let p = Placement::IDENTITY.moved(DVec3::new(0.3, 0.0, 0.0)).moved(out).moved(-out);
        assert!((p.shift - DVec3::new(0.3, 0.0, 0.0)).abs().max_element() <= crate::tolerance::rounding_slack(3.78e7));
        assert_eq!(p.rotation, DQuat::IDENTITY);
    }

    #[test]
    fn many_turns_stay_a_rotation() {
        // 10 000 turns of 2π/10 000 about a tilted axis add up to one full
        // turn: back where it started, and the quaternion stays unit length
        // (a matrix composed this often drifts away from orthogonal).
        let axis = DVec3::new(1.0, 2.0, 3.0).normalize();
        let mut p = Placement::IDENTITY;
        for _ in 0..10_000 {
            p = p.turned(DVec3::new(1.0, 1.0, 1.0), axis, TAU / 10_000.0);
        }
        assert!((p.rotation.length() - 1.0).abs() <= 4.0 * f64::EPSILON);
        assert!(points_eq(p.point(DVec3::new(3.0, -2.0, 7.0)), DVec3::new(3.0, -2.0, 7.0)));
    }

    #[test]
    fn baking_agrees_with_the_placement() {
        let p = Placement::IDENTITY.turned(DVec3::new(1.0, 2.0, 3.0), DVec3::new(0.0, 0.6, 0.8), 1.1).moved(DVec3::new(-4.0, 5.0, 0.5));
        let t = p.transform();
        for x in [DVec3::ZERO, DVec3::new(3.0, -1.0, 2.0), DVec3::new(-7.5, 0.25, 9.0)] {
            assert!(points_eq(t.point(x), p.point(x)));
        }
        assert!(points_eq(t.dir(DVec3::X), p.dir(DVec3::X)));
    }
}
