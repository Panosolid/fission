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

use crate::geom::{Curve, Surface};
use crate::topology::{Body, Coedge, Face};
use glam::DVec3;
use std::f64::consts::TAU;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MassProps {
    pub volume: f64,
    pub area: f64,
}

/// Exact volume and area of a valid body (to rounding).
pub fn mass_properties(body: &Body) -> MassProps {
    let (lo, hi) = body.bounds();
    let o = (lo + hi) * 0.5;
    let mut volume = 0.0;
    let mut area = 0.0;
    for face in &body.faces {
        let (v, a) = face_terms(body, face, o);
        volume += v;
        area += a;
    }
    MassProps { volume: volume / 3.0, area }
}

/// A coedge as the curve it runs along and its parameters in the direction
/// of travel (from `ta` to `tb`; `tb < ta` when the coedge is reversed).
fn travel(body: &Body, c: Coedge) -> (&Curve, f64, f64) {
    let e = &body.edges[c.edge];
    if c.reversed { (&e.curve, e.t1, e.t0) } else { (&e.curve, e.t0, e.t1) }
}

/// ½ ∫ (x − o) × dx along a curve from `ta` to `tb`.
///
/// Line from a to b: ½ (a − o) × (b − a) = ½ (a − o) × (b − o), the
/// triangle o, a, b. A circular arc sweeps that triangle plus the segment
/// between its chord and itself, (r²/2)(φ − sin φ) for a turn of φ, about
/// the circle's axis (negative when run backwards). Check: a full circle
/// gives 0 + πr². This form never cancels the large terms that
/// ½ ∫ [(c − o) + r(cos t X + sin t Y)] × r(−sin t X + cos t Y) dt would
/// for a shallow arc of a huge circle.
fn half_moment(curve: &Curve, ta: f64, tb: f64, o: DVec3) -> DVec3 {
    let chord = 0.5 * (curve.eval(ta) - o).cross(curve.eval(tb) - o);
    match *curve {
        Curve::Line { .. } => chord,
        Curve::Circle { axis, radius, .. } => chord + axis * (0.5 * radius * radius * theta_minus_sin(tb - ta)),
    }
}

/// θ − sin θ without cancellation: by its series below 0.1, where the
/// terms after θ⁹ are under 1e-15 of the first.
fn theta_minus_sin(t: f64) -> f64 {
    if t.abs() < 0.1 {
        let t2 = t * t;
        t * t2 / 6.0 * (1.0 - t2 / 20.0 * (1.0 - t2 / 42.0 * (1.0 - t2 / 72.0)))
    } else {
        t - t.sin()
    }
}

/// One coedge's share of a cylinder face's integrals, angles measured from
/// the face's point p, heights s along `axis` from the body's centre o:
/// (−∮ s d(θ − sin θ), −∮ s dθ) (see the module notes). Any height can be
/// 0 (∮ g(θ) dθ = 0 round the boundary, Green again), and o is better than
/// p: p can be far round a big cylinder, rounded by more than the face is
/// tall, and the circle centres sit near o. A line on a
/// cylinder runs along the axis (dθ = 0): nothing. A circle on it is a
/// cross-section at one height, its angle changing by (axis·k) per t.
fn cylinder_terms(curve: &Curve, ta: f64, tb: f64, p: DVec3, o: DVec3, center: DVec3, axis: DVec3) -> (f64, f64) {
    match *curve {
        Curve::Line { .. } => (0.0, 0.0),
        Curve::Circle { center: cc, axis: k, .. } => {
            let flat = |v: DVec3| v - axis * axis.dot(v);
            let (from, at) = (flat(p - center), flat(curve.eval(ta) - center));
            let ua = axis.dot(from.cross(at)).atan2(from.dot(at));
            let ub = ua + axis.dot(k) * (tb - ta);
            let s = axis.dot(cc - o);
            (-s * (theta_minus_sin(ub) - theta_minus_sin(ua)), -s * (ub - ua))
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
            let dx = curve.derivative(ta) * (tb - ta).signum();
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
            half_moment(curve, ta, tb, p)
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
                    let t_in = curve.derivative(tb) * (tb - ta).signum();
                    let t_out = next_curve.derivative(na) * (nb - na).signum();
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
mod tests {
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
        // 90° about (0, 0.252, 0.109). V = 2114391.95..., A = 2(wd + dh +
        // wh). Turning rounds each coordinate by up to rounding_slack(reach)
        // so V may move by area × that (≈ 8.5e6 × 4e6 × 1.4e-14 ≈ 0.5) at
        // most. Measuring each flat face's height from a far corner along a
        // computed (not exact) normal lost 142 here.
        let (w, d, h) = (1.0, 4228783.901680244, 0.5);
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
        // 10 × 10 square whose top edge bows in with bulge −1e-6: sweep
        // φ = 4·atan(1e-6) ≈ 4e-6, r = 10(1 + 1e-12)/4e-6 ≈ 2.5e6. The
        // segment cut off is (r²/2)(φ − sin φ) ≈ (2/3)·chord·sagitta =
        // (2/3)·10·5e-6 ≈ 3.3e-5, worked out here with the series
        // φ − sin φ = φ³/6 − φ⁵/120 + … (no cancellation). Extruded 3:
        // V = 3(100 − cut). Every corner is exact, so only the kernel's own
        // arithmetic can be off: allow FP_REL. Using the cylinder's centre,
        // 2.5e6 away, the side wall's r·A and centre terms (each ~7.5e7)
        // cancel to ~1e-4 and leave ~1e-8 of rounding.
        let square = [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)];
        let beta: f64 = 1e-6;
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
        // turn. V = π(R² − r²)·0.5 = π·2·(R + r)·0.5. The walls' terms are
        // each ±2πR²h ≈ ±8.86e12 and cancel; measuring each wall's height
        // from one of its own corners, 1.7e6 from the middle and rounded by
        // ~4e-10 when turned, left an error of ~2πR²·4e-10 ≈ 7e3 (688 here).
        // Turning may only move the true volume by area × rounding_slack.
        let (big, small) = (1679740.7957549074, 1679738.7957549074);
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
