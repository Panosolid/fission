//! `validate` checks that a body is a well-formed closed solid. Every kernel
//! operation must finish with `checked`, which runs it.

use crate::topology::{Body, EdgeId, FaceId};
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
    #[should_panic(expected = "invalid body")]
    fn checked_panics_in_test_builds() {
        let mut b = hand_cube();
        b.faces.pop();
        let _ = checked(b);
    }
}
