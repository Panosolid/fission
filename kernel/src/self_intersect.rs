//! The self-intersection check in `validate`: no two parts of a body's
//! boundary may meet or come within LINEAR of each other, except where its
//! topology says they meet (at shared vertices and along shared edges).
//!
//! Three tests, together complete for faces on planes, cylinders and
//! spheres bounded by lines and circles:
//! 1. Edge–edge: two edges meet only at the vertices they share.
//! 2. Edge–face: an edge meets a face it doesn't bound only at vertices
//!    they share (an edge lying in another face's surface is tested at
//!    its middle).
//! 3. Face–face: where two surfaces cross along a closed curve, a few
//!    points of that curve must not be inside both faces.
//!
//! Why that is enough: where two faces cross, the crossing curve either
//! reaches the edge of one of them, and there an edge meets the other face
//! (test 2), or it never does, so it is a closed curve inside both (test 3).
//! A closed curve is either wholly inside both faces or leaves one of
//! them through an edge (test 2 again), so a few points of it decide.
//!
//! intersect.rs proposes candidate points; every decision here measures:
//! a candidate counts only if it is within LINEAR of both parts and, for a
//! face, strictly inside it (more than LINEAR from its edges).
//!
//! Known limits (each documented where it applies):
//! - Faces on other surfaces (NURBS, steps 63–64) are not checked yet.
//! - A cylinder face bounded by anything other than lines along it and
//!   circles round it can't be classified (booleans make such faces,
//!   steps 46–47); points on it are not reported.
//! - A shell wholly inside another (a body inside a body, not touching)
//!   meets nothing, so it passes; voids come with booleans.
//!
//! Mutation testing (`cargo mutants`, lib tests) leaves these survivors,
//! all equivalent or ties at exactly a threshold:
//! - `check`, the sphere face box, `- pad` → `/ pad`: by precedence that is
//!   centre − r/LINEAR, a far bigger box, so it only stops pruning; so does
//!   `&&` → `||` in `overlapping`'s box test.
//! - `edges_meet`, `along_each_other`'s `&&` → `||`: one edge within LINEAR
//!   of the other's whole line or circle but not the reverse happens only
//!   at slants inside tolerance, and there the four ends (always candidates)
//!   find what the samples would. Checked: 1200 pairs of star prisms (with
//!   and without arcs), cubes and half cylinders turned by 1e-6, 1e-3 and
//!   1 rad and moved by as much gave identical reports.
//! - `> LINEAR` → `>= LINEAR` from a known vertex in `edge_meets_face`: a
//!   candidate exactly LINEAR from a shared vertex. (The same tie in
//!   `edges_meet` is killed by
//!   `validate::tests::vertex_exactly_linear_off_its_edges_is_on`.)
//! - `edge_meets_face`, the `==` in the `known` dedup → `!=`: drops the
//!   second shared vertex when both ends are f's vertices. That vertex is on
//!   f's boundary, so `classify` never calls it inside; only dividing out
//!   its root could matter, at an edge tangent there. Checked: 1200 edges
//!   tangent to balls of radius 100 mm to 1 km, 10 mm to 10 m long, in 100
//!   turns, arriving at the vertex with it left out of `known` altogether,
//!   report nothing (rounding splits the root only where the edge starts,
//!   `a_tangent_edge_at_a_shared_vertex_is_not_a_meeting`).
//! - `faces_meet`, `size(i) <= size(j)` → `>`: only the order of two
//!   `classify` calls that must both say inside.
//! - `classify`, `d < best` → `<=`: a tie between equally near edges; the
//!   path from either nearest point crosses no edge, so either decides the
//!   same. `* ±1` → `/ ±1` (normal, edge direction): exact. `> 0.0` →
//!   `>= 0.0`: the path is perpendicular to the edge at an inner nearest
//!   point, so the product is 0 only for a path of length 0, already the
//!   boundary.
//! - `corner_contains`, `a > 0.0` → `>=`, `a < angle(..)` → `<=`: a path
//!   leaving exactly along one of the corner's edges.
//! - `along_surface`, `+ PI` → `- PI` in the cylinder's turn: d − π and
//!   d + π differ by 2π, the same after `rem_euclid(TAU)`.

use crate::geom::{Curve, Surface};
use crate::intersect::{closed_meetings, curve_curve, curve_surface};
use crate::tolerance::{ANGULAR, LINEAR};
use crate::topology::{Body, Coedge, Edge, EdgeId, FaceId, VertexId};
use crate::validate::ValidationError;
use glam::DVec3;
use std::f64::consts::{PI, TAU};

/// Self-intersection errors reported at most, so a badly broken body
/// doesn't make the check, or its report, run on.
pub const MAX_REPORTED: usize = 8;

/// Fractions along an edge sampled to see whether it lies in a surface or
/// along another edge.
const ALONG: [f64; 5] = [0.0, 0.25, 0.5, 0.75, 1.0];

type Bounds = (DVec3, DVec3);

pub(crate) fn check(body: &Body, errs: &mut Vec<ValidationError>) {
    let pad = DVec3::splat(LINEAR);
    let edge_boxes: Vec<Bounds> = body.edges.iter().map(|e| e.bounds()).map(|(lo, hi)| (lo - pad, hi + pad)).collect();
    let face_boxes: Vec<Bounds> = body
        .faces
        .iter()
        .map(|f| {
            let (mut lo, mut hi) = (DVec3::INFINITY, DVec3::NEG_INFINITY);
            for c in f.loops.iter().flat_map(|l| &l.coedges) {
                let (a, b) = edge_boxes[c.edge];
                lo = lo.min(a);
                hi = hi.max(b);
            }
            // A sphere face bulges past its edges (a hemisphere past its
            // equator); planar and cylinder faces lie within their edges'
            // box (every point is between edge points along a line).
            if let Surface::Sphere { center, radius, .. } = f.surface {
                lo = lo.min(center - DVec3::splat(radius) - pad);
                hi = hi.max(center + DVec3::splat(radius) + pad);
            }
            (lo, hi)
        })
        .collect();
    let face_vertices: Vec<Vec<VertexId>> = body
        .faces
        .iter()
        .map(|f| {
            let mut vs: Vec<VertexId> = f
                .loops
                .iter()
                .flat_map(|l| &l.coedges)
                .flat_map(|c| [body.edges[c.edge].start, body.edges[c.edge].end])
                .collect();
            vs.sort_unstable();
            vs.dedup();
            vs
        })
        .collect();
    let face_edges: Vec<Vec<EdgeId>> = body
        .faces
        .iter()
        .map(|f| {
            let mut es: Vec<EdgeId> = f.loops.iter().flat_map(|l| &l.coedges).map(|c| c.edge).collect();
            es.sort_unstable();
            es
        })
        .collect();

    let full = |errs: &Vec<ValidationError>, before: usize| errs.len() - before >= MAX_REPORTED;
    let before = errs.len();
    for (i, j) in overlapping(&edge_boxes, &edge_boxes, true) {
        if let Some(point) = edges_meet(body, i, j) {
            errs.push(ValidationError::EdgesMeet { a: i.min(j), b: i.max(j), point });
            if full(errs, before) {
                return;
            }
        }
    }
    for (e, f) in overlapping(&edge_boxes, &face_boxes, false) {
        if face_edges[f].binary_search(&e).is_ok() {
            continue;
        }
        if let Some(point) = edge_meets_face(body, e, f, &face_vertices[f]) {
            errs.push(ValidationError::EdgeMeetsFace { edge: e, face: f, point });
            if full(errs, before) {
                return;
            }
        }
    }
    for (i, j) in overlapping(&face_boxes, &face_boxes, true) {
        if let Some(point) = faces_meet(body, i, j) {
            errs.push(ValidationError::FacesMeet { a: i.min(j), b: i.max(j), point });
            if full(errs, before) {
                return;
            }
        }
    }
}

