//! Boundary representation. A `Body` owns flat arenas of vertices, edges and
//! faces; everything refers to everything else by index.
//!
//! Conventions (checked by `validate`):
//! - A face's outward normal is its surface's natural normal, flipped when
//!   `sense` is false.
//! - Each loop runs counter-clockwise seen from outside the solid, so the
//!   face interior is on the left of every coedge (`normal × tangent` points
//!   into the face).
//! - Every edge is used by exactly two coedges, once in each direction.
//! - An edge runs from `start` to `end` along its curve over `t0 < t1`.
//!   Closed edges (full circles) have `start == end`.

use crate::geom::{Curve, Surface, Transform};
use glam::DVec3;

pub type VertexId = usize;
pub type EdgeId = usize;
pub type FaceId = usize;

#[derive(Debug, Clone, PartialEq)]
pub struct Vertex {
    pub point: DVec3,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Edge {
    pub curve: Curve,
    pub start: VertexId,
    pub end: VertexId,
    pub t0: f64,
    pub t1: f64,
}

impl Edge {
    pub fn is_closed(&self) -> bool {
        self.start == self.end
    }

    pub fn length(&self) -> f64 {
        self.curve.length(self.t0, self.t1)
    }

    /// Point at fraction `s` in [0, 1] along the edge.
    pub fn point_at(&self, s: f64) -> DVec3 {
        self.curve.eval(self.t0 + (self.t1 - self.t0) * s)
    }

