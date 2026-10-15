//! `validate` checks that a body is a well-formed closed solid. Every kernel
//! operation must finish with `checked`, which runs it.

use crate::geom::{Curve, Surface};
use crate::tessellate::{tessellate, TessOptions};
use crate::tolerance;
use crate::topology::{Body, EdgeId, Face, FaceId, Loop};
use glam::DVec3;
use std::fmt;

#[derive(Debug, Clone, PartialEq)]
pub enum ValidationError {
    /// An index points outside its arena.
    DanglingReference { face: FaceId, what: String },
    EmptyLoop { face: FaceId, loop_index: usize },
    /// Consecutive coedges in a loop don't share a vertex.
    LoopNotClosed { face: FaceId, loop_index: usize, position: usize },
    /// Watertight: each edge must be used by exactly two coedges.
    EdgeUseCount { edge: EdgeId, uses: usize },
    /// Consistent orientation: the two uses of an edge must run in opposite directions.
    EdgeSameDirection { edge: EdgeId },
    /// A face appears in no shell, or in more than one.
    FaceShellCount { face: FaceId, shells: usize },
    /// Faces of one shell don't form one edge-connected piece.
    ShellNotConnected { shell: usize },
    /// V − E + F − R doesn't give a whole, non-negative genus.
    EulerPoincare { shell: usize, v: usize, e: usize, f: usize, rings: usize },
    /// An edge's curve doesn't pass through its end vertex.
    VertexOffEdge { edge: EdgeId, vertex: usize, distance: f64 },
    /// A point of an edge is not on the surface of a face that uses it.
    EdgeOffFace { edge: EdgeId, face: FaceId, distance: f64 },
    ZeroLengthEdge { edge: EdgeId },
    ZeroAreaFace { face: FaceId },
    /// A planar face's outer loop runs clockwise seen from outside, i.e.
    /// the face normal disagrees with its boundary.
    FaceOrientation { face: FaceId },
    Tessellation { face: FaceId, message: String },
    /// The display mesh has holes or flipped triangles.
    MeshNotClosed { problems: usize },
    /// A shell encloses negative volume: its normals point inward.
    InsideOut { shell: usize, volume: f64 },
}

impl fmt::Display for ValidationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        use ValidationError::*;
        match self {
            DanglingReference { face, what } => write!(f, "face {face}: dangling reference to {what}"),
            EmptyLoop { face, loop_index } => write!(f, "face {face}: loop {loop_index} is empty"),
            LoopNotClosed { face, loop_index, position } => {
                write!(f, "face {face}: loop {loop_index} is broken after coedge {position}")
            }
            EdgeUseCount { edge, uses } => write!(f, "edge {edge} is used {uses} times (must be 2)"),
            EdgeSameDirection { edge } => write!(f, "edge {edge} is used twice in the same direction"),
            FaceShellCount { face, shells } => write!(f, "face {face} is in {shells} shells (must be 1)"),
            ShellNotConnected { shell } => write!(f, "shell {shell} is not connected"),
            EulerPoincare { shell, v, e, f: faces, rings } => write!(
                f,
                "shell {shell} breaks Euler–Poincaré: V={v} E={e} F={faces} R={rings}"
            ),
            VertexOffEdge { edge, vertex, distance } => {
                write!(f, "vertex {vertex} is {distance:e} mm off edge {edge}")
            }
            EdgeOffFace { edge, face, distance } => write!(f, "edge {edge} is {distance:e} mm off face {face}"),
            ZeroLengthEdge { edge } => write!(f, "edge {edge} has zero length"),
            ZeroAreaFace { face } => write!(f, "face {face} has zero area"),
            FaceOrientation { face } => write!(f, "face {face}: normal disagrees with its boundary loop"),
            Tessellation { face, message } => write!(f, "face {face} could not be tessellated: {message}"),
            MeshNotClosed { problems } => write!(f, "mesh has {problems} open or flipped edges"),
            InsideOut { shell, volume } => write!(f, "shell {shell} encloses {volume:e} mm³ (normals point inward)"),
        }
    }
}

/// Runs every check and returns all problems found.
pub fn validate(body: &Body) -> Result<(), Vec<ValidationError>> {
    let mut errs = Vec::new();
    check_references(body, &mut errs);
    if !errs.is_empty() {
        // Later checks index freely; stop before they could panic.
        return Err(errs);
    }
    check_loops(body, &mut errs);
    check_edge_uses(body, &mut errs);
    check_shells(body, &mut errs);
    check_geometry(body, &mut errs);
    if errs.is_empty() {
        // The mesh checks assume sound topology, so they run last.
        check_mesh(body, &mut errs);
    }
    if errs.is_empty() { Ok(()) } else { Err(errs) }
}

