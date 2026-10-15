//! Primitive solids.

use super::{check_length, finish, KernelError};
use crate::geom::Surface;
use crate::topology::{Body, Coedge, Loop, Shell};
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
    // Corners of each face, counter-clockwise seen from outside, and the
    // outward normal.
    let faces: [([usize; 4], DVec3); 6] = [
        ([0, 2, 3, 1], DVec3::NEG_Z),
        ([4, 5, 7, 6], DVec3::Z),
        ([0, 1, 5, 4], DVec3::NEG_Y),
        ([2, 6, 7, 3], DVec3::Y),
        ([0, 4, 6, 2], DVec3::NEG_X),
        ([1, 3, 7, 5], DVec3::X),
    ];
    let mut edges = HashMap::new();
    for (corners, normal) in faces {
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
        b.add_face(Surface::Plane { origin, normal, x_dir }, true, vec![Loop { coedges }]);
    }
    b.shells.push(Shell { faces: (0..6).collect() });
    finish(b)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tessellate::{tessellate, TessOptions};
    use crate::tolerance::{self, points_eq, rel_eq, FP_REL, LINEAR};
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
        for bad in [0.0, -1.0, LINEAR * 0.9, LINEAR, f64::NAN, f64::INFINITY, tolerance::MAX_SIZE * 1.1] {
            assert!(make_box(bad, 1.0, 1.0).is_err(), "width {bad} accepted");
            assert!(make_box(1.0, bad, 1.0).is_err(), "depth {bad} accepted");
            assert!(make_box(1.0, 1.0, bad).is_err(), "height {bad} accepted");
        }
        for good in [LINEAR * 1.1, 1.0, tolerance::MAX_SIZE * 0.9, tolerance::MAX_SIZE] {
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
    fn nasty_proportions() {
        check_box(LINEAR * 1.1, LINEAR * 1.1, LINEAR * 1.1); // smallest allowed cube
        check_box(1e-2, 1e-2, 1e5); // needle
        check_box(1e5, 1e5, 1e-2); // sheet
        check_box(1e5, 1e5, 1e5);
        check_box(LINEAR * 1.1, 1e5, 1e5); // thinnest plate at the largest size
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
