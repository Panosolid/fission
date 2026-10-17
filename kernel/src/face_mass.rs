//! Each face's area and centroid (step 24b), exact from the B-rep as in
//! `mass.rs`, so the app can tell faces apart by more than their number and
//! the timeline harness can compare them with closed forms.
//!
//! The centroid is c = q + (1/A) ∬ (x − q) dA for any point q, with A the
//! face's area from `mass::face_terms`. The first moment ∬ (x − q) dA has a
//! closed form on each surface from the face's edges alone. Below, s = ±1
//! is the face's sense (its outward normal n is s times the surface's
//! natural normal m), V = ∬ n dA = ½ ∮ (x − p) × dx is its vector area
//! (`mass::half_moment`), and p is its first corner:
//!
//! - Sphere (centre c, radius r): on the sphere x − c = r m = s r n, so
//!   ∬ (x − c) dA = s r V. Check: a hemisphere has V = πr² along its axis
//!   and A = 2πr², so its centroid is r/2 from the centre (Archimedes).
//! - Cylinder (axis point o, unit axis a, radius r): x − o = r m + h a, h
//!   the height along the axis. The first part gives s r V (V has no part
//!   along the axis; the rounding that gives it one is dropped, as in
//!   `mass.rs`). For the second, in coordinates (θ, h) round and along the
//!   axis dA = r dθ dh, and θ̂ × â = m, so the face's loops (counter-
//!   clockwise seen from n) run positively in (θ, h) when s = +1. Green's
//!   theorem with P = −h²/2 gives ∬ h dθ dh = −½ ∮ h² dθ, so
//!   ∬ h dA = −(s r/2) ∮ h² dθ, where only circles round the axis count (a
//!   line along the axis has dθ = 0; until step 46 no other curve lies on a
//!   cylinder). Heights are measured from p's, h_p, adding h_p A back, so
//!   a face far up its axis keeps its digits.
//! - Plane: in-plane coordinates (u, v) from p along e1 and e2 = n × e1
//!   run positively the way the loops do. Green's theorem gives
//!   ∬ u dA = ∮ (u²/2) dv and ∬ v dA = −∮ (v²/2) du; along a straight piece
//!   (u0, v0) → (u1, v1), where u and v are linear in the piece's
//!   parameter, these are exactly Δv (u0² + u0 u1 + u1²)/6 and
//!   −Δu (v0² + v0 v1 + v1²)/6. An arc counts as its chord plus the segment
//!   between chord and arc, added when the arc turns counter-clockwise
//!   seen from n (the segment is then on its left, inside the face) and
//!   taken away when clockwise. A segment of a circle of radius R turning φ
//!   has area R²(φ − sin φ)/2 and centroid 4R sin³(φ/2) / (3(φ − sin φ))
//!   from the centre towards the arc's midpoint (a standard result), so its
//!   moment about the centre is (2/3) R³ sin³(φ/2) in that direction, with
//!   nothing to divide by. Check: a half disc's centroid is
//!   (2/3)R³ / (πR²/2) = 4R/(3π) from the centre.
//!
//! Precision. Measuring a plane's moment from p keeps a face far from the
//! origin exact; the segment never multiplies R³ by a difference of large
//! terms (the naive ∫ (c_u + R cos t)² R cos t dt for a shallow arc of a
//! huge circle cancels terms of size R³ φ, see
//! `a_shallow_arc_of_a_huge_circle_keeps_the_caps_centroid`).
//!
//! `mesh_face_moments` measures the same from a mesh, the independent
//! route the property tests compare with (the stateful harness compares
//! with its own closed-form model instead).
//!
//! Mutation testing (`cargo mutants`) leaves these survivors, equivalent:
//! - `> → >=` in an arc's `left`: an arc on a plane is square to it, so
//!   `axis.dot(n)` is ±1, never 0, and an edge never has `tb == ta`.
//!
//! Each factor that is ±1 (`sign`, `left`, `axis.dot(k)`) comes first in
//! its product, so `* → /` there changes the answer (±1 / x, not x / ±1)
//! and the tests see it.

use crate::geom::{any_perpendicular, Curve, Surface};
use crate::mass::{face_terms, half_moment, theta_minus_sin, travel};
use crate::mesh::Mesh;
use crate::topology::{Body, Face};
use glam::DVec3;

/// A face's area and centroid.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FaceMass {
    pub area: f64,
    pub centroid: DVec3,
}

