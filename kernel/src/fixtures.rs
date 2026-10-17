//! Hand-built bodies for tests. They don't use the modelling operations, so
//! validation and tessellation can be tested against shapes whose
//! correctness is obvious from reading the code.

use crate::fmath;
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

/// Two bodies as one, each its own shell (the second's vertices, edges and
/// faces numbered after the first's). For self-intersection tests: two
/// solids that overlap or touch make one invalid body.
pub fn two_shells(a: &Body, b: &Body) -> Body {
    let mut out = a.clone();
    let (nv, ne, nf) = (a.vertices.len(), a.edges.len(), a.faces.len());
    out.vertices.extend(b.vertices.iter().cloned());
    out.edges.extend(b.edges.iter().cloned().map(|mut e| {
        e.start += nv;
        e.end += nv;
        e
    }));
    out.faces.extend(b.faces.iter().cloned().map(|mut f| {
        for c in f.loops.iter_mut().flat_map(|l| l.coedges.iter_mut()) {
            c.edge += ne;
        }
        f
    }));
    out.shells.extend(b.shells.iter().map(|s| Shell { faces: s.faces.iter().map(|f| f + nf).collect() }));
    out
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
    let x_top = DVec3::new(fmath::cos(twist), fmath::sin(twist), 0.0);
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
    let x_in = DVec3::new(fmath::cos(twist), fmath::sin(twist), 0.0);
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

/// The part of a sphere of radius `r` (centre at the origin) between the
/// planes z = `a` and z = `b`, −r < a < b < r: a band of the sphere and two
/// flat discs. Edges: 0 lower rim, 1 upper rim (both counter-clockwise from
/// above). Faces: 0 band, 1 lower disc, 2 upper disc.
pub fn hand_sphere_slice(r: f64, a: f64, b: f64) -> Body {
    let mut body = Body::default();
    let rim = |z: f64| circle(DVec3::new(0.0, 0.0, z), (r * r - z * z).sqrt());
    let va = body.add_vertex(rim(a).eval(0.0));
    let vb = body.add_vertex(rim(b).eval(0.0));
    let lower = body.add_edge(rim(a), va, va, 0.0, TAU);
    let upper = body.add_edge(rim(b), vb, vb, 0.0, TAU);
    let fwd = |edge| Loop { coedges: vec![Coedge { edge, reversed: false }] };
    let rev = |edge| Loop { coedges: vec![Coedge { edge, reversed: true }] };
    // The band is above the lower rim and below the upper one: running
    // counter-clockwise from above, the lower rim has the band on its left
    // (seen from outside), the upper rim has it on its right, so reversed.
    let sphere = Surface::Sphere { center: DVec3::ZERO, axis: DVec3::Z, x_dir: DVec3::X, radius: r };
    body.add_face(sphere, true, vec![fwd(lower), rev(upper)]);
    let disc = |z: f64, normal| Surface::Plane { origin: DVec3::new(0.0, 0.0, z), normal, x_dir: DVec3::X };
    body.add_face(disc(a, DVec3::NEG_Z), true, vec![rev(lower)]);
    body.add_face(disc(b, DVec3::Z), true, vec![fwd(upper)]);
    body.shells.push(Shell { faces: vec![0, 1, 2] });
    body
}

/// The part of a sphere of radius `r` (centre at the origin) above z = `a`:
/// a cap and a flat disc. Faces: 0 cap, 1 disc.
pub fn hand_sphere_cap(r: f64, a: f64) -> Body {
    let mut body = Body::default();
    let rim = circle(DVec3::new(0.0, 0.0, a), (r * r - a * a).sqrt());
    let v = body.add_vertex(rim.eval(0.0));
    let e = body.add_edge(rim, v, v, 0.0, TAU);
    let sphere = Surface::Sphere { center: DVec3::ZERO, axis: DVec3::Z, x_dir: DVec3::X, radius: r };
    body.add_face(sphere, true, vec![Loop { coedges: vec![Coedge { edge: e, reversed: false }] }]);
    let disc = Surface::Plane { origin: DVec3::new(0.0, 0.0, a), normal: DVec3::NEG_Z, x_dir: DVec3::X };
    body.add_face(disc, true, vec![Loop { coedges: vec![Coedge { edge: e, reversed: true }] }]);
    body.shells.push(Shell { faces: vec![0, 1] });
    body
}

/// One eighth of a ball of radius `r`: x, y, z ≥ 0. Its curved face is a
/// spherical triangle with three corners (A on x, B on y, C on z) joined by
/// quarter circles, and three flat quarter discs meet at the origin.
pub fn hand_sphere_octant(r: f64) -> Body {
    use std::f64::consts::FRAC_PI_2;
    let mut b = Body::default();
    let o = b.add_vertex(DVec3::ZERO);
    let va = b.add_vertex(DVec3::X * r);
    let vb = b.add_vertex(DVec3::Y * r);
    let vc = b.add_vertex(DVec3::Z * r);
    let quarter = |axis, x_dir| Curve::Circle { center: DVec3::ZERO, axis, x_dir, radius: r };
    // A → B about +Z (y_dir = Z × X = Y), B → C about +X (Y then X × Y = Z),
    // C → A about +Y (Z then Y × Z = X): each from t = 0 to π/2.
    let ab = b.add_edge(quarter(DVec3::Z, DVec3::X), va, vb, 0.0, FRAC_PI_2);
    let bc = b.add_edge(quarter(DVec3::X, DVec3::Y), vb, vc, 0.0, FRAC_PI_2);
    let ca = b.add_edge(quarter(DVec3::Y, DVec3::Z), vc, va, 0.0, FRAC_PI_2);
    let oa = b.add_line(o, va);
    let ob = b.add_line(o, vb);
    let oc = b.add_line(o, vc);
    let fwd = |edge| Coedge { edge, reversed: false };
    let rev = |edge| Coedge { edge, reversed: true };
    // Seen from (1,1,1) A → B → C is counter-clockwise: (B − A) × (C − A)
    // = (r², r², r²) points outward.
    let sphere = Surface::Sphere { center: DVec3::ZERO, axis: DVec3::Z, x_dir: DVec3::X, radius: r };
    b.add_face(sphere, true, vec![Loop { coedges: vec![fwd(ab), fwd(bc), fwd(ca)] }]);
    // Each flat face runs its arc backwards, then in to the origin and out.
    let plane = |normal| Surface::Plane { origin: DVec3::ZERO, normal, x_dir: crate::geom::any_perpendicular(normal) };
    b.add_face(plane(DVec3::NEG_Z), true, vec![Loop { coedges: vec![rev(ab), rev(oa), fwd(ob)] }]);
    b.add_face(plane(DVec3::NEG_X), true, vec![Loop { coedges: vec![rev(bc), rev(ob), fwd(oc)] }]);
    b.add_face(plane(DVec3::NEG_Y), true, vec![Loop { coedges: vec![rev(ca), rev(oc), fwd(oa)] }]);
    b.shells.push(Shell { faces: vec![0, 1, 2, 3] });
    b
}
