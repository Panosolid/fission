//! Exact volume and surface area of a B-rep, from its analytic geometry
//! rather than a mesh (a mesh of a curved body is always a little off).
//!
//! Everything reduces to integrals along the edges, which have closed forms
//! for lines and circles:
//!
//! - Vector area. For any surface patch S with boundary loops run with S on
//!   the left (the kernel's convention, seen from the outward normal n),
//!   ∬ n dA = ½ ∮ (x − o) × dx, for any fixed point o (Stokes' theorem
//!   applied to F = ½ e × (x − o), whose curl is e, for each direction e).
//! - Volume. By the divergence theorem with div(x − o) = 3,
//!   V = ⅓ Σ ∬ (x − o)·n dA. On a plane through p, (x − o)·n = (p − o)·n is
//!   constant, so the face gives (p − o)·(vector area). On a cylinder or
//!   sphere with centre (or axis point) c and radius r, (x − c)·n = ±r (the
//!   sign is the face's sense), so the face gives ±r·A + (c − o)·(vector
//!   area).
//! - Area. A plane: n·(vector area). A cylinder (axis a): F = −s θ̂, with s
//!   the height along the axis and θ̂ the direction round it, has curl F =
//!   the outward radial direction on the surface, so A = ±∮ F·dx. A sphere
//!   has no such F (it would make a closed sphere's area zero), so it uses
//!   Gauss–Bonnet instead: K·A + ∮ k_g ds + Σ ε = 2π χ, with K = 1/r², k_g
//!   the geodesic curvature of the boundary, ε the turning angle at each
//!   corner, and χ = 2 − (number of loops) for a region of a sphere.
//!
//! Precision. `o` is the centre of the body's bounding box, so a small part
//! far from the world origin keeps its digits, and each face is measured
//! from a point p on it (its first vertex): ∬ (x − o)·n dA =
//! ∬ (x − p)·n dA + (p − o)·(vector area), where the first part is small
//! because x − p is (it is 0 on a plane). Two things would otherwise lose
//! digits:
//! - On a plane, (p − o)·(vector area) is taken as ((p − o)·n)·A with the
//!   exact normal: the computed vector area's tiny sideways error times a
//!   long face's in-plane distance from o would swamp a thin body's volume.
//! - On a cylinder, ±r·A + (c − p)·(vector area) cancels two terms of size
//!   r·A when r is huge (a shallow arc). Instead, with θ the angle round the
//!   axis measured from p, (x − p)·n = ±r(1 − cos θ) ≥ 0 and dA = r dθ ds,
//!   so Green's theorem in (θ, s) gives ∬ (x − p)·n dA = −r² ∮ s (1 −
//!   cos θ) dθ = −r² ∮ s d(θ − sin θ), with θ − sin θ summed by its series
//!   when small. The orientation sign (sense) appears twice and cancels.
//!   Heights s are measured from o, not p: a thin tube's walls give
//!   ±2πr²h that cancel, so each must be right to a few ulps, and p (on
//!   the wall, up to 100 km round it) is rounded by more than h allows.
//!
//! Known limit: a sphere face uses ±r·A + (c − o)·(vector area) and Gauss–
//! Bonnet, which lose digits for a face much smaller than its sphere (a
//! shallow cap). Only whole hemispheres exist until booleans (steps 46–47),
//! which must replace this with a stable form before making such faces.
//!
//! Mutation testing (`cargo mutants -f src/mass.rs`) leaves one survivor:
//! `|t| < 0.1` vs `<= 0.1` in theta_minus_sin, which picks the series
//! instead of t − sin t at exactly ±0.1. Not strictly equivalent: the two
//! differ in the last bits there (the series is 1.7 ulps from the true
//! value, t − sin t 115 ulps, both far inside FP_REL), and a test that
//! told them apart would have to demand the less accurate one. Directions
//! of travel are written s·v (not v·s) for s = ±1, so that `/` there gives
//! s/v, which the sphere tests catch, rather than an equivalent v/s.

use crate::geom::{Curve, Surface}; // shard timing test
use crate::topology::{Body, Coedge, Face}; // shard timing test
use glam::DVec3; // shard timing test
use std::f64::consts::TAU; // shard timing test

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MassProps { // shard timing test
    pub volume: f64, // shard timing test
    pub area: f64, // shard timing test
} // shard timing test

/// Exact volume and area of a valid body (to rounding).
pub fn mass_properties(body: &Body) -> MassProps { // shard timing test
    let (lo, hi) = body.bounds(); // shard timing test
    about(body, (lo + hi) * 0.5) // shard timing test
} // shard timing test

/// The same, measured from `o`. Any point gives the same answer in exact
/// arithmetic (the divergence theorem holds about any point); a point near
/// the body keeps the most digits.
fn about(body: &Body, o: DVec3) -> MassProps { // shard timing test
    let mut volume = 0.0; // shard timing test
    let mut area = 0.0; // shard timing test
    for face in &body.faces { // shard timing test
        let (v, a) = face_terms(body, face, o); // shard timing test
        volume += v; // shard timing test
        area += a; // shard timing test
    } // shard timing test
    MassProps { volume: volume / 3.0, area } // shard timing test
} // shard timing test

/// A coedge as the curve it runs along and its parameters in the direction
/// of travel (from `ta` to `tb`; `tb < ta` when the coedge is reversed).
fn travel(body: &Body, c: Coedge) -> (&Curve, f64, f64) { // shard timing test
    let e = &body.edges[c.edge]; // shard timing test
    if c.reversed { (&e.curve, e.t1, e.t0) } else { (&e.curve, e.t0, e.t1) } // shard timing test
} // shard timing test

