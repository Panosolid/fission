//! Turns a B-rep body into a watertight triangle mesh.
//!
//! Every B-rep edge is discretised exactly once and both faces that use it
//! reuse those same mesh vertices, so the mesh is watertight by construction.
//! Faces are triangulated in their surface's (u, v) parameter space with a
//! constrained Delaunay triangulation, keeping the triangles inside the
//! face's loops.

use crate::geom::{Curve, Surface};
use crate::mesh::Mesh;
use crate::tolerance;
use crate::topology::{Body, FaceId};
use glam::DVec2;
use spade::{ConstrainedDelaunayTriangulation, Point2, Triangulation};

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TessOptions {
    /// Maximum distance between a curve and its chords (mm).
    pub chord: f64,
    /// Maximum angle turned per segment (radians).
    pub max_angle: f64,
    /// Every curved segment count is multiplied by this. Doubling it halves
    /// the step everywhere, which mass properties use for extrapolation.
    pub refine: u32,
}

impl TessOptions {
    pub const DISPLAY: TessOptions =
        TessOptions { chord: tolerance::DISPLAY_CHORD, max_angle: tolerance::DISPLAY_ANGLE, refine: 1 };
}

#[derive(Debug, Clone, PartialEq)]
pub struct TessError {
    pub face: FaceId,
    pub message: String,
}

pub fn tessellate(body: &Body, opts: &TessOptions) -> Result<Mesh, TessError> {
    let mut mesh = Mesh { positions: body.vertices.iter().map(|v| v.point).collect(), ..Mesh::default() };
    for e in &body.edges {
        let n = segments(&e.curve, e.t1 - e.t0, opts);
        let mut poly = vec![e.start as u32];
        for k in 1..n {
            mesh.positions.push(e.point_at(k as f64 / n as f64));
            poly.push((mesh.positions.len() - 1) as u32);
        }
        poly.push(e.end as u32);
        mesh.edge_polylines.push(poly);
    }
    for (fi, _) in body.faces.iter().enumerate() {
        tessellate_face(body, fi, &mut mesh).map_err(|message| TessError { face: fi, message })?;
    }
    Ok(mesh)
}

/// Number of chords used for a curve span.
fn segments(curve: &Curve, span: f64, opts: &TessOptions) -> usize {
    match *curve {
        Curve::Line { .. } => 1,
        Curve::Circle { radius, .. } => {
            let angle = span.abs();
            let by_angle = (angle / opts.max_angle).ceil();
            let chord_angle = if opts.chord < radius { 2.0 * (1.0 - opts.chord / radius).acos() } else { angle };
            let by_chord = (angle / chord_angle).ceil();
            (by_angle.max(by_chord).max(1.0) as usize) * opts.refine as usize
        }
    }
}

/// The mesh vertices around one loop, in loop order, without repeating the start.
fn loop_vertices(body: &Body, mesh: &Mesh, face: FaceId, loop_index: usize) -> Vec<u32> {
    let mut out = Vec::new();
    for c in &body.faces[face].loops[loop_index].coedges {
        let poly = &mesh.edge_polylines[c.edge];
        if c.reversed {
            out.extend(poly.iter().rev().skip(1));
        } else {
            out.extend(poly.iter().skip(1));
        }
    }
    out
}

fn tessellate_face(body: &Body, fi: FaceId, mesh: &mut Mesh) -> Result<(), String> {
    let face = &body.faces[fi];
    match face.surface {
        Surface::Plane { .. } => {
            let loops: Vec<Vec<u32>> = (0..face.loops.len()).map(|li| loop_vertices(body, mesh, fi, li)).collect();
            let uv: Vec<Vec<DVec2>> = loops
                .iter()
                .map(|l| l.iter().map(|&i| face.surface.project(mesh.positions[i as usize])).collect())
                .collect();
            let tris = triangulate_uv(&loops, &uv)?;
            push_triangles(mesh, fi, tris, face.sense);
            Ok(())
        }
        _ => Err("curved faces are not tessellated yet".into()),
    }
}

/// Adds triangles that are counter-clockwise in uv; uv runs counter-clockwise
/// around the natural normal, so flip them when the face is reversed.
fn push_triangles(mesh: &mut Mesh, face: FaceId, tris: Vec<[u32; 3]>, sense: bool) {
    for [a, b, c] in tris {
        mesh.triangles.push(if sense { [a, b, c] } else { [a, c, b] });
        mesh.triangle_face.push(face);
    }
}

