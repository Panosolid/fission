//! `validate` checks that a body is a well-formed closed solid. Every kernel
//! operation must finish with `checked`, which runs it.
//!
//! Mutation testing (`cargo mutants -f src/validate.rs`, lib tests) leaves
//! no survivors. Ties are pinned by tests: `> LINEAR` for vertex-off-edge
//! and edge-off-face at exactly LINEAR, and the outer loop's area `< 0.0`
//! for FaceOrientation at exactly 0 (`a_zero_area_outer_loop_is_not_called_inside_out`).
//!
//! Every error belongs to one `Category` (B0 decision 8), and every report
//! of errors groups them by it (`report_lines`): topology is what the
//! references and counts say, whatever the coordinates; geometry is whether
//! each entity sits where its references put it, within its own tolerance,
//! with a size; solid is whether the body bounds a region the right way
//! round without crossing itself. The fourth category, whether an
//! operation gave the right answer, lives in the tests (the boolean
//! identities, the oracle), not here. The checks run in that order, and
//! the costly solid ones (the mesh, self-intersection) only on a body whose
//! topology and geometry are sound; the one solid check that runs earlier
//! is a planar face's orientation, which falls out of the area the
//! zero-area check measures anyway.

use crate::geom::{Curve, Surface};
use crate::mesh::Mesh;
use crate::tessellate::{tessellate, TessOptions};
use crate::tolerance;
use crate::topology::{Body, EdgeId, Face, FaceId, Loop};
use glam::{DVec2, DVec3};
use std::fmt;

/// Which part of being a valid solid an error breaks (B0 decision 8). In
/// the order the checks run and reports list them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Category {
    /// The references and counts: indices in their arenas, closed loops,
    /// every edge used once each way, each face in one shell, shells
    /// connected, Euler–Poincaré.
    Topology,
    /// Where things are: vertices on their edges and edges on their faces,
    /// each within its own tolerance; tolerances an entity may carry; no
    /// zero-length edges or zero-area faces.
    Geometry,
    /// The region the body bounds: faces and loops the right way round, the
    /// display mesh closed, positive volume, nothing crossing itself.
    Solid,
}

impl Category {
    pub const ALL: [Category; 3] = [Category::Topology, Category::Geometry, Category::Solid];

    pub fn name(self) -> &'static str {
        match self {
            Category::Topology => "topology",
            Category::Geometry => "geometry",
            Category::Solid => "solid",
        }
    }
}