/// ½ ∫ (x − o) × dx along a curve from `ta` to `tb`, between the corners
/// `a` and `b` it joins.
///
/// Line from a to b: ½ (a − o) × (b − a) = ½ (a − o) × (b − o), the
/// triangle o, a, b. A circular arc sweeps that triangle plus the segment
/// between its chord and itself, (r²/2)(φ − sin φ) for a turn of φ, about
/// the circle's axis (negative when run backwards). Check: a full circle
/// gives 0 + πr². This form never cancels the large terms that
/// ½ ∫ [(c − o) + r(cos t X + sin t Y)] × r(−sin t X + cos t Y) dt would
/// for a shallow arc of a huge circle.
///
/// The chord runs between the corners themselves, not the curve's ends:
/// a far-out arc's centre is rounded, so its circle can miss its corners
/// by up to LINEAR, and with the straight sides between corners the loop
/// would not close. The gap, a sliver as long as the face, times its
/// distance from the body's centre swamped a thin far-out slot's volume
/// (see `a_thin_slot_far_out_keeps_its_volume`).
fn half_moment(curve: &Curve, ta: f64, tb: f64, a: DVec3, b: DVec3, o: DVec3) -> DVec3 { // shard timing test
    let chord = 0.5 * (a - o).cross(b - o); // shard timing test
    match *curve { // shard timing test
        Curve::Line { .. } => chord, // shard timing test
        Curve::Circle { axis, radius, .. } => chord + axis * (0.5 * radius * radius * theta_minus_sin(tb - ta)), // shard timing test
    } // shard timing test
} // shard timing test

/// θ − sin θ without cancellation: by its series θ³/3! − θ⁵/5! + … below
/// 0.1, to θ¹¹: the first term left out is 6θ¹⁰/13! ≈ 1e-19 of the first.
/// (Stopping at θ⁹ left 6θ⁸/11! ≈ 1.5e-15, six ulps, at 0.1.)
fn theta_minus_sin(t: f64) -> f64 { // shard timing test
    if t.abs() < 0.1 { // shard timing test
        let t2 = t * t; // shard timing test
        t * t2 / 6.0 * (1.0 - t2 / 20.0 * (1.0 - t2 / 42.0 * (1.0 - t2 / 72.0 * (1.0 - t2 / 110.0)))) // shard timing test
    } else { // shard timing test
        t - t.sin() // shard timing test
    } // shard timing test
} // shard timing test

/// One coedge's share of a cylinder face's integrals, angles measured from
/// the face's point p, heights s along `axis` from the body's centre o:
/// (−∮ s d(θ − sin θ), −∮ s dθ) (see the module notes). Any height can be
/// 0 (∮ g(θ) dθ = 0 round the boundary, Green again), and o is better than
/// p: p can be far round a big cylinder, rounded by more than the face is
/// tall, and the circle centres sit near o. A line on a
/// cylinder runs along the axis (dθ = 0): nothing. A circle on it is a
/// cross-section at one height, its angle changing by (axis·k) per t.
fn cylinder_terms(curve: &Curve, ta: f64, tb: f64, p: DVec3, o: DVec3, center: DVec3, axis: DVec3) -> (f64, f64) { // shard timing test
    match *curve { // shard timing test
        Curve::Line { .. } => (0.0, 0.0), // shard timing test
        Curve::Circle { center: cc, axis: k, .. } => { // shard timing test
            let flat = |v: DVec3| v - axis * axis.dot(v); // shard timing test
            let (from, at) = (flat(p - center), flat(curve.eval(ta) - center)); // shard timing test
            let ua = axis.dot(from.cross(at)).atan2(from.dot(at)); // shard timing test
            let ub = ua + axis.dot(k) * (tb - ta); // shard timing test
            let s = axis.dot(cc - o); // shard timing test
            (-s * (theta_minus_sin(ub) - theta_minus_sin(ua)), -s * (ub - ua)) // shard timing test
        }
    }
}

/// ∫ k_g ds along a curve on a sphere, `n(x)` the face's outward normal.
/// For a curve x(t), k_g ds = x''·(n × x') / |x'|² dt. On a circle x'' =
/// −(x − centre) and |x'| = r, and by symmetry the integrand is the same
/// all the way round, so one evaluation times the span is exact. Lines
/// can't lie on a sphere.
fn geodesic_turn(curve: &Curve, ta: f64, tb: f64, n: impl Fn(DVec3) -> DVec3) -> f64 {
    match *curve {
        Curve::Line { .. } => 0.0,
        Curve::Circle { center, radius, .. } => {
            let x = curve.eval(ta);
            let dx = (tb - ta).signum() * curve.derivative(ta);
            -(x - center).dot(n(x).cross(dx)) / (radius * radius) * (tb - ta).abs()
        }
    }
}

/// Signed angle the boundary turns through at a corner, from the incoming
/// tangent to the outgoing one, positive turning left about `n`.
fn corner_turn(t_in: DVec3, t_out: DVec3, n: DVec3) -> f64 {
    n.dot(t_in.cross(t_out)).atan2(t_in.dot(t_out))
}

