//! Hand-built bodies for tests. They don't use the modelling operations, so
//! validation and tessellation can be tested against shapes whose
//! correctness is obvious from reading the code.

use crate::geom::{Curve, Surface};
use crate::topology::{Body, Coedge, Loop, Shell};
use glam::DVec3;
use std::f64::consts::TAU;

/// Unit cube from (0,0,0) to (1,1,1).
pub fn hand_cube() -> Body {
    let mut b = Body::default();
    let mut v = [0; 8];
    for (i, slot) in v.iter_mut().enumerate() {
        let p = DVec3::new((i & 1) as f64, ((i >> 1) & 1) as f64, ((i >> 2) & 1) as f64);
        *slot = b.add_vertex(p);
    }
    let mut edge = std::collections::HashMap::new();
    // Each face as vertex indices, counter-clockwise seen from outside.
    let faces: [([usize; 4], DVec3); 6] = [
        ([0, 2, 3, 1], -DVec3::Z),
        ([4, 5, 7, 6], DVec3::Z),
        ([0, 1, 5, 4], -DVec3::Y),
        ([2, 6, 7, 3], DVec3::Y),
        ([0, 4, 6, 2], -DVec3::X),
        ([1, 3, 7, 5], DVec3::X),
    ];
    for (quad, normal) in faces {
        let mut coedges = Vec::new();
        for i in 0..4 {
            let (a, c) = (v[quad[i]], v[quad[(i + 1) % 4]]);
            let key = (a.min(c), a.max(c));
            let id = *edge.entry(key).or_insert_with(|| b.add_line(key.0, key.1));
            coedges.push(Coedge { edge: id, reversed: a != key.0 });
        }
        let origin = b.vertices[v[quad[0]]].point;
        let x_dir = crate::geom::any_perpendicular(normal);
        b.add_face(Surface::Plane { origin, normal, x_dir }, true, vec![Loop { coedges }]);
    }
    b.shells.push(Shell { faces: (0..6).collect() });
    b
}

fn circle(center: DVec3, radius: f64) -> Curve {
    Curve::Circle { center, axis: DVec3::Z, x_dir: DVec3::X, radius }
}

/// Cylinder of radius `r` and height `h` standing on the origin: two
/// seamless circular edges, two caps and one side face with two loops.
pub fn hand_cylinder(r: f64, h: f64) -> Body {
    let mut b = Body::default();
    let top_c = DVec3::new(0.0, 0.0, h);
    let v0 = b.add_vertex(DVec3::new(r, 0.0, 0.0));
    let v1 = b.add_vertex(DVec3::new(r, 0.0, h));
    let e0 = b.add_edge(circle(DVec3::ZERO, r), v0, v0, 0.0, TAU);
    let e1 = b.add_edge(circle(top_c, r), v1, v1, 0.0, TAU);
    let fwd = |edge| Coedge { edge, reversed: false };
    let rev = |edge| Coedge { edge, reversed: true };
    b.add_face(
        Surface::Plane { origin: DVec3::ZERO, normal: -DVec3::Z, x_dir: DVec3::X },
        true,
        vec![Loop { coedges: vec![rev(e0)] }],
    );
    b.add_face(
        Surface::Plane { origin: top_c, normal: DVec3::Z, x_dir: DVec3::X },
        true,
        vec![Loop { coedges: vec![fwd(e1)] }],
    );
    b.add_face(
        Surface::Cylinder { origin: DVec3::ZERO, axis: DVec3::Z, x_dir: DVec3::X, radius: r },
        true,
        vec![Loop { coedges: vec![fwd(e0)] }, Loop { coedges: vec![rev(e1)] }],
    );
    b.shells.push(Shell { faces: vec![0, 1, 2] });
    b
}

/// Sphere of radius `r` at the origin: two hemispheres sharing an equator edge.
pub fn hand_sphere(r: f64) -> Body {
    let mut b = Body::default();
    let v = b.add_vertex(DVec3::new(r, 0.0, 0.0));
    let e = b.add_edge(circle(DVec3::ZERO, r), v, v, 0.0, TAU);
    let s = Surface::Sphere { center: DVec3::ZERO, axis: DVec3::Z, x_dir: DVec3::X, radius: r };
    b.add_face(s.clone(), true, vec![Loop { coedges: vec![Coedge { edge: e, reversed: false }] }]);
    b.add_face(s, true, vec![Loop { coedges: vec![Coedge { edge: e, reversed: true }] }]);
    b.shells.push(Shell { faces: vec![0, 1] });
    b
}