/// Validates the result of a kernel operation. In debug and test builds an
/// invalid body is a bug, so this panics; in release it returns the errors.
pub fn checked(body: Body) -> Result<Body, Vec<ValidationError>> {
    match validate(&body) {
        Ok(()) => Ok(body),
        Err(errs) => {
            if cfg!(debug_assertions) {
                let list: Vec<String> = errs.iter().map(|e| e.to_string()).collect();
                panic!("kernel produced an invalid body:\n  {}", list.join("\n  "));
            }
            Err(errs)
        }
    }
}

fn check_references(body: &Body, errs: &mut Vec<ValidationError>) {
    let nv = body.vertices.len();
    for (ei, e) in body.edges.iter().enumerate() {
        if e.start >= nv || e.end >= nv {
            errs.push(ValidationError::DanglingReference { face: usize::MAX, what: format!("vertex from edge {ei}") });
        }
    }
    for (fi, f) in body.faces.iter().enumerate() {
        for l in &f.loops {
            for c in &l.coedges {
                if c.edge >= body.edges.len() {
                    errs.push(ValidationError::DanglingReference { face: fi, what: format!("edge {}", c.edge) });
                }
            }
        }
    }
    for s in &body.shells {
        for &f in &s.faces {
            if f >= body.faces.len() {
                errs.push(ValidationError::DanglingReference { face: f, what: "face from shell".into() });
            }
        }
    }
}

fn check_loops(body: &Body, errs: &mut Vec<ValidationError>) {
    for (fi, f) in body.faces.iter().enumerate() {
        for (li, l) in f.loops.iter().enumerate() {
            if l.coedges.is_empty() {
                errs.push(ValidationError::EmptyLoop { face: fi, loop_index: li });
                continue;
            }
            let n = l.coedges.len();
            for i in 0..n {
                let a = l.coedges[i];
                let b = l.coedges[(i + 1) % n];
                if body.coedge_end(a) != body.coedge_start(b) {
                    errs.push(ValidationError::LoopNotClosed { face: fi, loop_index: li, position: i });
                }
            }
        }
    }
}

fn check_edge_uses(body: &Body, errs: &mut Vec<ValidationError>) {
    for (ei, uses) in body.edge_faces().iter().enumerate() {
        if uses.len() != 2 {
            errs.push(ValidationError::EdgeUseCount { edge: ei, uses: uses.len() });
        } else if uses[0].1.reversed == uses[1].1.reversed {
            errs.push(ValidationError::EdgeSameDirection { edge: ei });
        }
    }
}

fn check_shells(body: &Body, errs: &mut Vec<ValidationError>) {
    let mut shell_count = vec![0usize; body.faces.len()];
    for s in &body.shells {
        for &f in &s.faces {
            shell_count[f] += 1;
        }
    }
    for (fi, &n) in shell_count.iter().enumerate() {
        if n != 1 {
            errs.push(ValidationError::FaceShellCount { face: fi, shells: n });
        }
    }

    let edge_faces = body.edge_faces();
    for (si, s) in body.shells.iter().enumerate() {
        if !is_connected(body, &s.faces, &edge_faces) {
            errs.push(ValidationError::ShellNotConnected { shell: si });
        }
        let c = body.counts(s);
        if c.genus().is_none() {
            errs.push(ValidationError::EulerPoincare { shell: si, v: c.v, e: c.e, f: c.f, rings: c.rings });
        }
    }
}

/// Fractions along each edge sampled by the geometric checks.
const EDGE_SAMPLES: [f64; 5] = [0.0, 0.25, 0.5, 0.75, 1.0];

fn check_geometry(body: &Body, errs: &mut Vec<ValidationError>) {
    for (ei, e) in body.edges.iter().enumerate() {
        if e.length() <= tolerance::LINEAR {
            errs.push(ValidationError::ZeroLengthEdge { edge: ei });
        }
        for (vertex, t) in [(e.start, e.t0), (e.end, e.t1)] {
            let distance = e.curve.eval(t).distance(body.vertices[vertex].point);
            if distance > tolerance::LINEAR {
                errs.push(ValidationError::VertexOffEdge { edge: ei, vertex, distance });
            }
        }
    }
    for (ei, uses) in body.edge_faces().iter().enumerate() {
        let e = &body.edges[ei];
        for &(fi, _) in uses {
            let surface = &body.faces[fi].surface;
            let distance = EDGE_SAMPLES.iter().map(|&s| surface.distance(e.point_at(s))).fold(0.0, f64::max);
            if distance > tolerance::LINEAR {
                errs.push(ValidationError::EdgeOffFace { edge: ei, face: fi, distance });
            }
        }
    }
    for (fi, f) in body.faces.iter().enumerate() {
        if let Surface::Plane { .. } = f.surface {
            let areas: Vec<f64> = f.loops.iter().map(|l| planar_loop_area(body, f, l)).collect();
            let net: f64 = areas.iter().sum();
            if net.abs() <= tolerance::AREA {
                errs.push(ValidationError::ZeroAreaFace { face: fi });
            } else if areas.first().is_some_and(|&a| a < 0.0) {
                errs.push(ValidationError::FaceOrientation { face: fi });
            }
        }
    }
}

