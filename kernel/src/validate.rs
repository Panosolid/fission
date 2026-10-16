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
    /// A loop runs the wrong way round its face: walking along it, the
    /// face isn't on the left (seen from outside). Holes run clockwise.
    LoopOrientation { face: FaceId, loop_index: usize },
    Tessellation { face: FaceId, message: String },
    /// The display mesh has holes or flipped triangles.
    MeshNotClosed { problems: usize },
    /// A shell encloses negative volume: its normals point inward.
    InsideOut { shell: usize, volume: f64 },
    /// Two edges meet (or come within LINEAR) away from a shared vertex.
    EdgesMeet { a: EdgeId, b: EdgeId, point: DVec3 },
    /// An edge meets a face it doesn't bound, away from a shared vertex.
    EdgeMeetsFace { edge: EdgeId, face: FaceId, point: DVec3 },
    /// Two faces cross (or touch) inside both.
    FacesMeet { a: FaceId, b: FaceId, point: DVec3 },
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
            LoopOrientation { face, loop_index } => {
                write!(f, "face {face}: loop {loop_index} runs the wrong way round (the face isn't on its left)")
            }
            Tessellation { face, message } => write!(f, "face {face} could not be tessellated: {message}"),
            MeshNotClosed { problems } => write!(f, "mesh has {problems} open or flipped edges"),
            InsideOut { shell, volume } => write!(f, "shell {shell} encloses {volume:e} mm³ (normals point inward)"),
            EdgesMeet { a, b, point } => write!(f, "edges {a} and {b} meet at {point} away from a shared vertex"),
            EdgeMeetsFace { edge, face, point } => write!(f, "edge {edge} meets face {face} at {point}"),
            FacesMeet { a, b, point } => write!(f, "faces {a} and {b} cross at {point}"),
        }
    }
}

impl ValidationError {
    /// Edges this error is about, for highlighting.
    pub fn edges(&self) -> Vec<EdgeId> {
        use ValidationError::*;
        match *self {
            EdgeUseCount { edge, .. }
            | EdgeSameDirection { edge }
            | VertexOffEdge { edge, .. }
            | EdgeOffFace { edge, .. }
            | ZeroLengthEdge { edge }
            | EdgeMeetsFace { edge, .. } => vec![edge],
            EdgesMeet { a, b, .. } => vec![a, b],
            _ => vec![],
        }
    }

    /// Vertices this error is about, for highlighting.
    pub fn vertices(&self) -> Vec<usize> {
        match *self {
            ValidationError::VertexOffEdge { vertex, .. } => vec![vertex],
            _ => vec![],
        }
    }

    /// The point where parts meet, for the self-intersection errors.
    pub fn point(&self) -> Option<DVec3> {
        use ValidationError::*;
        match *self {
            EdgesMeet { point, .. } | EdgeMeetsFace { point, .. } | FacesMeet { point, .. } => Some(point),
            _ => None,
        }
    }