/// Pairs (i, j) whose boxes overlap, i from `a` and j from `b`; with
/// `same`, a and b are one list and each pair comes once with i ≠ j.
/// Sweep along x: sorted by their low x, a box only meets boxes whose low
/// x it has not yet passed.
fn overlapping(a: &[Bounds], b: &[Bounds], same: bool) -> Vec<(usize, usize)> {
    let meets = |p: &Bounds, q: &Bounds| p.0.cmple(q.1).all() && q.0.cmple(p.1).all();
    let mut items: Vec<(f64, bool, usize)> = a.iter().enumerate().map(|(i, x)| (x.0.x, false, i)).collect();
    if !same {
        items.extend(b.iter().enumerate().map(|(j, x)| (x.0.x, true, j)));
    }
    items.sort_by(|x, y| x.0.total_cmp(&y.0));
    let (mut open_a, mut open_b): (Vec<usize>, Vec<usize>) = (Vec::new(), Vec::new());
    let mut out = Vec::new();
    for (lo_x, from_b, k) in items {
        open_a.retain(|&i| a[i].1.x >= lo_x);
        open_b.retain(|&j| b[j].1.x >= lo_x);
        if same {
            out.extend(open_a.iter().filter(|&&i| meets(&a[i], &a[k])).map(|&i| (i, k)));
            open_a.push(k);
        } else if from_b {
            out.extend(open_a.iter().filter(|&&i| meets(&a[i], &b[k])).map(|&i| (i, k)));
            open_b.push(k);
        } else {
            out.extend(open_b.iter().filter(|&&j| meets(&a[k], &b[j])).map(|&j| (k, j)));
            open_a.push(k);
        }
    }
    out
}

/// A point where edges i and j meet other than at a vertex they share.
fn edges_meet(body: &Body, i: EdgeId, j: EdgeId) -> Option<DVec3> {
    let (a, b) = (&body.edges[i], &body.edges[j]);
    let mut shared: Vec<VertexId> = [a.start, a.end].into_iter().filter(|v| *v == b.start || *v == b.end).collect();
    shared.dedup();
    let known: Vec<DVec3> = shared.iter().map(|&v| body.vertices[v].point).collect();
    let along_each_other = ALONG.iter().all(|&s| a.curve.distance(b.point_at(s)) <= LINEAR)
        && ALONG.iter().all(|&s| b.curve.distance(a.point_at(s)) <= LINEAR);
    let candidates: Vec<DVec3> = if along_each_other {
        // On one line or circle: they overlap if an end or a sample of one
        // lies inside the other (an overlap's ends are ends of one of them).
        ALONG.iter().flat_map(|&s| [a.point_at(s), b.point_at(s)]).collect()
    } else {
        let mut c = curve_curve(&a.curve, &b.curve, &known);
        // An end of one touching the other (a T), however they lie.
        c.extend([a.point_at(0.0), a.point_at(1.0), b.point_at(0.0), b.point_at(1.0)]);
        c
    };
    candidates
        .into_iter()
        .find(|&p| a.distance(p) <= LINEAR && b.distance(p) <= LINEAR && known.iter().all(|k| k.distance(p) > LINEAR))
}

/// A point where edge e meets face f other than at a vertex they share.
fn edge_meets_face(body: &Body, ei: EdgeId, fi: FaceId, face_vertices: &[VertexId]) -> Option<DVec3> {
    let e = &body.edges[ei];
    let surface = &body.faces[fi].surface;
    let mut known: Vec<(f64, DVec3)> = Vec::new();
    for (v, t) in [(e.start, e.t0), (e.end, e.t1)] {
        if face_vertices.binary_search(&v).is_ok() && !known.iter().any(|k| k.1 == body.vertices[v].point) {
            known.push((t, body.vertices[v].point));
        }
    }
    let in_surface = ALONG.iter().all(|&s| surface.distance(e.point_at(s)) <= LINEAR);
    let candidates: Vec<DVec3> = if in_surface {
        // The edge's inside meets no edge of f (the edge–edge test), so it
        // is all inside f or all outside: its middle decides.
        vec![e.point_at(0.25), e.point_at(0.5), e.point_at(0.75)]
    } else {
        let params: Vec<f64> = known.iter().map(|k| k.0).collect();
        let mut c: Vec<DVec3> = curve_surface(&e.curve, surface, &params).into_iter().map(|t| e.curve.eval(t)).collect();
        // A vertex resting on the face.
        c.extend([e.point_at(0.0), e.point_at(1.0)]);
        c
    };
    candidates.into_iter().find(|&p| {
        e.distance(p) <= LINEAR
            && surface.distance(p) <= LINEAR
            && known.iter().all(|k| k.1.distance(p) > LINEAR)
            && classify(body, fi, p) == Where::Inside
    })
}

/// A point inside both faces i and j where their surfaces cross.
fn faces_meet(body: &Body, i: FaceId, j: FaceId) -> Option<DVec3> {
    let (fa, fb) = (&body.faces[i], &body.faces[j]);
    // Classify against the face with fewer edges first: most candidates
    // are outside it, and that settles them cheaply.
    let size = |f: FaceId| body.faces[f].loops.iter().map(|l| l.coedges.len()).sum::<usize>();
    let (first, second) = if size(i) <= size(j) { (i, j) } else { (j, i) };
    closed_meetings(&fa.surface, &fb.surface).into_iter().find(|&p| {
        fa.surface.distance(p) <= LINEAR
            && fb.surface.distance(p) <= LINEAR
            && classify(body, first, p) == Where::Inside
            && classify(body, second, p) == Where::Inside
    })
}

/// Where a point of a face's surface lies relative to the face.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Where {
    /// More than LINEAR from the face's edges, on the face.
    Inside,
    /// Within LINEAR of one of its edges.
    Boundary,
    Outside,
    /// The face has an edge this can't measure along (see the module notes).
    Unknown,
}

