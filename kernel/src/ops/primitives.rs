//! Primitive solids.

use super::{check_length, finish, KernelError};
use crate::geom::{Curve, Surface};
use std::f64::consts::TAU;
use crate::topology::{Body, Coedge, FaceRole, Loop, Shell};
use glam::DVec3;
use std::collections::HashMap;

/// Axis-aligned box with one corner at the origin and the opposite corner
/// at (width, depth, height).
pub fn make_box(width: f64, depth: f64, height: f64) -> Result<Body, KernelError> {
    check_length("width", width)?;
    check_length("depth", depth)?;
    check_length("height", height)?;
    let size = DVec3::new(width, depth, height);

    let mut b = Body::default();
    // Vertex i has x, y, z taken from bits 0, 1, 2 of i.
    let v: Vec<usize> = (0..8)
        .map(|i| {
            let bit = |k: u32| ((i >> k) & 1) as f64;
            b.add_vertex(DVec3::new(bit(0), bit(1), bit(2)) * size)
        })
        .collect();
    // Corners of each face, counter-clockwise seen from outside, the
    // outward normal, and the face's role.
    let faces: [([usize; 4], DVec3, FaceRole); 6] = [
        ([0, 2, 3, 1], DVec3::NEG_Z, FaceRole::Bottom),
        ([4, 5, 7, 6], DVec3::Z, FaceRole::Top),
        ([0, 1, 5, 4], DVec3::NEG_Y, FaceRole::Front),
        ([2, 6, 7, 3], DVec3::Y, FaceRole::Back),
        ([0, 4, 6, 2], DVec3::NEG_X, FaceRole::Left),
        ([1, 3, 7, 5], DVec3::X, FaceRole::Right),
    ];
    let mut edges = HashMap::new();
    for (corners, normal, role) in faces {
        let coedges = (0..4)
            .map(|k| {
                let (a, c) = (v[corners[k]], v[corners[(k + 1) % 4]]);
                let key = (a.min(c), a.max(c));
                let edge = *edges.entry(key).or_insert_with(|| b.add_line(key.0, key.1));
                Coedge { edge, reversed: a != key.0 }
            })
            .collect();
        let origin = b.vertices[v[corners[0]]].point;
        let x_dir = crate::geom::any_perpendicular(normal);
        b.add_face_as(role, Surface::Plane { origin, normal, x_dir }, true, vec![Loop { coedges }]);
    }
    b.shells.push(Shell { faces: (0..6).collect() });
    finish(b)
}

/// Cylinder of `radius` and `height` standing on the origin along +Z: two
/// seamless circular edges, two caps, and a side face with two loops.
pub fn make_cylinder(radius: f64, height: f64) -> Result<Body, KernelError> {
    check_length("radius", radius)?;
    check_length("height", height)?;
    let mut b = Body::default();
    let top = DVec3::new(0.0, 0.0, height);
    let circle = |center| Curve::Circle { center, axis: DVec3::Z, x_dir: DVec3::X, radius };
    let v0 = b.add_vertex(DVec3::new(radius, 0.0, 0.0));
    let v1 = b.add_vertex(top + DVec3::new(radius, 0.0, 0.0));
    let bottom_edge = b.add_edge(circle(DVec3::ZERO), v0, v0, 0.0, TAU);
    let top_edge = b.add_edge(circle(top), v1, v1, 0.0, TAU);
    let fwd = |edge| Coedge { edge, reversed: false };
    let rev = |edge| Coedge { edge, reversed: true };
    // Bottom cap seen from below runs clockwise from above: the circle reversed.
    b.add_face_as(
        FaceRole::Bottom,
        Surface::Plane { origin: DVec3::ZERO, normal: DVec3::NEG_Z, x_dir: DVec3::X },
        true,
        vec![Loop { coedges: vec![rev(bottom_edge)] }],
    );
    b.add_face_as(FaceRole::Top, Surface::Plane { origin: top, normal: DVec3::Z, x_dir: DVec3::X }, true, vec![Loop { coedges: vec![fwd(top_edge)] }]);
    b.add_face_as(
        FaceRole::Side(None),
        Surface::Cylinder { origin: DVec3::ZERO, axis: DVec3::Z, x_dir: DVec3::X, radius },
        true,
        vec![Loop { coedges: vec![fwd(bottom_edge)] }, Loop { coedges: vec![rev(top_edge)] }],
    );
    b.shells.push(Shell { faces: vec![0, 1, 2] });
    finish(b)
}