impl fmt::Display for Category {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.name())
    }
}

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
    /// An edge's curve ends further from its end vertex than the vertex's
    /// own tolerance `tol` (which covers the gaps to every edge end it
    /// joins, B0 decision 5).
    VertexOffEdge { edge: EdgeId, vertex: usize, distance: f64, tol: f64 },
    /// A point of an edge is further from the surface of a face that uses
    /// it than the edge's own tolerance `tol`.
    EdgeOffFace { edge: EdgeId, face: FaceId, distance: f64, tol: f64 },
    /// An edge no longer than its own tolerance.
    ZeroLengthEdge { edge: EdgeId },
    /// A vertex's tolerance is outside what any entity may carry: below
    /// LINEAR, past TOL_INPUT_MAX, or not a number (`tolerance::tol_in_range`).
    VertexTolerance { vertex: usize, tol: f64 },
    /// An edge's tolerance is outside that range.
    EdgeTolerance { edge: EdgeId, tol: f64 },
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
            VertexOffEdge { edge, vertex, distance, tol } => {
                write!(f, "vertex {vertex} is {distance:e} mm off edge {edge}, past the vertex's tolerance of {tol:e} mm")
            }
            EdgeOffFace { edge, face, distance, tol } => {
                write!(f, "edge {edge} is {distance:e} mm off face {face}, past the edge's tolerance of {tol:e} mm")
            }
            ZeroLengthEdge { edge } => write!(f, "edge {edge} has zero length"),
            VertexTolerance { vertex, tol } => write!(f, "vertex {vertex} carries a tolerance of {tol:e} mm, {}", tol_range()),
            EdgeTolerance { edge, tol } => write!(f, "edge {edge} carries a tolerance of {tol:e} mm, {}", tol_range()),
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
    /// The category this error belongs to. No catch-all arm: a new error
    /// doesn't compile until it is given one.
    pub fn category(&self) -> Category {
        use ValidationError::*;
        match self {
            DanglingReference { .. }
            | EmptyLoop { .. }
            | LoopNotClosed { .. }
            | EdgeUseCount { .. }
            | EdgeSameDirection { .. }
            | FaceShellCount { .. }
            | ShellNotConnected { .. }
            | EulerPoincare { .. } => Category::Topology,
            VertexOffEdge { .. }
            | EdgeOffFace { .. }
            | ZeroLengthEdge { .. }
            | VertexTolerance { .. }
            | EdgeTolerance { .. }
            | ZeroAreaFace { .. } => Category::Geometry,
            // The mesh is how the kernel finds a body's inside: a face it
            // can't mesh (its boundary crossing itself) or a mesh with holes
            // leaves the region it bounds unknown.
            FaceOrientation { .. }
            | LoopOrientation { .. }
            | Tessellation { .. }
            | MeshNotClosed { .. }
            | InsideOut { .. }
            | EdgesMeet { .. }
            | EdgeMeetsFace { .. }
            | FacesMeet { .. } => Category::Solid,
        }
    }

    /// Edges this error is about, for highlighting.
    pub fn edges(&self) -> Vec<EdgeId> {
        use ValidationError::*;
        match *self {
            EdgeUseCount { edge, .. }
            | EdgeSameDirection { edge }
            | VertexOffEdge { edge, .. }
            | EdgeOffFace { edge, .. }
            | ZeroLengthEdge { edge }
            | EdgeTolerance { edge, .. }
            | EdgeMeetsFace { edge, .. } => vec![edge],
            EdgesMeet { a, b, .. } => vec![a, b],
            _ => vec![],
        }
    }

    /// Vertices this error is about, for highlighting.
    pub fn vertices(&self) -> Vec<usize> {
        match *self {
            ValidationError::VertexOffEdge { vertex, .. } | ValidationError::VertexTolerance { vertex, .. } => vec![vertex],
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

/// The range a tolerance must be in, in words, for the tolerance errors.
fn tol_range() -> String {
    format!("outside the {:e} to {:e} mm any vertex or edge may carry", tolerance::LINEAR, tolerance::TOL_INPUT_MAX)
}

/// Errors as a report, grouped by category: one line per error, each
/// starting with its category ("geometry: vertex 7 is …"), topology first,
/// then geometry, then solid, each group in the order the checks found them.
pub fn report_lines(errs: &[ValidationError]) -> Vec<String> {
    let mut sorted: Vec<&ValidationError> = errs.iter().collect();
    // Stable, so each group keeps the order the checks found it in.
    sorted.sort_by_key(|e| e.category());
    sorted.iter().map(|e| format!("{}: {e}", e.category())).collect()
}

/// Runs every check and returns all problems found.
pub fn validate(body: &Body) -> Result<(), Vec<ValidationError>> {
    validate_meshed(body).map(|_| ())
}

/// `validate`, also handing back the display mesh its mesh checks built
/// (`tessellate(body, &TessOptions::DISPLAY)`, the mesh the viewer and STL
/// export use), so callers don't tessellate the same body again.
pub fn validate_meshed(body: &Body) -> Result<Mesh, Vec<ValidationError>> {
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
    // The mesh checks assume sound topology, so they run last.
    let mesh = if errs.is_empty() { check_mesh(body, &mut errs) } else { None };
    if errs.is_empty() {
        // Assumes sound geometry too (edges on their faces, loops the
        // right way round), and is the costliest.
        crate::self_intersect::check(body, &mut errs);
    }
    match mesh {
        Some(mesh) if errs.is_empty() => Ok(mesh),
        _ => Err(errs),
    }
}

/// Validates the result of a kernel operation. In debug and test builds an
/// invalid body is a bug, so this panics; in release it returns the errors.
pub fn checked(body: Body) -> Result<Body, Vec<ValidationError>> {
    checked_meshed(body).map(|(body, _)| body)
}

/// `checked`, also handing back the body's display mesh (`validate_meshed`).
pub fn checked_meshed(body: Body) -> Result<(Body, Mesh), Vec<ValidationError>> {
    match validate_meshed(&body) {
        Ok(mesh) => Ok((body, mesh)),
        Err(errs) => {
            if cfg!(debug_assertions) {
                let list = report_lines(&errs);
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
    // Each vertex and edge is held to its own tolerance (B0 decision 5), so
    // a tolerance must be one an entity may carry first: a NaN would make
    // every `distance > tol` below false and pass anything.
    for (vi, v) in body.vertices.iter().enumerate() {
        if !tolerance::tol_in_range(v.tol) {
            errs.push(ValidationError::VertexTolerance { vertex: vi, tol: v.tol });
        }
    }
    for (ei, e) in body.edges.iter().enumerate() {
        if !tolerance::tol_in_range(e.tol) {
            errs.push(ValidationError::EdgeTolerance { edge: ei, tol: e.tol });
        }
        if e.length() <= e.tol {
            errs.push(ValidationError::ZeroLengthEdge { edge: ei });
        }
        // The vertex's tolerance covers the gap to every edge end it joins.
        for (vertex, t) in [(e.start, e.t0), (e.end, e.t1)] {
            let (distance, tol) = (e.curve.eval(t).distance(body.vertices[vertex].point), body.vertices[vertex].tol);
            if distance > tol {
                errs.push(ValidationError::VertexOffEdge { edge: ei, vertex, distance, tol });
            }
        }
    }
    for (ei, uses) in body.edge_faces().iter().enumerate() {
        let e = &body.edges[ei];
        for &(fi, _) in uses {
            let surface = &body.faces[fi].surface;
            let distance = EDGE_SAMPLES.iter().map(|&s| surface.distance(e.point_at(s))).fold(0.0, f64::max);
            if distance > e.tol {
                errs.push(ValidationError::EdgeOffFace { edge: ei, face: fi, distance, tol: e.tol });
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

/// The mesh checks; returns the mesh when tessellation succeeded.
fn check_mesh(body: &Body, errs: &mut Vec<ValidationError>) -> Option<Mesh> {
    let mesh = match tessellate(body, &TessOptions::DISPLAY) {
        Ok(m) => m,
        Err(e) => {
            errs.push(ValidationError::Tessellation { face: e.face, message: e.message });
            return None;
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
    // The triangle edges leaving each mesh vertex, as (face, end), grouped by
    // vertex (counting sort): a hash set of every edge took ~1 s for a
    // 2,000,000-triangle mesh. Each lookup scans one vertex's few edges.
    let mut first = vec![0usize; mesh.positions.len() + 1];
    for tri in &mesh.triangles {
        for &a in tri {
            first[a as usize + 1] += 1;
        }
    }
    for i in 1..first.len() {
        first[i] += first[i - 1];
    }
    let mut filled = first.clone();
    let mut leaving = vec![(0usize, 0u32); first[first.len() - 1]];
    for (t, tri) in mesh.triangles.iter().enumerate() {
        for k in 0..3 {
            let a = tri[k] as usize;
            leaving[filled[a]] = (mesh.triangle_face[t], tri[(k + 1) % 3]);
            filled[a] += 1;
        }
    }
    let has_step = |fi: FaceId, a: u32, b: u32| leaving[first[a as usize]..first[a as usize + 1]].contains(&(fi, b));
    for (fi, f) in body.faces.iter().enumerate() {
        for (li, l) in f.loops.iter().enumerate() {
            let right_way = l.coedges.iter().all(|c| {
                let poly = &mesh.edge_polylines[c.edge];
                if c.reversed {
                    poly.windows(2).all(|w| has_step(fi, w[1], w[0]))
                } else {
                    poly.windows(2).all(|w| has_step(fi, w[0], w[1]))
                }
            });
            if !right_way {
                errs.push(ValidationError::LoopOrientation { face: fi, loop_index: li });
            }
        }
    }
    for (si, s) in body.shells.iter().enumerate() {
        // Membership by face index, not a search of the shell's face list
        // per triangle (2,000 faces × 2,000,000 triangles).
        let mut in_shell = vec![false; body.faces.len()];
        s.faces.iter().for_each(|&f| in_shell[f] = true);
        let volume = mesh.signed_volume_of(|t| in_shell[mesh.triangle_face[t]]);
        if volume <= 0.0 {
            errs.push(ValidationError::InsideOut { shell: si, volume });
        }
    }
    Some(mesh)
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
    // Project onto the coordinate plane the normal is most along, keeping
    // the axes in cyclic order (yz, zx or xy): dropping a coordinate is
    // exact, and the projection's twice area is n_k times the loop's, so
    // with the exact shoelace the sign is exact for these corners.
    let k = if n.x.abs() >= n.y.abs().max(n.z.abs()) { 0 } else if n.y.abs() >= n.z.abs() { 1 } else { 2 };
    let flat: Vec<DVec2> = pts.iter().map(|p| DVec2::new(p[(k + 1) % 3], p[(k + 2) % 3])).collect();
    tolerance::twice_area(&flat) / (2.0 * n[k])
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

    /// The categories present in `errs`, in report order, each once.
    fn categories(errs: &[ValidationError]) -> Vec<Category> {
        let mut c: Vec<Category> = errs.iter().map(ValidationError::category).collect();
        c.sort();
        c.dedup();
        c
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
        // The four edges round the hole used once, and V − E + F = 8 − 12 +
        // 5 = 1 is odd: counting only, the other five faces still sit
        // where their edges are.
        assert_eq!(categories(&errs), [Category::Topology], "{errs:?}");
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
        // Its four edges now run the same way in both their faces
        // (topology), and the loop runs clockwise round the face's normal,
        // so the face's area is negative (solid, the orientation check that
        // runs with the geometry ones); where everything is, is unchanged.
        assert_eq!(categories(&errs), [Category::Topology, Category::Solid], "{errs:?}");
        assert!(errs.contains(&ValidationError::FaceOrientation { face: 0 }) && errs[0].category() == Category::Topology, "{errs:?}");
    }

    #[test]
    fn shuffled_loop_is_not_closed() {
        let mut b = hand_cube();
        b.faces[1].loops[0].coedges.swap(0, 1);
        let errs = validate(&b).unwrap_err();
        assert!(errs.iter().any(|e| matches!(e, ValidationError::LoopNotClosed { face: 1, .. })), "{errs:?}");
        // The loop is broken (topology), and its corners, taken at each
        // coedge's start, now come B, A, C, D round the top square A B C D:
        // a bow tie, whose two triangles' areas cancel, so the face has
        // zero area (geometry). Unit square A (0,0), B (1,0), C (1,1),
        // D (0,1) seen from above: shoelace terms B→A 0, A→C 0, C→D 1,
        // D→B −1, sum 0.
        assert_eq!(categories(&errs), [Category::Topology, Category::Geometry], "{errs:?}");
        assert!(errs.contains(&ValidationError::ZeroAreaFace { face: 1 }), "{errs:?}");
    }

    #[test]
    fn dangling_edge_is_reported_not_panicked() {
        let mut b = hand_cube();
        b.faces[2].loops[0].coedges[0].edge = 999;
        let errs = validate(&b).unwrap_err();
        assert!(matches!(errs[0], ValidationError::DanglingReference { face: 2, .. }));
        // Nothing else is checked once a reference dangles.
        assert_eq!(categories(&errs), [Category::Topology], "{errs:?}");
    }

    #[test]
    fn face_outside_any_shell_is_reported() {
        let mut b = hand_cube();
        b.shells[0].faces.retain(|&f| f != 3);
        let errs = validate(&b).unwrap_err();
        assert!(errs.contains(&ValidationError::FaceShellCount { face: 3, shells: 0 }));
        // And the shell counts 5 faces: V − E + F = 1, odd.
        assert_eq!(categories(&errs), [Category::Topology], "{errs:?}");
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
        // Off its three edges and nothing else: the edges' own curves, and
        // so the faces' areas, are unchanged.
        assert_eq!(categories(&errs), [Category::Geometry], "{errs:?}");
        assert_eq!(errs.len(), 3, "{errs:?}");
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
            assert!(r.err().unwrap_or_default().iter().all(|e| e.category() == Category::Geometry), "{factor}×");
        }
    }

    #[test]
    fn vertex_exactly_linear_off_its_edges_is_on() {
        // "Within tolerance" includes the tolerance itself. Vertex 0 is the
        // origin and starts all three of its edges at t0 = 0, so eval(t0) is
        // exactly (0,0,0). Moved to (0,0,−LINEAR), its distance is
        // sqrt(fl(LINEAR²)), which is LINEAR exactly (a correctly rounded
        // square root of a correctly rounded square gives back |x| in binary
        // floating point, barring underflow). So `> LINEAR` must not fire.
        let mut b = hand_cube();
        b.vertices[0].point.z = -tolerance::LINEAR;
        let d = b.edges[0].curve.eval(b.edges[0].t0).distance(b.vertices[0].point);
        assert_eq!(d.to_bits(), tolerance::LINEAR.to_bits(), "the setup must hit LINEAR exactly");
        assert_eq!(validate(&b), Ok(()));
    }

    #[test]
    fn edges_exactly_linear_off_a_face_are_on() {
        // The bottom face (0) is z = 0 with normal −z, and its four edges lie
        // in z = 0. Moving its plane's origin to z = −LINEAR puts every edge
        // sample p at |(p − origin)·(−z)| = |0 − (−LINEAR)| = LINEAR, exact
        // (one subtraction from zero and products with 0 and −1).
        let mut b = hand_cube();
        if let Surface::Plane { origin, .. } = &mut b.faces[0].surface {
            origin.z = -tolerance::LINEAR;
        }
        let d = b.faces[0].surface.distance(b.edges[0].point_at(0.5));
        assert_eq!(d.to_bits(), tolerance::LINEAR.to_bits(), "the setup must hit LINEAR exactly");
        assert_eq!(validate(&b), Ok(()));
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
            assert!(r.err().unwrap_or_default().iter().all(|e| e.category() == Category::Geometry), "{factor}×");
        }
    }

    #[test]
    fn a_grown_edge_tolerance_holds_its_edges_to_it() {
        // The top face (1, z = 1) is bounded by four edges. Grown to
        // G = 5·LINEAR = 5e-5 (as an intersection may grow them, below the
        // cap), they may lie up to G off it: the plane moved up 0.9·G
        // leaves each edge 0.9·G off, which passes; 1.1·G fails, naming the
        // edge's own tolerance. At LINEAR the same 0.9·G fails (it is 4.5
        // LINEAR), so the edge's field is what lets it pass.
        let g = 5.0 * tolerance::LINEAR;
        let top: Vec<usize> = hand_cube().faces[1].loops[0].coedges.iter().map(|c| c.edge).collect();
        let lifted = |factor: f64, tol: f64| {
            let mut b = hand_cube();
            for &e in &top {
                b.edges[e].tol = tol;
            }
            if let Surface::Plane { origin, .. } = &mut b.faces[1].surface {
                origin.z += g * factor;
            }
            validate(&b)
        };
        assert_eq!(lifted(0.9, g), Ok(()));
        let errs = lifted(1.1, g).unwrap_err();
        assert_eq!(errs.len(), 4, "{errs:?}");
        for e in &errs {
            let ValidationError::EdgeOffFace { face: 1, distance, tol, .. } = *e else { panic!("{errs:?}") };
            assert!(tol == g && tolerance::eq(distance, 1.1 * g), "{e}");
        }
        assert_eq!(categories(&errs), [Category::Geometry]);
        assert!(lifted(0.9, tolerance::LINEAR).unwrap_err().iter().all(|e| matches!(e, ValidationError::EdgeOffFace { face: 1, .. })));
    }

    #[test]
    fn a_vertex_tolerance_covers_every_edge_end_it_joins() {
        // Vertex 7 is (1,1,1), where its three edges end. Grown to G =
        // 5·LINEAR and moved d along z, it is d from each edge end: 0.9·G
        // passes, 1.1·G fails once per edge, each naming the vertex's
        // tolerance. The edges keep LINEAR: the gap is the vertex's to
        // cover, not theirs (edge 0.9·G off would be 4.5 of their LINEAR).
        let g = 5.0 * tolerance::LINEAR;
        let moved = |factor: f64| {
            let mut b = hand_cube();
            b.vertices[7].tol = g;
            b.vertices[7].point.z += g * factor;
            validate(&b)
        };
        assert_eq!(moved(0.9), Ok(()));
        let errs = moved(1.1).unwrap_err();
        assert_eq!(errs.len(), 3, "{errs:?}");
        for e in &errs {
            let ValidationError::VertexOffEdge { vertex: 7, distance, tol, .. } = *e else { panic!("{errs:?}") };
            assert!(tol == g && tolerance::eq(distance, 1.1 * g), "{e}");
        }
        assert_eq!(categories(&errs), [Category::Geometry]);
    }

    #[test]
    fn an_edge_tolerance_does_not_cover_its_vertices() {
        // The other way round: vertex 7's three edges grown to G, the
        // vertex left at LINEAR and moved 0.9·G. The gap at each edge end
        // is the vertex's, so it fails three times, at the vertex's LINEAR.
        let g = 5.0 * tolerance::LINEAR;
        let mut b = hand_cube();
        for e in &mut b.edges {
            if e.start == 7 || e.end == 7 {
                e.tol = g;
            }
        }
        b.vertices[7].point.z += 0.9 * g;
        let errs = validate(&b).unwrap_err();
        assert_eq!(errs.len(), 3, "{errs:?}");
        assert!(errs.iter().all(|e| matches!(*e, ValidationError::VertexOffEdge { vertex: 7, tol, .. } if tol == tolerance::LINEAR)), "{errs:?}");
        assert_eq!(categories(&errs), [Category::Geometry]);
    }

    #[test]
    fn a_tolerance_out_of_range_has_its_own_error() {
        // Any entity may carry LINEAR to TOL_INPUT_MAX (500 nm), both ends
        // in; the cap (100 nm) is within. 0.9× of LINEAR, 1.1× of
        // TOL_INPUT_MAX and NaN are refused, each with only its own error.
        let with = |vertex: Option<f64>, edge: Option<f64>| {
            let mut b = hand_cube();
            if let Some(t) = vertex {
                b.vertices[3].tol = t;
            }
            if let Some(t) = edge {
                b.edges[5].tol = t;
            }
            validate(&b)
        };
        for ok in [tolerance::LINEAR, tolerance::TOL_CAP, 0.9 * tolerance::TOL_INPUT_MAX, tolerance::TOL_INPUT_MAX] {
            assert_eq!(with(Some(ok), Some(ok)), Ok(()), "{ok:e}");
        }
        for bad in [0.9 * tolerance::LINEAR, 1.1 * tolerance::TOL_INPUT_MAX] {
            assert_eq!(with(Some(bad), None), Err(vec![ValidationError::VertexTolerance { vertex: 3, tol: bad }]), "{bad:e}");
            assert_eq!(with(None, Some(bad)), Err(vec![ValidationError::EdgeTolerance { edge: 5, tol: bad }]), "{bad:e}");
        }
        // A tolerance is part of where an entity may be: geometry.
        assert_eq!(ValidationError::VertexTolerance { vertex: 3, tol: 0.0 }.category(), Category::Geometry);
        assert_eq!(ValidationError::EdgeTolerance { edge: 5, tol: 0.0 }.category(), Category::Geometry);
        // Negative and infinite ones are named too (with what follows from
        // them: every gap, even 0, is past a negative one, and every edge
        // is shorter than an infinite one).
        for bad in [-tolerance::LINEAR, f64::INFINITY] {
            assert!(with(Some(bad), None).unwrap_err().contains(&ValidationError::VertexTolerance { vertex: 3, tol: bad }), "{bad:e}");
            assert!(with(None, Some(bad)).unwrap_err().contains(&ValidationError::EdgeTolerance { edge: 5, tol: bad }), "{bad:e}");
        }
        // NaN fails every `distance > tol`, so without this check an edge
        // with a NaN tolerance would pass however far off its faces it
        // lay: the face moved a whole 0.1 mm, only the tolerance is named.
        let mut b = hand_cube();
        b.edges[5].tol = f64::NAN;
        let face = b.edge_faces()[5][0].0;
        if let Surface::Plane { origin, normal, .. } = &mut b.faces[face].surface {
            *origin += *normal * 0.1;
        }
        let errs = validate(&b).unwrap_err();
        assert!(matches!(errs[0], ValidationError::EdgeTolerance { edge: 5, tol } if tol.is_nan()), "{errs:?}");
        assert!(errs.iter().all(|e| !e.edges().contains(&5) || matches!(e, ValidationError::EdgeTolerance { .. })), "{errs:?}");
        // The face's other three edges are off it too: geometry, all of it.
        assert_eq!(categories(&errs), [Category::Geometry], "{errs:?}");
    }

    #[test]
    fn an_edge_no_longer_than_its_tolerance_has_zero_length() {
        // A cube 4e-4 mm across (0.4 µm: below MIN_FEATURE, but validate
        // doesn't judge feature sizes) has edges 4e-4 long. Edge 0 with a
        // tolerance of length / 0.9 ≈ 4.44e-4 (within TOL_INPUT_MAX) is no
        // longer than it: zero length. With length / 1.1 ≈ 3.64e-4 it is
        // an edge. At LINEAR it is 40 tolerances long.
        let small = hand_cube().transformed(&crate::geom::Transform::uniform_scale(4e-4));
        let len = small.edges[0].length();
        assert!(tolerance::rel_eq(len, 4e-4, tolerance::FP_REL));
        let zero = |tol: f64| {
            let mut b = small.clone();
            b.edges[0].tol = tol;
            let errs = validate(&b).err().unwrap_or_default();
            assert!(errs.iter().all(|e| e.category() == Category::Geometry), "{errs:?}");
            errs.contains(&ValidationError::ZeroLengthEdge { edge: 0 })
        };
        assert!(zero(len / 0.9));
        assert!(!zero(len / 1.1));
        assert_eq!(validate(&small), Ok(()));
    }

    #[test]
    fn tolerant_bodies_carry_real_gaps_and_validate() {
        // `fixtures::tolerant` (B0r rule 3): every entity carries tol and the
        // geometry uses 0.45·tol of it twice over. By hand on the cube at
        // T = TOL_INPUT_MAX: vertex 0 (the origin, bits 000) moves along
        // (1,1,1)/√3 by 0.45·T, so it is 0.45·T = 2.25e-4 from the ends of
        // its three edges, which stay at the origin; the top face (1, odd)
        // moves 0.45·T inwards (down) off its four edges.
        let t = tolerance::TOL_INPUT_MAX;
        let b = crate::fixtures::tolerant(&hand_cube(), t);
        assert!(b.vertices.iter().all(|v| v.tol == t) && b.edges.iter().all(|e| e.tol == t));
        let ends: Vec<DVec3> = b.edges.iter().flat_map(|e| [(e.start, e.t0), (e.end, e.t1)].map(|(v, t)| (v, e.curve.eval(t)))).filter(|&(v, _)| v == 0).map(|(_, p)| p).collect();
        assert_eq!(ends, vec![DVec3::ZERO; 3]);
        assert!(tolerance::rel_eq(b.vertices[0].point.length(), 2.25e-4, tolerance::FP_REL));
        assert!(tolerance::rel_eq(b.faces[1].surface.distance(DVec3::new(0.5, 0.5, 1.0)), 2.25e-4, 1e-9));
        // Every kind of body the kernel makes or tests with: valid with
        // the cap and with the loosest input tolerance; the same geometry
        // held to LINEAR fails (the gaps are 22.5 and 4.5 of it, so real);
        // 1.1× TOL_INPUT_MAX is refused by its range.
        let v = |p: &[(f64, f64)]| p.iter().map(|&(x, y)| glam::DVec2::new(x, y)).collect::<Vec<_>>();
        let l = crate::ops::profile::Profile::polygon(v(&[(0.0, 0.0), (10.0, 0.0), (10.0, 2.0), (2.0, 2.0), (2.0, 8.0), (0.0, 8.0)]), vec![]);
        let ring = crate::ops::profile::Profile::polygon(
            v(&[(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)]),
            vec![v(&[(3.0, 3.0), (3.0, 7.0), (7.0, 7.0), (7.0, 3.0)])],
        );
        use crate::fixtures::*;
        use crate::ops::{extrude::extrude, primitives};
        let bodies = [
            ("hand cube", hand_cube()),
            ("hand cylinder", hand_cylinder(1.0, 2.0)),
            ("hand tube", hand_tube(1.0, 2.0, 1.0, 0.0)),
            ("hand half cylinder", hand_half_cylinder(1.0, 2.0)),
            ("box", primitives::make_box(3.0, 4.0, 5.0).unwrap()),
            ("cylinder", primitives::make_cylinder(2.0, 5.0).unwrap()),
            ("sphere", primitives::make_sphere(2.0).unwrap()),
            ("L prism", extrude(&l, 3.0).unwrap()),
            ("square ring", extrude(&ring, 3.0).unwrap()),
        ];
        for (name, body) in &bodies {
            for t in [tolerance::TOL_CAP, tolerance::TOL_INPUT_MAX] {
                let b = tolerant(body, t);
                assert_eq!(validate(&b), Ok(()), "{name} at {t:e}");
                let mut tight = b.clone();
                tight.vertices.iter_mut().for_each(|v| v.tol = tolerance::LINEAR);
                tight.edges.iter_mut().for_each(|e| e.tol = tolerance::LINEAR);
                assert!(validate(&tight).is_err(), "{name} at {t:e}: its gaps are within LINEAR");
            }
            let errs = validate(&tolerant(body, 1.1 * tolerance::TOL_INPUT_MAX)).unwrap_err();
            let loose = errs.iter().filter(|e| matches!(e, ValidationError::VertexTolerance { .. } | ValidationError::EdgeTolerance { .. })).count();
            assert_eq!(loose, body.vertices.len() + body.edges.len(), "{name}: {errs:?}");
            assert_eq!(categories(&errs), [Category::Geometry], "{name}: {errs:?}");
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
        assert_eq!(categories(&errs), [Category::Geometry], "{errs:?}");
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
        // Every edge still used once each way, every curve where it was:
        // only which side the face is on is wrong.
        assert_eq!(categories(&errs), [Category::Solid]);
    }

    #[test]
    fn a_zero_area_outer_loop_is_not_called_inside_out() {
        // A plane face whose outer loop goes from (0,0,0) to (4,0,0) and
        // straight back on a second edge, enclosing nothing (shoelace: the
        // two cross products are 0 exactly), with a counter-clockwise
        // triangle (0,1) (2,1) (0,3) inside it, area ½·2·2 = 2. The net
        // area is 2 > AREA, so the face isn't zero-area; the outer loop
        // runs neither way, so it isn't FaceOrientation either (which
        // means "runs clockwise", area < 0). The geometry checks report
        // nothing: what's wrong here is for the topology and solid checks.
        let mut b = Body::default();
        let p = [(0.0, 0.0), (4.0, 0.0), (0.0, 1.0), (2.0, 1.0), (0.0, 3.0)].map(|(x, y)| b.add_vertex(DVec3::new(x, y, 0.0)));
        let c = |edge| crate::topology::Coedge { edge, reversed: false };
        let outer = Loop { coedges: vec![c(b.add_line(p[0], p[1])), c(b.add_line(p[1], p[0]))] };
        let inner = Loop { coedges: vec![c(b.add_line(p[2], p[3])), c(b.add_line(p[3], p[4])), c(b.add_line(p[4], p[2]))] };
        let plane = Surface::Plane { origin: DVec3::ZERO, normal: DVec3::Z, x_dir: DVec3::X };
        let f = b.add_face(plane, true, vec![outer, inner]);
        let areas: Vec<f64> = b.faces[f].loops.iter().map(|l| planar_loop_area(&b, &b.faces[f], l)).collect();
        assert!(areas[0] == 0.0 && tolerance::eq(areas[1], 2.0), "{areas:?}");
        let mut errs = vec![];
        check_geometry(&b, &mut errs);
        assert_eq!(errs, vec![]);
        // Flipped (normal −Z), the face sees the triangle run clockwise,
        // area −2, and the zero loop's area becomes −0.0, still not below
        // 0: nothing reported while the zero loop is first. With the
        // triangle first, the outer loop runs clockwise: FaceOrientation.
        b.faces[f].sense = false;
        let mut errs = vec![];
        check_geometry(&b, &mut errs);
        assert_eq!(errs, vec![]);
        b.faces[f].loops.swap(0, 1);
        let mut errs = vec![];
        check_geometry(&b, &mut errs);
        assert_eq!(errs, vec![ValidationError::FaceOrientation { face: f }]);
        // Found by the geometry pass, but which way a face faces is the
        // solid's question.
        assert_eq!(categories(&errs), [Category::Solid]);
    }

    #[test]
    fn inward_normal_is_caught() {
        let mut b = hand_cube();
        b.faces[4].sense = false;
        let errs = validate(&b).unwrap_err();
        assert_eq!(errs, vec![ValidationError::FaceOrientation { face: 4 }]);
        assert_eq!(categories(&errs), [Category::Solid]);
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
        // The counts are a cube's still; only sizes went to zero.
        assert_eq!(categories(&errs), [Category::Geometry], "{errs:?}");
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
        assert_eq!(categories(&errs), [Category::Solid]);
    }

    #[test]
    fn edge_with_only_its_end_dangling_is_reported() {
        let mut b = hand_cube();
        b.edges[0].end = 999;
        let errs = validate(&b).unwrap_err();
        assert!(matches!(errs[0], ValidationError::DanglingReference { .. }), "{errs:?}");
        assert_eq!(categories(&errs), [Category::Topology], "{errs:?}");
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
        // Two cubes apart are fine geometry; one shell can't hold both.
        assert_eq!(categories(&errs), [Category::Topology], "{errs:?}");
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
            [e @ ValidationError::InsideOut { volume, .. }] => assert!(tolerance::eq(*volume, -1.0) && e.category() == Category::Solid, "{volume}"),
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
        let up = Face { surface: Surface::Plane { origin: o, normal: DVec3::Z, x_dir: DVec3::X }, sense: true, loops: vec![], role: None };
        assert!(tolerance::eq(planar_loop_area(&b, &up, &l), 6.0));
        let down = Face { sense: false, ..up.clone() };
        assert!(tolerance::eq(planar_loop_area(&b, &down, &l), -6.0));
        let mut rev = l.clone();
        rev.coedges.reverse();
        rev.coedges.iter_mut().for_each(|c| c.reversed = true);
        assert!(tolerance::eq(planar_loop_area(&b, &up, &rev), -6.0));
    }

    #[test]
    fn planar_loop_area_on_a_slanted_face_by_hand() {
        // Corners (0,0,0), (1,0,1), (1,3,1), (0,3,0): sides (1,0,1), of
        // length √2, and (0,3,0), at right angles, so area 3√2. Their cross
        // product (1,0,1)×(0,3,0) = (−3, 0, 3) gives the normal they run
        // counter-clockwise about, (−1, 0, 1)/√2. Its x and z parts tie,
        // so the loop is measured in the yz projection, which runs
        // clockwise there: twice area −6, over 2·n_x = −√2, is 3√2.
        let mut b = Body::default();
        let corners = [(0.0, 0.0, 0.0), (1.0, 0.0, 1.0), (1.0, 3.0, 1.0), (0.0, 3.0, 0.0)].map(|(x, y, z)| DVec3::new(x, y, z));
        let v: Vec<usize> = corners.iter().map(|&p| b.add_vertex(p)).collect();
        let coedges = (0..4).map(|i| crate::topology::Coedge { edge: b.add_line(v[i], v[(i + 1) % 4]), reversed: false }).collect();
        let l = Loop { coedges };
        let normal = DVec3::new(-1.0, 0.0, 1.0) / 2f64.sqrt();
        let up = Face { surface: Surface::Plane { origin: DVec3::ZERO, normal, x_dir: DVec3::new(1.0, 0.0, 1.0) / 2f64.sqrt() }, sense: true, loops: vec![], role: None };
        assert!(tolerance::rel_eq(planar_loop_area(&b, &up, &l), 3.0 * 2f64.sqrt(), tolerance::FP_REL));
        let down = Face { sense: false, ..up };
        assert!(tolerance::rel_eq(planar_loop_area(&b, &down, &l), -3.0 * 2f64.sqrt(), tolerance::FP_REL));
    }

    #[test]
    fn planar_loop_area_sign_of_a_sliver_is_exact() {
        // The sliver of tolerance::tests (o, A = (1 + t, 1), B = (1, 1 − t),
        // C = (0, t²/2), t = 2⁻³⁰): twice its area is −t²/2 = −2⁻⁶¹ exactly,
        // clockwise, where the plain shoelace sum says +2⁻⁶¹. On the
        // face x = 5 with corners (5, y, z): seen from +x the yz plane runs
        // counter-clockwise, so the loop's area about +x is −2⁻⁶², and
        // about −x (sense false) +2⁻⁶².
        let t = (2f64).powi(-30);
        let yz = [(0.0, 0.0), (1.0 + t, 1.0), (1.0, 1.0 - t), (0.0, t * t / 2.0)];
        let mut b = Body::default();
        let v: Vec<usize> = yz.iter().map(|&(y, z)| b.add_vertex(DVec3::new(5.0, y, z))).collect();
        let coedges = (0..4).map(|i| crate::topology::Coedge { edge: b.add_line(v[i], v[(i + 1) % 4]), reversed: false }).collect();
        let l = Loop { coedges };
        let plane = Surface::Plane { origin: DVec3::new(5.0, 0.0, 0.0), normal: DVec3::X, x_dir: DVec3::Y };
        let f = Face { surface: plane, sense: true, loops: vec![], role: None };
        assert_eq!(planar_loop_area(&b, &f, &l), -(2f64).powi(-62));
        assert_eq!(planar_loop_area(&b, &Face { sense: false, ..f }, &l), (2f64).powi(-62));
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
            (VertexOffEdge { edge: 4, vertex: 7, distance: 0.5, tol: 3e-5 }, vec!["vertex 7", "edge 4", "5e-1", "vertex's tolerance of 3e-5"]),
            (EdgeOffFace { edge: 3, face: 1, distance: 0.25, tol: 2e-5 }, vec!["edge 3", "face 1", "2.5e-1", "edge's tolerance of 2e-5"]),
            (VertexTolerance { vertex: 5, tol: 6e-4 }, vec!["vertex 5", "tolerance of 6e-4", "1e-5 to 5e-4"]),
            (EdgeTolerance { edge: 9, tol: f64::NAN }, vec!["edge 9", "tolerance of NaN", "1e-5 to 5e-4"]),
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
    fn every_error_is_in_the_category_decision_8_gives_it() {
        // B0 decision 8, worked from what each check asks, not from the
        // match: topology needs only indices and counts; geometry needs
        // coordinates and tolerances but no idea of inside; solid asks
        // which side is inside, or whether the body crosses itself.
        use ValidationError::*;
        let p = DVec3::ZERO;
        let table = [
            (DanglingReference { face: 0, what: "edge 9".into() }, Category::Topology), // an index past its arena
            (EmptyLoop { face: 0, loop_index: 0 }, Category::Topology),                    // a list's length
            (LoopNotClosed { face: 0, loop_index: 0, position: 0 }, Category::Topology),   // vertex indices compared
            (EdgeUseCount { edge: 0, uses: 1 }, Category::Topology),                       // a count of uses
            (EdgeSameDirection { edge: 0 }, Category::Topology),                           // two reversed flags compared
            (FaceShellCount { face: 0, shells: 0 }, Category::Topology),                   // a count of shells
            (ShellNotConnected { shell: 0 }, Category::Topology),                          // a walk over shared edges
            (EulerPoincare { shell: 0, v: 8, e: 12, f: 5, rings: 0 }, Category::Topology), // V − E + F − R
            (VertexOffEdge { edge: 0, vertex: 0, distance: 1.0, tol: 1e-5 }, Category::Geometry), // a distance
            (EdgeOffFace { edge: 0, face: 0, distance: 1.0, tol: 1e-5 }, Category::Geometry),     // a distance
            (ZeroLengthEdge { edge: 0 }, Category::Geometry),                              // a length
            (VertexTolerance { vertex: 0, tol: 0.0 }, Category::Geometry),                 // how far it may be off
            (EdgeTolerance { edge: 0, tol: 0.0 }, Category::Geometry),                     // how far it may be off
            (ZeroAreaFace { face: 0 }, Category::Geometry),                                // an area's size
            (FaceOrientation { face: 0 }, Category::Solid),                                // an area's sign: which side is out
            (LoopOrientation { face: 0, loop_index: 0 }, Category::Solid),                 // which side of a loop the face is
            (Tessellation { face: 0, message: "face boundary crosses itself".into() }, Category::Solid), // no region to mesh
            (MeshNotClosed { problems: 1 }, Category::Solid),                              // the mesh bounds no region
            (InsideOut { shell: 0, volume: -1.0 }, Category::Solid),                       // the region's sign
            (EdgesMeet { a: 0, b: 1, point: p }, Category::Solid),                         // crossing itself
            (EdgeMeetsFace { edge: 0, face: 1, point: p }, Category::Solid),               // crossing itself
            (FacesMeet { a: 0, b: 1, point: p }, Category::Solid),                         // crossing itself
        ];
        for (e, want) in &table {
            assert_eq!(e.category(), *want, "{e}");
        }
        // Every variant once: 8 topology, 6 geometry, 8 solid, 22 in all
        // (`category` has no catch-all arm, so a new one won't compile
        // without a category; this table must then grow too).
        let count = |c: Category| table.iter().filter(|(_, w)| *w == c).count();
        assert_eq!((count(Category::Topology), count(Category::Geometry), count(Category::Solid)), (8, 6, 8));
        assert_eq!(Category::ALL.map(Category::name), ["topology", "geometry", "solid"]);
        assert_eq!(Category::Geometry.to_string(), "geometry");
        assert!(Category::Topology < Category::Geometry && Category::Geometry < Category::Solid, "reports list them in this order");
    }

    #[test]
    fn reports_group_errors_by_category() {
        // Found in this order (as `check_geometry` finds a zero-area face
        // and a clockwise one in the same pass, then a short edge): the
        // report lists the topology error first, then the two geometry ones
        // in the order found, then the solid one, each saying its category.
        use ValidationError::*;
        let found = [ZeroAreaFace { face: 2 }, FaceOrientation { face: 5 }, ZeroLengthEdge { edge: 3 }, EdgeUseCount { edge: 1, uses: 1 }];
        assert_eq!(
            report_lines(&found),
            [
                "topology: edge 1 is used 1 times (must be 2)",
                "geometry: face 2 has zero area",
                "geometry: edge 3 has zero length",
                "solid: face 5: normal disagrees with its boundary loop",
            ]
        );
        assert!(report_lines(&[]).is_empty());
        // A real body: face 0's loop turned round (`flipped_loop_breaks_orientation`)
        // reports its four edges' topology before the face's orientation.
        let mut b = hand_cube();
        let l = &mut b.faces[0].loops[0].coedges;
        l.reverse();
        l.iter_mut().for_each(|c| c.reversed = !c.reversed);
        let lines = report_lines(&validate(&b).unwrap_err());
        assert_eq!(lines.len(), 5, "{lines:?}");
        assert!(lines[..4].iter().all(|l| l.starts_with("topology: edge ") && l.ends_with("used twice in the same direction")), "{lines:?}");
        assert_eq!(lines[4], "solid: face 0: normal disagrees with its boundary loop");
    }

    /// splitmix64, so every run breaks the same bodies the same way.
    fn splitmix(state: &mut u64) -> u64 {
        *state = state.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = *state;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    #[test]
    fn seeded_breaks_land_in_the_category_their_kind_predicts() {
        // Model: a break that touches only references and counts gives
        // topology errors only; one that moves an entity or its tolerance
        // gives geometry errors only; one that turns a face or the whole
        // body round, or overlaps two solids, gives solid errors only. For
        // each break the model also names the exact errors where it can
        // (which vertex, which edges, which face). Bodies: boxes, cubes
        // moved far out, L prisms, square rings, cylinders and tubes, of
        // seeded sizes; 1,200 breaks from one seed.
        use crate::ops::{extrude::extrude, primitives};
        use crate::ops::profile::Profile;
        use crate::geom::Transform;
        const SEED: u64 = 0x31b0_ca7e;
        let mut state = SEED;
        let mut unit = || (splitmix(&mut state) >> 11) as f64 / (1u64 << 53) as f64;
        let mut kinds = [0usize; 10];
        for case in 0..1200 {
            let size = 0.5 + 49.5 * unit();
            let v = |p: &[(f64, f64)]| p.iter().map(|&(x, y)| glam::DVec2::new(x * size, y * size)).collect::<Vec<_>>();
            let shape = (unit() * 6.0) as usize;
            let body = match shape {
                0 => primitives::make_box(size, 0.5 + 49.5 * unit(), 0.5 + 49.5 * unit()).unwrap(),
                1 => hand_cube().transformed(&Transform::uniform_scale(size)).transformed(&Transform::translation(DVec3::splat(1e3 * unit()))),
                2 => extrude(&Profile::polygon(v(&[(0.0, 0.0), (1.0, 0.0), (1.0, 0.2), (0.2, 0.2), (0.2, 0.8), (0.0, 0.8)]), vec![]), size).unwrap(),
                3 => extrude(&Profile::polygon(v(&[(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)]), vec![v(&[(0.3, 0.3), (0.3, 0.7), (0.7, 0.7), (0.7, 0.3)])]), size).unwrap(),
                4 => primitives::make_cylinder(size, 0.5 + 49.5 * unit()).unwrap(),
                _ => crate::fixtures::hand_tube(size, 2.0 * size, size, 0.0),
            };
            assert_eq!(validate(&body), Ok(()), "case {case}: the unbroken body");
            let pick = |u: f64, n: usize| ((u * n as f64) as usize).min(n - 1);
            let planar: Vec<usize> = (0..body.faces.len()).filter(|&f| matches!(body.faces[f].surface, Surface::Plane { .. })).collect();
            let mut b = body.clone();
            let kind = pick(unit(), kinds.len());
            kinds[kind] += 1;
            // (category, the errors the model names exactly, or None when it
            // names only one that must be among them)
            let (want, exact, among): (Category, Option<Vec<ValidationError>>, Option<ValidationError>) = match kind {
                0 => {
                    // A face dropped from its shell (left in the arena).
                    let f = b.shells[0].faces.remove(pick(unit(), body.shells[0].faces.len()));
                    (Category::Topology, None, Some(ValidationError::FaceShellCount { face: f, shells: 0 }))
                }
                1 => {
                    // A face listed twice in its shell.
                    let f = body.shells[0].faces[pick(unit(), body.shells[0].faces.len())];
                    b.shells[0].faces.push(f);
                    (Category::Topology, None, Some(ValidationError::FaceShellCount { face: f, shells: 2 }))
                }
                2 => {
                    // A coedge pointing past the edges: that alone, since
                    // nothing else is checked once a reference dangles.
                    let f = pick(unit(), b.faces.len());
                    let edge = b.edges.len() + pick(unit(), 1000);
                    b.faces[f].loops[0].coedges[0].edge = edge;
                    (Category::Topology, Some(vec![ValidationError::DanglingReference { face: f, what: format!("edge {edge}") }]), None)
                }
                3 => {
                    // An empty loop added to a face.
                    let f = pick(unit(), b.faces.len());
                    b.faces[f].loops.push(Loop { coedges: vec![] });
                    let loop_index = b.faces[f].loops.len() - 1;
                    (Category::Topology, None, Some(ValidationError::EmptyLoop { face: f, loop_index }))
                }
                4 => {
                    // A vertex moved 1.1 to 10,000 of its tolerances in a
                    // seeded direction: off every edge end it joins, at
                    // that distance (the ends stay; the edges' curves, so
                    // the faces' areas, don't move).
                    let vtx = pick(unit(), b.vertices.len());
                    let d = b.vertices[vtx].tol * 1.1 * crate::fmath::powf(10.0, 4.0 * unit());
                    // Uniform on the sphere: z uniform in [−1, 1], longitude uniform.
                    let z = 2.0 * unit() - 1.0;
                    let (sin, cos) = crate::fmath::sin_cos(std::f64::consts::TAU * unit());
                    let r = (1.0 - z * z).sqrt();
                    b.vertices[vtx].point += DVec3::new(r * cos, r * sin, z) * d;
                    let mut want = vec![];
                    for (ei, e) in b.edges.iter().enumerate() {
                        for (vertex, t) in [(e.start, e.t0), (e.end, e.t1)] {
                            if vertex == vtx {
                                let distance = e.curve.eval(t).distance(b.vertices[vtx].point);
                                assert!(tolerance::rel_eq(distance, d, 1e-6), "case {case}: {distance} vs {d}");
                                want.push(ValidationError::VertexOffEdge { edge: ei, vertex, distance, tol: b.vertices[vtx].tol });
                            }
                        }
                    }
                    (Category::Geometry, Some(want), None)
                }
                5 | 6 => {
                    // A tolerance no entity may carry, on a vertex (5) or
                    // an edge (6): below LINEAR, past TOL_INPUT_MAX, or NaN.
                    let tol = match pick(unit(), 3) {
                        0 => tolerance::LINEAR * (0.01 + 0.89 * unit()),
                        1 => tolerance::TOL_INPUT_MAX * (1.1 + unit()),
                        _ => f64::NAN,
                    };
                    let e = if kind == 5 {
                        let vertex = pick(unit(), b.vertices.len());
                        b.vertices[vertex].tol = tol;
                        ValidationError::VertexTolerance { vertex, tol }
                    } else {
                        let edge = pick(unit(), b.edges.len());
                        b.edges[edge].tol = tol;
                        ValidationError::EdgeTolerance { edge, tol }
                    };
                    (Category::Geometry, Some(vec![e]), None)
                }
                7 => {
                    // A plane moved 1.1 to 1,000 of its edges' tolerance
                    // along its normal, either way: each of its edges off it.
                    let f = planar[pick(unit(), planar.len())];
                    let d = tolerance::LINEAR * 1.1 * crate::fmath::powf(10.0, 3.0 * unit()) * if unit() < 0.5 { -1.0 } else { 1.0 };
                    if let Surface::Plane { origin, normal, .. } = &mut b.faces[f].surface {
                        *origin += *normal * d;
                    }
                    let mut edges: Vec<usize> = b.faces[f].loops.iter().flat_map(|l| l.coedges.iter().map(|c| c.edge)).collect();
                    edges.sort_unstable();
                    let want = edges.iter().map(|&edge| ValidationError::EdgeOffFace { edge, face: f, distance: d.abs(), tol: b.edges[edge].tol }).collect();
                    (Category::Geometry, Some(want), None)
                }
                8 => {
                    // A planar face turned to face inwards: its outer loop
                    // now runs clockwise round its normal, and that alone.
                    let f = planar[pick(unit(), planar.len())];
                    b.faces[f].sense = !b.faces[f].sense;
                    (Category::Solid, Some(vec![ValidationError::FaceOrientation { face: f }]), None)
                }
                _ => {
                    // The body and a copy moved along every axis: two
                    // shells, each sound, crossing. Across the profile by 2
                    // to 15% of the body's box, less than the L's and the
                    // ring's arms are wide (20%, 30%), so the copy's corner
                    // overlaps the original's (an L moved 30% each way
                    // sits in its own notch, touching nothing); up the
                    // extrusion by 10 to 70%.
                    let (lo, hi) = body.bounds();
                    let shift = (hi - lo) * DVec3::new(0.02 + 0.13 * unit(), 0.02 + 0.13 * unit(), 0.1 + 0.6 * unit());
                    b = crate::fixtures::two_shells(&body, &body.transformed(&Transform::translation(shift)));
                    (Category::Solid, None, None)
                }
            };
            let errs = validate(&b).expect_err(&format!("case {case}, kind {kind}, shape {shape}: the break went unnoticed"));
            assert_eq!(categories(&errs), [want], "case {case}, kind {kind} (seed {SEED:#x}): {errs:?}");
            if let Some(e) = among {
                assert!(errs.contains(&e), "case {case}, kind {kind}: {e:?} not in {errs:?}");
            }
            if let Some(mut want) = exact {
                // Distances and tolerances compared to the model's within
                // rounding, NaN as NaN; everything else exactly.
                let key = |e: &ValidationError| format!("{:?}", ValidationError::category(e)) + &e.edges().iter().chain(&e.vertices()).chain(&e.faces()).map(|i| format!(" {i}")).collect::<String>();
                let mut got = errs.clone();
                got.sort_by_key(key);
                want.sort_by_key(key);
                assert_eq!(got.len(), want.len(), "case {case}, kind {kind}: {got:?} vs {want:?}");
                for (g, w) in got.iter().zip(&want) {
                    let close = |a: f64, b: f64| (a.is_nan() && b.is_nan()) || tolerance::rel_eq(a, b, 1e-6);
                    let same = match (g, w) {
                        (ValidationError::VertexOffEdge { edge: a, vertex: v, distance: d, tol: t }, ValidationError::VertexOffEdge { edge: b, vertex: u, distance: e, tol: s }) => a == b && v == u && close(*d, *e) && t == s,
                        (ValidationError::EdgeOffFace { edge: a, face: f, distance: d, tol: t }, ValidationError::EdgeOffFace { edge: b, face: g, distance: e, tol: u }) => a == b && f == g && close(*d, *e) && t == u,
                        (ValidationError::VertexTolerance { vertex: a, tol: t }, ValidationError::VertexTolerance { vertex: b, tol: u })
                        | (ValidationError::EdgeTolerance { edge: a, tol: t }, ValidationError::EdgeTolerance { edge: b, tol: u }) => a == b && close(*t, *u),
                        _ => g == w,
                    };
                    assert!(same, "case {case}, kind {kind}: got {g:?}, model says {w:?}");
                }
            }
        }
        // Every kind of break ran often enough to mean something.
        assert!(kinds.iter().all(|&n| n >= 80), "{kinds:?}");
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
        assert!(html.contains("geometry: vertex 7 is 2.5e-1 mm off edge 5"), "{message}");
        assert!(message.contains("\n  geometry: vertex 7 is 2.5e-1 mm off edge 5"), "the panic groups its errors too: {message}");
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
    #[test]
    fn validate_meshed_hands_back_the_display_mesh() {
        // The mesh the app shows comes from validation now, so it must be
        // exactly what tessellating for display gives; an invalid body gives
        // only its errors.
        for body in [hand_cube(), crate::fixtures::hand_tube(1.0, 2.0, 3.0, 0.4), crate::ops::primitives::make_sphere(2.0).unwrap()] {
            assert_eq!(validate_meshed(&body).unwrap(), tessellate(&body, &TessOptions::DISPLAY).unwrap());
        }
        let mut b = hand_cube();
        b.vertices[7].point.z += 0.5;
        assert_eq!(validate_meshed(&b).unwrap_err(), validate(&b).unwrap_err());
    }

    #[test]
    fn each_shell_s_volume_counts_only_its_own_faces() {
        // A 3 mm cube (27 mm³) and, apart from it, a unit cube turned inside
        // out (−1 mm³) as two shells of one body: only shell 1 is inside out,
        // with exactly −1 mm³. Counting every face for every shell would give
        // 26 mm³ for both and miss it.
        let big = hand_cube().transformed(&crate::geom::Transform::uniform_scale(3.0));
        let mut small = hand_cube().transformed(&crate::geom::Transform::translation(DVec3::new(10.0, 0.0, 0.0)));
        for f in &mut small.faces {
            f.sense = !f.sense;
            for l in &mut f.loops {
                l.coedges.reverse();
                l.coedges.iter_mut().for_each(|c| c.reversed = !c.reversed);
            }
        }
        match validate(&crate::fixtures::two_shells(&big, &small)).unwrap_err().as_slice() {
            [e @ ValidationError::InsideOut { shell: 1, volume }] => assert!(tolerance::eq(*volume, -1.0) && e.category() == Category::Solid, "{volume}"),
            other => panic!("{other:?}"),
        }
    }
}