fn check_mesh(body: &Body, errs: &mut Vec<ValidationError>) {
    let mesh = match tessellate(body, &TessOptions::DISPLAY) {
        Ok(m) => m,
        Err(e) => {
            errs.push(ValidationError::Tessellation { face: e.face, message: e.message });
            return;
        }
    };
    if let Err(problems) = mesh.check_closed() {
        errs.push(ValidationError::MeshNotClosed { problems: problems.len() });
    }
    for (si, s) in body.shells.iter().enumerate() {
        let volume: f64 = (0..mesh.triangles.len())
            .filter(|&t| s.faces.contains(&mesh.triangle_face[t]))
            .map(|t| {
                let [a, b, c] = mesh.triangle(t);
                a.dot(b.cross(c)) / 6.0
            })
            .sum();
        if volume <= 0.0 {
            errs.push(ValidationError::InsideOut { shell: si, volume });
        }
    }
}

/// Signed area of a loop on a planar face, positive when it runs
/// counter-clockwise around the face's outward normal. Curved edges are
/// sampled, which is plenty to tell zero from non-zero and to get the sign.
fn planar_loop_area(body: &Body, face: &Face, l: &Loop) -> f64 {
    let Surface::Plane { normal, .. } = face.surface else { return 0.0 };
    let n = if face.sense { normal } else { -normal };
    let mut pts = Vec::new();
    for c in &l.coedges {
        let e = &body.edges[c.edge];
        let samples = if matches!(e.curve, Curve::Line { .. }) { 1 } else { 32 };
        for k in 0..samples {
            let s = k as f64 / samples as f64;
            pts.push(e.point_at(if c.reversed { 1.0 - s } else { s }));
        }
    }
    let origin = pts.first().copied().unwrap_or_default();
    let mut twice = DVec3::ZERO;
    for i in 0..pts.len() {
        twice += (pts[i] - origin).cross(pts[(i + 1) % pts.len()] - origin);
    }
    twice.dot(n) / 2.0
}