/// Sphere of `radius` centred on the origin: two hemispheres sharing an
/// equator edge (a single face with no edges couldn't satisfy Euler–Poincaré
/// in this data structure).
pub fn make_sphere(radius: f64) -> Result<Body, KernelError> {
    check_length("radius", radius)?;
    let mut b = Body::default();
    let v = b.add_vertex(DVec3::new(radius, 0.0, 0.0));
    let equator = Curve::Circle { center: DVec3::ZERO, axis: DVec3::Z, x_dir: DVec3::X, radius };
    let e = b.add_edge(equator, v, v, 0.0, TAU);
    let s = Surface::Sphere { center: DVec3::ZERO, axis: DVec3::Z, x_dir: DVec3::X, radius };
    // Upper hemisphere: the equator counter-clockwise seen from above.
    b.add_face_as(FaceRole::Upper, s.clone(), true, vec![Loop { coedges: vec![Coedge { edge: e, reversed: false }] }]);
    b.add_face_as(FaceRole::Lower, s, true, vec![Loop { coedges: vec![Coedge { edge: e, reversed: true }] }]);
    b.shells.push(Shell { faces: vec![0, 1] });
    finish(b)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tessellate::{tessellate, TessOptions};
    use crate::tolerance::{self, points_eq, rel_eq, FP_REL, MIN_FEATURE};
    use proptest::prelude::*;
    use proptest::test_runner::FileFailurePersistence;

    /// Checks every hand-derivable fact about a box of the given size.
    fn check_box(w: f64, d: f64, h: f64) {
        let b = make_box(w, d, h).unwrap();
        let c = b.counts(&b.shells[0]);
        assert_eq!((c.v, c.e, c.f, c.rings), (8, 12, 6, 0));
        assert_eq!(c.genus(), Some(0));

        let m = tessellate(&b, &TessOptions::DISPLAY).unwrap();
        assert_eq!(m.check_closed(), Ok(()));
        assert!(rel_eq(m.signed_volume(), w * d * h, FP_REL), "volume {} vs {}", m.signed_volume(), w * d * h);
        let area = 2.0 * (w * d + d * h + w * h);
        assert!(rel_eq(m.area(), area, FP_REL), "area {} vs {area}", m.area());

        // Bounding box is exactly [0, size].
        let (lo, hi) = m.positions.iter().fold((DVec3::INFINITY, DVec3::NEG_INFINITY), |(lo, hi), &p| (lo.min(p), hi.max(p)));
        assert!(points_eq(lo, DVec3::ZERO));
        assert!(points_eq(hi, DVec3::new(w, d, h)));

        // Every face's outward normal points away from the centre.
        let centre = DVec3::new(w, d, h) / 2.0;
        for (fi, f) in b.faces.iter().enumerate() {
            let Surface::Plane { origin, .. } = f.surface else { panic!("box face {fi} is not planar") };
            let n = b.face_normal_at(fi, origin);
            let face_centre = f.loops[0].coedges.iter().map(|c| b.vertices[b.coedge_start(*c)].point).sum::<DVec3>() / 4.0;
            assert!(n.dot(face_centre - centre) > 0.0, "face {fi} normal points inward");
        }
    }

    #[test]
    fn hand_worked_box_10_20_30() {
        // V = 10·20·30 = 6000; A = 2(10·20 + 20·30 + 10·30) = 2200.
        let b = make_box(10.0, 20.0, 30.0).unwrap();
        let m = tessellate(&b, &TessOptions::DISPLAY).unwrap();
        assert!(rel_eq(m.signed_volume(), 6000.0, FP_REL));
        assert!(rel_eq(m.area(), 2200.0, FP_REL));
        // The far corner is vertex 7 = (10, 20, 30).
        assert!(points_eq(b.vertices[7].point, DVec3::new(10.0, 20.0, 30.0)));
        check_box(10.0, 20.0, 30.0);
    }

    #[test]
    fn sizes_either_side_of_the_limits() {
        for bad in [0.0, -1.0, MIN_FEATURE * 0.9, f64::NAN, f64::INFINITY, tolerance::MAX_SIZE * 1.1] {
            assert!(make_box(bad, 1.0, 1.0).is_err(), "width {bad} accepted");
            assert!(make_box(1.0, bad, 1.0).is_err(), "depth {bad} accepted");
            assert!(make_box(1.0, 1.0, bad).is_err(), "height {bad} accepted");
        }
        for good in [MIN_FEATURE, MIN_FEATURE * 1.1, 1.0, tolerance::MAX_SIZE * 0.9, tolerance::MAX_SIZE] {
            assert!(make_box(good, 1.0, 1.0).is_ok(), "width {good} rejected");
        }
    }

    #[test]
    fn errors_explain_themselves() {
        let msg = make_box(-2.0, 1.0, 1.0).unwrap_err().to_string();
        assert!(msg.contains("width") && msg.contains("-2"), "{msg}");
        let msg = KernelError::InvalidResult(vec![crate::validate::ValidationError::ZeroLengthEdge { edge: 4 }]).to_string();
        assert!(msg.contains("failed validation") && msg.contains("edge 4"), "{msg}");
    }

    #[test]
    fn cylinder_by_hand() {
        // r = 3, h = 4, display tessellation: each circle has n chords; the
        // mesh is a prism over the inscribed n-gon, area (n/2)·r²·sin(2π/n).
        // Surface: two n-gon caps + n rectangles of side 2r·sin(π/n) by h.
        let b = make_cylinder(3.0, 4.0).unwrap();
        let c = b.counts(&b.shells[0]);
        assert_eq!((c.v, c.e, c.f, c.rings), (2, 2, 3, 1));
        let m = tessellate(&b, &TessOptions::DISPLAY).unwrap();
        let n = (m.edge_polylines[0].len() - 1) as f64;
        let polygon = 0.5 * n * 9.0 * (TAU / n).sin();
        let side = n * 2.0 * 3.0 * (std::f64::consts::PI / n).sin() * 4.0;
        assert!(rel_eq(m.signed_volume(), polygon * 4.0, FP_REL));
        assert!(rel_eq(m.area(), 2.0 * polygon + side, FP_REL));
    }

    #[test]
    fn sphere_by_hand() {
        // r = 2: 1 vertex, 1 edge, 2 faces → V − E + F = 2, genus 0.
        let b = make_sphere(2.0).unwrap();
        let c = b.counts(&b.shells[0]);
        assert_eq!((c.v, c.e, c.f, c.rings), (1, 1, 2, 0));
        // The mesh is convex with every vertex on the sphere, so it lies
        // inside the sphere (V < 4/3·π·2³ = 32π/3) and contains the ball
        // whose radius is the nearest distance from the centre to any
        // triangle's plane (V > 4/3·π·d³).
        let m = tessellate(&b, &TessOptions::DISPLAY).unwrap();
        let d = (0..m.triangles.len())
            .map(|t| {
                let [a, b2, c2] = m.triangle(t);
                (b2 - a).cross(c2 - a).normalize().dot(a).abs()
            })
            .fold(f64::INFINITY, f64::min);
        let v = m.signed_volume();
        let ball = |r: f64| 4.0 / 3.0 * std::f64::consts::PI * r.powi(3);
        assert!(v < ball(2.0) && v > ball(d), "{} < {v} < {}", ball(d), ball(2.0));
    }

    #[test]
    fn curved_primitive_size_limits() {
        for bad in [0.0, -1.0, MIN_FEATURE * 0.9, f64::NAN, f64::NEG_INFINITY, tolerance::MAX_SIZE * 1.1] {
            assert!(make_cylinder(bad, 1.0).is_err() && make_cylinder(1.0, bad).is_err() && make_sphere(bad).is_err(), "{bad}");
        }
        for good in [MIN_FEATURE, MIN_FEATURE * 1.1, 1.0, tolerance::MAX_SIZE] {
            assert!(make_cylinder(good, 1.0).is_ok() && make_cylinder(1.0, good).is_ok() && make_sphere(good).is_ok(), "{good}");
        }
    }

    #[test]
    fn nasty_proportions() {
        check_box(MIN_FEATURE, MIN_FEATURE, MIN_FEATURE); // smallest allowed cube
        check_box(1e-2, 1e-2, 1e5); // needle
        check_box(1e5, 1e5, 1e-2); // sheet
        check_box(1e5, 1e5, 1e5);
        check_box(MIN_FEATURE, tolerance::MAX_SIZE, tolerance::MAX_SIZE); // thinnest plate at the largest size
    }

    /// Lengths spread evenly on a log scale, so tiny and huge sizes are as
    /// likely as everyday ones.
    fn length() -> impl Strategy<Value = f64> {
        (-2.0f64..5.0).prop_map(|e| 10f64.powf(e))
    }

    proptest! {
        #![proptest_config(ProptestConfig {
            cases: 256,
            failure_persistence: Some(Box::new(FileFailurePersistence::Direct("tests/regressions/box.txt"))),
            ..ProptestConfig::default()
        })]

        #[test]
        fn random_boxes_are_valid_with_exact_volume_and_area(w in length(), d in length(), h in length()) {
            check_box(w, d, h);
        }
    }
}