/// The area and centroid of each face of `body`, by face index.
pub fn face_masses(body: &Body) -> Vec<FaceMass> {
    body.faces.iter().map(|f| face_mass(body, f)).collect()
}

/// The area and centroid of one face of a valid body (to rounding).
pub fn face_mass(body: &Body, face: &Face) -> FaceMass {
    let sign = if face.sense { 1.0 } else { -1.0 };
    let coedges = || face.loops.iter().flat_map(|l| l.coedges.iter().copied());
    let corner = |v: usize| body.vertices[v].point;
    let p = coedges().next().map_or(DVec3::ZERO, |c| corner(body.coedge_start(c)));
    let area = face_terms(body, face, p).1;
    let vector_area: DVec3 = coedges()
        .map(|c| {
            let (curve, ta, tb) = travel(body, c);
            half_moment(curve, ta, tb, corner(body.coedge_start(c)), corner(body.coedge_end(c)), p)
        })
        .sum();
    let centroid = match face.surface {
        Surface::Sphere { center, radius, .. } => center + vector_area * (sign * radius / area),
        Surface::Cylinder { origin, axis, radius, .. } => {
            let across = vector_area - axis * axis.dot(vector_area);
            let hp = axis.dot(p - origin);
            // ∮ (h − h_p)² dθ, θ measured about +axis.
            let mut swept = 0.0;
            for c in coedges() {
                let (curve, ta, tb) = travel(body, c);
                if let Curve::Circle { center, axis: k, .. } = *curve {
                    let h = axis.dot(center - origin) - hp;
                    swept += axis.dot(k) * (tb - ta) * h * h;
                }
            }
            let height = hp - sign * radius * swept / area * 0.5;
            origin + across * (sign * radius / area) + axis * height
        }
        Surface::Plane { normal, .. } => {
            let n = sign * normal;
            let e1 = any_perpendicular(n);
            let e2 = n.cross(e1);
            let mut moment = DVec3::ZERO;
            for c in coedges() {
                let (a, b) = (corner(body.coedge_start(c)) - p, corner(body.coedge_end(c)) - p);
                let (u0, v0, u1, v1) = (a.dot(e1), a.dot(e2), b.dot(e1), b.dot(e2));
                moment += e1 * ((v1 - v0) * (u0 * u0 + u0 * u1 + u1 * u1) / 6.0);
                moment -= e2 * ((u1 - u0) * (v0 * v0 + v0 * v1 + v1 * v1) / 6.0);
                let (curve, ta, tb) = travel(body, c);
                if let Curve::Circle { center, axis, x_dir, radius } = *curve {
                    let phi = (tb - ta).abs();
                    let left = if (axis.dot(n) > 0.0) == (tb > ta) { 1.0 } else { -1.0 };
                    let mid = 0.5 * (ta + tb);
                    let towards = x_dir * mid.cos() + axis.cross(x_dir) * mid.sin();
                    let segment = 0.5 * radius * radius * theta_minus_sin(phi);
                    let about_centre = 2.0 / 3.0 * radius.powi(3) * (0.5 * phi).sin().powi(3);
                    moment += left * (segment * (center - p) + towards * about_centre);
                }
            }
            p + moment / area
        }
    };
    FaceMass { area, centroid }
}