/// (∬ (x − o)·n dA, area) for one face.
fn face_terms(body: &Body, face: &Face, o: DVec3) -> (f64, f64) {
    let sign = if face.sense { 1.0 } else { -1.0 };
    let coedges = || face.loops.iter().flat_map(|l| l.coedges.iter().copied());
    let p = coedges().next().map_or(o, |c| body.vertices[body.coedge_start(c)].point);
    let vector_area: DVec3 = coedges()
        .map(|c| {
            let (curve, ta, tb) = travel(body, c);
            let (a, b) = (body.vertices[body.coedge_start(c)].point, body.vertices[body.coedge_end(c)].point);
            half_moment(curve, ta, tb, a, b, p)
        })
        .sum();
    match face.surface {
        Surface::Plane { normal, .. } => {
            let n = sign * normal;
            let area = n.dot(vector_area);
            ((p - o).dot(n) * area, area)
        }
        Surface::Cylinder { origin, axis, radius, .. } => {
            let (mut bulge, mut turn) = (0.0, 0.0);
            for c in coedges() {
                let (curve, ta, tb) = travel(body, c);
                let (b, t) = cylinder_terms(curve, ta, tb, p, o, origin, axis);
                bulge += b;
                turn += t;
            }
            // The vector area of a cylinder face is square to the axis.
            let across = vector_area - axis * axis.dot(vector_area);
            (radius * radius * bulge + (p - o).dot(across), sign * radius * turn)
        }
        Surface::Sphere { center, radius, .. } => {
            let n = |x: DVec3| sign * (x - center) / radius;
            let mut turn = 0.0;
            for l in &face.loops {
                for (i, &c) in l.coedges.iter().enumerate() {
                    let (curve, ta, tb) = travel(body, c);
                    turn += geodesic_turn(curve, ta, tb, n);
                    // The corner at this coedge's end, into the next one.
                    let next = l.coedges[(i + 1) % l.coedges.len()];
                    let (next_curve, na, nb) = travel(body, next);
                    let t_in = (tb - ta).signum() * curve.derivative(tb);
                    let t_out = (nb - na).signum() * next_curve.derivative(na);
                    let corner = body.vertices[body.coedge_end(c)].point;
                    turn += corner_turn(t_in, t_out, n(corner));
                }
            }
            let euler = 2.0 - face.loops.len() as f64;
            let area = radius * radius * (TAU * euler - turn);
            (sign * radius * area + (center - o).dot(vector_area), area)
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::fixtures::*;
    use crate::geom::Transform;
    use crate::ops::extrude::{extrude, Boundary, Profile};
    use crate::tessellate::{tessellate, TessOptions};
    use crate::tolerance::{measure_eq, rel_eq, rounding_slack, FP_REL, MASS_PROPS_ANGLE, MASS_PROPS_REL};
    use glam::DVec2;
    use std::f64::consts::{FRAC_PI_2, PI};

    #[track_caller]
    fn check(body: &Body, volume: f64, area: f64) {
        let m = mass_properties(body);
        assert!(rel_eq(m.volume, volume, FP_REL), "volume {} expected {volume}", m.volume);
        assert!(rel_eq(m.area, area, FP_REL), "area {} expected {area}", m.area);
    }

    #[test]
    fn planar_and_cylindrical_bodies_by_hand() {
        // Unit cube: V = 1, A = 6.
        check(&hand_cube(), 1.0, 6.0);
        // Cylinder r = 2, h = 3: V = π·4·3 = 12π; A = 2·π·4 + 2π·2·3 = 20π.
        // Twisting the top circle changes nothing.
        check(&hand_cylinder(2.0, 3.0), 12.0 * PI, 20.0 * PI);
        check(&hand_twisted_cylinder(2.0, 3.0, 0.7), 12.0 * PI, 20.0 * PI);
        // Half cylinder r = 2, h = 3: V = 12π/2 = 6π; A = two half discs
        // 2·(π·4/2) + flat side 4·3 + curved side π·2·3 = 4π + 12 + 6π.
        check(&hand_half_cylinder(2.0, 3.0), 6.0 * PI, 10.0 * PI + 12.0);
        // Tube r 1 to 2, h = 3: V = π(4 − 1)·3 = 9π; A = two rings
        // 2·π(4 − 1) + outer wall 2π·2·3 + bore 2π·1·3 = 6π + 12π + 6π. The
        // bore has sense false: its radius term counts negatively.
        check(&hand_tube(1.0, 2.0, 3.0, 0.3), 9.0 * PI, 24.0 * PI);
    }

    #[test]
    fn a_thin_slot_far_out_keeps_its_volume() {
        // Regression (OpenCascade oracle, seed 33200934698058; OpenCascade
        // agreed with a 50-digit calculation, Fission was 1.1e-6 high): a
        // slot 364.5 mm long with half-round ends, drawn at y = 5e7, so its
        // width is w = (5e7 + 0.0022) − 5e7 as doubles = 0.00219999998808
        // (exact by Sterbenz), extruded 96. V = (364.5·w + π(w/2)²)·96: a
        // rectangle plus two half discs of radius w/2.
        let (y0, y1) = (5e7, 5e7 + 0.0022);
        let w = y1 - y0;
        let corners = vec![DVec2::new(0.0, y0), DVec2::new(364.5, y0), DVec2::new(364.5, y1), DVec2::new(0.0, y1)];
        let slot = Profile { outer: Boundary::Path { corners, bulges: vec![0.0, 1.0, 0.0, 1.0] }, holes: vec![] };
        let v = (364.5 * w + PI * w * w / 4.0) * 96.0;
        // The arcs' centres (5e7 + w/2) round by up to half an ulp there
        // (3.7e-9), so the circles miss their corners by that much; the
        // vector area used to follow the circles and the straight sides the
        // corners, leaving a 2.5e-9 × 96 mm sliver per end, 182 mm from the
        // centre: 8.7e-5 of volume. It now follows the corners.
        let m = mass_properties(&extrude(&slot, 96.0).unwrap());
        assert!(rel_eq(m.volume, v, FP_REL), "volume {} expected {v}", m.volume);
    }

    #[test]
    fn spherical_bodies_by_hand() {
        // Sphere r = 3: V = 4/3·π·27 = 36π, A = 4π·9 = 36π. The equator is a
        // great circle (k_g = 0) and each hemisphere has one loop (χ = 1):
        // Gauss–Bonnet gives each 9·2π.
        check(&hand_sphere(3.0), 36.0 * PI, 36.0 * PI);
        // Cap of r = 5 above z = 3: height h = 2, rim radius √(25 − 9) = 4.
        // V = πh²(3r − h)/3 = π·4·13/3 = 52π/3; A = 2πrh + π·4² = 20π + 16π.
        // The rim is not a great circle: k_g = z/r per unit of t (worked
        // out in `geodesic_turn`'s terms), so it carries 2π·3/5.
        check(&hand_sphere_cap(5.0, 3.0), 52.0 * PI / 3.0, 36.0 * PI);
        // More than half: above z = −3, h = 8. V = π·64·7/3 = 448π/3 (the
        // two caps add up to 4/3·π·125 = 500π/3); A = 2π·5·8 + 16π = 96π.
        check(&hand_sphere_cap(5.0, -3.0), 448.0 * PI / 3.0, 96.0 * PI);
        // Slice of r = 5 between z = −3 and 4, a band with two loops
        // (χ = 0). V = π∫(25 − z²)dz = π(25·7 − (64 + 27)/3) = 434π/3;
        // A = 2πr·7 + discs π·16 + π·9 = 70π + 25π.
        check(&hand_sphere_slice(5.0, -3.0, 4.0), 434.0 * PI / 3.0, 95.0 * PI);
        // Octant of r = 2: V = (4/3·π·8)/8 = 4π/3. The curved face is an
        // eighth of the sphere, 4π·4/8 = 2π: three great-circle sides and
        // three corners turning π/2 each, so 4(2π − 3π/2) = 2π. Three
        // quarter discs add 3π. A = 5π.
        check(&hand_sphere_octant(2.0), 4.0 * PI / 3.0, 5.0 * PI);
    }

    #[test]
    fn the_new_sphere_fixtures_are_valid() {
        for (name, body) in [("cap", hand_sphere_cap(5.0, 3.0)), ("big cap", hand_sphere_cap(5.0, -3.0))] {
            assert_eq!(crate::validate::validate(&body), Ok(()), "{name}");
        }
        // Sphere faces other than caps can't be meshed yet (they arrive with
        // booleans, steps 46–47). Everything else about these two passes:
        // the only complaint is that one, for the curved face.
        for (name, body) in [("slice", hand_sphere_slice(5.0, -3.0, 4.0)), ("octant", hand_sphere_octant(2.0))] {
            let unsupported =
                crate::validate::ValidationError::Tessellation { face: 0, message: "general sphere faces are not supported yet".into() };
            assert_eq!(crate::validate::validate(&body), Err(vec![unsupported]), "{name}");
        }
    }

    fn path(corners: &[(f64, f64)], bulges: &[f64]) -> Boundary {
        Boundary::Path { corners: corners.iter().map(|&(x, y)| DVec2::new(x, y)).collect(), bulges: bulges.to_vec() }
    }

    #[test]
    fn extrusions_by_hand() {
        let rect = [(0.0, 0.0), (10.0, 0.0), (10.0, 4.0), (0.0, 4.0)];
        // Stadium 10 × 4 with half-circle ends of r = 2, extruded 2:
        // profile 40 + π·4, perimeter 20 + 2·2π: V = 2(40 + 4π);
        // A = 2(40 + 4π) + 2(20 + 4π).
        let stadium = extrude(&Profile { outer: path(&rect, &[0.0, 1.0, 0.0, 1.0]), holes: vec![] }, 2.0).unwrap();
        check(&stadium, 2.0 * (40.0 + 4.0 * PI), 2.0 * (40.0 + 4.0 * PI) + 2.0 * (20.0 + 4.0 * PI));
        // 10 × 10 plate with a round hole r = 2 at its centre, extruded 5:
        // profile 100 − 4π, perimeters 40 + 4π: V = 5(100 − 4π);
        // A = 2(100 − 4π) + 5(40 + 4π).
        let square = [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)];
        let hole = Boundary::Circle { center: DVec2::new(5.0, 5.0), radius: 2.0 };
        let plate = extrude(&Profile { outer: path(&square, &[]), holes: vec![hole] }, 5.0).unwrap();
        check(&plate, 5.0 * (100.0 - 4.0 * PI), 2.0 * (100.0 - 4.0 * PI) + 5.0 * (40.0 + 4.0 * PI));
        // The same square with its top edge bowing in, bulge −0.4: sweep
        // φ = 4·atan 0.4, r = 10(1 + 0.16)/1.6 = 7.25. The segment cut off
        // has area (r²/2)(φ − sin φ) and the arc is r·φ long instead of 10.
        // Extruded 3: V = 3(100 − cut); A = 2(100 − cut) + 3(30 + rφ).
        let bowed = extrude(&Profile { outer: path(&square, &[0.0, 0.0, -0.4, 0.0]), holes: vec![] }, 3.0).unwrap();
        let (r, phi) = (7.25, 4.0 * 0.4f64.atan());
        let cut = r * r / 2.0 * (phi - phi.sin());
        check(&bowed, 3.0 * (100.0 - cut), 2.0 * (100.0 - cut) + 3.0 * (30.0 + r * phi));
    }

    #[test]
    fn primitives_by_hand() {
        use crate::ops::primitives::*;
        // 2 × 3 × 4 box: V = 24, A = 2(6 + 12 + 8) = 52.
        check(&make_box(2.0, 3.0, 4.0).unwrap(), 24.0, 52.0);
        // Cylinder r = 20, h = 20 (the app's): V = 8000π, A = 800π + 800π.
        check(&make_cylinder(20.0, 20.0).unwrap(), 8000.0 * PI, 1600.0 * PI);
        // Sphere r = 1.5: V = 4/3·π·3.375 = 4.5π, A = 4π·2.25 = 9π.
        check(&make_sphere(1.5).unwrap(), 4.5 * PI, 9.0 * PI);
    }

    #[test]
    fn far_from_the_origin_nothing_is_lost() {
        // Turned and moved 90 km away. Moving rounds each coordinate by up
        // to rounding_slack(9e7) ≈ 1.3e-6, which can change the true volume
        // by at most area × that and the area by about perimeter × that
        // (bounded here by area × that / the smallest size, 1). Measured
        // from the world origin, the vector-area terms would be ~1e16 and
        // lose everything; from the box centre they keep their digits.
        let far = Transform::rotation(DVec3::new(1.0, 2.0, 3.0), 0.9).then(Transform::translation(DVec3::new(9e7, -5e7, 3e7)));
        for (body, volume, area) in [
            (hand_cube(), 1.0, 6.0),
            (hand_tube(1.0, 2.0, 3.0, 0.3), 9.0 * PI, 24.0 * PI),
            (hand_sphere_octant(2.0), 4.0 * PI / 3.0, 5.0 * PI),
            (hand_sphere_cap(5.0, 3.0), 52.0 * PI / 3.0, 36.0 * PI),
        ] {
            let m = mass_properties(&body.transformed(&far));
            let slack = area * rounding_slack(9e7);
            assert!(measure_eq(m.volume, volume, slack), "volume {} expected {volume} ± {slack}", m.volume);
            assert!(measure_eq(m.area, area, slack), "area {} expected {area} ± {slack}", m.area);
        }
    }

    #[test]
    fn long_thin_box_turned_keeps_its_volume() {
        // Regression (stateful seed 0x5eed): 1 × 4228783.9 × 0.5, turned
        // 90° about (0, 0.252, 0.109). Measuring each flat face's height
        // from a far corner along a computed (not exact) normal lost 142
        // there. That box is now over MAX_SIZE (refused, checked below), so
        // the same box is tested at 983438.1, near the new limit. The old
        // mistake, rebuilt on purpose (height from the farthest corner along
        // the normalised vector area), measured 249 off at 4228783.9 and
        // 3.98 off here, 115× this test's slack.
        // V = w·d·h, A = 2(wd + dh + wh). Turning rounds each coordinate by
        // up to rounding_slack(reach), so V may move by area × that
        // (≈ 2e6 × 1e6 × 1.4e-14 ≈ 0.03) at most.
        assert!(crate::ops::primitives::make_box(1.0, 4228783.901680244, 0.5).is_err());
        let (w, d, h) = (1.0, 983438.1166698242, 0.5);
        let turn = Transform::rotation(DVec3::new(0.0, 0.25212664109292654, 0.1092220701325219), FRAC_PI_2);
        let body = crate::ops::primitives::make_box(w, d, h).unwrap().transformed(&turn);
        let (lo, hi) = body.bounds();
        let area = 2.0 * (w * d + d * h + w * h);
        let slack = area * rounding_slack(lo.abs().max(hi.abs()).max_element());
        let m = mass_properties(&body);
        assert!(measure_eq(m.volume, w * d * h, slack), "volume {} expected {} ± {slack}", m.volume, w * d * h);
        assert!(measure_eq(m.area, area, slack), "area {} expected {area} ± {slack}", m.area);
    }

    #[test]
    fn a_very_shallow_arc_keeps_its_digits() {
        // 10 × 10 square whose top edge bows in with bulge −3e-6 (the
        // flattest arc whose radius is inside MAX_SIZE; at the old −1e-6
        // the radius, 2.5e6, is now refused): sweep φ = 4·atan(3e-6) ≈
        // 1.2e-5, r = 10(1 + 9e-12)/1.2e-5 ≈ 8.3e5. The segment cut off is
        // (r²/2)(φ − sin φ) ≈ (2/3)·chord·sagitta = (2/3)·10·1.5e-5 ≈
        // 1e-4, worked out here with the series φ − sin φ = φ³/6 − φ⁵/120
        // + … (no cancellation). Extruded 3: V = 3(100 − cut). Every corner
        // is exact, so only the kernel's own arithmetic can be off: allow
        // FP_REL. Using the cylinder's centre, 8.3e5 away, the side wall's
        // r·A and centre terms (each ~2.5e7) cancel to ~3e-4 and leave
        // ~3e-9 of rounding.
        let square = [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)];
        let too_flat = Profile { outer: path(&square, &[0.0, 0.0, -1e-6, 0.0]), holes: vec![] };
        assert!(extrude(&too_flat, 3.0).is_err(), "an arc of radius 2.5e6 is over MAX_SIZE");
        let beta: f64 = 3e-6;
        let bowed = extrude(&Profile { outer: path(&square, &[0.0, 0.0, -beta, 0.0]), holes: vec![] }, 3.0).unwrap();
        let (r, phi) = (10.0 * (1.0 + beta * beta) / (4.0 * beta), 4.0 * beta.atan());
        let phi_minus_sin = phi.powi(3) / 6.0 - phi.powi(5) / 120.0 + phi.powi(7) / 5040.0;
        let cut = r * r / 2.0 * phi_minus_sin;
        let m = mass_properties(&bowed);
        assert!(rel_eq(m.volume, 3.0 * (100.0 - cut), FP_REL), "volume {} expected {}", m.volume, 3.0 * (100.0 - cut));
        assert!(rel_eq(m.area, 2.0 * (100.0 - cut) + 3.0 * (30.0 + r * phi), FP_REL), "area {}", m.area);
    }

    #[test]
    fn a_huge_thin_washer_turned_keeps_its_volume() {
        // Regression (random tester, seed 0x5eed, saved): circles of r =
        // 1679740.80 and r − 2 whose centres are 1.5 apart (a wall 0.5 to
        // 3.5 thick), extruded 0.5, lifted 963.28 and turned a quarter
        // turn. Measuring each wall's height from one of its own corners,
        // 1.7e6 from the middle and rounded by ~4e-10 when turned, left an
        // error of ~2πR²·4e-10 ≈ 7e3 (688 there). That washer is now over
        // MAX_SIZE (refused, checked below), so the same washer is tested
        // at the new limit, R = 499870.80 (1 km across).
        // V = π(R² − r²)·0.5 = π·2·(R + r)·0.5. The walls' terms are each
        // ±2πR²h ≈ ±7.8e11 and cancel. Turning may only move the true
        // volume by area × rounding_slack.
        let old = Profile {
            outer: Boundary::Circle { center: DVec2::new(0.0, 3.5), radius: 1679740.7957549074 },
            holes: vec![Boundary::Circle { center: DVec2::new(1.5, 3.5), radius: 1679738.7957549074 }],
        };
        assert!(extrude(&old, 0.5).is_err());
        let (big, small) = (499870.7957549074, 499868.7957549074);
        let profile = Profile {
            outer: Boundary::Circle { center: DVec2::new(0.0, 3.5), radius: big },
            holes: vec![Boundary::Circle { center: DVec2::new(1.5, 3.5), radius: small }],
        };
        let body = extrude(&profile, 0.5).unwrap();
        let turn = Transform::translation(DVec3::new(0.0, 0.0, 963.281384129561))
            .then(Transform::rotation(DVec3::new(0.0, 0.5506269028984057, -0.6972794946650358), 1.5707963256948965));
        let volume = PI * 2.0 * (big + small) * 0.5;
        for b in [body.clone(), body.transformed(&turn)] {
            let (lo, hi) = b.bounds();
            let m = mass_properties(&b);
            let slack = m.area * rounding_slack(lo.abs().max(hi.abs()).max_element());
            assert!(measure_eq(m.volume, volume, slack), "volume {} expected {volume} ± {slack}", m.volume);
        }
    }

    #[test]
    fn a_tube_far_up_its_own_axis_keeps_its_digits() {
        // The tube of `planar_and_cylindrical_bodies_by_hand` (r 1 to 2, h =
        // 3, V = 9π, A = 24π) moved 2^26 = 67108864 up its own axis. Every
        // coordinate stays exact (2^26 and 2^26 + 3 are doubles; x and y
        // don't change), so it is the same body and must give the same
        // numbers to FP_REL. Each wall's circles sit at heights ±1.5 from
        // the body's centre o; measured from a point ~1.3e8 away instead,
        // the walls' terms ∓s·2πr² would be ~1.3e8·2πr² each, cancelling
        // to 2πr²·3 and leaving ~1e-8 of it to rounding.
        let up = Transform::translation(DVec3::new(0.0, 0.0, 67108864.0));
        check(&hand_tube(1.0, 2.0, 3.0, 0.3).transformed(&up), 9.0 * PI, 24.0 * PI);
    }

    #[test]
    fn a_long_half_round_bar_turned_keeps_its_volume() {
        // A half disc of r = 1 (the chord (−1, 0)→(1, 0), then the upper
        // half circle back) extruded h = 1e5 and turned about an odd axis:
        // V = (π/2)·h; A = two half discs π + the flat side 2h + the curved
        // side πh. Turning rounds each coordinate by up to
        // rounding_slack(reach), which may move the true volume by area ×
        // that (≈ 7e-4 here). The curved wall's vector area is square to
        // its axis in exact arithmetic, but the computed one has an
        // along-axis part of rounding: chord terms ~h² = 1e10 rounded at
        // ~1e-16, ~1e-6. That part is dropped; kept or doubled, times the
        // wall's corner ~h/2 from the centre along the axis, it adds ~0.1.
        let half = Profile { outer: path(&[(-1.0, 0.0), (1.0, 0.0)], &[0.0, 1.0]), holes: vec![] };
        let h = 1e5;
        let turn = Transform::rotation(DVec3::new(0.3, -0.8, 0.5), 1.1);
        let body = extrude(&half, h).unwrap().transformed(&turn);
        let (volume, area) = (PI / 2.0 * h, PI + (2.0 + PI) * h);
        let (lo, hi) = body.bounds();
        let slack = area * rounding_slack(lo.abs().max(hi.abs()).max_element());
        let m = mass_properties(&body);
        assert!(measure_eq(m.volume, volume, slack), "volume {} expected {volume} ± {slack}", m.volume);
        assert!(measure_eq(m.area, area, slack), "area {} expected {area} ± {slack}", m.area);
    }

    /// The square frame with 1 µm walls the random tester found (seed
    /// 0x389ee678a942 and 25 others, saved), at 10 km then (L =
    /// 9999999.99999, now over MAX_SIZE and refused) and here at 1 km, the
    /// new limit: outer corners 0 and L = 999999.99999 (plus a corner
    /// halfway along the bottom), hole corners 0.001 and L − 0.001,
    /// extruded 1. V = (L² − (L − 2w)²)·h = 4Lw − 4w² with w = 0.001:
    /// 3999.99999996 − 0.000004 = 3999.99999596.
    pub(crate) fn huge_thin_frame() -> Body {
        let v = DVec2::new;
        let l = 999999.99999;
        let outer = vec![v(0.0, 0.0), v(499999.999995, 0.0), v(l, 0.0), v(l, l), v(0.0, l)];
        let hole = vec![v(0.001, 0.001), v(0.001, 999999.99899), v(999999.99899, 999999.99899), v(999999.99899, 0.001)];
        extrude(&Profile::polygon(outer, vec![hole]), 1.0).unwrap()
    }

    pub(crate) const HUGE_THIN_FRAME_VOLUME: f64 = 3999.99999596;

    #[test]
    fn the_10_km_frame_is_now_refused() {
        let v = DVec2::new;
        let l = 9999999.99999;
        let outer = vec![v(0.0, 0.0), v(4999999.999995, 0.0), v(l, 0.0), v(l, l), v(0.0, l)];
        let hole = vec![v(0.001, 0.001), v(0.001, 9999999.99899), v(9999999.99899, 9999999.99899), v(9999999.99899, 0.001)];
        assert!(extrude(&Profile::polygon(outer, vec![hole]), 1.0).is_err());
    }

    #[test]
    fn a_body_turned_inside_out_has_negative_volume() {
        // Flipping every face (sense and loop direction) gives the same
        // surface facing inwards: the divergence theorem then gives −V,
        // while areas stay positive. (A body like this fails validation; it
        // shows the volume sign comes from the orientation, not abs().)
        for (mut b, volume, area) in [(hand_tube(1.0, 2.0, 3.0, 0.3), 9.0 * PI, 24.0 * PI), (hand_sphere_octant(2.0), 4.0 * PI / 3.0, 5.0 * PI)] {
            for f in &mut b.faces {
                f.sense = !f.sense;
                for l in &mut f.loops {
                    l.coedges.reverse();
                    l.coedges.iter_mut().for_each(|c| c.reversed = !c.reversed);
                }
            }
            check(&b, -volume, area);
        }
    }

    #[test]
    fn exact_values_agree_with_extrapolated_meshes() {
        // A second, independent route (self-consistency: it doesn't count as
        // a hand-worked test). An inscribed mesh's error shrinks as h² in
        // the step h, with an h⁴ term next, so two meshes with steps h and
        // h/2 extrapolate to (4·fine − coarse)/3 with only the h⁴ error
        // left: (0.02 rad)⁴ ≈ 1.6e-7, inside MASS_PROPS_REL.
        let opts = |refine| TessOptions { chord: 1.0, max_angle: MASS_PROPS_ANGLE, refine };
        let rect = [(0.0, 0.0), (10.0, 0.0), (10.0, 4.0), (0.0, 4.0)];
        for (name, body) in [
            ("tube", hand_tube(1.0, 2.0, 3.0, 0.3)),
            ("sphere", hand_sphere(3.0)),
            ("cap", hand_sphere_cap(5.0, 3.0)),
            ("stadium", extrude(&Profile { outer: path(&rect, &[0.0, 1.0, -0.3, 1.0]), holes: vec![] }, 2.0).unwrap()),
        ] {
            let coarse = tessellate(&body, &opts(1)).unwrap();
            let fine = tessellate(&body, &opts(2)).unwrap();
            let v = (4.0 * fine.signed_volume() - coarse.signed_volume()) / 3.0;
            let a = (4.0 * fine.area() - coarse.area()) / 3.0;
            let m = mass_properties(&body);
            assert!(rel_eq(m.volume, v, MASS_PROPS_REL), "{name}: volume {} vs extrapolated {v}", m.volume);
            assert!(rel_eq(m.area, a, MASS_PROPS_REL), "{name}: area {} vs extrapolated {a}", m.area);
        }
    }

    #[test]
    // The references keep all 20 worked digits, more than an f64 holds.
    #[allow(clippy::excessive_precision)]
    fn theta_minus_sin_by_hand() {
        // References summed by hand from θ³/3! − θ⁵/5! + θ⁷/7! − … in exact
        // fractions (Python, until the terms were below 1e-45), 20 digits.
        // Below 0.1 the series is used and must be good to a few ulps; the
        // direct θ − sin θ there would lose about 0.1/(θ³/6) ulps (1e7 of
        // them at θ = 1e-3).
        // Purely relative (rel_eq's floor of LINEAR² would accept anything
        // this small): within n ulps of the reference.
        let close = |got: f64, want: f64, n: f64| (got - want).abs() <= n * f64::EPSILON * want.abs();
        for (t, want) in [
            (1e-6, 1.666_666_666_666_583_333_3e-19),
            (1e-3, 1.666_666_583_333_335_317_5e-10),
            (0.05, 2.083_072_932_167_120_513_5e-5),
            (0.0999, 1.660_842_687_008_990_605_0e-4),
        ] {
            for sign in [1.0, -1.0] {
                let got = theta_minus_sin(sign * t);
                assert!(close(got, sign * want, 4.0), "{t}: {got} vs {want}");
            }
        }
        // From 0.1 the direct form, losing ~0.1/1.7e-4 ≈ 600 ulps at the
        // switch, inside FP_REL; well above it, a few ulps.
        for (t, want) in [(0.1, 1.665_833_531_718_476_931_9e-4), (0.1001, 1.670_834_359_769_619_622_1e-4)] {
            assert!(close(theta_minus_sin(t), want, FP_REL / f64::EPSILON), "{t}");
        }
        for (t, want) in [(1.0, 0.158_529_015_192_103_493_35), (3.0, 2.858_879_991_940_132_777_9)] {
            assert!(close(theta_minus_sin(t), want, 8.0), "{t}");
        }
    }

    #[test]
    fn the_same_body_described_differently() {
        // The same surfaces and edges, written down differently, must give
        // the same numbers (each still validates). Round descriptions (a
        // cylinder's origin at the height of its first vertex, circles
        // starting at t = 0) could hide a formula that only works for them.
        let shift_cylinders = |mut b: Body, by: f64| {
            for f in &mut b.faces {
                if let Surface::Cylinder { origin, axis, .. } = &mut f.surface {
                    *origin += *axis * by;
                }
            }
            b
        };
        // Full circles starting at t = 0.3: same circle, the vertex on it moved.
        let shift_circles = |mut b: Body| {
            for e in 0..b.edges.len() {
                let edge = &mut b.edges[e];
                if edge.is_closed() {
                    edge.t0 += 0.3;
                    edge.t1 += 0.3;
                    let at = edge.curve.eval(edge.t0);
                    b.vertices[b.edges[e].start].point = at;
                }
            }
            b
        };
        // The bowed square of `extrusions_by_hand`: an arc turning
        // 4·atan 0.4 ≈ 1.52 rad, not a half circle (whose ends at 0 and π
        // have equal sines, which can hide a wrong angle).
        let square = [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)];
        let bowed = extrude(&Profile { outer: path(&square, &[0.0, 0.0, -0.4, 0.0]), holes: vec![] }, 3.0).unwrap();
        let (r, phi) = (7.25, 4.0 * 0.4f64.atan());
        let cut = r * r / 2.0 * (phi - phi.sin());
        for (name, body, volume, area) in [
            ("bowed square", bowed, 3.0 * (100.0 - cut), 2.0 * (100.0 - cut) + 3.0 * (30.0 + r * phi)),
            ("half cylinder", hand_half_cylinder(2.0, 3.0), 6.0 * PI, 10.0 * PI + 12.0),
            ("tube", hand_tube(1.0, 2.0, 3.0, 0.3), 9.0 * PI, 24.0 * PI),
            ("cap", hand_sphere_cap(5.0, 3.0), 52.0 * PI / 3.0, 36.0 * PI),
            ("big cap", hand_sphere_cap(5.0, -3.0), 448.0 * PI / 3.0, 96.0 * PI),
        ] {
            for by in [7.3, -2.1] {
                let b = shift_cylinders(body.clone(), by);
                assert_eq!(crate::validate::validate(&b), Ok(()), "{name}, origin moved {by}");
                check(&b, volume, area);
            }
            let b = shift_circles(body.clone());
            assert_eq!(crate::validate::validate(&b), Ok(()), "{name}, circles from 0.3");
            check(&b, volume, area);
        }
    }

    #[test]
    fn any_point_will_do() {
        // Measured from points away from the body's centre, so every
        // centre term (c − o)·(vector area) is non-zero (from the box
        // centre, a sphere's centre is o itself and its term vanishes).
        let rect = [(0.0, 0.0), (10.0, 0.0), (10.0, 4.0), (0.0, 4.0)];
        let stadium = extrude(&Profile { outer: path(&rect, &[0.0, 1.0, 0.0, 1.0]), holes: vec![] }, 2.0).unwrap();
        for (name, body, volume, area) in [
            ("cube", hand_cube(), 1.0, 6.0),
            ("tube", hand_tube(1.0, 2.0, 3.0, 0.3), 9.0 * PI, 24.0 * PI),
            ("cap", hand_sphere_cap(5.0, 3.0), 52.0 * PI / 3.0, 36.0 * PI),
            ("slice", hand_sphere_slice(5.0, -3.0, 4.0), 434.0 * PI / 3.0, 95.0 * PI),
            ("octant", hand_sphere_octant(2.0), 4.0 * PI / 3.0, 5.0 * PI),
            ("stadium", stadium, 2.0 * (40.0 + 4.0 * PI), 2.0 * (40.0 + 4.0 * PI) + 2.0 * (20.0 + 4.0 * PI)),
        ] {
            for o in [DVec3::new(3.0, -2.0, 7.0), DVec3::new(-0.4, 11.0, 0.2)] {
                let m = about(&body, o);
                assert!(rel_eq(m.volume, volume, FP_REL) && rel_eq(m.area, area, FP_REL), "{name} from {o}: {m:?}");
            }
        }
    }

    #[test]
    fn corner_turns_by_hand() {
        // Seen from +Z, going +X then turning to +Y is a left turn of π/2;
        // to −Y a right turn, −π/2; straight on, 0; back, ±π.
        let n = DVec3::Z;
        assert!(rel_eq(corner_turn(DVec3::X, DVec3::Y, n), FRAC_PI_2, FP_REL));
        assert!(rel_eq(corner_turn(DVec3::X, DVec3::NEG_Y, n), -FRAC_PI_2, FP_REL));
        assert_eq!(corner_turn(DVec3::X, DVec3::X, n), 0.0);
        assert!(rel_eq(corner_turn(DVec3::X, DVec3::NEG_X, n).abs(), PI, FP_REL));
    }
}