    /// Faces this error is about, for highlighting.
    pub fn faces(&self) -> Vec<FaceId> {
        use ValidationError::*;
        match *self {
            DanglingReference { face, .. }
            | EmptyLoop { face, .. }
            | LoopNotClosed { face, .. }
            | FaceShellCount { face, .. }
            | EdgeOffFace { face, .. }
            | ZeroAreaFace { face }
            | FaceOrientation { face }
            | LoopOrientation { face, .. }
            | Tessellation { face, .. }
            | EdgeMeetsFace { face, .. } => vec![face],
            FacesMeet { a, b, .. } => vec![a, b],
            _ => vec![],
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
    if errs.is_empty() {
        // Assumes sound geometry too (edges on their faces, loops the
        // right way round), and is the costliest.
        crate::self_intersect::check(body, &mut errs);
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
                // WebAssembly has no files, and no debug_dump module.
                #[cfg(not(target_arch = "wasm32"))]
                let dump = crate::debug_dump::dump_invalid(&body, &list.join("\n"))
                    .map_or_else(|| "none written".to_string(), |p| p.display().to_string());
                #[cfg(target_arch = "wasm32")]
                let dump = "none written (WebAssembly has no files)";
                panic!("kernel produced an invalid body:\n  {}\nfailure dump: {dump}", list.join("\n  "));
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
    // Triangles run counter-clockwise seen from outside, so a face's
    // triangles have its interior on the left of each of their edges.
    // Walking a loop in its own direction, the face must be on the left:
    // each mesh step a→b along the loop is an edge a→b of one of the face's
    // triangles. (Which triangles are inside is decided by crossings, not by
    // loop direction, so a loop run backwards still meshes; this catches it.)
    let mut directed: std::collections::HashSet<(usize, u32, u32)> = std::collections::HashSet::new();
    for (t, tri) in mesh.triangles.iter().enumerate() {
        for k in 0..3 {
            directed.insert((mesh.triangle_face[t], tri[k], tri[(k + 1) % 3]));
        }
    }
    for (fi, f) in body.faces.iter().enumerate() {
        for (li, l) in f.loops.iter().enumerate() {
            let right_way = l.coedges.iter().all(|c| {
                let poly = &mesh.edge_polylines[c.edge];
                let steps: Vec<(u32, u32)> = if c.reversed {
                    poly.windows(2).map(|w| (w[1], w[0])).collect()
                } else {
                    poly.windows(2).map(|w| (w[0], w[1])).collect()
                };
                steps.iter().all(|&(a, b)| directed.contains(&(fi, a, b)))
            });
            if !right_way {
                errs.push(ValidationError::LoopOrientation { face: fi, loop_index: li });
            }
        }
    }
    for (si, s) in body.shells.iter().enumerate() {
        let volume = mesh.signed_volume_of(|t| s.faces.contains(&mesh.triangle_face[t]));
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
mod tests {
    use super::*;
    use crate::fixtures::hand_cube;
    use crate::geom::{Curve, Surface};
    use crate::topology::{Face, Loop};
    use glam::DVec3;

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
    fn vertex_offset_near_tolerance_boundary() {
        // Vertex 7 is (1,1,1); its edges end at exactly (1,1,1), so moving it
        // by d along z puts it exactly d from all three edges.
        for (factor, ok) in [(0.5, true), (0.9, true), (1.1, false), (2.0, false)] {
            let mut b = hand_cube();
            b.vertices[7].point.z += tolerance::LINEAR * factor;
            let r = validate(&b);
            assert_eq!(r.is_ok(), ok, "{factor}× tolerance: {r:?}");
        }
    }

    #[test]
    fn plane_offset_near_tolerance_boundary() {
        // Shifting the top face's plane by d leaves its four edges d away.
        for (factor, ok) in [(0.9, true), (1.1, false)] {
            let mut b = hand_cube();
            if let Surface::Plane { origin, .. } = &mut b.faces[1].surface {
                origin.z += tolerance::LINEAR * factor;
            }
            let r = validate(&b);
            assert_eq!(r.is_ok(), ok, "{factor}× tolerance: {r:?}");
        }
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
    fn hole_running_the_wrong_way_is_caught() {
        // Found by a planted bug in step 10 (circle holes built running
        // counter-clockwise): every other check passed, because the mesh
        // comes out the same. Reverse the whole hole as that bug did: its
        // loop on each cap (faces 0 and 1, loop 1) and both loops of the
        // bore (face 3), so every edge is still used once each way.
        let mut b = crate::fixtures::hand_tube(1.0, 2.0, 1.0, 0.0);
        assert_eq!(validate(&b), Ok(()));
        for (f, l) in [(0, 1), (1, 1), (3, 0), (3, 1)] {
            b.faces[f].loops[l].coedges[0].reversed ^= true;
        }
        let errs = validate(&b).unwrap_err();
        let expected: Vec<_> = [(0, 1), (1, 1), (3, 0), (3, 1)]
            .map(|(face, loop_index)| ValidationError::LoopOrientation { face, loop_index })
            .to_vec();
        assert_eq!(errs, expected);
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
    fn edge_with_only_its_end_dangling_is_reported() {
        let mut b = hand_cube();
        b.edges[0].end = 999;
        let errs = validate(&b).unwrap_err();
        assert!(matches!(errs[0], ValidationError::DanglingReference { .. }), "{errs:?}");
    }

    #[test]
    fn two_separate_cubes_in_one_shell_are_not_connected() {
        let mut b = hand_cube();
        let other = hand_cube().transformed(&crate::geom::Transform::translation(DVec3::new(5.0, 0.0, 0.0)));
        let (nv, ne, nf) = (b.vertices.len(), b.edges.len(), b.faces.len());
        b.vertices.extend(other.vertices);
        for mut e in other.edges {
            e.start += nv;
            e.end += nv;
            b.edges.push(e);
        }
        for mut f in other.faces {
            for l in &mut f.loops {
                l.coedges.iter_mut().for_each(|c| c.edge += ne);
            }
            b.faces.push(f);
        }
        b.shells[0].faces.extend(nf..nf + 6);
        let errs = validate(&b).unwrap_err();
        assert!(errs.contains(&ValidationError::ShellNotConnected { shell: 0 }), "{errs:?}");
    }

    #[test]
    fn inside_out_volume_is_reported_correctly() {
        // The unit cube turned inside out encloses exactly -1 mm³.
        let mut b = hand_cube();
        for f in &mut b.faces {
            f.sense = !f.sense;
            for l in &mut f.loops {
                l.coedges.reverse();
                l.coedges.iter_mut().for_each(|c| c.reversed = !c.reversed);
            }
        }
        match validate(&b).unwrap_err().as_slice() {
            [ValidationError::InsideOut { volume, .. }] => assert!(tolerance::eq(*volume, -1.0), "{volume}"),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn small_box_far_from_the_origin_is_valid() {
        // Regression: shell volume was summed about the world origin, so a
        // 0.01 mm cube 1e6 mm out came out negative and was called inside out.
        let b = hand_cube()
            .transformed(&crate::geom::Transform::uniform_scale(0.01))
            .transformed(&crate::geom::Transform::translation(DVec3::splat(1e6)));
        assert_eq!(validate(&b), Ok(()));
    }

    #[test]
    fn planar_loop_area_by_hand() {
        // A 2 × 3 rectangle far from the origin (corner at (10, 20, 7)),
        // counter-clockwise seen from +Z: area +6. Reversing the loop, or
        // flipping the face, gives -6.
        let mut b = Body::default();
        let o = DVec3::new(10.0, 20.0, 7.0);
        let corners = [o, o + DVec3::new(2.0, 0.0, 0.0), o + DVec3::new(2.0, 3.0, 0.0), o + DVec3::new(0.0, 3.0, 0.0)];
        let v: Vec<usize> = corners.iter().map(|&p| b.add_vertex(p)).collect();
        let coedges = (0..4).map(|i| crate::topology::Coedge { edge: b.add_line(v[i], v[(i + 1) % 4]), reversed: false }).collect();
        let l = Loop { coedges };
        let up = Face { surface: Surface::Plane { origin: o, normal: DVec3::Z, x_dir: DVec3::X }, sense: true, loops: vec![] };
        assert!(tolerance::eq(planar_loop_area(&b, &up, &l), 6.0));
        let down = Face { sense: false, ..up.clone() };
        assert!(tolerance::eq(planar_loop_area(&b, &down, &l), -6.0));
        let mut rev = l.clone();
        rev.coedges.reverse();
        rev.coedges.iter_mut().for_each(|c| c.reversed = true);
        assert!(tolerance::eq(planar_loop_area(&b, &up, &rev), -6.0));
    }

    #[test]
    fn every_error_message_names_its_entities() {
        use ValidationError::*;
        let cases = [
            (DanglingReference { face: 3, what: "edge 9".into() }, vec!["face 3", "edge 9"]),
            (EmptyLoop { face: 4, loop_index: 1 }, vec!["face 4", "loop 1"]),
            (LoopNotClosed { face: 2, loop_index: 0, position: 5 }, vec!["face 2", "loop 0", "coedge 5"]),
            (EdgeUseCount { edge: 7, uses: 3 }, vec!["edge 7", "3 times"]),
            (EdgeSameDirection { edge: 8 }, vec!["edge 8", "same direction"]),
            (FaceShellCount { face: 6, shells: 0 }, vec!["face 6", "0 shells"]),
            (ShellNotConnected { shell: 2 }, vec!["shell 2", "not connected"]),
            (EulerPoincare { shell: 1, v: 8, e: 12, f: 5, rings: 0 }, vec!["shell 1", "V=8", "E=12", "F=5", "R=0"]),
            (VertexOffEdge { edge: 4, vertex: 7, distance: 0.5 }, vec!["vertex 7", "edge 4", "5e-1"]),
            (EdgeOffFace { edge: 3, face: 1, distance: 0.25 }, vec!["edge 3", "face 1", "2.5e-1"]),
            (ZeroLengthEdge { edge: 11 }, vec!["edge 11", "zero length"]),
            (ZeroAreaFace { face: 9 }, vec!["face 9", "zero area"]),
            (FaceOrientation { face: 5 }, vec!["face 5", "normal"]),
            (LoopOrientation { face: 2, loop_index: 1 }, vec!["face 2", "loop 1", "wrong way"]),
            (Tessellation { face: 2, message: "boom".into() }, vec!["face 2", "boom"]),
            (MeshNotClosed { problems: 4 }, vec!["4 open"]),
            (InsideOut { shell: 0, volume: -1.0 }, vec!["shell 0", "-1e0", "inward"]),
            (EdgesMeet { a: 2, b: 13, point: DVec3::new(1.0, 0.5, 2.0) }, vec!["edges 2 and 13", "[1, 0.5, 2]"]),
            (EdgeMeetsFace { edge: 6, face: 10, point: DVec3::new(0.5, 1.0, 1.0) }, vec!["edge 6", "face 10", "[0.5, 1, 1]"]),
            (FacesMeet { a: 1, b: 7, point: DVec3::new(0.5, 0.25, 1.0) }, vec!["faces 1 and 7", "[0.5, 0.25, 1]", "cross"]),
        ];
        for (err, words) in cases {
            let msg = err.to_string();
            for w in words {
                assert!(msg.contains(w), "{msg:?} should mention {w:?}");
            }
        }
    }

    #[test]
    fn checked_writes_a_failure_dump_before_panicking() {
        // Vertex 7 lifted off its edges: the panic names the dump, and the
        // dump's page lists the same errors.
        let mut b = hand_cube();
        b.vertices[7].point.z += 0.25;
        let message = std::panic::catch_unwind(|| checked(b)).unwrap_err();
        let message = message.downcast_ref::<String>().unwrap();
        let path = message.split("failure dump: ").nth(1).expect("the panic names its dump");
        let html = std::fs::read_to_string(std::path::Path::new(path).join("index.html")).unwrap();
        assert!(html.contains("vertex 7 is 2.5e-1 mm off edge 5"), "{message}");
    }

    #[test]
    #[should_panic(expected = "invalid body")]
    fn checked_panics_in_test_builds() {
        let mut b = hand_cube();
        b.faces.pop();
        let _ = checked(b);
    }

    #[test]
    fn self_intersection_errors_name_their_parts() {
        // The failure dump highlights what an error names: both edges of
        // EdgesMeet, the edge and face of EdgeMeetsFace, both faces of
        // FacesMeet.
        let p = DVec3::new(0.5, 0.25, 1.0);
        let e = ValidationError::EdgesMeet { a: 2, b: 5, point: p };
        assert_eq!((e.edges(), e.faces(), e.point()), (vec![2, 5], vec![], Some(p)));
        let e = ValidationError::EdgeMeetsFace { edge: 6, face: 10, point: p };
        assert_eq!((e.edges(), e.faces(), e.point()), (vec![6], vec![10], Some(p)));
        let e = ValidationError::FacesMeet { a: 1, b: 7, point: p };
        assert_eq!((e.edges(), e.faces(), e.point()), (vec![], vec![1, 7], Some(p)));
    }
}
