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

/// Cylinder whose top circle starts at angle `twist` instead of 0, so the
/// top and bottom vertices don't line up. Exercises the seam bridging in
/// cylinder tessellation with a non-zero offset.
pub fn hand_twisted_cylinder(r: f64, h: f64, twist: f64) -> Body {
    let mut b = hand_cylinder(r, h);
    let x_top = DVec3::new(twist.cos(), twist.sin(), 0.0);
    b.vertices[1].point = DVec3::new(0.0, 0.0, h) + x_top * r;
    b.edges[1].curve = Curve::Circle { center: DVec3::new(0.0, 0.0, h), axis: DVec3::Z, x_dir: x_top, radius: r };
    b
}

/// Half cylinder (a "D"): the half disc y ≥ 0 of radius `r`, extruded by `h`.
/// Its curved face is a partial cylinder patch bounded by two arcs and two
/// lines. Volume πr²h/2.
pub fn hand_half_cylinder(r: f64, h: f64) -> Body {
    use std::f64::consts::PI;
    let mut b = Body::default();
    let top = DVec3::new(0.0, 0.0, h);
    let v0 = b.add_vertex(DVec3::new(r, 0.0, 0.0));
    let v1 = b.add_vertex(DVec3::new(-r, 0.0, 0.0));
    let v2 = b.add_vertex(DVec3::new(r, 0.0, h));
    let v3 = b.add_vertex(DVec3::new(-r, 0.0, h));
    let e0 = b.add_edge(circle(DVec3::ZERO, r), v0, v1, 0.0, PI); // bottom arc through +Y
    let e1 = b.add_line(v1, v0); // bottom straight edge
    let e2 = b.add_edge(circle(top, r), v2, v3, 0.0, PI); // top arc
    let e3 = b.add_line(v3, v2); // top straight edge
    let e4 = b.add_line(v0, v2); // vertical at +X
    let e5 = b.add_line(v1, v3); // vertical at -X
    let fwd = |edge| Coedge { edge, reversed: false };
    let rev = |edge| Coedge { edge, reversed: true };
    let plane = |origin, normal| Surface::Plane { origin, normal, x_dir: DVec3::X };
    // Bottom, seen from below: straight edge +X → -X... i.e. e1 reversed, then the arc back.
    b.add_face(plane(DVec3::ZERO, DVec3::NEG_Z), true, vec![Loop { coedges: vec![rev(e1), rev(e0)] }]);
    b.add_face(plane(top, DVec3::Z), true, vec![Loop { coedges: vec![fwd(e2), fwd(e3)] }]);
    // Flat side y = 0, seen from -Y: +X is to the right.
    b.add_face(plane(DVec3::ZERO, DVec3::NEG_Y), true, vec![Loop { coedges: vec![fwd(e1), fwd(e4), rev(e3), rev(e5)] }]);
    // Curved side seen from outside: the bottom arc runs to the right.
    b.add_face(
        Surface::Cylinder { origin: DVec3::ZERO, axis: DVec3::Z, x_dir: DVec3::X, radius: r },
        true,
        vec![Loop { coedges: vec![fwd(e0), fwd(e5), rev(e2), rev(e4)] }],
    );
    b.shells.push(Shell { faces: vec![0, 1, 2, 3] });
    b
}

/// Tube (a cylinder with a coaxial round hole) from z = 0 to `h`, radii
/// `r_in` < `r_out`. The inner circles start `twist` radians round from the
/// outer ones, so their mesh points don't line up. Edges: 0 outer bottom,
/// 1 outer top, 2 inner bottom, 3 inner top.
pub fn hand_tube(r_in: f64, r_out: f64, h: f64, twist: f64) -> Body {
    let mut b = Body::default();
    let top = DVec3::new(0.0, 0.0, h);
    let x_in = DVec3::new(twist.cos(), twist.sin(), 0.0);
    let ring = |center, x_dir, radius| Curve::Circle { center, axis: DVec3::Z, x_dir, radius };
    let vo0 = b.add_vertex(DVec3::X * r_out);
    let vo1 = b.add_vertex(top + DVec3::X * r_out);
    let vi0 = b.add_vertex(x_in * r_in);
    let vi1 = b.add_vertex(top + x_in * r_in);
    let ob = b.add_edge(ring(DVec3::ZERO, DVec3::X, r_out), vo0, vo0, 0.0, TAU);
    let ot = b.add_edge(ring(top, DVec3::X, r_out), vo1, vo1, 0.0, TAU);
    let ib = b.add_edge(ring(DVec3::ZERO, x_in, r_in), vi0, vi0, 0.0, TAU);
    let it = b.add_edge(ring(top, x_in, r_in), vi1, vi1, 0.0, TAU);
    let fwd = |edge| Loop { coedges: vec![Coedge { edge, reversed: false }] };
    let rev = |edge| Loop { coedges: vec![Coedge { edge, reversed: true }] };
    // Seen from below, the outer circle runs clockwise-from-above (reversed)
    // and the hole the other way; from above, the opposite.
    b.add_face(Surface::Plane { origin: DVec3::ZERO, normal: -DVec3::Z, x_dir: DVec3::X }, true, vec![rev(ob), fwd(ib)]);
    b.add_face(Surface::Plane { origin: top, normal: DVec3::Z, x_dir: DVec3::X }, true, vec![fwd(ot), rev(it)]);
    let wall = |x_dir, radius| Surface::Cylinder { origin: DVec3::ZERO, axis: DVec3::Z, x_dir, radius };
    b.add_face(wall(DVec3::X, r_out), true, vec![fwd(ob), rev(ot)]);
    // The bore faces the axis: sense false, loops the other way round.
    b.add_face(wall(x_in, r_in), false, vec![rev(ib), fwd(it)]);
    b.shells.push(Shell { faces: vec![0, 1, 2, 3] });
    b
}