    /// Unit tangent in the edge's direction at fraction `s`.
    pub fn tangent_at(&self, s: f64) -> DVec3 {
        self.curve.tangent(self.t0 + (self.t1 - self.t0) * s)
    }
}

/// One use of an edge by a loop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Coedge {
    pub edge: EdgeId,
    pub reversed: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Loop {
    pub coedges: Vec<Coedge>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Face {
    pub surface: Surface,
    pub sense: bool,
    /// The first loop is the outer boundary when the face has one.
    pub loops: Vec<Loop>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Shell {
    pub faces: Vec<FaceId>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Body {
    pub vertices: Vec<Vertex>,
    pub edges: Vec<Edge>,
    pub faces: Vec<Face>,
    pub shells: Vec<Shell>,
}

impl Body {
    pub fn add_vertex(&mut self, point: DVec3) -> VertexId {
        self.vertices.push(Vertex { point });
        self.vertices.len() - 1
    }

    /// Straight edge between two existing vertices.
    pub fn add_line(&mut self, start: VertexId, end: VertexId) -> EdgeId {
        let (a, b) = (self.vertices[start].point, self.vertices[end].point);
        let len = a.distance(b);
        let dir = if len > 0.0 { (b - a) / len } else { DVec3::X };
        self.add_edge(Curve::Line { origin: a, dir }, start, end, 0.0, len)
    }

    pub fn add_edge(&mut self, curve: Curve, start: VertexId, end: VertexId, t0: f64, t1: f64) -> EdgeId {
        self.edges.push(Edge { curve, start, end, t0, t1 });
        self.edges.len() - 1
    }

    pub fn add_face(&mut self, surface: Surface, sense: bool, loops: Vec<Loop>) -> FaceId {
        self.faces.push(Face { surface, sense, loops });
        self.faces.len() - 1
    }

    pub fn coedge_start(&self, c: Coedge) -> VertexId {
        let e = &self.edges[c.edge];
        if c.reversed { e.end } else { e.start }
    }

    pub fn coedge_end(&self, c: Coedge) -> VertexId {
        let e = &self.edges[c.edge];
        if c.reversed { e.start } else { e.end }
    }

    /// Outward unit normal of a face at the surface point closest to `p`.
    pub fn face_normal_at(&self, face: FaceId, p: DVec3) -> DVec3 {
        let f = &self.faces[face];
        let n = f.surface.normal_at(p);
        if f.sense { n } else { -n }
    }

    /// Faces adjacent to each edge, in coedge order.
    pub fn edge_faces(&self) -> Vec<Vec<(FaceId, Coedge)>> {
        let mut uses = vec![Vec::new(); self.edges.len()];
        for (fi, f) in self.faces.iter().enumerate() {
            for l in &f.loops {
                for &c in &l.coedges {
                    if let Some(u) = uses.get_mut(c.edge) {
                        u.push((fi, c));
                    }
                }
            }
        }
        uses
    }

    /// Axis-aligned box containing the body: exact for its lines, circles
    /// and arcs; a sphere face is boxed by its whole sphere (exact for a
    /// ball, loose for a lone cap).
    pub fn bounds(&self) -> (DVec3, DVec3) {
        let mut lo = DVec3::INFINITY;
        let mut hi = DVec3::NEG_INFINITY;
        let add = |lo: &mut DVec3, hi: &mut DVec3, p: DVec3, half: DVec3| {
            *lo = lo.min(p - half);
            *hi = hi.max(p + half);
        };
        for v in &self.vertices {
            add(&mut lo, &mut hi, v.point, DVec3::ZERO);
        }
        for e in &self.edges {
            if let Curve::Circle { center, axis, x_dir, radius } = e.curve {
                if e.t1 - e.t0 >= std::f64::consts::TAU - crate::tolerance::ANGULAR {
                    // A circle's extent along a world axis k is
                    // r·√(1 − axis_k²), which for a unit axis equals
                    // r·√(sum of the other two components squared). The
                    // second form keeps its digits when the axis is within
                    // ~1e-8 of k, where 1 − axis_k² rounds to 0.
                    let half = DVec3::new(axis.y.hypot(axis.z), axis.z.hypot(axis.x), axis.x.hypot(axis.y)) * radius;
                    add(&mut lo, &mut hi, center, half);
                    continue;
                }
                // An arc: its ends are vertices, already in. Along axis k
                // the point is c_k + r(x_k cos t + y_k sin t) =
                // c_k + r·A_k cos(t − α_k), A_k = hypot(x_k, y_k) (= the
                // circle's half extent, without cancellation), α_k =
                // atan2(y_k, x_k): the most at t = α_k, the least at α_k + π.
                // Each of those the arc passes through widens the box along
                // axis k only (the point's other coordinates are inside
                // the box already: they lie between the arc's ends' or are
                // covered by another axis's extreme).
                let y_dir = axis.cross(x_dir);
                for k in 0..3 {
                    let (xk, yk) = (x_dir[k], y_dir[k]);
                    let reach = radius * xk.hypot(yk);
                    let peak = yk.atan2(xk);
                    for (t, sign) in [(peak, 1.0), (peak + std::f64::consts::PI, -1.0)] {
                        if (t - e.t0).rem_euclid(std::f64::consts::TAU) <= e.t1 - e.t0 {
                            let extreme = center[k] + sign * reach;
                            lo[k] = lo[k].min(extreme);
                            hi[k] = hi[k].max(extreme);
                        }
                    }
                }
            }
        }
        for f in &self.faces {
            if let Surface::Sphere { center, radius, .. } = f.surface {
                add(&mut lo, &mut hi, center, DVec3::splat(radius));
            }
        }
        (lo, hi)
    }

    pub fn transformed(&self, tf: &Transform) -> Body {
        Body {
            vertices: self.vertices.iter().map(|v| Vertex { point: tf.point(v.point) }).collect(),
            edges: self
                .edges
                .iter()
                .map(|e| Edge {
                    curve: e.curve.transformed(tf),
                    start: e.start,
                    end: e.end,
                    t0: e.curve.transform_param(e.t0, tf),
                    t1: e.curve.transform_param(e.t1, tf),
                })
                .collect(),
            faces: self
                .faces
                .iter()
                .map(|f| Face { surface: f.surface.transformed(tf), sense: f.sense, loops: f.loops.clone() })
                .collect(),
            shells: self.shells.clone(),
        }
    }

    /// Topological counts used by the Euler–Poincaré check.
    pub fn counts(&self, shell: &Shell) -> EulerCounts {
        let mut vs = std::collections::BTreeSet::new();
        let mut es = std::collections::BTreeSet::new();
        let mut loops = 0;
        for &f in &shell.faces {
            for l in &self.faces[f].loops {
                loops += 1;
                for c in &l.coedges {
                    es.insert(c.edge);
                    vs.insert(self.edges[c.edge].start);
                    vs.insert(self.edges[c.edge].end);
                }
            }
        }
        let f = shell.faces.len();
        EulerCounts { v: vs.len(), e: es.len(), f, rings: loops - f.min(loops) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tolerance::{eq, points_eq};
    use std::f64::consts::{FRAC_PI_2, PI};

    fn quarter_arc_edge() -> (Body, EdgeId) {
        // Unit circle about +Z, edge from t = π/2 to t = π: (0,1,0) → (-1,0,0).
        let mut b = Body::default();
        let v0 = b.add_vertex(DVec3::Y);
        let v1 = b.add_vertex(DVec3::NEG_X);
        let c = Curve::Circle { center: DVec3::ZERO, axis: DVec3::Z, x_dir: DVec3::X, radius: 1.0 };
        let e = b.add_edge(c, v0, v1, FRAC_PI_2, PI);
        (b, e)
    }

    #[test]
    fn bounds_of_a_barely_tilted_circle() {
        // Regression (OpenCascade oracle, overnight batch: cylinders of
        // radius 3e4 to 1e7 tilted by ~1e-9 had bounds short by r·θ).
        // A cylinder of radius r = 1e4 turned by θ = 1e-9 about X: each
        // circle's axis is (0, −sin θ, cos θ), so it reaches r·sin θ =
        // 1e4 · 1e-9 = 1e-5 below its centre in z. The bottom circle is
        // centred at the origin, so lo.z = −1e-5. The old formula
        // r·√(1 − cos²θ) rounds cos θ to 1.0 and gives 0.
        let c = crate::ops::primitives::make_cylinder(1e4, 1.0).unwrap();
        let t = crate::ops::transform::rotate(&c, DVec3::ZERO, DVec3::X, 1e-9).unwrap();
        let (lo, _) = t.bounds();
        assert!(eq(lo.z, -1e-5), "lo.z = {:e}", lo.z);
    }

    #[test]
    fn bounds_of_arcs_by_hand() {
        // Half cylinder r = 1, h = 2: its arcs run from (1,0) through
        // (0,1) to (−1,0), so y spans [0, 1], not the full circle's [−1, 1].
        let (lo, hi) = crate::fixtures::hand_half_cylinder(1.0, 2.0).bounds();
        assert!(points_eq(lo, DVec3::new(-1.0, 0.0, 0.0)) && points_eq(hi, DVec3::new(1.0, 1.0, 2.0)), "{lo} {hi}");
        // The same arc tilted: a quarter arc from (0,1,0) to (−1,0,0)
        // about +Z spans x ∈ [−1, 0], y ∈ [0, 1] (its ends; it passes no
        // axis extreme in between).
        let (b, _) = quarter_arc_edge();
        let (lo, hi) = b.bounds();
        assert!(points_eq(lo, DVec3::new(-1.0, 0.0, 0.0)) && points_eq(hi, DVec3::new(0.0, 1.0, 0.0)), "{lo} {hi}");
        // Regression (OpenCascade oracle, step 10: bounds of curved
        // extrusions stretched towards arc centres). A shallow arc far from
        // its centre: about the origin, radius √101, from (1, 10) to
        // (−1, 10) through the top (0, √101). Its box is x ∈ [−1, 1],
        // y ∈ [10, √101]; the centre (0, 0) must not pull y down to 0.
        let mut b = Body::default();
        let r = 101f64.sqrt();
        let v0 = b.add_vertex(DVec3::new(1.0, 10.0, 0.0));
        let v1 = b.add_vertex(DVec3::new(-1.0, 10.0, 0.0));
        let start = 10f64.atan2(1.0);
        let c = Curve::Circle { center: DVec3::ZERO, axis: DVec3::Z, x_dir: DVec3::new(1.0, 10.0, 0.0) / r, radius: r };
        b.add_edge(c, v0, v1, 0.0, PI - 2.0 * start);
        let (lo, hi) = b.bounds();
        assert!(points_eq(lo, DVec3::new(-1.0, 10.0, 0.0)) && points_eq(hi, DVec3::new(1.0, r, 0.0)), "{lo} {hi}");
    }

    #[test]
    fn edge_points_and_tangents_by_hand() {
        let (b, e) = quarter_arc_edge();
        let e = &b.edges[e];
        // Halfway is t = 3π/4: (cos, sin) = (-√½, √½).
        let h = 0.5f64.sqrt();
        assert!(points_eq(e.point_at(0.5), DVec3::new(-h, h, 0.0)));
        assert!(points_eq(e.point_at(0.0), DVec3::Y));
        assert!(points_eq(e.point_at(1.0), DVec3::NEG_X));
        // Counter-clockwise tangent at t = 3π/4 is (-sin, cos) = (-√½, -√½).
        assert!(points_eq(e.tangent_at(0.5), DVec3::new(-h, -h, 0.0)));
        // At the start, t = π/2: (-1, 0, 0).
        assert!(points_eq(e.tangent_at(0.0), DVec3::NEG_X));
        // Length r·Δt = π/2.
        assert!(eq(e.length(), FRAC_PI_2));
        assert!(!e.is_closed());
    }

    #[test]
    fn closed_edge_has_same_start_and_end() {
        let mut b = Body::default();
        let v = b.add_vertex(DVec3::X);
        let c = Curve::Circle { center: DVec3::ZERO, axis: DVec3::Z, x_dir: DVec3::X, radius: 1.0 };
        let e = b.add_edge(c, v, v, 0.0, 2.0 * PI);
        assert!(b.edges[e].is_closed());
    }

    #[test]
    fn ids_are_arena_positions() {
        let mut b = Body::default();
        assert_eq!(b.add_vertex(DVec3::ZERO), 0);
        assert_eq!(b.add_vertex(DVec3::X), 1);
        assert_eq!(b.add_line(0, 1), 0);
        assert_eq!(b.add_line(1, 0), 1);
        let s = Surface::Plane { origin: DVec3::ZERO, normal: DVec3::Z, x_dir: DVec3::X };
        assert_eq!(b.add_face(s.clone(), true, vec![]), 0);
        assert_eq!(b.add_face(s, true, vec![]), 1);
    }

    #[test]
    fn degenerate_line_gets_a_finite_direction() {
        let mut b = Body::default();
        let v = b.add_vertex(DVec3::ONE);
        let w = b.add_vertex(DVec3::ONE);
        let e = b.add_line(v, w);
        let Curve::Line { dir, .. } = b.edges[e].curve else { unreachable!() };
        assert!(dir.is_finite(), "zero-length line produced {dir}");
        assert!(eq(b.edges[e].length(), 0.0));
    }

    #[test]
    fn reversed_face_normal_by_hand() {
        let mut b = Body::default();
        // Cylinder about Z: natural normal at (3, 0, 7) is +X; reversed is -X.
        let s = Surface::Cylinder { origin: DVec3::ZERO, axis: DVec3::Z, x_dir: DVec3::X, radius: 3.0 };
        let f = b.add_face(s.clone(), true, vec![]);
        let g = b.add_face(s, false, vec![]);
        assert!(points_eq(b.face_normal_at(f, DVec3::new(3.0, 0.0, 7.0)), DVec3::X));
        assert!(points_eq(b.face_normal_at(g, DVec3::new(3.0, 0.0, 7.0)), DVec3::NEG_X));
    }

    #[test]
    fn bounds_by_hand() {
        // Unit circle about Z centred at (5, 0, 2): x ∈ [4, 6], y ∈ [-1, 1], z = 2.
        let mut b = Body::default();
        let v = b.add_vertex(DVec3::new(6.0, 0.0, 2.0));
        let c = Curve::Circle { center: DVec3::new(5.0, 0.0, 2.0), axis: DVec3::Z, x_dir: DVec3::X, radius: 1.0 };
        b.add_edge(c, v, v, 0.0, 2.0 * PI);
        let (lo, hi) = b.bounds();
        assert!(points_eq(lo, DVec3::new(4.0, -1.0, 2.0)));
        assert!(points_eq(hi, DVec3::new(6.0, 1.0, 2.0)));
        // Tilt the axis to (0, √½, √½): extents r·√(1 − a²) = (1, √½, √½).
        let h = 0.5f64.sqrt();
        b.edges[0].curve = Curve::Circle { center: DVec3::ZERO, axis: DVec3::new(0.0, h, h), x_dir: DVec3::X, radius: 1.0 };
        b.vertices[0].point = DVec3::X;
        let (lo, hi) = b.bounds();
        assert!(points_eq(lo, DVec3::new(-1.0, -h, -h)));
        assert!(points_eq(hi, DVec3::new(1.0, h, h)));
    }

    #[test]
    fn transformed_body_by_hand() {
        let (b, e) = quarter_arc_edge();
        // Scale by 2 then move up 5: (0,1,0) → (0,2,5); the arc keeps its
        // angle range and doubles its radius, so its length is 2·π/2 = π.
        let tf = Transform::uniform_scale(2.0).then(Transform::translation(DVec3::new(0.0, 0.0, 5.0)));
        let moved = b.transformed(&tf);
        assert!(points_eq(moved.vertices[0].point, DVec3::new(0.0, 2.0, 5.0)));
        assert!(points_eq(moved.edges[e].point_at(1.0), DVec3::new(-2.0, 0.0, 5.0)));
        assert!(eq(moved.edges[e].length(), PI));
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EulerCounts {
    pub v: usize,
    pub e: usize,
    pub f: usize,
    /// Loops beyond the first on each face (holes).
    pub rings: usize,
}

impl EulerCounts {
    /// V − E + F − R, which must equal 2(1 − genus) for one closed shell.
    pub fn characteristic(&self) -> i64 {
        self.v as i64 - self.e as i64 + self.f as i64 - self.rings as i64
    }

    /// Genus implied by Euler–Poincaré, or `None` if it is not a whole,
    /// non-negative number (which means the topology is broken).
    pub fn genus(&self) -> Option<i64> {
        let chi = self.characteristic();
        if chi > 2 || (2 - chi) % 2 != 0 { None } else { Some((2 - chi) / 2) }
    }
}