/// Classifies `q`, a point on face fi's surface. The nearest point of the
/// face's boundary, measured along the surface, is found; the shortest
/// path from there to q crosses no edge (anything it crossed would be
/// nearer), so q is inside exactly when that path sets off into the face:
/// to the left of the edge (outward normal × edge direction points into
/// the face), or, at a vertex, into the corner between its two edges.
///
/// Along the surface: on a plane, straight; on a sphere, along a great
/// circle, and the straight-line distance between two points of a sphere
/// grows with the great-circle one, so the nearest point is the same; on a
/// cylinder, unrolled flat, where lines along it and circles round it are
/// straight lines, and the nearest point on each such edge is the
/// straight-line nearest one, but which edge is nearest needs the
/// unrolled distance (the far side of a cylinder is near in space).
pub(crate) fn classify(body: &Body, fi: FaceId, q: DVec3) -> Where {
    let f = &body.faces[fi];
    let surface = &f.surface;
    let mut best: Option<(f64, Coedge, f64, Option<bool>)> = None;
    for c in f.loops.iter().flat_map(|l| &l.coedges) {
        let e = &body.edges[c.edge];
        if !measurable_on(e, surface) {
            return Where::Unknown;
        }
        let (t, end) = e.closest(q);
        let p = e.curve.eval(t);
        if p.distance(q) <= LINEAR {
            return Where::Boundary;
        }
        let d = match surface {
            // Straight-line distance orders points as the distance along a
            // plane or sphere does.
            Surface::Plane { .. } | Surface::Sphere { .. } => p.distance(q),
            Surface::Cylinder { .. } => along_surface(surface, p, q).length(),
        };
        if best.is_none_or(|b| d < b.0) {
            best = Some((d, *c, t, end));
        }
    }
    let Some((_, c, t, end)) = best else {
        return Where::Inside; // no edges: the face is its whole surface
    };
    let e = &body.edges[c.edge];
    let p = e.curve.eval(t);
    let normal = surface.normal_at(p) * if f.sense { 1.0 } else { -1.0 };
    let path = along_surface(surface, p, q);
    let inside = match end {
        None => {
            let along = e.curve.derivative(t) * if c.reversed { -1.0 } else { 1.0 };
            normal.cross(along).dot(path) > 0.0
        }
        Some(at_end) => {
            let v = if at_end { e.end } else { e.start };
            match corner_contains(body, fi, v, normal, path) {
                Some(inside) => inside,
                None => return Where::Unknown,
            }
        }
    };
    if inside {
        Where::Inside
    } else {
        Where::Outside
    }
}

/// Whether `dir` (in the tangent plane at vertex v, outward normal n)
/// points into face fi: into the corner between an edge arriving at v and
/// the next one leaving, turning counter-clockwise (about n) from the
/// leaving edge round to the arriving one. None if v is on no loop of fi.
fn corner_contains(body: &Body, fi: FaceId, v: VertexId, n: DVec3, dir: DVec3) -> Option<bool> {
    let angle = |from: DVec3, x: DVec3| n.dot(from.cross(x)).atan2(from.dot(x)).rem_euclid(TAU);
    let mut seen = false;
    for l in &body.faces[fi].loops {
        for (k, cin) in l.coedges.iter().enumerate() {
            let cout = l.coedges[(k + 1) % l.coedges.len()];
            let (end, t_in) = coedge_end(&body.edges[cin.edge], *cin);
            if end != v {
                continue;
            }
            seen = true;
            let t_out = coedge_start(&body.edges[cout.edge], cout);
            let a = angle(t_out, dir);
            if a > 0.0 && a < angle(t_out, -t_in) {
                return Some(true);
            }
        }
    }
    seen.then_some(false)
}

/// The vertex a coedge arrives at and its unit direction there.
fn coedge_end(e: &Edge, c: Coedge) -> (VertexId, DVec3) {
    if c.reversed {
        (e.start, -e.curve.tangent(e.t0))
    } else {
        (e.end, e.curve.tangent(e.t1))
    }
}

/// A coedge's unit direction where it sets off.
fn coedge_start(e: &Edge, c: Coedge) -> DVec3 {
    if c.reversed {
        -e.curve.tangent(e.t1)
    } else {
        e.curve.tangent(e.t0)
    }
}

/// Whether `classify` can measure along the surface to this edge: always
/// on planes and spheres; on a cylinder, only lines along it and circles
/// round it.
fn measurable_on(e: &Edge, surface: &Surface) -> bool {
    let Surface::Cylinder { origin, axis, radius, .. } = *surface else { return true };
    match e.curve {
        Curve::Line { dir, .. } => dir.cross(axis).length() <= ANGULAR,
        Curve::Circle { center, axis: z, radius: rho, .. } => {
            let off = (center - origin) - axis * (center - origin).dot(axis);
            z.cross(axis).length() <= ANGULAR && off.length() <= LINEAR && (rho - radius).abs() <= LINEAR
        }
    }
}