/// Each face's area and first moment about `o`, ∬ (x − o) dA, summed over
/// a mesh's triangles (each triangle's area times its centroid's offset).
/// An inscribed mesh is off by about the square of its step, so two meshes
/// extrapolate as in `mass.rs` (`(4·fine − coarse)/3`).
pub fn mesh_face_moments(mesh: &Mesh, faces: usize, o: DVec3) -> Vec<(f64, DVec3)> {
    let mut out = vec![(0.0, DVec3::ZERO); faces];
    for (t, &f) in mesh.triangles.iter().zip(&mesh.triangle_face) {
        let [a, b, c] = t.map(|i| mesh.positions[i as usize] - o);
        let area = 0.5 * (b - a).cross(c - a).length();
        out[f].0 += area;
        out[f].1 += (a + b + c) * (area / 3.0);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geom::Transform;
    use crate::ops::extrude::{extrude, Boundary, Profile};
    use crate::ops::primitives::{make_box, make_cylinder, make_sphere};
    use crate::tessellate::{tessellate, TessOptions};
    use crate::tolerance::{rel_eq, FP_REL, MASS_PROPS_ANGLE, MASS_PROPS_REL};
    use crate::topology::{FaceRole, Piece};
    use glam::DVec2;
    use proptest::prelude::*;
    use proptest::test_runner::FileFailurePersistence;
    use std::f64::consts::PI;

    fn side(boundary: usize, piece: usize) -> FaceRole {
        FaceRole::Side(Piece::at(boundary, piece))
    }

    fn path(corners: &[(f64, f64)], bulges: &[f64]) -> Boundary {
        Boundary::Path { corners: corners.iter().map(|&(x, y)| DVec2::new(x, y)).collect(), bulges: bulges.to_vec() }
    }

    /// The face with `role`, which must be the only one.
    #[track_caller]
    fn face_with(body: &Body, role: FaceRole) -> FaceMass {
        let found: Vec<usize> = (0..body.faces.len()).filter(|&f| body.faces[f].role == Some(role)).collect();
        assert_eq!(found.len(), 1, "{role:?} on faces {found:?}");
        face_mass(body, &body.faces[found[0]])
    }

    /// Area and centroid within FP_REL of the hand-worked values, measured
    /// against the larger of 1 mm and the value (as MATCH_REL is in the
    /// timeline harness).
    #[track_caller]
    fn expect(body: &Body, role: FaceRole, area: f64, centroid: (f64, f64, f64)) {
        let m = face_with(body, role);
        let want = DVec3::new(centroid.0, centroid.1, centroid.2);
        assert!(rel_eq(m.area, area, FP_REL), "{role:?}: area {} vs {area}", m.area);
        for k in 0..3 {
            let (got, w) = (m.centroid[k], want[k]);
            assert!((got - w).abs() <= FP_REL * w.abs().max(1.0), "{role:?}: centroid {} vs {want}", m.centroid);
        }
    }

    /// Every face has a role, and no two the same.
    #[track_caller]
    fn roles(body: &Body) -> Vec<FaceRole> {
        let roles: Vec<FaceRole> = body.faces.iter().map(|f| f.role.expect("every face has a role")).collect();
        let unique: std::collections::HashSet<_> = roles.iter().collect();
        assert_eq!(unique.len(), roles.len(), "{roles:?}");
        roles
    }

    #[test]
    fn a_box_by_hand() {
        // 40 × 30 × 20 from the origin. Each face is a rectangle, its
        // centroid in the middle: bottom 40 × 30 at z = 0, centre (20, 15);
        // front (−Y) 40 × 20 at y = 0, centre (20, 10) in x and z; left
        // (−X) 30 × 20 at x = 0.
        let b = make_box(40.0, 30.0, 20.0).unwrap();
        assert_eq!(roles(&b).len(), 6);
        expect(&b, FaceRole::Bottom, 1200.0, (20.0, 15.0, 0.0));
        expect(&b, FaceRole::Top, 1200.0, (20.0, 15.0, 20.0));
        expect(&b, FaceRole::Front, 800.0, (20.0, 0.0, 10.0));
        expect(&b, FaceRole::Back, 800.0, (20.0, 30.0, 10.0));
        expect(&b, FaceRole::Left, 600.0, (0.0, 15.0, 10.0));
        expect(&b, FaceRole::Right, 600.0, (40.0, 15.0, 10.0));
    }

    #[test]
    fn a_cylinder_and_a_sphere_by_hand() {
        // Cylinder r = 2, h = 3: caps πr² = 4π on the axis; the side 2πrh =
        // 12π, by symmetry centred on the axis half way up.
        let c = make_cylinder(2.0, 3.0).unwrap();
        assert_eq!(roles(&c).len(), 3);
        expect(&c, FaceRole::Bottom, 4.0 * PI, (0.0, 0.0, 0.0));
        expect(&c, FaceRole::Top, 4.0 * PI, (0.0, 0.0, 3.0));
        expect(&c, FaceRole::Wall, 12.0 * PI, (0.0, 0.0, 1.5));
        // Sphere r = 3: each half 2πr² = 18π; equal heights cut equal
        // areas (Archimedes), so the mean height is r/2 = 1.5.
        let s = make_sphere(3.0).unwrap();
        assert_eq!(roles(&s).len(), 2);
        expect(&s, FaceRole::Upper, 18.0 * PI, (0.0, 0.0, 1.5));
        expect(&s, FaceRole::Lower, 18.0 * PI, (0.0, 0.0, -1.5));
    }

    #[test]
    fn a_cylinder_wall_whose_axis_origin_is_elsewhere_by_hand() {
        // The same cylinder r = 2, h = 3, with its surface's origin slid
        // along the axis: the surface is the same set of points, so the
        // wall is still 12π centred half way up, (0, 0, 1.5), wherever the
        // origin sits (the swept sum measures heights from the face's own
        // corner, not from the origin).
        for shift in [-7.0, 0.0, 2.5, 40.0] {
            let mut c = make_cylinder(2.0, 3.0).unwrap();
            for f in &mut c.faces {
                if let Surface::Cylinder { origin, axis, .. } = &mut f.surface {
                    *origin += *axis * shift;
                }
            }
            expect(&c, FaceRole::Wall, 12.0 * PI, (0.0, 0.0, 1.5));
        }
    }

    #[test]
    fn a_rectangle_extruded_by_hand() {
        // The timeline model's case: 40 × 30 extruded by 10. Caps 1200 at
        // (20, 15); the side of piece k is that side's length × 10, at its
        // midpoint half way up.
        let rect = [(0.0, 0.0), (40.0, 0.0), (40.0, 30.0), (0.0, 30.0)];
        let b = extrude(&Profile { outer: path(&rect, &[]), holes: vec![] }, 10.0).unwrap();
        assert_eq!(roles(&b).len(), 6);
        expect(&b, FaceRole::Start, 1200.0, (20.0, 15.0, 0.0));
        expect(&b, FaceRole::End, 1200.0, (20.0, 15.0, 10.0));
        expect(&b, side(0, 0), 400.0, (20.0, 0.0, 5.0));
        expect(&b, side(0, 1), 300.0, (40.0, 15.0, 5.0));
        expect(&b, side(0, 2), 400.0, (20.0, 30.0, 5.0));
        expect(&b, side(0, 3), 300.0, (0.0, 15.0, 5.0));
    }

    #[test]
    fn a_clockwise_rectangle_names_each_side_by_the_piece_given() {
        // The same rectangle given clockwise: piece 0 runs up the left side
        // (0, 0) → (0, 30), piece 1 along the back, piece 2 down the right,
        // piece 3 along the front. The kernel turns the loop round, but each
        // side keeps the name of the piece that made it.
        let rect = [(0.0, 0.0), (0.0, 30.0), (40.0, 30.0), (40.0, 0.0)];
        let b = extrude(&Profile { outer: path(&rect, &[]), holes: vec![] }, 10.0).unwrap();
        expect(&b, side(0, 0), 300.0, (0.0, 15.0, 5.0));
        expect(&b, side(0, 1), 400.0, (20.0, 30.0, 5.0));
        expect(&b, side(0, 2), 300.0, (40.0, 15.0, 5.0));
        expect(&b, side(0, 3), 400.0, (20.0, 0.0, 5.0));
    }

    #[test]
    fn a_slot_by_hand() {
        // Centres (0, 5) and (20, 5), radius 5, extruded by 10: the bottom
        // line (0, 0) → (20, 0), the right half circle (bulge 1), the top
        // line back, the left half circle. Caps: 20 × 10 + π·5² = 200 + 25π,
        // centred at (10, 5) by symmetry. A half circle's wall is π·5·10 =
        // 50π; an arc's centroid is r sin(φ/2)/(φ/2) from its centre, for
        // φ = π that is 2r/π = 10/π, beyond the centres along the slot.
        let corners = [(0.0, 0.0), (20.0, 0.0), (20.0, 10.0), (0.0, 10.0)];
        let b = extrude(&Profile { outer: path(&corners, &[0.0, 1.0, 0.0, 1.0]), holes: vec![] }, 10.0).unwrap();
        assert_eq!(roles(&b).len(), 6);
        expect(&b, FaceRole::Start, 200.0 + 25.0 * PI, (10.0, 5.0, 0.0));
        expect(&b, FaceRole::End, 200.0 + 25.0 * PI, (10.0, 5.0, 10.0));
        expect(&b, side(0, 0), 200.0, (10.0, 0.0, 5.0));
        expect(&b, side(0, 1), 50.0 * PI, (20.0 + 10.0 / PI, 5.0, 5.0));
        expect(&b, side(0, 2), 200.0, (10.0, 10.0, 5.0));
        expect(&b, side(0, 3), 50.0 * PI, (-10.0 / PI, 5.0, 5.0));
    }

    #[test]
    fn a_half_disc_cap_by_hand() {
        // A half disc of radius 3: the diameter (−3, 0) → (3, 0), then a
        // half circle back over the top (bulge 1). Area πr²/2 = 4.5π,
        // centroid 4r/(3π) = 4/π above the centre, the textbook value the
        // segment formula must reproduce.
        let b = extrude(&Profile { outer: path(&[(-3.0, 0.0), (3.0, 0.0)], &[0.0, 1.0]), holes: vec![] }, 2.0).unwrap();
        expect(&b, FaceRole::Start, 4.5 * PI, (0.0, 4.0 / PI, 0.0));
        expect(&b, side(0, 0), 12.0, (0.0, 0.0, 1.0));
        expect(&b, side(0, 1), 6.0 * PI, (0.0, 6.0 / PI, 1.0));
    }

    #[test]
    fn a_concave_side_by_hand() {
        // A 40 × 20 rectangle whose top has a half circle bowing in from
        // (30, 20) to (10, 20) (bulge −1) round (20, 20), radius 10: the
        // rectangle less the lower half disc. Area 800 − 50π. The half
        // disc's centroid is 40/(3π) below (20, 20), so the cap's y is
        // (800·10 − 50π·(20 − 40/(3π))) / (800 − 50π)
        // = (8000 − 1000π + 2000/3) / (800 − 50π). The wall faces the axis
        // (sense false) but its centroid is still 2r/π = 20/π from the
        // axis towards the arc's midpoint (20, 10).
        let corners = [(0.0, 0.0), (40.0, 0.0), (40.0, 20.0), (30.0, 20.0), (10.0, 20.0), (0.0, 20.0)];
        let b = extrude(&Profile { outer: path(&corners, &[0.0, 0.0, 0.0, -1.0, 0.0, 0.0]), holes: vec![] }, 4.0).unwrap();
        let area = 800.0 - 50.0 * PI;
        let y = (8000.0 - 1000.0 * PI + 2000.0 / 3.0) / area;
        expect(&b, FaceRole::Start, area, (20.0, y, 0.0));
        expect(&b, FaceRole::End, area, (20.0, y, 4.0));
        expect(&b, side(0, 3), 40.0 * PI, (20.0, 20.0 - 20.0 / PI, 2.0));
    }

    #[test]
    fn a_plate_with_a_round_hole_by_hand() {
        // 40 × 30 less a circle of radius 5 round (10, 10), extruded by 10.
        // Cap area 1200 − 25π, centroid (1200·(20, 15) − 25π·(10, 10)) /
        // (1200 − 25π). The hole's wall is 2π·5·10 = 100π, centred on its
        // axis; it is the side of hole 0 (loop 1), piece 0.
        let rect = [(0.0, 0.0), (40.0, 0.0), (40.0, 30.0), (0.0, 30.0)];
        let hole = Boundary::Circle { center: DVec2::new(10.0, 10.0), radius: 5.0 };
        let b = extrude(&Profile { outer: path(&rect, &[]), holes: vec![hole] }, 10.0).unwrap();
        assert_eq!(roles(&b).len(), 7);
        let area = 1200.0 - 25.0 * PI;
        let (x, y) = ((24000.0 - 250.0 * PI) / area, (18000.0 - 250.0 * PI) / area);
        expect(&b, FaceRole::Start, area, (x, y, 0.0));
        expect(&b, FaceRole::End, area, (x, y, 10.0));
        expect(&b, side(1, 0), 100.0 * PI, (10.0, 10.0, 5.0));
        expect(&b, side(0, 0), 400.0, (20.0, 0.0, 5.0));
    }

    #[test]
    fn a_square_hole_given_counter_clockwise_keeps_its_piece_numbers() {
        // A hole runs clockwise in the solid, so one given counter-clockwise
        // is turned round: its piece 0, (10, 10) → (20, 10), must still be
        // the wall at y = 10, 10 long, 5 high: 50, centred (15, 10, 2.5).
        let rect = [(0.0, 0.0), (40.0, 0.0), (40.0, 30.0), (0.0, 30.0)];
        let hole = [(10.0, 10.0), (20.0, 10.0), (20.0, 20.0), (10.0, 20.0)];
        let b = extrude(&Profile { outer: path(&rect, &[]), holes: vec![path(&hole, &[])] }, 5.0).unwrap();
        assert_eq!(roles(&b).len(), 10);
        expect(&b, side(1, 0), 50.0, (15.0, 10.0, 2.5));
        expect(&b, side(1, 1), 50.0, (20.0, 15.0, 2.5));
        expect(&b, side(1, 3), 50.0, (10.0, 15.0, 2.5));
        // Cap: 1200 − 100, centroid (1200·(20, 15) − 100·(15, 15)) / 1100.
        expect(&b, FaceRole::Start, 1100.0, (22500.0 / 1100.0, 15.0, 0.0));
    }

    #[test]
    fn the_smallest_extrude_and_slot_by_hand() {
        // At 0.9× MIN_FEATURE the distance and the arc radius are refused;
        // at 1.1× the faces are there with their areas: a 1 × 1 square at
        // d = 1.1 µm has sides 1.1e-3 mm²; a slot of radius 1.1 µm has
        // half circle walls π·1.1e-3·1 mm².
        use crate::tolerance::MIN_FEATURE;
        let square = [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)];
        let flat = |d| extrude(&Profile { outer: path(&square, &[]), holes: vec![] }, d);
        assert!(flat(0.9 * MIN_FEATURE).is_err());
        let b = flat(1.1 * MIN_FEATURE).unwrap();
        expect(&b, side(0, 1), 1.1 * MIN_FEATURE, (1.0, 0.5, 0.55 * MIN_FEATURE));
        let slot = |r: f64| {
            let c = [(0.0, 0.0), (1.0, 0.0), (1.0, 2.0 * r), (0.0, 2.0 * r)];
            extrude(&Profile { outer: path(&c, &[0.0, 1.0, 0.0, 1.0]), holes: vec![] }, 1.0)
        };
        assert!(slot(0.9 * MIN_FEATURE).is_err());
        let r = 1.1 * MIN_FEATURE;
        let b = slot(r).unwrap();
        expect(&b, side(0, 1), PI * r, (1.0 + 2.0 * r / PI, r, 0.5));
    }

    #[test]
    fn a_shallow_arc_of_a_huge_circle_keeps_the_caps_centroid() {
        // A unit square whose top (1, 1) → (0, 1) bows out by a shallow arc
        // of radius R = 1e6 (half angle h = asin(1/(2R)), bulge tan(h/2)).
        // The segment's area is R²(φ − sin φ)/2 ≈ c³/(12R) = 1/(12e6) and its
        // centroid sits 2/5 of the sagitta c²/(8R) above the chord, so the
        // cap's centroid is at y = (0.5 + seg·(1 + 0.4·sag)) / (1 + seg),
        // which these series give to ~1e-20. The naive ∮ u² dv over the arc
        // cancels terms of R³φ ~ 1e12 and is off by ~1e-4 mm here.
        let r: f64 = 1e6;
        let h = (0.5 / r).asin();
        let bulge = (0.5 * h).tan();
        let corners = [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)];
        let b = extrude(&Profile { outer: path(&corners, &[0.0, 0.0, bulge, 0.0]), holes: vec![] }, 1.0).unwrap();
        let (seg, sag) = (1.0 / (12.0 * r), 1.0 / (8.0 * r));
        let y = (0.5 + seg * (1.0 + 0.4 * sag)) / (1.0 + seg);
        let m = face_with(&b, FaceRole::Start);
        assert!(rel_eq(m.area, 1.0 + seg, FP_REL), "area {}", m.area);
        assert!((m.centroid.y - y).abs() < 1e-12, "y {} vs {y}", m.centroid.y);
        assert!((m.centroid.x - 0.5).abs() < 1e-12, "x {}", m.centroid.x);
    }

    #[test]
    fn far_from_the_origin_and_turned_the_centroids_move_with_the_body() {
        // A move and a turn are exact maps, so each face keeps its role and
        // its centroid lands where the transform takes the old one. 100 km
        // out a double resolves ~15 nm, so compare to that.
        let corners = [(0.0, 0.0), (20.0, 0.0), (20.0, 10.0), (0.0, 10.0)];
        let b = extrude(&Profile { outer: path(&corners, &[0.0, 1.0, 0.0, 1.0]), holes: vec![] }, 10.0).unwrap();
        let tf = Transform::rotation(DVec3::new(1.0, 2.0, 3.0).normalize(), 0.7).then(Transform::translation(DVec3::new(9e7, -4e7, 3e7)));
        let moved = b.transformed(&tf);
        for (f, g) in b.faces.iter().zip(&moved.faces) {
            assert_eq!(f.role, g.role);
            let (m, n) = (face_mass(&b, f), face_mass(&moved, g));
            assert!(rel_eq(m.area, n.area, 1e-9), "{:?}: {} vs {}", f.role, m.area, n.area);
            let want = tf.point(m.centroid);
            assert!(n.centroid.distance(want) < 1e-6, "{:?}: {} vs {want}", f.role, n.centroid);
        }
    }

    #[test]
    fn a_box_mesh_by_hand() {
        // A flat face's triangles cover it exactly, so the mesh route is
        // exact on a box. 40 × 30 × 20 from the origin, moments about
        // o = (10, 0, 0): the top is 40 × 30 = 1200 at z = 20, centre
        // (20, 15, 20), offset (10, 15, 20), moment 1200·(10, 15, 20) =
        // (12000, 18000, 24000); the left (x = 0) is 30 × 20 = 600, centre
        // (0, 15, 10), offset (−10, 15, 10), moment (−6000, 9000, 6000).
        let b = make_box(40.0, 30.0, 20.0).unwrap();
        let mesh = tessellate(&b, &TessOptions::default()).unwrap();
        let m = mesh_face_moments(&mesh, b.faces.len(), DVec3::new(10.0, 0.0, 0.0));
        assert_eq!(m.len(), 6);
        let at = |role| m[b.faces.iter().position(|f| f.role == Some(role)).unwrap()];
        for (role, want_area, want) in [
            (FaceRole::Top, 1200.0, DVec3::new(12000.0, 18000.0, 24000.0)),
            (FaceRole::Left, 600.0, DVec3::new(-6000.0, 9000.0, 6000.0)),
        ] {
            let (area, moment) = at(role);
            assert!(rel_eq(area, want_area, FP_REL), "{role:?}: area {area}");
            assert!(moment.distance(want) <= FP_REL * want.length(), "{role:?}: moment {moment} vs {want}");
        }
    }

    /// Each face's area and centroid from two meshes, extrapolated.
    fn extrapolated(body: &Body) -> Vec<(f64, DVec3)> {
        let (lo, hi) = body.bounds();
        let o = (lo + hi) * 0.5;
        let opts = |refine| TessOptions { chord: 1.0, max_angle: MASS_PROPS_ANGLE, refine };
        let coarse = mesh_face_moments(&tessellate(body, &opts(1)).unwrap(), body.faces.len(), o);
        let fine = mesh_face_moments(&tessellate(body, &opts(2)).unwrap(), body.faces.len(), o);
        coarse
            .iter()
            .zip(&fine)
            .map(|(c, f)| {
                let area = (4.0 * f.0 - c.0) / 3.0;
                (area, o + ((4.0 * f.1 - c.1) / 3.0) / area)
            })
            .collect()
    }

    #[test]
    fn exact_values_agree_with_extrapolated_meshes() {
        // Self-consistency (a second route; it doesn't count as hand-worked).
        let rect = [(0.0, 0.0), (10.0, 0.0), (10.0, 4.0), (0.0, 4.0)];
        for (name, body) in [
            ("box", make_box(3.0, 4.0, 5.0).unwrap()),
            ("cylinder", make_cylinder(2.0, 3.0).unwrap()),
            ("sphere", make_sphere(3.0).unwrap()),
            ("stadium", extrude(&Profile { outer: path(&rect, &[0.0, 1.0, -0.3, 1.0]), holes: vec![] }, 2.0).unwrap()),
        ] {
            check_against_meshes(name, &body);
        }
    }

    #[track_caller]
    fn check_against_meshes(name: &str, body: &Body) {
        let (lo, hi) = body.bounds();
        let size = (hi - lo).length();
        let meshed = extrapolated(body);
        assert_eq!(meshed.len(), body.faces.len(), "{name}: one mesh value per face");
        for (f, (area, centroid)) in meshed.into_iter().enumerate() {
            let m = face_mass(body, &body.faces[f]);
            let role = body.faces[f].role;
            assert!(rel_eq(m.area, area, MASS_PROPS_REL), "{name} {role:?}: area {} vs extrapolated {area}", m.area);
            assert!(m.centroid.distance(centroid) <= MASS_PROPS_REL * size, "{name} {role:?}: centroid {} vs {centroid}", m.centroid);
        }
    }

    /// A star polygon round the origin: corner k at angle (k + jitter)·2π/n
    /// and its own radius, each piece bowed by its bulge.
    fn star() -> impl Strategy<Value = (Vec<(f64, f64)>, Vec<f64>)> {
        (3usize..9).prop_flat_map(|n| {
            (prop::collection::vec((0.0..0.6f64, 10.0..30.0f64, -0.25..0.25f64), n), any::<bool>()).prop_map(move |(pts, cw)| {
                let mut corners: Vec<(f64, f64)> = pts
                    .iter()
                    .enumerate()
                    .map(|(k, &(j, r, _))| {
                        let a = (k as f64 + j) * std::f64::consts::TAU / n as f64;
                        (r * a.cos(), r * a.sin())
                    })
                    .collect();
                let mut bulges: Vec<f64> = pts.iter().map(|p| p.2).collect();
                if cw {
                    // The same loop the other way: corners reversed, piece i
                    // now the old piece n − 2 − i, run backwards.
                    corners.reverse();
                    bulges = (0..n).map(|i| -bulges[(2 * n - 2 - i) % n]).collect();
                }
                (corners, bulges)
            })
        })
    }

    /// The side face piece `i` of a loop sweeps over height `d`: a line's is
    /// its length × d at its midpoint; an arc's (radius r, turn φ) is r|φ|d
    /// at r sin(φ/2)/(φ/2) from its centre towards its midpoint. Both half
    /// way up.
    fn side_by_formula(a: DVec2, b: DVec2, bulge: f64, d: f64) -> (f64, DVec3) {
        let chord = b - a;
        let c = chord.length();
        let mid = (a + b) * 0.5;
        if bulge == 0.0 {
            return (c * d, mid.extend(0.5 * d));
        }
        // Bulge tan(φ/4); positive turns counter-clockwise, so the arc
        // bows to the right of the chord by the sagitta |bulge|·c/2.
        let phi = 4.0 * bulge.atan();
        let r = c * (1.0 + bulge * bulge) / (4.0 * bulge.abs());
        let right = DVec2::new(chord.y, -chord.x) / c;
        let out = right * bulge.signum();
        let top = mid + out * (bulge.abs() * c * 0.5);
        let centre = top - out * r;
        let h = 0.5 * phi.abs();
        ((r * phi.abs() * d), (centre + out * (r * h.sin() / h)).extend(0.5 * d))
    }

    proptest! {
        #![proptest_config(ProptestConfig { cases: 64, failure_persistence: Some(Box::new(FileFailurePersistence::Direct("tests/regressions/face-mass.txt"))), ..ProptestConfig::default() })]

        /// Random star outlines with bowed sides, either way round, some with
        /// a round hole: every face has one role, the roles are exactly the
        /// caps and one side per piece as given, the faces' areas add up to
        /// the body's, each side matches its closed form, and every face
        /// matches the extrapolated meshes.
        #[test]
        fn extruded_faces_are_named_and_measured((corners, bulges) in star(), d in 0.5..20.0f64, hole in any::<bool>()) {
            let holes = if hole { vec![Boundary::Circle { center: DVec2::ZERO, radius: 3.0 }] } else { vec![] };
            let profile = Profile { outer: path(&corners, &bulges), holes };
            let made = extrude(&profile, d);
            prop_assume!(made.is_ok());
            let b = made.unwrap();
            let rs = roles(&b);
            let n = corners.len();
            let mut want: Vec<FaceRole> = vec![FaceRole::Start, FaceRole::End];
            want.extend((0..n).map(|i| side(0, i)));
            if hole { want.push(side(1, 0)); }
            let mut got = rs.clone();
            let key = |r: &FaceRole| format!("{r:?}");
            got.sort_by_key(key);
            want.sort_by_key(key);
            prop_assert_eq!(got, want);
            let total: f64 = face_masses(&b).iter().map(|m| m.area).sum();
            let body_area = crate::mass::mass_properties(&b).area;
            prop_assert!(rel_eq(total, body_area, 1e-12), "faces {} vs body {}", total, body_area);
            for i in 0..n {
                let pts: Vec<DVec2> = corners.iter().map(|&(x, y)| DVec2::new(x, y)).collect();
                let (area, centroid) = side_by_formula(pts[i], pts[(i + 1) % n], bulges[i], d);
                let m = face_with(&b, side(0, i));
                prop_assert!(rel_eq(m.area, area, 1e-9), "piece {}: area {} vs {}", i, m.area, area);
                prop_assert!(m.centroid.distance(centroid) < 1e-9 * 30.0, "piece {}: {} vs {}", i, m.centroid, centroid);
            }
            check_against_meshes("star", &b);
        }
    }
}