/// Constrained Delaunay triangulation of the region bounded by `loops`
/// (mesh vertex ids with matching uv points). Returns counter-clockwise
/// triangles inside the region (even-odd rule).
pub(crate) fn triangulate_uv(loops: &[Vec<u32>], uv: &[Vec<DVec2>]) -> Result<Vec<[u32; 3]>, String> {
    let mut cdt: ConstrainedDelaunayTriangulation<Point2<f64>> = ConstrainedDelaunayTriangulation::new();
    let mut handle_to_mesh: Vec<u32> = Vec::new();
    let mut handles = Vec::new();
    for (l, pts) in loops.iter().zip(uv) {
        let mut hs = Vec::new();
        for (&id, p) in l.iter().zip(pts) {
            let snap = |x: f64| if x.abs() < tolerance::SNAP_TO_ZERO { 0.0 } else { x };
            let h = cdt.insert(Point2::new(snap(p.x), snap(p.y))).map_err(|e| format!("{e:?}"))?;
            if h.index() == handle_to_mesh.len() {
                handle_to_mesh.push(id);
            } else if handle_to_mesh[h.index()] != id {
                return Err("two boundary points have the same uv position".into());
            }
            hs.push(h);
        }
        handles.push(hs);
    }
    for hs in &handles {
        for i in 0..hs.len() {
            let (a, b) = (hs[i], hs[(i + 1) % hs.len()]);
            if a == b {
                continue;
            }
            if !cdt.can_add_constraint(a, b) {
                return Err("face boundary crosses itself".into());
            }
            cdt.add_constraint(a, b);
        }
    }
    let mut out = Vec::new();
    for f in cdt.inner_faces() {
        let [a, b, c] = f.vertices();
        let pa = a.position();
        let pb = b.position();
        let pc = c.position();
        let centroid = DVec2::new((pa.x + pb.x + pc.x) / 3.0, (pa.y + pb.y + pc.y) / 3.0);
        if inside(centroid, uv) {
            out.push([a, b, c].map(|v| handle_to_mesh[v.fix().index()]));
        }
    }
    Ok(out)
}

/// Even-odd point-in-region test against all loops.
fn inside(p: DVec2, loops: &[Vec<DVec2>]) -> bool {
    let mut crossings = 0;
    for l in loops {
        for i in 0..l.len() {
            let (a, b) = (l[i], l[(i + 1) % l.len()]);
            if (a.y > p.y) != (b.y > p.y) {
                let x = a.x + (p.y - a.y) / (b.y - a.y) * (b.x - a.x);
                if x > p.x {
                    crossings += 1;
                }
            }
        }
    }
    crossings % 2 == 1
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tolerance::eq;
    use crate::validate::tests::hand_cube;

    fn region(loops: &[Vec<(f64, f64)>]) -> (Vec<Vec<u32>>, Vec<Vec<DVec2>>) {
        let mut next = 0;
        let mut ids = Vec::new();
        let mut uv = Vec::new();
        for l in loops {
            ids.push(l.iter().map(|_| { next += 1; next - 1 }).collect());
            uv.push(l.iter().map(|&(x, y)| DVec2::new(x, y)).collect());
        }
        (ids, uv)
    }

    fn area(tris: &[[u32; 3]], uv: &[Vec<DVec2>]) -> f64 {
        let flat: Vec<DVec2> = uv.iter().flatten().copied().collect();
        tris.iter()
            .map(|t| {
                let [a, b, c] = t.map(|i| flat[i as usize]);
                (b - a).perp_dot(c - a) / 2.0
            })
            .sum()
    }

    #[test]
    fn concave_l_shape() {
        let (ids, uv) = region(&[vec![(0.0, 0.0), (2.0, 0.0), (2.0, 1.0), (1.0, 1.0), (1.0, 2.0), (0.0, 2.0)]]);
        let tris = triangulate_uv(&ids, &uv).unwrap();
        assert_eq!(tris.len(), 4);
        // Every triangle counter-clockwise, so the signed sum is the true area.
        assert!(eq(area(&tris, &uv), 3.0));
    }

    #[test]
    fn square_with_square_hole() {
        let outer = vec![(0.0, 0.0), (4.0, 0.0), (4.0, 4.0), (0.0, 4.0)];
        let hole = vec![(1.0, 1.0), (1.0, 3.0), (3.0, 3.0), (3.0, 1.0)];
        let (ids, uv) = region(&[outer, hole]);
        let tris = triangulate_uv(&ids, &uv).unwrap();
        assert!(eq(area(&tris, &uv), 12.0));
    }

    #[test]
    fn self_crossing_boundary_is_an_error() {
        let (ids, uv) = region(&[vec![(0.0, 0.0), (2.0, 2.0), (2.0, 0.0), (0.0, 2.0)]]);
        assert!(triangulate_uv(&ids, &uv).is_err());
    }

    #[test]
    fn cube_mesh_is_closed_with_unit_volume() {
        let m = tessellate(&hand_cube(), &TessOptions::DISPLAY).unwrap();
        assert_eq!(m.triangles.len(), 12);
        assert_eq!(m.check_closed(), Ok(()));
        assert!(eq(m.signed_volume(), 1.0));
        assert!(eq(m.area(), 6.0));
    }

    #[test]
    fn tessellation_is_deterministic() {
        let a = tessellate(&hand_cube(), &TessOptions::DISPLAY).unwrap();
        let b = tessellate(&hand_cube(), &TessOptions::DISPLAY).unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn circle_segment_counts_respect_both_limits() {
        let c = Curve::Circle { center: Default::default(), axis: glam::DVec3::Z, x_dir: glam::DVec3::X, radius: 1000.0 };
        let opts = TessOptions::DISPLAY;
        let n = segments(&c, std::f64::consts::TAU, &opts);
        // Chord height of each segment within the limit.
        let sag = 1000.0 * (1.0 - (std::f64::consts::PI / n as f64).cos());
        assert!(sag <= opts.chord);
        let small = Curve::Circle { center: Default::default(), axis: glam::DVec3::Z, x_dir: glam::DVec3::X, radius: 1e-3 };
        assert!(segments(&small, std::f64::consts::TAU, &opts) as f64 >= std::f64::consts::TAU / opts.max_angle);
        let twice = TessOptions { refine: 2, ..opts };
        assert_eq!(segments(&c, 1.0, &twice), 2 * segments(&c, 1.0, &opts));
    }
}