/// The direction in which the shortest path along the surface leaves p for
/// q (p and q on the surface). On a cylinder its length is that path's
/// length (unrolled, the path is straight); on a plane too.
fn along_surface(surface: &Surface, p: DVec3, q: DVec3) -> DVec3 {
    match *surface {
        Surface::Plane { normal, .. } => (q - p) - normal * (q - p).dot(normal),
        Surface::Sphere { center, .. } => {
            // Leaves along the great circle through p and q; its length is
            // not the chord's, but only its direction and its order among
            // other paths (the same as the chord's) are used.
            let n = (p - center).normalize();
            (q - p) - n * (q - p).dot(n)
        }
        Surface::Cylinder { axis, x_dir, radius, .. } => {
            let (up, uq) = (surface.project(p), surface.project(q));
            let turn = (uq.x - up.x + PI).rem_euclid(TAU) - PI;
            let round = (x_dir * -up.x.sin() + axis.cross(x_dir) * up.x.cos()) * radius;
            round * turn + axis * (uq.y - up.y)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fixtures::{
        hand_cube, hand_cylinder, hand_half_cylinder, hand_sphere, hand_sphere_octant, hand_tube, two_shells,
    };
    use crate::geom::Transform;
    use crate::tolerance::{MAX_SIZE, MIN_FEATURE};
    use crate::ops::extrude::extrude;
    use crate::ops::profile::{Boundary, Profile};
    use crate::validate::validate;
    use glam::DVec2;
    use std::f64::consts::FRAC_PI_2;

    fn errors(b: &Body) -> Vec<ValidationError> {
        validate(b).err().unwrap_or_default()
    }

    fn moved(b: Body, by: DVec3) -> Body {
        b.transformed(&Transform::translation(by))
    }

    fn points_of(errs: &[ValidationError]) -> Vec<DVec3> {
        errs.iter().map(|e| e.point().unwrap_or_else(|| panic!("not a self-intersection: {e}"))).collect()
    }

    #[test]
    fn overlapping_cubes_by_hand() {
        // Unit cube A, and B the same moved by (½, ½, ½). An edge of A on
        // its far side (two coordinates 1, one running 0→1) passes through
        // the near face of B where the running coordinate is ½: e.g. the
        // edge x = 1, z = 1 crosses B's face y = ½ at (1, ½, 1), inside it
        // (x and z are 1, strictly between ½ and 3/2). Likewise an edge of B
        // with two coordinates ½ crosses A's face where its running one is
        // 1. So every meeting point has coordinates {1, 1, ½} or {½, ½, 1}
        // in some order, six in all, and nothing else is reported.
        let errs = errors(&two_shells(&hand_cube(), &moved(hand_cube(), DVec3::splat(0.5))));
        assert!(!errs.is_empty());
        let mut expected = Vec::new();
        for (a, b) in [(1.0, 0.5), (0.5, 1.0)] {
            expected.extend([DVec3::new(a, a, b), DVec3::new(a, b, a), DVec3::new(b, a, a)]);
        }
        for e in &errs {
            assert!(matches!(e, ValidationError::EdgeMeetsFace { .. }), "{e}");
            let p = e.point().unwrap();
            assert!(expected.iter().any(|q| q.distance(p) <= LINEAR), "{p} is not a hand-worked meeting");
        }
        assert_eq!(errs.len(), 6, "{errs:?}");
    }

    #[test]
    fn cubes_meeting_along_an_edge() {
        // B moved by (1, 1, 0) shares only the vertical line x = y = 1 with
        // A: A's edge 3–7 and B's edge 0–4 lie on each other. Their faces
        // there are side by side (A's x = 1 face has y ≤ 1, B's y ≥ 1), so
        // only the edge test sees it, at points on that line.
        let errs = errors(&two_shells(&hand_cube(), &moved(hand_cube(), DVec3::new(1.0, 1.0, 0.0))));
        assert!(!errs.is_empty());
        for e in &errs {
            assert!(matches!(e, ValidationError::EdgesMeet { .. }), "{e}");
            let p = e.point().unwrap();
            assert!((p.x - 1.0).abs() <= LINEAR && (p.y - 1.0).abs() <= LINEAR && (-LINEAR..=1.0 + LINEAR).contains(&p.z), "{p}");
        }
    }

    #[test]
    fn a_gap_of_linear_is_the_boundary() {
        // B on top of A, moved ¼ across so their faces overlap, with a gap
        // g between A's top (z = 1) and B's bottom. Closer than LINEAR is
        // touching: 0.9·LINEAR is reported, 1.1·LINEAR is two separate
        // solids.
        let pair = |g: f64| two_shells(&hand_cube(), &moved(hand_cube(), DVec3::new(0.25, 0.25, 1.0 + g)));
        assert!(!errors(&pair(0.9 * LINEAR)).is_empty());
        assert_eq!(errors(&pair(1.1 * LINEAR)), vec![]);
    }

    #[test]
    fn a_corner_resting_on_a_face() {
        // B: the unit cube stood on a corner (its diagonal (1,1,1) turned to
        // point up), that corner g above the middle of A's top face. Only
        // the corner comes near A: its neighbours are 1/√3 ≈ 0.58 higher.
        let up = DVec3::ONE.normalize();
        let turn = Transform::rotation(up.cross(DVec3::Z), up.angle_between(DVec3::Z));
        let pair = |g: f64| {
            // The corner (−½, −½, −½) of the centred cube ends at −(√3/2)·z.
            let b = moved(hand_cube(), DVec3::splat(-0.5)).transformed(&turn);
            let corner = b.vertices.iter().map(|v| v.point).min_by(|p, q| p.z.total_cmp(&q.z)).unwrap();
            assert!((corner.z + 3f64.sqrt() / 2.0).abs() < 1e-12);
            two_shells(&hand_cube(), &moved(b, DVec3::new(0.5, 0.5, 1.0 + g) - corner))
        };
        let errs = errors(&pair(0.9 * LINEAR));
        assert!(matches!(errs[0], ValidationError::EdgeMeetsFace { face: 1, .. }), "{errs:?}");
        assert!(points_of(&errs).iter().all(|p| p.distance(DVec3::new(0.5, 0.5, 1.0)) <= LINEAR));
        assert_eq!(errors(&pair(1.1 * LINEAR)), vec![]);
    }

    #[test]
    fn a_ball_through_a_face_needs_the_third_test() {
        // A ball of radius 0.3 centred 0.1 above the middle of the cube's
        // top: its equator (z = 1.1) clears the cube and no cube edge comes
        // within 0.5 of its centre, so no edge meets anything. The top
        // plane cuts the ball in a circle of radius √(0.3² − 0.1²) = √0.08
        // round (½, ½, 1), inside the top face and the lower hemisphere
        // (face 6 + 1 = 7).
        let ball = moved(hand_sphere(0.3), DVec3::new(0.5, 0.5, 1.1));
        let errs = errors(&two_shells(&hand_cube(), &ball));
        assert_eq!(errs.len(), 1, "{errs:?}");
        let ValidationError::FacesMeet { a: 1, b: 7, point } = errs[0] else { panic!("{errs:?}") };
        assert!((point.z - 1.0).abs() <= LINEAR);
        assert!((point.truncate().distance(DVec2::new(0.5, 0.5)) - 0.08f64.sqrt()).abs() <= LINEAR);
    }

    #[test]
    fn crossing_rods() {
        // A: radius 1 along z (z from −2 to 2). B: radius ½ along x (x from
        // −3 to 3). Their caps are clear of each other, so only the side
        // faces (2 and 3 + 2 = 5) cross, on curves where x² + y² = 1 and
        // y² + z² = ¼.
        let a = moved(hand_cylinder(1.0, 4.0), DVec3::new(0.0, 0.0, -2.0));
        let b = hand_cylinder(0.5, 6.0)
            .transformed(&Transform::rotation(DVec3::Y, FRAC_PI_2).then(Transform::translation(DVec3::new(-3.0, 0.0, 0.0))));
        let errs = errors(&two_shells(&a, &b));
        assert_eq!(errs.len(), 1, "{errs:?}");
        let ValidationError::FacesMeet { a: 2, b: 5, point: p } = errs[0] else { panic!("{errs:?}") };
        assert!((p.x * p.x + p.y * p.y - 1.0).abs() <= LINEAR && (p.y * p.y + p.z * p.z - 0.25).abs() <= LINEAR, "{p}");
    }

    #[test]
    fn a_rod_through_a_ball() {
        // Unit ball at the origin; rod of radius 0.3 along z through
        // (0.2, 0), from z = −3 to 3. They cross on two loops where
        // |p| = 1 and (x − 0.2)² + y² = 0.09; nothing else meets (the ball's
        // equator is ≥ 1 − 0.2 − 0.3 = 0.5 from the rod).
        let rod = moved(hand_cylinder(0.3, 6.0), DVec3::new(0.2, 0.0, -3.0));
        let errs = errors(&two_shells(&hand_sphere(1.0), &rod));
        assert!(!errs.is_empty());
        for p in points_of(&errs) {
            assert!((p.length() - 1.0).abs() <= LINEAR && ((p.x - 0.2).powi(2) + p.y * p.y - 0.09).abs() <= LINEAR, "{p}");
        }
        assert!(errs.iter().all(|e| matches!(e, ValidationError::FacesMeet { b: 4, .. })), "{errs:?}");
    }

    #[test]
    fn two_balls_crossing() {
        // Unit balls centred 0 and (0, 0, 1.2). Each equator is √(1 + 1.44)
        // from the other's centre, so only the faces meet, on the circle
        // z = 0.6, radius √(1 − 0.36) = 0.8: ball 1's upper half (face 0)
        // and ball 2's lower half (face 2 + 1 = 3).
        let errs = errors(&two_shells(&hand_sphere(1.0), &moved(hand_sphere(1.0), DVec3::new(0.0, 0.0, 1.2))));
        assert_eq!(errs.len(), 1, "{errs:?}");
        let ValidationError::FacesMeet { a: 0, b: 3, point: p } = errs[0] else { panic!("{errs:?}") };
        assert!((p.z - 0.6).abs() <= LINEAR && (p.truncate().length() - 0.8).abs() <= LINEAR, "{p}");
    }

    #[test]
    fn a_tilted_rod_through_a_box_top() {
        // Box [−2, 2]² × [−4, 0]; rod of radius 0.3 and length 2 centred at
        // the origin, tilted 30° from z about x. Its caps sit at heights
        // ±cos 30° ≈ ±0.87, tipped by at most 0.3·sin 30° = 0.15, so they
        // clear the top (z = 0); its side crosses the top on an ellipse:
        // where z = 0, x = ±0.3 at the ends of the long axis... any point
        // with z = 0 at distance 0.3 from the rod's axis.
        let bigbox = hand_cube().transformed(&Transform::uniform_scale(4.0).then(Transform::translation(DVec3::new(-2.0, -2.0, -4.0))));
        let tilt = Transform::rotation(DVec3::X, 30f64.to_radians());
        let rod = moved(hand_cylinder(0.3, 2.0), DVec3::new(0.0, 0.0, -1.0)).transformed(&tilt);
        let errs = errors(&two_shells(&bigbox, &rod));
        assert_eq!(errs.len(), 1, "{errs:?}");
        let ValidationError::FacesMeet { a: 1, b: 8, point: p } = errs[0] else { panic!("{errs:?}") };
        let axis = tilt.dir(DVec3::Z);
        assert!(p.z.abs() <= LINEAR && ((p - axis * p.dot(axis)).length() - 0.3).abs() <= LINEAR, "{p}");
    }

    #[test]
    fn reports_stop_at_the_cap() {
        // Two 40-sided prisms, the second turned 1/80 of a turn and lifted
        // halfway: every side edge of each crosses the other's faces, far
        // more than MAX_REPORTED meetings.
        let ngon = |turn: f64| -> Vec<DVec2> {
            (0..40).map(|i| DVec2::from_angle(TAU * i as f64 / 40.0 + turn) * 10.0).collect()
        };
        let a = extrude(&Profile::polygon(ngon(0.0), vec![]), 2.0).unwrap();
        let b = moved(extrude(&Profile::polygon(ngon(TAU / 80.0), vec![]), 2.0).unwrap(), DVec3::Z);
        assert_eq!(errors(&two_shells(&a, &b)).len(), MAX_REPORTED);
    }

    #[test]
    fn near_misses_that_are_valid() {
        // Shapes whose parts come close, or meet tangentially, without
        // touching: each must pass.
        // Tangent joins (a slot's straight sides run into its round ends)
        // at a radius of 250 m (the slot then spans 1 km, MAX_SIZE), where
        // a straight side stays within LINEAR of the round end's cylinder
        // for √(2 · 2.5e5 · 1e-5) ≈ 2.2 mm past the join.
        let slot = |w: f64| {
            let corners = vec![DVec2::new(0.0, 0.0), DVec2::new(w, 0.0), DVec2::new(w, w), DVec2::new(0.0, w)];
            Profile { outer: Boundary::Path { corners, bulges: vec![0.0, 1.0, 0.0, 1.0] }, holes: vec![] }
        };
        for w in [4.0, MAX_SIZE / 2.0] {
            extrude(&slot(w), w / 2.0).unwrap();
        }
        // A U: the tops of its arms are in one plane, apart; each arm's
        // edges lie in the other's top plane outside it.
        let u = [(0.0, 0.0), (3.0, 0.0), (3.0, 3.0), (2.0, 3.0), (2.0, 1.0), (1.0, 1.0), (1.0, 3.0), (0.0, 3.0)];
        extrude(&Profile::polygon(u.iter().map(|&(x, y)| DVec2::new(x, y)).collect(), vec![]), 1.0).unwrap();
        // A wall of 1 µm (MIN_FEATURE) between coaxial cylinders 1 km
        // across (MAX_SIZE), and a part 100 km out.
        // At r = 5e5 a double is 5.8e-11 apart, so r − MIN_FEATURE rounds to
        // a wall 1.07e-11 thinner than 1 µm, which the profile check rightly
        // refuses: take the nearest radius below whose wall is not thinner.
        let r = MAX_SIZE / 2.0;
        let mut inner = r - MIN_FEATURE;
        while r - inner < MIN_FEATURE {
            inner = inner.next_down();
        }
        assert!(r - inner < MIN_FEATURE * (1.0 + 1e-6), "still a 1 µm wall");
        let ring = Profile { outer: Boundary::Circle { center: DVec2::ZERO, radius: r }, holes: vec![Boundary::Circle { center: DVec2::ZERO, radius: inner }] };
        extrude(&ring, 5.0).unwrap();
        let far = Profile::polygon(vec![DVec2::new(1e8 - 3.0, 0.0), DVec2::new(1e8, 0.0), DVec2::new(1e8, 2.0)], vec![]);
        extrude(&far, 1.0).unwrap();
        // The hand-built bodies (no `ops`): each is valid. (The sphere cap,
        // slice and octant can't be meshed until step 47, so `validate`
        // stops before this check; classify_on_a_sphere_octant tests them.)
        for b in [
            hand_cube(),
            hand_cylinder(2.0, 3.0),
            hand_sphere(5.0),
            hand_half_cylinder(1.0, 2.0),
            hand_tube(1.0, 1.001, 2.0, 0.3),
        ] {
            assert_eq!(errors(&b), vec![]);
        }
    }

    #[test]
    fn classify_on_a_plane_by_hand() {
        // The cube's top (face 1, z = 1, x and y in [0, 1]). The middle is
        // inside; (2, ½, 1) is outside, nearest the edge x = 1 with the face
        // on its other side; (2, 2, 1) is outside, nearest the corner
        // (1, 1). On the edge, and within LINEAR of it, is the boundary:
        // 0.9·LINEAR in from x = 1 is boundary, 1.1·LINEAR in is inside,
        // 1.1·LINEAR out is outside.
        let b = hand_cube();
        assert_eq!(classify(&b, 1, DVec3::new(0.5, 0.5, 1.0)), Where::Inside);
        assert_eq!(classify(&b, 1, DVec3::new(2.0, 0.5, 1.0)), Where::Outside);
        assert_eq!(classify(&b, 1, DVec3::new(2.0, 2.0, 1.0)), Where::Outside);
        assert_eq!(classify(&b, 1, DVec3::new(1.0, 0.5, 1.0)), Where::Boundary);
        assert_eq!(classify(&b, 1, DVec3::new(1.0 - 0.9 * LINEAR, 0.5, 1.0)), Where::Boundary);
        assert_eq!(classify(&b, 1, DVec3::new(1.0 - 1.1 * LINEAR, 0.5, 1.0)), Where::Inside);
        assert_eq!(classify(&b, 1, DVec3::new(1.0 + 1.1 * LINEAR, 0.5, 1.0)), Where::Outside);
    }

    #[test]
    fn classify_at_a_reflex_corner_by_hand() {
        // An L: (0,0) (2,0) (2,1) (1,1) (1,2) (0,2), extruded 1; its top is
        // face 1. (1.2, 1.2) is nearest the inner corner (1, 1) and lies in
        // the notch, outside; (0.8, 0.8) is nearest... the edges, inside;
        // (1.0001, 1.0001)... just past the corner into the notch: outside;
        // (0.9999, 1.0001) is above y = 1 but left of x = 1: inside the
        // upper arm.
        let l = [(0.0, 0.0), (2.0, 0.0), (2.0, 1.0), (1.0, 1.0), (1.0, 2.0), (0.0, 2.0)];
        let b = extrude(&Profile::polygon(l.iter().map(|&(x, y)| DVec2::new(x, y)).collect(), vec![]), 1.0).unwrap();
        let top = (0..b.faces.len())
            .find(|&f| matches!(b.faces[f].surface, Surface::Plane { normal, .. } if normal.z * if b.faces[f].sense { 1.0 } else { -1.0 } > 0.5))
            .unwrap();
        let at = |x: f64, y: f64| classify(&b, top, DVec3::new(x, y, 1.0));
        assert_eq!(at(1.2, 1.2), Where::Outside);
        assert_eq!(at(1.0001, 1.0001), Where::Outside);
        assert_eq!(at(0.8, 0.8), Where::Inside);
        assert_eq!(at(0.9999, 1.0001), Where::Inside);
        assert_eq!(at(1.0001, 0.9999), Where::Inside);
        assert_eq!(at(1.5, 0.5), Where::Inside);
    }

    #[test]
    fn classify_at_a_sharp_corner_by_hand() {
        // The triangle (0,0) (4,0) (0,1), extruded 1; its top is face 1.
        // At (4, 0) the edges meet at atan(¼) ≈ 14°. q = (4.1, 0.3) is
        // nearest that corner: past the end of the edge along y = 0
        // (x > 4), and before the start of the edge to (0, 1), since
        // (q − (4,0))·(−4, 1) = −0.4 + 0.3 < 0. It is outside (x + 4y =
        // 5.3 > 4), although it lies on the face's side of the edge
        // arriving at the corner (y > 0): only the corner between both
        // edges decides. Mirrored below y = 0, (4.1, −0.3) is outside too,
        // and (3.9, 0.02) is inside (x + 4y = 3.98 < 4).
        let tri = [(0.0, 0.0), (4.0, 0.0), (0.0, 1.0)];
        let b = extrude(&Profile::polygon(tri.iter().map(|&(x, y)| DVec2::new(x, y)).collect(), vec![]), 1.0).unwrap();
        let top = (0..b.faces.len())
            .find(|&f| matches!(b.faces[f].surface, Surface::Plane { normal, .. } if normal.z * if b.faces[f].sense { 1.0 } else { -1.0 } > 0.5))
            .unwrap();
        let at = |x: f64, y: f64| classify(&b, top, DVec3::new(x, y, 1.0));
        assert_eq!(at(4.1, 0.3), Where::Outside);
        assert_eq!(at(4.1, -0.3), Where::Outside);
        assert_eq!(at(3.9, 0.02), Where::Inside);
    }

    #[test]
    fn classify_on_a_cylinder_by_hand() {
        // The half cylinder's curved face (face 3): radius 1, angles 0 to π
        // (y ≥ 0), heights 0 to 2. At angle π/2, height 1: inside. At angle
        // −π/2 (y < 0), height 1: outside, nearest the lines at angles 0 and
        // π, ¼ turn away along the surface; straight across, the point is 2
        // from the face's middle but √2 from those lines, and unrolled it
        // is π/2 from them: either way outside. Height 3: outside, above the
        // top arc. Angle π/2 at height 2 − 0.9·LINEAR: boundary.
        let b = hand_half_cylinder(1.0, 2.0);
        let at = |angle: f64, h: f64| classify(&b, 3, DVec3::new(angle.cos(), angle.sin(), h));
        assert_eq!(at(FRAC_PI_2, 1.0), Where::Inside);
        assert_eq!(at(-FRAC_PI_2, 1.0), Where::Outside);
        assert_eq!(at(FRAC_PI_2, 3.0), Where::Outside);
        assert_eq!(at(FRAC_PI_2, 2.0 - 0.9 * LINEAR), Where::Boundary);
        assert_eq!(at(FRAC_PI_2, 2.0 - 1.1 * LINEAR), Where::Inside);
        // Just round from the line at angle 0: 0.01 rad in is inside, out is not.
        assert_eq!(at(0.01, 1.0), Where::Inside);
        assert_eq!(at(-0.01, 1.0), Where::Outside);
    }

    #[test]
    fn classify_on_a_sphere_by_hand() {
        // Unit ball: face 0 is the upper half, bounded by the equator run
        // counter-clockwise seen from above. The north pole is inside it, the
        // south pole outside, a point 1.1·LINEAR above the equator inside
        // and 0.9·LINEAR above it on the boundary.
        let b = hand_sphere(1.0);
        assert_eq!(classify(&b, 0, DVec3::Z), Where::Inside);
        assert_eq!(classify(&b, 0, -DVec3::Z), Where::Outside);
        assert_eq!(classify(&b, 1, -DVec3::Z), Where::Inside);
        let above = |h: f64| DVec3::new((1.0 - h * h).sqrt(), 0.0, h);
        assert_eq!(classify(&b, 0, above(1.1 * LINEAR)), Where::Inside);
        assert_eq!(classify(&b, 0, above(0.9 * LINEAR)), Where::Boundary);
        assert_eq!(classify(&b, 1, above(1.1 * LINEAR)), Where::Outside);
    }

    #[test]
    fn classify_on_a_sphere_octant_by_hand() {
        // The octant x, y, z ≥ 0 of a ball of radius 3: its sphere face is a
        // triangle of three quarter circles. (1, 1, 1)·3/√3 is its middle,
        // inside; (−1, 1, 1)·3/√3 is across the arc x = 0, outside; a point
        // of the arc in the plane z = 0 is boundary; and from the corner
        // (3, 0, 0), stepping 1e-3 rad up and round into the octant is
        // inside, while stepping round to y < 0 is outside.
        let b = hand_sphere_octant(3.0);
        let face = (0..b.faces.len()).find(|&f| matches!(b.faces[f].surface, Surface::Sphere { .. })).unwrap();
        let r = 3.0 / 3f64.sqrt();
        assert_eq!(classify(&b, face, DVec3::new(r, r, r)), Where::Inside);
        assert_eq!(classify(&b, face, DVec3::new(-r, r, r)), Where::Outside);
        let s = 3.0 / 2f64.sqrt();
        assert_eq!(classify(&b, face, DVec3::new(s, s, 0.0)), Where::Boundary);
        let near = |lon: f64, lat: f64| DVec3::new(lat.cos() * lon.cos(), lat.cos() * lon.sin(), lat.sin()) * 3.0;
        assert_eq!(classify(&b, face, near(1e-3, 1e-3)), Where::Inside);
        assert_eq!(classify(&b, face, near(-1e-3, 1e-3)), Where::Outside);
    }

    #[test]
    fn a_tangent_edge_at_a_shared_vertex_is_not_a_meeting() {
        // A ball of radius MAX_SIZE (1 km), and an extra edge from its equator's
        // vertex v straight up, 1 m long: tangent to the ball at v, it
        // leaves the ball (at s along it, s²/2R off the surface) over the
        // upper hemisphere. Its only meeting with the ball is v, a double
        // root. Turned to an awkward angle, rounding splits it into a pair
        // of roots near v, within LINEAR of the sphere and inside the
        // hemisphere, so only dividing out the known root v keeps them from
        // being reported. Checked by hand: with v left out of `known`,
        // turns 7 and 8 report a meeting (at 10 km and at 1 km alike).
        let r = MAX_SIZE;
        for k in 1..=8 {
            let turn = Transform::rotation(DVec3::new(0.3, 1.0, 0.7 * k as f64), 0.37 * k as f64);
            let mut b = hand_sphere(r);
            let top = b.add_vertex(DVec3::new(r, 0.0, 1e3));
            b.add_line(0, top);
            let b = b.transformed(&turn);
            assert_eq!(edge_meets_face(&b, 1, 0, &[0]), None, "turn {k}");
        }
    }

    #[test]
    fn a_doubled_edge_meets_its_twin_between_their_vertices() {
        // A second edge from cube vertex 0 (0, 0, 0) to vertex 1 (1, 0, 0)
        // lies along the cube's edge 0–1: they share both vertices and
        // every point between, so they meet away from the shared vertices.
        // The first sample more than LINEAR from both is a quarter of the
        // way along: (¼, 0, 0).
        let mut b = hand_cube();
        let twin = (0..b.edges.len()).find(|&e| [b.edges[e].start, b.edges[e].end] == [0, 1] || [b.edges[e].start, b.edges[e].end] == [1, 0]).unwrap();
        let e = b.add_line(0, 1);
        let p = edges_meet(&b, twin, e).expect("they overlap");
        assert!(p.distance(DVec3::new(0.25, 0.0, 0.0)) <= LINEAR, "{p}");
    }

    #[test]
    fn a_diagonal_across_a_face_meets_it_between_its_vertices() {
        // An edge from cube vertex 0 (0, 0, 0) to vertex 3 (1, 1, 0) runs
        // across the bottom (face 0, vertices 0, 1, 2, 3), in its plane. Its
        // ends are the face's own vertices; a quarter of the way along,
        // (¼, ¼, 0), is ¼ from the bottom's edges, inside it: the first
        // meeting found.
        let mut b = hand_cube();
        let e = b.add_line(0, 3);
        let p = edge_meets_face(&b, e, 0, &[0, 1, 2, 3]).expect("it crosses the face");
        assert!(p.distance(DVec3::new(0.25, 0.25, 0.0)) <= LINEAR, "{p}");
    }

    #[test]
    fn along_surface_by_hand() {
        // Plane through (5, −3, 2) with normal n = (0, 0.6, 0.8); q is p
        // moved 2 along x (in the plane) and 0.5 along n (off it): the part
        // in the plane is (2, 0, 0).
        let n = DVec3::new(0.0, 0.6, 0.8);
        let plane = Surface::Plane { origin: DVec3::new(5.0, -3.0, 2.0), normal: n, x_dir: DVec3::X };
        let p = DVec3::new(5.0, -3.0, 2.0);
        let got = along_surface(&plane, p, p + DVec3::new(2.0, 0.0, 0.0) + n * 0.5);
        assert!(got.distance(DVec3::new(2.0, 0.0, 0.0)) <= LINEAR, "{got}");
        // Ball of radius 2 round c = (4, −2, 7): p = c + 2x, q = c + 2y. The
        // tangent plane at p is x = 6, so the chord q − p = (−2, 2, 0) loses
        // its x part: the great circle leaves p along (0, 2, 0).
        let c = DVec3::new(4.0, -2.0, 7.0);
        let ball = Surface::Sphere { center: c, axis: DVec3::Z, x_dir: DVec3::X, radius: 2.0 };
        let got = along_surface(&ball, c + DVec3::X * 2.0, c + DVec3::Y * 2.0);
        assert!(got.distance(DVec3::new(0.0, 2.0, 0.0)) <= LINEAR, "{got}");
        // Rod of radius 2.5 along z through o = (1, 2, 3). p at angle π/3,
        // height 1; q at angle π/3 + 0.4, height 1.7. Unrolled, the path
        // runs 2.5 · 0.4 = 1 round, along the circle's direction at p,
        // (−sin π/3, cos π/3, 0) = (−√3/2, ½, 0), and 0.7 up: (−√3/2, ½, 0.7).
        let o = DVec3::new(1.0, 2.0, 3.0);
        let rod = Surface::Cylinder { origin: o, axis: DVec3::Z, x_dir: DVec3::X, radius: 2.5 };
        let at = |a: f64, h: f64| o + DVec3::new(2.5 * a.cos(), 2.5 * a.sin(), h);
        let a = PI / 3.0;
        let got = along_surface(&rod, at(a, 1.0), at(a + 0.4, 1.7));
        assert!(got.distance(DVec3::new(-(3f64.sqrt()) / 2.0, 0.5, 0.7)) <= LINEAR, "{got}");
        // Across angle 0: from angle 0.2 to 2π − 0.2 the short way is −0.4,
        // 1 back round: −(−sin 0.2, cos 0.2, 0), at the same height.
        let got = along_surface(&rod, at(0.2, 1.0), at(TAU - 0.2, 1.0));
        assert!(got.distance(DVec3::new(0.2f64.sin(), -(0.2f64.cos()), 0.0)) <= LINEAR, "{got}");
    }

    /// A rigid motion off the origin and turned about a skew axis: the
    /// classify cases above sit at the origin, where p − c and p + c agree,
    /// on unit or axis-aligned shapes. Rigid, so LINEAR offsets survive.
    fn rigid() -> Transform {
        Transform::rotation(DVec3::new(0.3, -1.0, 0.6), 1.1).then(Transform::translation(DVec3::new(12.5, -7.0, 3.25)))
    }

    #[test]
    fn classify_by_hand_anywhere() {
        let tf = rigid();
        // The half cylinder of radius 2.5 and height 3 (curved face 3:
        // angles 0 to π). At angle θ, height h the point is
        // (2.5 cos θ, 2.5 sin θ, h). Round from the line at angle 0 by
        // 0.9·LINEAR (θ = 0.9·LINEAR/2.5): boundary; 1.1·LINEAR in: inside;
        // 1.1·LINEAR out: outside. 0.1 rad past either line: outside;
        // 0.1 rad in: inside. Below the bottom and round past the line
        // (θ = −0.1, h = −0.1, nearest the corner at (2.5, 0, 0)): outside.
        let r = 2.5;
        let b = hand_half_cylinder(r, 3.0).transformed(&tf);
        let at = |angle: f64, h: f64| classify(&b, 3, tf.point(DVec3::new(r * angle.cos(), r * angle.sin(), h)));
        assert_eq!(at(FRAC_PI_2, 1.5), Where::Inside);
        assert_eq!(at(-FRAC_PI_2, 1.5), Where::Outside);
        assert_eq!(at(FRAC_PI_2, 3.5), Where::Outside);
        assert_eq!(at(FRAC_PI_2, -0.5), Where::Outside);
        assert_eq!(at(0.9 * LINEAR / r, 1.5), Where::Boundary);
        assert_eq!(at(1.1 * LINEAR / r, 1.5), Where::Inside);
        assert_eq!(at(-1.1 * LINEAR / r, 1.5), Where::Outside);
        assert_eq!(at(PI - 1.1 * LINEAR / r, 1.5), Where::Inside);
        assert_eq!(at(PI + 1.1 * LINEAR / r, 1.5), Where::Outside);
        for (angle, want) in [(0.1, Where::Inside), (-0.1, Where::Outside), (PI - 0.1, Where::Inside), (PI + 0.1, Where::Outside)] {
            for h in [0.3, 1.5, 2.7] {
                assert_eq!(at(angle, h), want, "angle {angle}, height {h}");
            }
        }
        assert_eq!(at(-0.1, -0.1), Where::Outside);
        assert_eq!(at(0.1, 0.05), Where::Inside);
        assert_eq!(at(FRAC_PI_2, 3.0 - 0.9 * LINEAR), Where::Boundary);
        assert_eq!(at(FRAC_PI_2, 3.0 - 1.1 * LINEAR), Where::Inside);
        // A ball of radius 2.5: the upper half (face 0) holds the north
        // pole, not the south; 1.1·LINEAR above the equator (along the
        // sphere) is inside face 0 and outside face 1, 0.9·LINEAR is the
        // boundary.
        let ball = hand_sphere(r).transformed(&tf);
        let above = |h: f64| tf.point(DVec3::new((r * r - h * h).sqrt(), 0.0, h));
        assert_eq!(classify(&ball, 0, tf.point(DVec3::Z * r)), Where::Inside);
        assert_eq!(classify(&ball, 0, tf.point(-DVec3::Z * r)), Where::Outside);
        assert_eq!(classify(&ball, 1, tf.point(-DVec3::Z * r)), Where::Inside);
        assert_eq!(classify(&ball, 0, above(1.1 * LINEAR)), Where::Inside);
        assert_eq!(classify(&ball, 0, above(0.9 * LINEAR)), Where::Boundary);
        assert_eq!(classify(&ball, 1, above(1.1 * LINEAR)), Where::Outside);
        // The sphere octant of radius 3, moved: its middle is inside, its
        // mirror across the arc x = 0 outside, and from the corner (3, 0, 0)
        // 1e-3 rad up and round into the octant inside, round to y < 0
        // outside.
        let oct = hand_sphere_octant(3.0).transformed(&tf);
        let face = (0..oct.faces.len()).find(|&f| matches!(oct.faces[f].surface, Surface::Sphere { .. })).unwrap();
        let m = 3.0 / 3f64.sqrt();
        assert_eq!(classify(&oct, face, tf.point(DVec3::new(m, m, m))), Where::Inside);
        assert_eq!(classify(&oct, face, tf.point(DVec3::new(-m, m, m))), Where::Outside);
        let near = |lon: f64, lat: f64| tf.point(DVec3::new(lat.cos() * lon.cos(), lat.cos() * lon.sin(), lat.sin()) * 3.0);
        assert_eq!(classify(&oct, face, near(1e-3, 1e-3)), Where::Inside);
        assert_eq!(classify(&oct, face, near(-1e-3, 1e-3)), Where::Outside);
        // The unit cube's top (face 1), moved: the plane is off the origin.
        let cube = hand_cube().transformed(&tf);
        let top = |x: f64, y: f64| classify(&cube, 1, tf.point(DVec3::new(x, y, 1.0)));
        assert_eq!(top(0.5, 0.5), Where::Inside);
        assert_eq!(top(2.0, 0.5), Where::Outside);
        assert_eq!(top(2.0, 2.0), Where::Outside);
        assert_eq!(top(1.0 - 0.9 * LINEAR, 0.5), Where::Boundary);
        assert_eq!(top(1.0 - 1.1 * LINEAR, 0.5), Where::Inside);
        assert_eq!(top(1.0 + 1.1 * LINEAR, 0.5), Where::Outside);
    }

    #[test]
    fn unmeasurable_cylinder_edges_give_unknown() {
        // On a cylinder, classify can only measure along lines along it and
        // circles round it. Swap one edge of the half cylinder's curved face
        // for each other kind (the body is no longer valid; classify is
        // asked directly): a slanted line, a circle tilted off the axis, one
        // off the axis, and one of another radius. Each gives Unknown, where
        // the point would otherwise be inside.
        let b = hand_half_cylinder(1.0, 2.0);
        let q = DVec3::new(0.0, 1.0, 1.0);
        assert_eq!(classify(&b, 3, q), Where::Inside);
        let bottom = b.faces[3].loops[0].coedges[0].edge; // the bottom arc
        let side = b.faces[3].loops[0].coedges[1].edge; // the line at −x
        let swapped = |edge: EdgeId, curve: Curve| {
            let mut b2 = b.clone();
            b2.edges[edge].curve = curve;
            classify(&b2, 3, q)
        };
        let slanted = Curve::Line { origin: DVec3::new(-1.0, 0.0, 0.0), dir: DVec3::new(0.0, 0.6, 0.8) };
        assert_eq!(swapped(side, slanted), Where::Unknown);
        let arc = |center: DVec3, axis: DVec3, radius: f64| Curve::Circle { center, axis, x_dir: DVec3::X, radius };
        assert_eq!(swapped(bottom, arc(DVec3::ZERO, DVec3::new(0.0, 0.6, 0.8), 1.0)), Where::Unknown);
        assert_eq!(swapped(bottom, arc(DVec3::new(0.1, 0.0, 0.0), DVec3::Z, 1.0)), Where::Unknown);
        assert_eq!(swapped(bottom, arc(DVec3::ZERO, DVec3::Z, 1.1)), Where::Unknown);
        // Within tolerance of round the axis is still measurable.
        assert_eq!(swapped(bottom, arc(DVec3::new(0.5 * LINEAR, 0.0, 0.0), DVec3::Z, 1.0 + 0.5 * LINEAR)), Where::Inside);
    }

    #[test]
    fn edges_just_past_a_ball_s_poles_are_seen() {
        // A ball's face boxes reach past its edges' boxes to the poles (an
        // upper hemisphere bulges above its equator). A cube's bottom edge
        // passing 0.5·LINEAR over the north pole of a radius-1 ball centred
        // at (3, 3, 3), or its top edge 0.5·LINEAR under the south pole,
        // touches the ball there: reported. Each edge's box comes within
        // LINEAR of the pole only through its own padding, so the face box
        // must be padded by LINEAR too.
        let ball = moved(hand_sphere(1.0), DVec3::splat(3.0));
        let g = 0.5 * LINEAR;
        for (lift, label) in [(4.0 + g, "over the north pole"), (2.0 - g - 1.0, "under the south pole")] {
            let cube = moved(hand_cube(), DVec3::new(2.5, 3.0, lift));
            let errs = errors(&two_shells(&ball, &cube));
            assert!(!errs.is_empty(), "{label}");
            let pole = DVec3::new(3.0, 3.0, if lift > 3.0 { 4.0 } else { 2.0 });
            assert!(points_of(&errs).iter().all(|p| p.distance(pole) <= 2.0 * LINEAR), "{label}: {errs:?}");
        }
    }

    #[test]
    fn the_cap_counts_only_this_check_s_reports() {
        // `check` adds at most MAX_REPORTED errors of its own, however many
        // validate already found.
        let ngon = |turn: f64| -> Vec<DVec2> { (0..40).map(|i| DVec2::from_angle(TAU * i as f64 / 40.0 + turn) * 10.0).collect() };
        let a = extrude(&Profile::polygon(ngon(0.0), vec![]), 2.0).unwrap();
        let b = moved(extrude(&Profile::polygon(ngon(TAU / 80.0), vec![]), 2.0).unwrap(), DVec3::Z);
        let body = two_shells(&a, &b);
        for already in [1, 3, MAX_REPORTED + 2] {
            let mut errs = vec![ValidationError::EdgesMeet { a: 0, b: 1, point: DVec3::ZERO }; already];
            check(&body, &mut errs);
            assert_eq!(errs.len(), already + MAX_REPORTED, "{already} found before");
        }
    }
}