fn is_connected(body: &Body, faces: &[FaceId], edge_faces: &[Vec<(FaceId, crate::topology::Coedge)>]) -> bool {
    let Some(&first) = faces.first() else { return false };
    let in_shell: std::collections::HashSet<FaceId> = faces.iter().copied().collect();
    let mut seen = std::collections::HashSet::from([first]);
    let mut stack = vec![first];
    while let Some(f) = stack.pop() {
        for l in &body.faces[f].loops {
            for c in &l.coedges {
                for &(g, _) in &edge_faces[c.edge] {
                    if in_shell.contains(&g) && seen.insert(g) {
                        stack.push(g);
                    }
                }
            }
        }
    }
    seen.len() == in_shell.len()
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::geom::Surface;
    use crate::topology::{Coedge, Loop, Shell};
    use glam::DVec3;

    /// A hand-built unit cube, independent of the primitives module, so
    /// validate is tested against something whose correctness is obvious.
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

    #[test]
    fn cube_is_valid_with_genus_zero() {
        let b = hand_cube();
        assert_eq!(validate(&b), Ok(()));
        let c = b.counts(&b.shells[0]);
        assert_eq!((c.v, c.e, c.f, c.rings), (8, 12, 6, 0));
        assert_eq!(c.genus(), Some(0));
    }

    #[test]
    fn missing_face_is_not_watertight() {
        let mut b = hand_cube();
        b.faces.pop();
        b.shells[0].faces.pop();
        let errs = validate(&b).unwrap_err();
        assert!(errs.iter().any(|e| matches!(e, ValidationError::EdgeUseCount { uses: 1, .. })), "{errs:?}");
    }

    #[test]
    fn flipped_loop_breaks_orientation() {
        let mut b = hand_cube();
        let l = &mut b.faces[0].loops[0].coedges;
        l.reverse();
        for c in l.iter_mut() {
            c.reversed = !c.reversed;
        }
        let errs = validate(&b).unwrap_err();
        assert!(errs.iter().any(|e| matches!(e, ValidationError::EdgeSameDirection { .. })), "{errs:?}");
    }

    #[test]
    fn shuffled_loop_is_not_closed() {
        let mut b = hand_cube();
        b.faces[1].loops[0].coedges.swap(0, 1);
        let errs = validate(&b).unwrap_err();
        assert!(errs.iter().any(|e| matches!(e, ValidationError::LoopNotClosed { face: 1, .. })), "{errs:?}");
    }

    #[test]
    fn dangling_edge_is_reported_not_panicked() {
        let mut b = hand_cube();
        b.faces[2].loops[0].coedges[0].edge = 999;
        let errs = validate(&b).unwrap_err();
        assert!(matches!(errs[0], ValidationError::DanglingReference { face: 2, .. }));
    }

    #[test]
    fn face_outside_any_shell_is_reported() {
        let mut b = hand_cube();
        b.shells[0].faces.retain(|&f| f != 3);
        let errs = validate(&b).unwrap_err();
        assert!(errs.contains(&ValidationError::FaceShellCount { face: 3, shells: 0 }));
    }

    #[test]
    fn euler_genus_detects_bad_counts() {
        use crate::topology::EulerCounts;
        // Torus-like block with one through hole: genus 1.
        assert_eq!(EulerCounts { v: 16, e: 24, f: 10, rings: 2 }.genus(), Some(1));
        // Odd characteristic is impossible for a closed orientable shell.
        assert_eq!(EulerCounts { v: 8, e: 12, f: 5, rings: 0 }.genus(), None);
        assert_eq!(EulerCounts { v: 9, e: 12, f: 6, rings: 0 }.genus(), None);
    }

    #[test]
    fn moved_vertex_is_off_its_edges() {
        let mut b = hand_cube();
        b.vertices[7].point.z += 1e-3;
        let errs = validate(&b).unwrap_err();
        assert!(errs.iter().any(|e| matches!(e, ValidationError::VertexOffEdge { vertex: 7, .. })), "{errs:?}");
    }

    #[test]
    fn tiny_vertex_noise_within_tolerance_is_accepted() {
        let mut b = hand_cube();
        b.vertices[7].point.z += tolerance::LINEAR * 0.5;
        assert_eq!(validate(&b), Ok(()));
    }

    #[test]
    fn shifted_plane_puts_edges_off_face() {
        let mut b = hand_cube();
        if let Surface::Plane { origin, .. } = &mut b.faces[1].surface {
            origin.z += 0.01;
        }
        let errs = validate(&b).unwrap_err();
        assert!(errs.iter().any(|e| matches!(e, ValidationError::EdgeOffFace { face: 1, .. })), "{errs:?}");
    }

    #[test]
    fn inward_normal_is_caught() {
        let mut b = hand_cube();
        b.faces[4].sense = false;
        let errs = validate(&b).unwrap_err();
        assert_eq!(errs, vec![ValidationError::FaceOrientation { face: 4 }]);
    }

    #[test]
    fn collapsed_box_has_zero_length_edges_and_zero_area_faces() {
        let mut b = hand_cube();
        // Squash the top onto the bottom.
        for v in &mut b.vertices {
            v.point.z = 0.0;
        }
        for e in &mut b.edges {
            let (p, q) = (b.vertices[e.start].point, b.vertices[e.end].point);
            let len = p.distance(q);
            e.curve = Curve::Line { origin: p, dir: if len > 0.0 { (q - p) / len } else { DVec3::X } };
            e.t1 = len;
        }
        if let Surface::Plane { origin, .. } = &mut b.faces[1].surface {
            origin.z = 0.0;
        }
        let errs = validate(&b).unwrap_err();
        assert!(errs.iter().any(|e| matches!(e, ValidationError::ZeroLengthEdge { .. })), "{errs:?}");
        assert!(errs.iter().any(|e| matches!(e, ValidationError::ZeroAreaFace { face: 2 })), "{errs:?}");
    }

    #[test]
    fn whole_cube_turned_inside_out_is_caught() {
        let mut b = hand_cube();
        for f in &mut b.faces {
            f.sense = !f.sense;
            for l in &mut f.loops {
                l.coedges.reverse();
                for c in &mut l.coedges {
                    c.reversed = !c.reversed;
                }
            }
        }
        // Every local check is consistent; only the enclosed volume gives it away.
        let errs = validate(&b).unwrap_err();
        assert!(matches!(errs.as_slice(), [ValidationError::InsideOut { shell: 0, .. }]), "{errs:?}");
    }

    #[test]
    #[should_panic(expected = "invalid body")]
    fn checked_panics_in_test_builds() {
        let mut b = hand_cube();
        b.faces.pop();
        let _ = checked(b);
    }
}
