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
