//! Turns a B-rep body into a watertight triangle mesh.
//!
//! Every B-rep edge is discretised exactly once and both faces that use it
//! reuse those same mesh vertices, so the mesh is watertight by construction.
//! Faces are triangulated in their surface's (u, v) parameter space with a
//! constrained Delaunay triangulation, keeping the triangles inside the
//! face's loops.
//!
//! Mutation testing (`cargo mutants -f src/tessellate.rs`) leaves these
//! survivors, all equivalent (no input can tell them apart):
//! - `<` vs `<=` on `chord < 2r` in segments: at chord = 2r the sag rule
//!   gives θ = 2·acos(−1) = 2π instead of no limit (∞), and both are above
//!   the third-of-a-turn cap the step is clamped to (f64::min drops a NaN
//!   angle limit, so it can't choose between them either).
//! - `> π` vs `>= π` on a loop's winding in periodic_domain: unwrap_loop's
//!   winding is a sum of wrapped steps round a closed loop, a whole number
//!   of turns (0, ±2π) up to rounding of ~1e-15 per point, never π.
//! - `<` vs `<=` on ANGULAR in slerp: the angle is acos of a double, which
//!   is 0 at 1 and already √(2·2⁻⁵³) ≈ 1.49e-8 at the next double below 1,
//!   so it is never exactly ANGULAR = 1e-9.

use crate::fmath;
use crate::geom::{Curve, Surface};
use crate::mesh::Mesh;
use crate::tolerance;
use crate::topology::{Body, FaceId};
use glam::{DVec2, DVec3};
use std::f64::consts::{PI, TAU};
use spade::handles::FixedVertexHandle;
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

impl Default for TessOptions {
    fn default() -> Self {
        Self::DISPLAY
    }
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

#[cfg(test)]
thread_local! {
    /// Tessellations run on this thread, so tests can catch repeated work.
    pub(crate) static TESSELLATIONS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

pub fn tessellate(body: &Body, opts: &TessOptions) -> Result<Mesh, TessError> {
    #[cfg(test)]
    TESSELLATIONS.with(|n| n.set(n.get() + 1));
    let mut mesh =
        Mesh { positions: body.vertices.iter().map(|v| v.point).collect(), options: *opts, ..Mesh::default() };
    // Where along each edge (as fractions 0..=1) its mesh points go.
    let mut params: Vec<Vec<f64>> = body
        .edges
        .iter()
        .map(|e| {
            let n = segments(&e.curve, e.t1 - e.t0, opts);
            (0..=n).map(|k| k as f64 / n as f64).collect()
        })
        .collect();
    conform_planar_faces(body, &mut params)?;
    for (e, ps) in body.edges.iter().zip(&params) {
        let mut poly = vec![e.start as u32];
        for &f in &ps[1..ps.len() - 1] {
            mesh.positions.push(e.point_at(f));
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

/// Most mesh points a tessellation may use before giving up: keeps cost
/// bounded when chords have to be split very finely.
pub const MAX_MESH_POINTS: usize = 4_000_000;

/// A mesh point on a face boundary: a B-rep vertex, or point k of an edge.
#[derive(Clone, Copy, PartialEq)]
enum BoundaryPoint {
    Vertex(usize),
    OnEdge(usize, usize),
}

/// One chord of a planar face's boundary, in the face's uv coordinates.
struct Chord {
    a: DVec2,
    b: DVec2,
    ends: [BoundaryPoint; 2],
    edge: usize,
    /// Interval k of the edge: between params[edge][k] and [k + 1].
    k: usize,
    /// For a chord of an arc, the arc's centre in uv.
    center: Option<DVec2>,
}

/// Splits chords of curved edges until no two chords of any planar face's
/// boundary touch except where they share an end point, and no chord's
/// circular segment (the sliver between it and its arc) holds any other
/// boundary. A chord sags inside its arc by up to the chord tolerance, so
/// where a wall is thinner than that the chords of one side would cut
/// through the other. A chord can also pass another boundary without
/// touching it: a corner between the chord and its arc ends up on the
/// wrong side, and the meshed loop turns inside out (a shallow arc of huge
/// radius gets one chord, and the corner beside it is only 1e-5 above it).
/// Each split quarters the sag, so this stops once chords sag less than
/// the gap. Chords of straight edges can't be split: if two of them touch,
/// the face itself crosses itself and that is an error.
fn conform_planar_faces(body: &Body, params: &mut [Vec<f64>]) -> Result<(), TessError> {
    let snap = |p: DVec2| {
        let s = |x: f64| if x.abs() < tolerance::SNAP_TO_ZERO { 0.0 } else { x };
        DVec2::new(s(p.x), s(p.y))
    };
    loop {
        let mut split: Vec<(usize, usize)> = Vec::new();
        for (fi, face) in body.faces.iter().enumerate() {
            if !matches!(face.surface, Surface::Plane { .. }) {
                continue;
            }
            let mut chords = Vec::new();
            for l in &face.loops {
                for c in &l.coedges {
                    let e = &body.edges[c.edge];
                    let ps = &params[c.edge];
                    let id = |k: usize| match k {
                        0 => BoundaryPoint::Vertex(e.start),
                        k if k == ps.len() - 1 => BoundaryPoint::Vertex(e.end),
                        k => BoundaryPoint::OnEdge(c.edge, k),
                    };
                    let center = match e.curve {
                        Curve::Circle { center, .. } => Some(snap(face.surface.project(center))),
                        Curve::Line { .. } => None,
                    };
                    let uv = |k: usize| {
                        let p = match k {
                            0 => body.vertices[e.start].point,
                            k if k == ps.len() - 1 => body.vertices[e.end].point,
                            k => e.point_at(ps[k]),
                        };
                        snap(face.surface.project(p))
                    };
                    for k in 0..ps.len() - 1 {
                        chords.push(Chord { a: uv(k), b: uv(k + 1), ends: [id(k), id(k + 1)], edge: c.edge, k, center });
                    }
                }
            }
            for (s, t) in touching_pairs(&chords) {
                let curved = |c: &Chord| matches!(body.edges[c.edge].curve, Curve::Circle { .. });
                if !curved(s) && !curved(t) {
                    return Err(TessError { face: fi, message: "face boundary crosses itself".into() });
                }
                for c in [s, t].into_iter().filter(|c| curved(c)) {
                    split.push((c.edge, c.k));
                }
            }
            // The owner of the segment is curved; the intruder, if curved
            // too, is split as well, so a chord passing through the sliver
            // (in and out across the arc) stops reaching it sooner.
            for (s, t) in sagging_pairs(&chords) {
                for c in [s, t].into_iter().filter(|c| c.center.is_some()) {
                    split.push((c.edge, c.k));
                }
            }
        }
        if split.is_empty() {
            return Ok(());
        }
        split.sort_unstable();
        split.dedup();
        // Each edge's list is rebuilt once per pass (O(n)); inserting the
        // midpoints one at a time cost O(n) each, ~10¹² steps near the budget.
        let mut i = 0;
        while i < split.len() {
            let e = split[i].0;
            let old = std::mem::take(&mut params[e]);
            let mut new = Vec::with_capacity(old.len() + split.len() - i);
            for (k, &t) in old.iter().enumerate() {
                new.push(t);
                if i < split.len() && split[i] == (e, k) {
                    let (lo, hi) = (t, old[k + 1]);
                    let mid = 0.5 * (lo + hi);
                    if !(lo < mid && mid < hi) {
                        return Err(TessError { face: 0, message: "boundary curves touch: chords can't be split further".into() });
                    }
                    new.push(mid);
                    i += 1;
                }
            }
            params[e] = new;
        }
        if params.iter().map(Vec::len).sum::<usize>() > MAX_MESH_POINTS {
            return Err(TessError { face: 0, message: format!("more than {MAX_MESH_POINTS} mesh points needed") });
        }
    }
}

/// Pairs of chords that touch other than at a shared end point (exact
/// predicates). Chords sharing an end point only count if they overlap
/// along a line. Sweeps along u so only chords whose u ranges overlap are
/// compared.
fn touching_pairs(chords: &[Chord]) -> Vec<(&Chord, &Chord)> {
    let mut order: Vec<usize> = (0..chords.len()).collect();
    order.sort_by(|&i, &j| chords[i].a.x.min(chords[i].b.x).total_cmp(&chords[j].a.x.min(chords[j].b.x)));
    let mut active: Vec<usize> = Vec::new();
    let mut out = Vec::new();
    for &i in &order {
        let s = &chords[i];
        let (lo, hi) = (s.a.min(s.b), s.a.max(s.b));
        active.retain(|&j| chords[j].a.x.max(chords[j].b.x) >= lo.x);
        for &j in &active {
            let t = &chords[j];
            let (tlo, thi) = (t.a.min(t.b), t.a.max(t.b));
            // Chords can only touch where their y ranges overlap: skip t if
            // it lies wholly below s, or wholly above it.
            if thi.y < lo.y {
                continue;
            }
            if tlo.y > hi.y {
                continue;
            }
            let shared: Vec<usize> = (0..2).filter(|&m| s.ends.contains(&t.ends[m])).collect();
            let touches = match shared.len() {
                0 => tolerance::segments_touch((s.a, s.b), (t.a, t.b)),
                // Meeting at one end: they overlap only if collinear and the
                // other end of one lies on the other.
                1 => {
                    let (t_far, s_far) = if shared[0] == 0 { (t.b, if s.ends[0] == t.ends[0] { s.b } else { s.a }) } else { (t.a, if s.ends[0] == t.ends[1] { s.b } else { s.a }) };
                    let on = |p: DVec2, q: DVec2, r: DVec2| {
                        tolerance::side(p, q, r) == 0 && r.cmpge(p.min(q)).all() && r.cmple(p.max(q)).all()
                    };
                    on(s.a, s.b, t_far) || on(t.a, t.b, s_far)
                }
                // Same two end points: the chords coincide.
                _ => true,
            };
            if touches {
                out.push((s, t));
            }
        }
        active.push(i);
    }
    out
}

/// Whether chord `t` reaches into the circular segment of chord `s`: the
/// open region between `s` and its arc, which is the part of the arc's
/// disc on the far side of `s` from the centre (every chord spans at most
/// a third of a turn, so its arc is the minor one). An end `t` shares with
/// `s` doesn't count; a `t` sharing an end can only reach in with its
/// other end, since it can't cross the arc (straight: the face would cross
/// itself, which the profile rules refuse; curved: its own chord crosses
/// `s`, or its arc enters `t`'s own segment the other way round).
/// Inside the disc is tested with the power of the point,
/// |x − c|² − |a − c|² = |x − a|² + 2(x − a)·(a − c), which stays accurate
/// for centres far beyond the chord.
fn reaches_into(s: &Chord, t: &Chord) -> bool {
    let Some(c) = s.center else { return false };
    let arc = -tolerance::side(s.a, s.b, c);
    let power = |x: DVec2| (x - s.a).length_squared() + 2.0 * (x - s.a).dot(s.a - c);
    let inside = |x: DVec2| tolerance::side(s.a, s.b, x) == arc && power(x) < 0.0;
    let shared = t.ends.map(|e| s.ends.contains(&e));
    if (!shared[0] && inside(t.a)) || (!shared[1] && inside(t.b)) {
        return true;
    }
    if shared[0] || shared[1] {
        return false;
    }
    // Both ends outside: t can still pass through, in and out across the
    // arc. The part of t inside the disc solves power(a + λd) < 0, a
    // quadratic |d|²λ² + 2λ·d·(t.a − c) + power(t.a); that part can't cross
    // s without touching it, so its middle tells which side it is on.
    let d = t.b - t.a;
    let (qa, h) = (d.length_squared(), d.dot(t.a - c));
    let disc = h * h - qa * power(t.a);
    if disc <= 0.0 {
        return false;
    }
    let root = disc.sqrt();
    let (lo, hi) = (((-h - root) / qa).max(0.0), ((-h + root) / qa).min(1.0));
    lo < hi && tolerance::side(s.a, s.b, t.a + d * (0.5 * (lo + hi))) == arc
}

/// Pairs (s, t) where chord t reaches into chord s's circular segment.
/// Sweeps along u like `touching_pairs`, each chord's box grown by twice
/// its sag (the segment lies within its sag of the chord).
fn sagging_pairs(chords: &[Chord]) -> Vec<(&Chord, &Chord)> {
    let boxes: Vec<(DVec2, DVec2)> = chords
        .iter()
        .map(|s| {
            let grow = s.center.map_or(0.0, |c| {
                let r = (s.a - c).length();
                2.0 * (r - (0.5 * (s.a + s.b) - c).length()).max(0.0)
            });
            (s.a.min(s.b) - DVec2::splat(grow), s.a.max(s.b) + DVec2::splat(grow))
        })
        .collect();
    let mut order: Vec<usize> = (0..chords.len()).collect();
    order.sort_by(|&i, &j| boxes[i].0.x.total_cmp(&boxes[j].0.x));
    let mut active: Vec<usize> = Vec::new();
    let mut out = Vec::new();
    for &i in &order {
        let (lo, hi) = boxes[i];
        active.retain(|&j| boxes[j].1.x >= lo.x);
        for &j in &active {
            if boxes[j].1.y < lo.y || boxes[j].0.y > hi.y {
                continue;
            }
            let (s, t) = (&chords[i], &chords[j]);
            if reaches_into(s, t) {
                out.push((s, t));
            }
            if reaches_into(t, s) {
                out.push((t, s));
            }
        }
        active.push(i);
    }
    out
}

/// Largest angle one chord may span (a third of a circle).
const MAX_SEGMENT_ANGLE: f64 = TAU / 3.0;

/// Number of chords used for a curve span.
fn segments(curve: &Curve, span: f64, opts: &TessOptions) -> usize {
    match *curve {
        Curve::Line { .. } => 1,
        Curve::Circle { radius, .. } => {
            let angle = span.abs();
            // A chord spanning θ sags r(1 - cos(θ/2)) below the arc, which
            // grows up to 2r. Solving for θ is valid while chord < 2r.
            let chord_angle =
                if opts.chord < 2.0 * radius { 2.0 * fmath::acos(1.0 - opts.chord / radius) } else { f64::INFINITY };
            // No segment may turn more than a third of a circle, so a full
            // circle always has at least 3 chords and encloses some area.
            let step = opts.max_angle.min(chord_angle).clamp(TAU / tolerance::MAX_SEGMENTS_PER_TURN, MAX_SEGMENT_ANGLE);
            ((angle / step - tolerance::SEGMENT_COUNT_SLACK).ceil().max(1.0) as usize) * opts.refine as usize
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
        Surface::Cylinder { radius, .. } => {
            let (ids, uv) = periodic_domain(body, mesh, fi, radius)?;
            let tris = triangulate_uv(&ids, &uv)?;
            push_triangles(mesh, fi, tris, face.sense);
            Ok(())
        }
        Surface::Sphere { center, radius, .. } => sphere_cap(body, fi, mesh, center, radius),
    }
}

/// Wraps an angle difference into (-π, π].
fn wrap(d: f64) -> f64 {
    let w = d.rem_euclid(TAU);
    if w > PI { w - TAU } else { w }
}

/// Unwraps the u values of a loop so they change continuously. Returns the
/// unwrapped points and how far u winds around the loop (0 or ±2π).
fn unwrap_loop(pts: &[DVec2]) -> (Vec<DVec2>, f64) {
    let mut out: Vec<DVec2> = Vec::with_capacity(pts.len());
    for (i, p) in pts.iter().enumerate() {
        let u = if i == 0 { p.x } else { out[i - 1].x + wrap(p.x - pts[i - 1].x) };
        out.push(DVec2::new(u, p.y));
    }
    let (first, last) = (pts[0], pts[pts.len() - 1]);
    let winding = out[out.len() - 1].x + wrap(first.x - last.x) - out[0].x;
    (out, winding)
}

/// The uv points of a loop (same order as `loop_vertices`), with edges that
/// are constant-parameter lines of the surface given exactly one value for
/// that parameter. A circle round a cylinder's axis has a single v; a line
/// along the axis has a single u. Projecting each point instead adds
/// rounding noise, which far from the origin can exceed the point spacing of
/// a small circle: the "straight" row zig-zags and the triangulation folds.
fn snapped_loop_uv(body: &Body, mesh: &Mesh, fi: FaceId, li: usize) -> Vec<DVec2> {
    let face = &body.faces[fi];
    let ids = loop_vertices(body, mesh, fi, li);
    let mut uv: Vec<DVec2> = ids.iter().map(|&i| face.surface.project(mesh.positions[i as usize])).collect();
    let Surface::Cylinder { origin, axis, .. } = face.surface else { return uv };
    let n = uv.len();
    // Coedge k's points sit at positions start_k ..= end_k (start_k is the
    // previous coedge's last point, so corners get both edges' snaps).
    let mut end = n - 1;
    for c in &face.loops[li].coedges {
        let e = &body.edges[c.edge];
        let count = mesh.edge_polylines[c.edge].len() - 1;
        let positions: Vec<usize> = (0..=count).map(|k| (end + k) % n).collect();
        end = positions[count];
        match e.curve {
            Curve::Circle { center, axis: ca, .. } if ca.cross(axis).length() <= tolerance::ANGULAR => {
                let radial = (center - origin) - axis * (center - origin).dot(axis);
                if radial.length() <= tolerance::LINEAR {
                    let v = (center - origin).dot(axis);
                    positions.iter().for_each(|&k| uv[k].y = v);
                }
            }
            Curve::Line { origin: lo, dir } if dir.cross(axis).length() <= tolerance::ANGULAR => {
                let u = face.surface.project(lo).x;
                positions.iter().for_each(|&k| uv[k].x = u);
            }
            _ => {}
        }
    }
    uv
}

/// Loops of mesh vertex ids with their matching uv points.
type UvRegion = (Vec<Vec<u32>>, Vec<Vec<DVec2>>);

/// Builds a simple uv region for a face on a surface whose `u` is periodic.
/// Loops that wind all the way around (like the two circles bounding a
/// cylinder's side) are joined by a seam into one polygon. `u` is scaled by
/// `u_scale` so the triangulation sees true proportions.
fn periodic_domain(body: &Body, mesh: &Mesh, fi: FaceId, u_scale: f64) -> Result<UvRegion, String> {
    let face = &body.faces[fi];
    let mut ids = Vec::new();
    let mut uvs = Vec::new();
    let mut windings = Vec::new();
    for li in 0..face.loops.len() {
        let l = loop_vertices(body, mesh, fi, li);
        let raw = snapped_loop_uv(body, mesh, fi, li);
        let (uv, w) = unwrap_loop(&raw);
        ids.push(l);
        uvs.push(uv);
        windings.push(w);
    }
    let periodic: Vec<usize> = (0..windings.len()).filter(|&i| windings[i].abs() > PI).collect();
    let (ids, mut uvs) = match periodic.as_slice() {
        [] => {
            // Bring every loop to the same period as the first.
            let base = uvs[0][0].x;
            for uv in uvs.iter_mut().skip(1) {
                let shift = base + wrap(uv[0].x - base) - uv[0].x;
                uv.iter_mut().for_each(|p| p.x += shift);
            }
            (ids, uvs)
        }
        [a, b] if ids.len() == 2 => {
            let (ia, ua, wa) = (&ids[*a], &uvs[*a], windings[*a]);
            let (ib, ub, wb) = (&ids[*b], &uvs[*b], windings[*b]);
            // Walk A once round, step across the seam to the closest point of
            // B, walk B once round (the other way), and step back.
            let target = ua[0].x + wa;
            let j = (0..ub.len())
                .min_by(|&x, &y| wrap(ub[x].x - target).abs().total_cmp(&wrap(ub[y].x - target).abs()))
                .ok_or("empty loop")?;
            let mut poly_ids: Vec<u32> = ia.clone();
            let mut poly_uv: Vec<DVec2> = ua.clone();
            poly_ids.push(ia[0]);
            poly_uv.push(DVec2::new(ua[0].x + wa, ua[0].y));
            let shift = target + wrap(ub[j].x - target) - ub[j].x;
            for k in 0..ub.len() {
                let m = (j + k) % ub.len();
                // Indices past the end of B wrap round, so undo B's winding.
                let unwrap = if m < j { wb } else { 0.0 };
                poly_ids.push(ib[m]);
                poly_uv.push(DVec2::new(ub[m].x + shift + unwrap, ub[m].y));
            }
            poly_ids.push(ib[j]);
            poly_uv.push(DVec2::new(ub[j].x + shift + wb, ub[j].y));
            (vec![poly_ids], vec![poly_uv])
        }
        _ => return Err("this arrangement of loops around a periodic surface is not supported yet".into()),
    };
    uvs.iter_mut().flatten().for_each(|p| p.x *= u_scale);
    Ok((ids, uvs))
}

/// A sphere face bounded by a single circle (a hemisphere or any other cap):
/// rings of points from the boundary towards the pole on the face's side.
fn sphere_cap(body: &Body, fi: FaceId, mesh: &mut Mesh, center: DVec3, radius: f64) -> Result<(), String> {
    let face = &body.faces[fi];
    let [l] = face.loops.as_slice() else { return Err("general sphere faces are not supported yet".into()) };
    let [c] = l.coedges.as_slice() else { return Err("general sphere faces are not supported yet".into()) };
    let e = &body.edges[c.edge];
    let Curve::Circle { center: rim_center, axis, radius: rim_radius, .. } = e.curve else {
        return Err("sphere cap must be bounded by a circle".into());
    };
    if !e.is_closed() {
        return Err("sphere cap boundary must be a closed circle".into());
    }
    let boundary = loop_vertices(body, mesh, fi, 0);
    // The face interior lies on the left of its boundary: normal × tangent.
    let s0 = if c.reversed { 1.0 } else { 0.0 };
    let p0 = e.point_at(s0);
    let t0 = if c.reversed { -e.tangent_at(s0) } else { e.tangent_at(s0) };
    let inward = body.face_normal_at(fi, p0).cross(t0);
    let pole_dir = if inward.dot(axis) >= 0.0 { axis } else { -axis };
    let pole = center + pole_dir * radius;

    let dirs: Vec<DVec3> = boundary.iter().map(|&i| (mesh.positions[i as usize] - center).normalize()).collect();
    // Angle from the rim to the pole, from the exact curve rather than mesh
    // points: those carry the rounding of world coordinates (~1e-8 mm at
    // 100 km), enough to tip the ring count past a whole number, so a part
    // that merely moved would be meshed differently.
    let theta = fmath::atan2(rim_radius, (rim_center - center).dot(pole_dir));
    let rings = segments(&Curve::Circle { center, axis, x_dir: dirs[0], radius }, theta, mesh_opts(mesh)).max(1);

    let mut prev: Vec<u32> = boundary.clone();
    for k in 1..=rings {
        let ring: Vec<u32> = if k == rings {
            mesh.positions.push(pole);
            vec![(mesh.positions.len() - 1) as u32]
        } else {
            let f = k as f64 / rings as f64;
            dirs.iter()
                .map(|&d| {
                    mesh.positions.push(center + slerp(d, pole_dir, f) * radius);
                    (mesh.positions.len() - 1) as u32
                })
                .collect()
        };
        let n = prev.len();
        for i in 0..n {
            let (a, b) = (prev[i], prev[(i + 1) % n]);
            if ring.len() == 1 {
                push_oriented(mesh, body, fi, [a, b, ring[0]]);
            } else {
                let (c2, d) = (ring[(i + 1) % n], ring[i]);
                push_oriented(mesh, body, fi, [a, b, c2]);
                push_oriented(mesh, body, fi, [a, c2, d]);
            }
        }
        prev = ring;
    }
    Ok(())
}

/// The options the current tessellation runs with, recovered from the mesh
/// so helpers share one setting.
fn mesh_opts(mesh: &Mesh) -> &TessOptions {
    &mesh.options
}

/// Spherical interpolation between unit vectors.
fn slerp(a: DVec3, b: DVec3, f: f64) -> DVec3 {
    let angle = fmath::acos(a.dot(b).clamp(-1.0, 1.0));
    if angle < tolerance::ANGULAR {
        return a;
    }
    (a * fmath::sin((1.0 - f) * angle) + b * fmath::sin(f * angle)) / fmath::sin(angle)
}

/// Adds a triangle wound so its normal agrees with the face's outward normal.
fn push_oriented(mesh: &mut Mesh, body: &Body, fi: FaceId, t: [u32; 3]) {
    let [a, b, c] = t.map(|i| mesh.positions[i as usize]);
    let n = (b - a).cross(c - a);
    let outward = body.face_normal_at(fi, (a + b + c) / 3.0);
    mesh.triangles.push(if n.dot(outward) >= 0.0 { t } else { [t[0], t[2], t[1]] });
    mesh.triangle_face.push(fi);
}

/// Adds triangles that are counter-clockwise in uv; uv runs counter-clockwise
/// around the natural normal, so flip them when the face is reversed.
fn push_triangles(mesh: &mut Mesh, face: FaceId, tris: Vec<[u32; 3]>, sense: bool) {
    for [a, b, c] in tris {
        mesh.triangles.push(if sense { [a, b, c] } else { [a, c, b] });
        mesh.triangle_face.push(face);
    }
}

type Cdt = ConstrainedDelaunayTriangulation<Point2<f64>>;

/// Snaps a uv coordinate the triangulator would refuse (below ~1e-142) to 0.
fn snap_uv(p: DVec2) -> Point2<f64> {
    let snap = |x: f64| if x.abs() < tolerance::SNAP_TO_ZERO { 0.0 } else { x };
    Point2::new(snap(p.x), snap(p.y))
}

/// All the points of `uv`, loop after loop, bulk loaded into a triangulation
/// whose handle i is point i; None when two points share a position (bulk
/// loading would keep only one) or a coordinate is refused. About twice as
/// fast as inserting the points one at a time in a release build: 4 s
/// instead of 8 s for a cap face with 2,000 round holes (500,000 points,
/// slow mostly because points lying almost on one circle need exact
/// predicates).
fn bulk_loaded(uv: &[Vec<DVec2>]) -> Option<Cdt> {
    let points: Vec<Point2<f64>> = uv.iter().flatten().map(|&p| snap_uv(p)).collect();
    let n = points.len();
    Cdt::bulk_load_cdt(points, vec![]).ok().filter(|cdt| cdt.num_vertices() == n)
}

/// The triangulation of `triangulate_uv`'s points inserted one at a time,
/// with the mesh vertex of each handle and each loop's handles. This path
/// accepts a repeated point only if it is the same mesh vertex, and reports
/// anything else (`bulk_loaded` can't tell which point was kept).
#[allow(clippy::type_complexity)]
fn insert_one_at_a_time(loops: &[Vec<u32>], uv: &[Vec<DVec2>]) -> Result<((Cdt, Vec<u32>), Vec<Vec<FixedVertexHandle>>), String> {
    let mut cdt = Cdt::new();
    let mut handle_to_mesh: Vec<u32> = Vec::new();
    let mut handles = Vec::new();
    for (l, pts) in loops.iter().zip(uv) {
        let mut hs = Vec::new();
        for (&id, &p) in l.iter().zip(pts) {
            let h = cdt.insert(snap_uv(p)).map_err(|e| format!("{e:?}"))?;
            if h.index() == handle_to_mesh.len() {
                handle_to_mesh.push(id);
            } else if handle_to_mesh[h.index()] != id {
                return Err("two boundary points have the same uv position".into());
            }
            hs.push(h);
        }
        handles.push(hs);
    }
    Ok(((cdt, handle_to_mesh), handles))
}

/// Constrained Delaunay triangulation of the region bounded by `loops`
/// (mesh vertex ids with matching uv points). Returns counter-clockwise
/// triangles inside the region (even-odd rule).
pub(crate) fn triangulate_uv(loops: &[Vec<u32>], uv: &[Vec<DVec2>]) -> Result<Vec<[u32; 3]>, String> {
    triangulate_loaded(loops, uv, bulk_loaded(uv))
}

/// `triangulate_uv` from the bulk loaded points, or (None) from inserting
/// them one at a time.
fn triangulate_loaded(loops: &[Vec<u32>], uv: &[Vec<DVec2>], loaded: Option<Cdt>) -> Result<Vec<[u32; 3]>, String> {
    let ((mut cdt, handle_to_mesh), handles) = match loaded {
        Some(cdt) => {
            let mut next = 0;
            let handles = loops
                .iter()
                .map(|l| {
                    next += l.len();
                    (next - l.len()..next).map(FixedVertexHandle::from_index).collect()
                })
                .collect();
            ((cdt, loops.iter().flatten().copied().collect()), handles)
        }
        None => insert_one_at_a_time(loops, uv)?,
    };
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
    // Inside/outside by topology, not geometry: walk from the outside of the
    // triangulation, flipping between outside and inside each time a
    // boundary (constraint) edge is crossed. Testing triangle centroids
    // instead misclassifies the slivers that appear when boundary points are
    // collinear up to rounding.
    // Indexed by face handle (dense indices), not hashed: a cap face with
    // 1,000,000 triangles took 0.4 s with a hash map.
    let mut inside: Vec<Option<bool>> = vec![None; cdt.num_all_faces()];
    let mut queue = std::collections::VecDeque::new();
    for f in cdt.inner_faces() {
        for e in f.adjacent_edges() {
            if e.rev().face().is_outer() && inside[f.fix().index()].is_none() {
                let parity = e.is_constraint_edge();
                inside[f.fix().index()] = Some(parity);
                queue.push_back((f, parity));
            }
        }
    }
    while let Some((f, parity)) = queue.pop_front() {
        for e in f.adjacent_edges() {
            if let Some(next) = e.rev().face().as_inner() {
                let slot = &mut inside[next.fix().index()];
                if slot.is_none() {
                    let next_parity = parity ^ e.is_constraint_edge();
                    *slot = Some(next_parity);
                    queue.push_back((next, next_parity));
                }
            }
        }
    }
    let mut out = Vec::new();
    for f in cdt.inner_faces() {
        if inside[f.fix().index()] == Some(true) {
            out.push(f.vertices().map(|v| handle_to_mesh[v.fix().index()]));
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tolerance::eq;
    use crate::fixtures::{hand_cube, hand_cylinder, hand_half_cylinder, hand_sphere, hand_tube, hand_twisted_cylinder};
    use crate::tolerance::{points_eq, rel_eq, FP_REL, LINEAR};
    use crate::validate::validate;

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

    /// Largest distance from the surface of any mesh vertex, and of any
    /// mesh edge's midpoint.
    fn surface_error(body: &Body, m: &Mesh) -> (f64, f64) {
        let mut on = 0.0f64;
        let mut mid = 0.0f64;
        for (t, tri) in m.triangles.iter().enumerate() {
            let s = &body.faces[m.triangle_face[t]].surface;
            for k in 0..3 {
                let (a, b) = (m.positions[tri[k] as usize], m.positions[tri[(k + 1) % 3] as usize]);
                on = on.max(s.distance(a));
                mid = mid.max(s.distance((a + b) / 2.0));
            }
        }
        (on, mid)
    }

    #[test]
    fn cylinder_mesh_is_an_exact_prism_over_the_inscribed_polygon() {
        for (r, h) in [(1.0, 2.0), (25.0, 0.5), (0.05, 300.0)] {
            let body = hand_cylinder(r, h);
            let opts = TessOptions::DISPLAY;
            let m = tessellate(&body, &opts).unwrap();
            assert_eq!(m.check_closed(), Ok(()), "r={r} h={h}");
            let n = m.edge_polylines[0].len() - 1;
            let polygon = 0.5 * n as f64 * r * r * fmath::sin(TAU / n as f64);
            assert!(crate::tolerance::rel_eq(m.signed_volume(), polygon * h, crate::tolerance::FP_REL), "r={r} h={h}");
            let (on, mid) = surface_error(&body, &m);
            assert!(on <= crate::tolerance::LINEAR);
            assert!(mid <= opts.chord, "chord error {mid} > {}", opts.chord);
        }
    }

    #[test]
    fn sphere_mesh_is_closed_and_on_the_sphere() {
        for r in [1.0, 40.0, 1e-2] {
            let body = hand_sphere(r);
            let opts = TessOptions::DISPLAY;
            let m = tessellate(&body, &opts).unwrap();
            assert_eq!(m.check_closed(), Ok(()), "r={r}");
            assert!(m.signed_volume() > 0.0 && m.signed_volume() < 4.0 / 3.0 * PI * r.powi(3));
            let (on, mid) = surface_error(&body, &m);
            assert!(on <= crate::tolerance::LINEAR, "r={r}: vertex {on} off sphere");
            // Ring and meridian edges obey the chord limit; quad diagonals
            // cut across both directions, so they can sag up to twice that.
            assert!(mid <= 2.0 * opts.chord, "r={r}: chord error {mid}");
        }
    }

    #[test]
    fn hand_cylinder_and_sphere_validate() {
        assert_eq!(crate::validate::validate(&hand_cylinder(3.0, 7.0)), Ok(()));
        assert_eq!(crate::validate::validate(&hand_sphere(5.0)), Ok(()));
        let c = hand_cylinder(3.0, 7.0);
        assert_eq!(c.counts(&c.shells[0]).genus(), Some(0));
        let s = hand_sphere(5.0);
        assert_eq!(s.counts(&s.shells[0]).genus(), Some(0));
    }

    #[test]
    fn rotated_cylinder_has_no_sliver_misclassification() {
        // Regression (found by the stateful harness, minimal case
        // tests/regressions/stateful/seed5eed-75f6a478290e8ae7.json): after a
        // 90° turn about (1,1,0) the top circle's points are no longer exactly
        // collinear in the side face's uv space, the triangulation makes
        // slivers along the boundary, and classifying triangles by their
        // centroid put some on the wrong side: 6 open/flipped mesh edges.
        let c = crate::fixtures::hand_cylinder(56.5, 5.0);
        let b = c.transformed(&crate::geom::Transform::rotation(DVec3::new(1.0, 1.0, 0.0), PI / 2.0));
        let m = tessellate(&b, &TessOptions::DISPLAY).unwrap();
        assert_eq!(m.check_closed(), Ok(()));
        assert_eq!(validate(&b), Ok(()));
    }

    #[test]
    fn tiny_cylinder_far_away_does_not_fold() {
        // Regression (stateful harness, seed5eed-1c6487431cbfd1f1.json):
        // radius 1.1e-6 turned about Y and moved 5e5 out. Projected uv
        // carried ~1e-10 of noise against a 2e-7 point spacing, so each
        // circle's "straight" row in uv zig-zagged and the triangulation
        // made triangles from three points of one row: flat in uv, folded
        // over the cap in 3D (15 open/flipped mesh edges).
        let c = crate::fixtures::hand_cylinder(1.1e-6, 2.5);
        let b = c
            .transformed(&crate::geom::Transform::rotation(DVec3::Y, 9.911584385521566))
            .transformed(&crate::geom::Transform::translation(DVec3::new(5e5, 0.0, 0.0)));
        let m = tessellate(&b, &TessOptions::DISPLAY).unwrap();
        assert_eq!(m.check_closed(), Ok(()));
        // The same for a partial cylinder patch, whose straight edges are
        // constant-u lines.
        let h = crate::fixtures::hand_half_cylinder(1.1e-6, 2.5)
            .transformed(&crate::geom::Transform::rotation(DVec3::new(1.0, 2.0, 3.0), 2.0))
            .transformed(&crate::geom::Transform::translation(DVec3::new(-3e5, 4e5, 1e5)));
        let m = tessellate(&h, &TessOptions::DISPLAY).unwrap();
        assert_eq!(m.check_closed(), Ok(()));
    }

    #[test]
    fn half_cylinder_patch_is_an_exact_half_prism() {
        // The curved face is a partial patch (no loop winds round the axis).
        // Its mesh is a prism over the inscribed half polygon: n chords over
        // an angle of π, area n/2 · r² sin(π/n), times h.
        for (r, h) in [(1.0, 2.0), (30.0, 0.2), (0.02, 50.0)] {
            let body = hand_half_cylinder(r, h);
            assert_eq!(validate(&body), Ok(()), "r={r} h={h}");
            let m = tessellate(&body, &TessOptions::DISPLAY).unwrap();
            assert_eq!(m.check_closed(), Ok(()));
            let n = m.edge_polylines[0].len() - 1;
            let half_polygon = 0.5 * n as f64 * r * r * fmath::sin(PI / n as f64);
            assert!(rel_eq(m.signed_volume(), half_polygon * h, FP_REL), "r={r} h={h}");
            let (on, mid) = surface_error(&body, &m);
            assert!(on <= LINEAR && mid <= TessOptions::DISPLAY.chord);
        }
    }

    #[test]
    fn twisted_cylinder_seam_still_closes() {
        // Top vertex at a different angle from the bottom one, so the seam
        // joins points that don't line up and the B loop needs shifting.
        for twist in [0.5, 2.0, -2.5, PI] {
            let body = hand_twisted_cylinder(4.0, 3.0, twist);
            assert_eq!(validate(&body), Ok(()), "twist {twist}");
            let m = tessellate(&body, &TessOptions::DISPLAY).unwrap();
            assert_eq!(m.check_closed(), Ok(()), "twist {twist}");
            let (on, mid) = surface_error(&body, &m);
            assert!(on <= LINEAR && mid <= TessOptions::DISPLAY.chord, "twist {twist}: {mid}");
            // Every side triangle spans a small angle: none may cut across
            // the cylinder (that would put its centroid far inside).
            for (t, &f) in m.triangle_face.iter().enumerate() {
                if f == 2 {
                    let [a, b, c] = m.triangle(t);
                    let centroid = (a + b + c) / 3.0;
                    let radial = DVec3::new(centroid.x, centroid.y, 0.0).length();
                    assert!(4.0 - radial <= TessOptions::DISPLAY.chord * 2.0, "twist {twist}: triangle {t} cuts inside");
                }
            }
            // Inscribed in the true cylinder, so strictly less volume.
            assert!(m.signed_volume() < PI * 16.0 * 3.0);
        }
    }

    #[test]
    fn sphere_triangles_belong_to_their_own_hemisphere() {
        // Face 0's loop runs counter-clockwise seen from +Z, so it is the
        // upper hemisphere; face 1 is the lower one.
        let body = hand_sphere(3.0);
        let m = tessellate(&body, &TessOptions::DISPLAY).unwrap();
        for (t, &f) in m.triangle_face.iter().enumerate() {
            let [a, b, c] = m.triangle(t);
            let z = (a + b + c).z / 3.0;
            if f == 0 {
                assert!(z > 0.0, "upper-face triangle {t} is below the equator");
            } else {
                assert!(z < 0.0, "lower-face triangle {t} is above the equator");
            }
        }
    }

    #[test]
    fn sphere_refinement_counts_by_hand() {
        // Radius 1, max angle 0.2, chord 0.01 (chord angle 2·acos(0.99) ≈ 0.284):
        // equator 2π/0.2 → 32 segments; quarter meridian (π/2)/0.2 → 8 rings.
        // Per hemisphere: 32 × (2·(8-1) + 1) = 480 triangles, 960 in all.
        let body = hand_sphere(1.0);
        let m1 = tessellate(&body, &TessOptions::DISPLAY).unwrap();
        assert_eq!(m1.triangles.len(), 960);
        // refine 2 doubles both: 64 × (2·(16-1) + 1) = 1984 per hemisphere.
        let m2 = tessellate(&body, &TessOptions { refine: 2, ..TessOptions::DISPLAY }).unwrap();
        assert_eq!(m2.triangles.len(), 3968);
    }

    #[test]
    fn arc_edge_not_starting_at_zero_by_hand() {
        // Unit circle, edge over t ∈ [3, 3 + π/2]: max angle 0.2 gives
        // ceil(1.571/0.2) = 8 segments; chord limit gives ceil(1.571/0.284) = 6.
        // So 8 segments, 9 points, all inside the arc's angle range.
        let mut b = Body::default();
        let c = Curve::Circle { center: DVec3::ZERO, axis: DVec3::Z, x_dir: DVec3::X, radius: 1.0 };
        let (t0, t1) = (3.0, 3.0 + PI / 2.0);
        let v0 = b.add_vertex(c.eval(t0));
        let v1 = b.add_vertex(c.eval(t1));
        b.add_edge(c.clone(), v0, v1, t0, t1);
        let m = tessellate(&b, &TessOptions::DISPLAY).unwrap();
        let poly = &m.edge_polylines[0];
        assert_eq!(poly.len(), 9);
        for (k, &i) in poly.iter().enumerate() {
            let expected = c.eval(t0 + (t1 - t0) * k as f64 / 8.0);
            assert!(points_eq(m.positions[i as usize], expected), "point {k}");
        }
    }

    #[test]
    fn chord_limit_boundary_by_hand() {
        // A chord spanning θ sags r(1 - cos(θ/2)). A full circle needs 4
        // chords exactly when θ = π/2, i.e. c* = r(1 - cos 45°) = r(1 - √½).
        // Slightly tighter (0.9 c*) forces θ < π/2 → 5 chords; slightly
        // looser (1.1 c*) allows θ > π/2 → 4 chords.
        let c = Curve::Circle { center: DVec3::ZERO, axis: DVec3::Z, x_dir: DVec3::X, radius: 1.0 };
        let c_star = 1.0 - 0.5f64.sqrt();
        let opts = |chord| TessOptions { chord, max_angle: 100.0, refine: 1 };
        assert_eq!(segments(&c, TAU, &opts(c_star * 0.9)), 5);
        assert_eq!(segments(&c, TAU, &opts(c_star * 1.1)), 4);
        // Same rule on a radius-50 circle: everything scales with r.
        let big = Curve::Circle { center: DVec3::ZERO, axis: DVec3::Z, x_dir: DVec3::X, radius: 50.0 };
        assert_eq!(segments(&big, TAU, &opts(50.0 * c_star * 0.9)), 5);
        assert_eq!(segments(&big, TAU, &opts(50.0 * c_star * 1.1)), 4);
    }

    #[test]
    fn chords_are_split_where_a_wall_is_thinner_than_their_sag() {
        // A tube of radius 100 with a 1 µm wall (MIN_FEATURE, the thinnest
        // the supported range allows), hole points half a chord out of step.
        // By hand: r ≈ 100 at a 0.01 chord allows 2·acos(1 − 1e-4) ≈ 0.02828
        // rad per chord, so both circles start with ceil(2π/0.02828) = 223
        // chords, sagging 100·(1 − cos(π/223)) ≈ 9.9e-3 inside their circle:
        // ten times the wall, so the outer chords cut through the hole.
        // Halving twice gives 892 chords sagging ≈ 6.2e-4 < 1e-3, after
        // which they can't cross (the hole's chords sag away, inwards). Both
        // chords of a crossing pair are split, so each circle ends with
        // more than 223 and at most 892 chords.
        let (r, wall) = (100.0, crate::tolerance::MIN_FEATURE);
        let body = hand_tube(r, r + wall, 5.0, PI / 223.0);
        assert_eq!(validate(&body), Ok(()));
        let m = tessellate(&body, &TessOptions::DISPLAY).unwrap();
        assert_eq!(m.check_closed(), Ok(()));
        let chords = |e: usize| m.edge_polylines[e].len() - 1;
        for e in 0..4 {
            assert!((224..=892).contains(&chords(e)), "edge {e}: {} chords", chords(e));
        }
        // Top and bottom caps are refined alike (same shape, same rule).
        assert_eq!((chords(0), chords(2)), (chords(1), chords(3)));
        // No outer chord crosses a hole chord, checked by brute force with
        // plain arithmetic (independently of the exact sweep the kernel
        // uses): segments pq and uv cross when each straddles the other.
        let cross = |a: DVec3, b: DVec3, c: DVec3| (b - a).truncate().perp_dot((c - a).truncate());
        for (outer, hole) in [(0, 2), (1, 3)] {
            for w in m.edge_polylines[outer].windows(2) {
                let (p, q) = (m.positions[w[0] as usize], m.positions[w[1] as usize]);
                for z in m.edge_polylines[hole].windows(2) {
                    let (u, v) = (m.positions[z[0] as usize], m.positions[z[1] as usize]);
                    let straddles = cross(p, q, u) * cross(p, q, v) < 0.0 && cross(u, v, p) * cross(u, v, q) < 0.0;
                    assert!(!straddles, "outer chord {p}–{q} crosses hole chord {u}–{v}");
                }
            }
        }
    }

    #[test]
    fn sphere_ring_count_does_not_depend_on_position() {
        // Regression (found by the overnight run on GitHub, seed
        // 0x5d7c66cfebde): rotating a sphere 50 km about a far pivot changed
        // its mesh volume by 2e-6, because the cap's pole angle was measured
        // from mesh points that carry the rounding of world coordinates.
        //
        // By hand: r = 137.5…; the 0.01 chord allows 2·acos(1 − 0.01/r) ≈
        // 0.0241 rad per chord, below the 2π/256 ≈ 0.0245 floor, so the step
        // is exactly 2π/256. Each hemisphere spans π/2 from equator to pole,
        // exactly 64 steps: 64 rings, i.e. 63 bands of 2·256 triangles plus a
        // fan of 256, 256·(2·64 − 1) = 32512 triangles; 65024 for the ball.
        let r = 137.52459832834157;
        let ball = crate::ops::primitives::make_sphere(r).unwrap();
        // Turned and moved geometry, baked into world coordinates (as two
        // bodies meeting in a boolean will be).
        let turned = crate::ops::transform::rotate(&crate::placed::Placed::new(ball), DVec3::ZERO, DVec3::new(1.0, 1.0, 1.0), -4.71238898038469).unwrap();
        let far = crate::ops::transform::rotate(&turned, DVec3::new(5e7, 0.0, 0.0), DVec3::new(-9e-10, 0.0, 1.0), 3.8846540033404207).unwrap();
        let (ball, far) = (turned.baked(), far.baked());
        for (name, b) in [("at the origin", &ball), ("100 km out", &far)] {
            let m = tessellate(b, &TessOptions::DISPLAY).unwrap();
            assert_eq!(m.triangles.len(), 65024, "{name}");
        }
    }

    #[test]
    fn segment_count_is_capped_for_huge_circles() {
        // r = 1e6 at a 0.01 mm chord would need 2π / (2·acos(1 − 1e-8)) ≈
        // 22,214 chords; the cap holds it to 256 (and 512 with refine 2).
        let c = Curve::Circle { center: DVec3::ZERO, axis: DVec3::Z, x_dir: DVec3::X, radius: 1e6 };
        assert_eq!(segments(&c, TAU, &TessOptions::DISPLAY), 256);
        assert_eq!(segments(&c, TAU, &TessOptions { refine: 2, ..TessOptions::DISPLAY }), 512);
        // Half a turn gets half: 128.
        assert_eq!(segments(&c, PI, &TessOptions::DISPLAY), 128);
    }

    #[test]
    fn whole_segment_counts_survive_rounding_noise() {
        // At the cap a hemisphere's quarter meridian spans exactly
        // (π/2) / (2π/256) = 64 steps. A span a few ulps over must still
        // give 64, and one a tenth of a step over must give 65.
        let c = Curve::Circle { center: DVec3::ZERO, axis: DVec3::Z, x_dir: DVec3::X, radius: 1e6 };
        let step = TAU / 256.0;
        assert_eq!(segments(&c, 64.0 * step * (1.0 + 4.0 * f64::EPSILON), &TessOptions::DISPLAY), 64);
        assert_eq!(segments(&c, 64.1 * step, &TessOptions::DISPLAY), 65);
    }

    #[test]
    fn full_circle_always_has_at_least_three_chords() {
        // Even with no chord or angle limit to speak of (chord 10r), a
        // circle is never drawn with fewer than 3 chords: 2π / (2π/3) = 3.
        let c = Curve::Circle { center: DVec3::ZERO, axis: DVec3::Z, x_dir: DVec3::X, radius: 1.0 };
        let opts = TessOptions { chord: 10.0, max_angle: 100.0, refine: 1 };
        assert_eq!(segments(&c, TAU, &opts), 3);
        // Chord = r: the sag rule alone allows θ = π (2 chords), but two
        // chords of a circle enclose nothing, so the floor of 3 applies.
        // (This case was 1 chord before the fix: the old code skipped the
        // sag rule entirely once chord >= r.)
        assert_eq!(segments(&c, TAU, &TessOptions { chord: 1.0, ..opts }), 3);
        // ...so a cylinder meshed that coarsely is still a valid triangular prism.
        let body = hand_cylinder(1.0, 1.0);
        let m = tessellate(&body, &opts).unwrap();
        assert_eq!(m.check_closed(), Ok(()));
        // Equilateral triangle in a unit circle: area (3√3/4)·r², times h = 1.
        assert!(rel_eq(m.signed_volume(), 3.0 * 3f64.sqrt() / 4.0, FP_REL));
    }

    #[test]
    fn unwrap_loop_by_hand() {
        // Four points round the circle, counter-clockwise: u winds by +2π.
        let ccw = [0.0, 1.6, 3.2, 4.8].map(|u| DVec2::new(u, 0.0));
        let (out, w) = unwrap_loop(&ccw);
        assert!(crate::tolerance::angle_eq(w, TAU));
        assert!(crate::tolerance::angle_eq(out[3].x, 4.8));
        // Clockwise starting just past zero: 0.1 → 6.2 is a step of -0.183, etc.
        let cw = [0.1, 6.2, 4.6, 3.0, 1.4].map(|u| DVec2::new(u, 0.0));
        let (out, w) = unwrap_loop(&cw);
        assert!(crate::tolerance::angle_eq(w, -TAU));
        assert!(crate::tolerance::angle_eq(out[1].x, 6.2 - TAU));
        // A patch that doesn't go round: winding 0.
        let patch = [5.9, 6.2, 0.2, 0.2, 5.9].map(|u| DVec2::new(u, 1.0));
        assert!(crate::tolerance::angle_eq(unwrap_loop(&patch).1, 0.0));
    }

    #[test]
    fn slerp_by_hand() {
        // Halfway between X and Y on the unit circle is (√½, √½, 0).
        let h = 0.5f64.sqrt();
        assert!(points_eq(slerp(DVec3::X, DVec3::Y, 0.5), DVec3::new(h, h, 0.0)));
        // A third of the way: (cos 30°, sin 30°, 0).
        assert!(points_eq(slerp(DVec3::X, DVec3::Y, 1.0 / 3.0), DVec3::new(0.75f64.sqrt(), 0.5, 0.0)));
        assert!(points_eq(slerp(DVec3::X, DVec3::Y, 0.0), DVec3::X));
        assert!(points_eq(slerp(DVec3::X, DVec3::Y, 1.0), DVec3::Y));
        assert!(points_eq(slerp(DVec3::Z, DVec3::Z, 0.7), DVec3::Z));
    }

    #[test]
    fn push_oriented_by_hand() {
        // Cube face 1 is the top, outward normal +Z. Seen from above,
        // (-5,-5) → (-4,-5) → (-5,-4) is counter-clockwise: kept as is.
        // The clockwise version must be flipped. (Placed off the origin so a
        // sign slip in the edge vectors changes the answer.)
        let body = hand_cube();
        let mut m = Mesh {
            positions: vec![DVec3::new(-5.0, -5.0, 1.0), DVec3::new(-4.0, -5.0, 1.0), DVec3::new(-5.0, -4.0, 1.0)],
            ..Mesh::default()
        };
        push_oriented(&mut m, &body, 1, [0, 1, 2]);
        push_oriented(&mut m, &body, 1, [0, 2, 1]);
        assert_eq!(m.triangles, vec![[0, 1, 2], [0, 1, 2]]);
        assert_eq!(m.triangle_face, vec![1, 1]);
    }

    #[test]
    fn coordinates_between_the_old_snap_and_the_cdt_floor() {
        // Regression (stateful harness, tests/regressions/stateful/
        // seed5eed-df8b7471ccfdeb56.json): a box turned by almost a full
        // revolution leaves uv residue around 1e-60. That is above the old
        // 1e-100 snap but below the triangulator's 2^-142 floor, so it was
        // rejected with TooSmall. Both sides of the floor must work.
        for tiny in [1e-60, spade::MIN_ALLOWED_VALUE * 0.9, spade::MIN_ALLOWED_VALUE * 1.1, 1e-30] {
            let (ids, uv) = region(&[vec![(tiny, -tiny), (1.0, tiny), (0.0, 1.0)]]);
            assert_eq!(triangulate_uv(&ids, &uv).unwrap().len(), 1, "{tiny:e}");
        }
    }

    #[test]
    fn snap_threshold_is_above_the_triangulator_floor() {
        // Compile-time facts, checked at test time so a change to either
        // constant can't silently reopen the TooSmall crash.
        let (snap, floor) = (tolerance::SNAP_TO_ZERO, spade::MIN_ALLOWED_VALUE);
        assert!(snap > floor && snap < tolerance::LINEAR * 1e-20, "{snap:e} vs floor {floor:e}");
    }

    #[test]
    fn tiny_coordinates_are_snapped_not_rejected() {
        // The triangulator refuses coordinates below ~1e-142; real geometry
        // never needs them, so they are snapped to zero.
        let (ids, uv) = region(&[vec![(1e-200, 0.0), (1.0, 0.0), (0.0, 1.0)]]);
        assert_eq!(triangulate_uv(&ids, &uv).unwrap().len(), 1);
    }

    #[test]
    fn bulk_loading_keeps_input_order_and_leaves_repeats_to_the_slow_path() {
        // Two loops of distinct points: handle i is point i, loop after loop.
        let p = |x: f64, y: f64| DVec2::new(x, y);
        let uv = vec![vec![p(0.0, 0.0), p(4.0, 0.0), p(4.0, 4.0), p(0.0, 4.0)], vec![p(1.0, 1.0), p(1.0, 2.0), p(2.0, 1.0)]];
        let cdt = bulk_loaded(&uv).expect("distinct points load");
        let flat: Vec<DVec2> = uv.iter().flatten().copied().collect();
        assert_eq!(cdt.num_vertices(), 7);
        for (i, v) in cdt.vertices().enumerate() {
            assert_eq!(p(v.position().x, v.position().y), flat[i], "handle {i}");
        }
        // A repeated position (bulk loading would keep one of the two) and
        // a coordinate the triangulator refuses both go to the one at a time
        // path, which decides whether they are an error.
        let mut repeated = uv.clone();
        repeated[1][2] = p(4.0, 4.0);
        assert!(bulk_loaded(&repeated).is_none());
        assert!(bulk_loaded(&[vec![p(f64::NAN, 0.0), p(1.0, 0.0), p(0.0, 1.0)]]).is_none());
        assert!(bulk_loaded(&[vec![p(f64::INFINITY, 0.0), p(1.0, 0.0), p(0.0, 1.0)]]).is_none());
    }

    #[test]
    fn a_region_with_holes_triangulates_by_hand() {
        // A 4 × 4 square with a unit square hole and a right-triangle hole
        // (legs 1): n = 4 + 4 + 3 = 11 boundary points, h = 2 holes. The
        // triangles' angles add up to the region's: π(4 − 2) at the outer
        // corners plus 2π·k − π(k − 2) = π(k + 2) round each hole of k
        // points, π(n − 2 + 2h) in all, so there are n + 2h − 2 = 13
        // triangles, of area 16 − 1 − 0.5 = 14.5. Both paths agree.
        let (ids, uv) = region(&[
            vec![(0.0, 0.0), (4.0, 0.0), (4.0, 4.0), (0.0, 4.0)],
            vec![(0.5, 0.5), (0.5, 1.5), (1.5, 1.5), (1.5, 0.5)],
            vec![(2.5, 2.5), (2.5, 3.5), (3.5, 2.5)],
        ]);
        for tris in [triangulate_uv(&ids, &uv).unwrap(), triangulate_loaded(&ids, &uv, None).unwrap()] {
            assert_eq!(tris.len(), 13);
            assert!(rel_eq(area(&tris, &uv), 14.5, FP_REL), "{}", area(&tris, &uv));
        }
    }

    #[test]
    fn bulk_loading_and_one_at_a_time_triangulate_the_same_region() {
        // Self-consistency, seeded: squares with grids of round holes (regular
        // polygons, so many points are cocircular and the Delaunay diagonals
        // are ties either path may break its own way), with and without
        // jitter. Both must give n + 2h − 2 counter-clockwise triangles of the
        // same total area, with every boundary step an edge of a triangle on
        // its left: the same region, meshed watertight.
        let mut seed: u64 = 0x005e_ed0f_ba11;
        let mut rnd = move || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            (seed >> 11) as f64 / (1u64 << 53) as f64
        };
        for case in 0..40 {
            let g = 1 + (rnd() * 6.0) as usize;
            let sides = 3 + (rnd() * 40.0) as usize;
            let jitter = if case % 2 == 0 { 0.0 } else { 0.05 };
            let mut loops = vec![vec![(0.0, 0.0), (g as f64, 0.0), (g as f64, g as f64), (0.0, g as f64)]];
            for i in 0..g {
                for j in 0..g {
                    let turn = if case % 3 == 0 { 0.0 } else { rnd() };
                    loops.push(
                        (0..sides)
                            .rev()
                            .map(|k| {
                                let a = TAU * (k as f64 + turn) / sides as f64;
                                let r = 0.3 + jitter * rnd();
                                (i as f64 + 0.5 + r * fmath::cos(a), j as f64 + 0.5 + r * fmath::sin(a))
                            })
                            .collect(),
                    );
                }
            }
            let (ids, uv) = region(&loops);
            let n: usize = uv.iter().map(Vec::len).sum();
            let flat: Vec<DVec2> = uv.iter().flatten().copied().collect();
            let bulk = triangulate_uv(&ids, &uv).unwrap();
            let slow = triangulate_loaded(&ids, &uv, None).unwrap();
            for tris in [&bulk, &slow] {
                assert_eq!(tris.len(), n + 2 * (g * g) - 2, "case {case}");
                let directed: std::collections::HashSet<(u32, u32)> =
                    tris.iter().flat_map(|t| (0..3).map(move |k| (t[k], t[(k + 1) % 3]))).collect();
                for t in tris.iter() {
                    let [a, b, c] = t.map(|i| flat[i as usize]);
                    assert!((b - a).perp_dot(c - a) > 0.0, "case {case}: {t:?} is not counter-clockwise");
                }
                // The outer loop runs counter-clockwise, holes clockwise: the
                // region is on the left of every step.
                for l in &ids {
                    for k in 0..l.len() {
                        assert!(directed.contains(&(l[k], l[(k + 1) % l.len()])), "case {case}: step {k}");
                    }
                }
            }
            assert!(rel_eq(area(&bulk, &uv), area(&slow, &uv), FP_REL), "case {case}");
        }
    }

    #[test]
    fn two_vertices_at_one_uv_point_is_an_error() {
        let ids = vec![vec![0, 1, 2, 3]];
        let uv = vec![[(0.0, 0.0), (1.0, 0.0), (1.0, 0.0), (0.0, 1.0)].map(|(x, y)| DVec2::new(x, y)).to_vec()];
        let err = triangulate_uv(&ids, &uv).unwrap_err();
        assert!(err.contains("same uv"), "{err}");
    }

    #[test]
    fn unsupported_loop_layout_is_an_error_not_a_wrong_mesh() {
        // Two loops winding round the axis plus a small extra loop on the
        // same cylinder face: not supported yet, so it must say so.
        let mut body = hand_cylinder(2.0, 4.0);
        let s = body.faces[2].surface.clone();
        let p: Vec<usize> = [(1.0, 1.0), (1.2, 1.0), (1.1, 1.5)].iter().map(|&(u, v)| body.add_vertex(s.eval(DVec2::new(u, v)))).collect();
        let coedges = (0..3).map(|i| crate::topology::Coedge { edge: body.add_line(p[i], p[(i + 1) % 3]), reversed: false }).collect();
        body.faces[2].loops.push(crate::topology::Loop { coedges });
        let err = tessellate(&body, &TessOptions::DISPLAY).unwrap_err();
        assert_eq!(err.face, 2);
        assert!(err.message.contains("not supported"), "{}", err.message);
    }

    #[test]
    fn circle_segment_counts_respect_both_limits() {
        // Below the per-turn cap (r = 100 needs ~222 chords), every chord sags
        // no more than the chord limit.
        let c = Curve::Circle { center: Default::default(), axis: glam::DVec3::Z, x_dir: glam::DVec3::X, radius: 100.0 };
        let opts = TessOptions::DISPLAY;
        let n = segments(&c, std::f64::consts::TAU, &opts);
        // Chord height of each segment within the limit.
        let sag = 100.0 * (1.0 - fmath::cos(std::f64::consts::PI / n as f64));
        assert!(sag <= opts.chord);
        let small = Curve::Circle { center: Default::default(), axis: glam::DVec3::Z, x_dir: glam::DVec3::X, radius: 1e-3 };
        assert!(segments(&small, std::f64::consts::TAU, &opts) as f64 >= std::f64::consts::TAU / opts.max_angle);
        let twice = TessOptions { refine: 2, ..opts };
        assert_eq!(segments(&c, 1.0, &twice), 2 * segments(&c, 1.0, &opts));
    }

    #[test]
    fn a_nan_angle_limit_leaves_the_chord_rule_in_charge() {
        // f64::min skips a NaN, so an unset angle limit is simply ignored.
        let c = Curve::Circle { center: DVec3::ZERO, axis: DVec3::Z, x_dir: DVec3::X, radius: 1.0 };
        let opts = |chord| TessOptions { chord, max_angle: f64::NAN, refine: 1 };
        // By hand: chord 0.01 on r = 1 allows 2·acos(0.99) ≈ 0.28308 rad per
        // chord; 2π / 0.28308 ≈ 22.2, so 23 chords.
        assert_eq!(segments(&c, TAU, &opts(0.01)), 23);
        // Chord 2.5 ≥ 2r: the sag rule sets no limit at all, so the
        // third-of-a-turn cap decides: 2π / (2π/3) = 3 chords. (The sag
        // formula itself would be 2·acos(1 − 2.5) = NaN here.)
        assert_eq!(segments(&c, TAU, &opts(2.5)), 3);
    }

    #[test]
    fn wrap_by_hand() {
        // The range is (−π, π]: a difference of exactly half a turn either
        // way comes out as +π, just past it as just past −π.
        assert_eq!(wrap(PI), PI);
        assert_eq!(wrap(-PI), PI);
        assert!(crate::tolerance::angle_eq(wrap(PI + 0.25), 0.25 - PI));
        assert!(crate::tolerance::angle_eq(wrap(3.0 * TAU + 1.0), 1.0));
    }

    #[test]
    fn triangulator_snap_boundary() {
        // A unit square with an extra boundary point x along the bottom edge
        // from (0, 0). Below SNAP_TO_ZERO, x is snapped to 0 and lands on
        // (0, 0), which belongs to another vertex: an error. At or above it
        // the five points are distinct and the square triangulates into
        // 5 − 2 = 3 triangles of total area 1.
        let snap = tolerance::SNAP_TO_ZERO;
        for (x, distinct) in [(0.9 * snap, false), (snap, true), (1.1 * snap, true)] {
            let (ids, uv) = region(&[vec![(0.0, 0.0), (x, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)]]);
            match triangulate_uv(&ids, &uv) {
                Ok(tris) => {
                    assert!(distinct, "x = {x:e} was not snapped");
                    assert_eq!(tris.len(), 3, "x = {x:e}");
                    assert!(rel_eq(area(&tris, &uv), 1.0, FP_REL), "x = {x:e}");
                }
                Err(e) => assert!(!distinct && e.contains("same uv"), "x = {x:e}: {e}"),
            }
        }
    }

    /// A chord between two points with distinct vertex ids.
    fn chord(a: (f64, f64), b: (f64, f64), ends: [usize; 2]) -> Chord {
        let ends = ends.map(BoundaryPoint::Vertex);
        Chord { a: DVec2::new(a.0, a.1), b: DVec2::new(b.0, b.1), ends, edge: 0, k: 0, center: None }
    }

    #[test]
    fn touching_pairs_by_hand() {
        let count = |chords: &[Chord]| touching_pairs(chords).len();
        // A chord from (0, 0) up to (1, 1) starts on the edge y = 0, x ∈
        // [-2, 2]: they touch where one's lowest y is the other's highest.
        // The edge starts further left, so the sweep meets it first.
        let edge = chord((-2.0, 0.0), (2.0, 0.0), [0, 1]);
        assert_eq!(count(&[edge, chord((0.0, 0.0), (1.0, 1.0), [2, 3])]), 1);
        // The same with the edge at y = 1, touching the chord's top end.
        let edge = chord((-2.0, 1.0), (2.0, 1.0), [0, 1]);
        assert_eq!(count(&[edge, chord((0.0, 0.0), (1.0, 1.0), [2, 3])]), 1);
        // Lift the chord a hair clear of either edge and nothing touches.
        let low = chord((-2.0, 0.0), (2.0, 0.0), [0, 1]);
        let high = chord((-2.0, 1.0 + 1e-12), (2.0, 1.0 + 1e-12), [4, 5]);
        assert_eq!(count(&[low, high, chord((0.0, 1e-12), (1.0, 1.0), [2, 3])]), 0);
        // Chords sharing the end point (0, 0) (vertex 0) touch only where
        // they run along one line over each other: (0,0)–(1,0) lies inside
        // (0,0)–(2,0), whichever comes first...
        let long = || chord((0.0, 0.0), (2.0, 0.0), [0, 1]);
        let short = || chord((0.0, 0.0), (1.0, 0.0), [0, 2]);
        assert_eq!(count(&[long(), short()]), 1);
        assert_eq!(count(&[short(), long()]), 1);
        // ...but not when they leave it in opposite directions, or at an angle.
        assert_eq!(count(&[chord((0.0, 0.0), (-1.0, 0.0), [0, 2]), long()]), 0);
        assert_eq!(count(&[long(), chord((0.0, 0.0), (1.0, 1e-9), [0, 2])]), 0);
    }

    /// Flat plate on z = 0: the square [-2, 2] × [0, 4] with a round hole of
    /// radius 1 centred at (0, 1), so the rim comes down to the bottom edge
    /// at (0, 0). The rim starts in direction `start` from its centre (−Y:
    /// at that lowest point; +Y: at the top, (0, 2)) and its one vertex is
    /// stored at `vertex`. Edges 0–3 are the square, edge 4 the rim.
    fn plate_with_hole(start: DVec3, vertex: DVec3) -> Body {
        use crate::topology::{Coedge, Loop};
        let mut b = Body::default();
        let corners = [(-2.0, 0.0), (2.0, 0.0), (2.0, 4.0), (-2.0, 4.0)];
        let c: Vec<usize> = corners.iter().map(|&(x, y)| b.add_vertex(DVec3::new(x, y, 0.0))).collect();
        let square = (0..4).map(|i| Coedge { edge: b.add_line(c[i], c[(i + 1) % 4]), reversed: false }).collect();
        let v = b.add_vertex(vertex);
        let rim = Curve::Circle { center: DVec3::Y, axis: DVec3::Z, x_dir: start, radius: 1.0 };
        let hole = b.add_edge(rim, v, v, 0.0, TAU);
        let plane = Surface::Plane { origin: DVec3::ZERO, normal: DVec3::Z, x_dir: DVec3::X };
        b.add_face(plane, true, vec![Loop { coedges: square }, Loop { coedges: vec![Coedge { edge: hole, reversed: true }] }]);
        b
    }

    /// The plate's meshed area when the rim has its 32 display chords: the
    /// square's 16 less the inscribed 32-gon, (32/2)·sin(2π/32) ≈ 3.1214.
    /// (r = 1 at max angle 0.2: ceil(2π / 0.2) = 32 chords.)
    fn plate_area() -> f64 {
        16.0 - 16.0 * fmath::sin(PI / 16.0)
    }

    #[test]
    fn a_hole_touching_its_outline_fails_in_bounded_time() {
        // Regression (found closing mutation survivors): the rim of radius 1
        // round (0, 1) touches the plate's bottom edge y = 0 at (0, 0). Rim
        // points within ~1e-8 rad of the touch round onto y = 0 (1 − cos θ
        // rounds to 0 below θ ≈ 1.05e-8, since 1 − cos θ ≈ θ²/2 < 2⁻⁵⁴ ≈
        // 5.6e-17 there), so their chords keep touching the edge however often
        // they are split and the point count grows to the budget. Each split
        // was a Vec::insert, O(n) apiece, so near the budget a pass cost
        // ~10¹² steps and this ran for hours. A face can't touch itself in
        // a valid body, so the answer is an error; it must come back
        // promptly (the whole pass is now O(n)).
        let t = std::time::Instant::now();
        let r = tessellate(&plate_with_hole(DVec3::Y, 2.0 * DVec3::Y), &TessOptions::DISPLAY);
        assert!(r.is_err(), "a hole touching its outline was meshed");
        assert!(t.elapsed().as_secs() < 120, "took {:?}", t.elapsed());
    }

    #[test]
    fn chord_touch_test_snaps_tiny_uv_like_the_triangulator() {
        // The rim's curve comes down to (0, 0) on the bottom edge but its
        // vertex is stored δ above it. The triangulator snaps coordinates
        // below SNAP_TO_ZERO to 0, which would put the vertex on the bottom
        // edge: the hole touches the outline, which the chord check must see
        // too, rather than pass it to the triangulator. At or above the snap
        // the vertex is clear of the edge, nothing touches, and the plate
        // meshes with the rim's 32 chords.
        let snap = tolerance::SNAP_TO_ZERO;
        for (delta, touches) in [(0.9 * snap, true), (snap, false), (1.1 * snap, false)] {
            let body = plate_with_hole(DVec3::NEG_Y, DVec3::new(0.0, delta, 0.0));
            assert_eq!(chords_touch(&body), touches, "δ = {delta:e}");
            if !touches {
                let m = tessellate(&body, &TessOptions::DISPLAY).unwrap();
                assert_eq!(m.edge_polylines[4].len(), 33, "δ = {delta:e}");
                assert!(rel_eq(m.area(), plate_area(), FP_REL), "δ = {delta:e}: area {}", m.area());
            }
        }
    }

    /// Whether conform_planar_faces finds chords of `body` that touch. With
    /// the mesh-point budget already full, the first split it makes is the
    /// budget error, so this answers at once even where splitting would take
    /// long (see a_chord_that_cannot_be_halved_is_an_error_at_once).
    fn chords_touch(body: &Body) -> bool {
        let mut body = body.clone();
        let mut params = initial_params(&body);
        fill_budget(&mut body, &mut params, MAX_MESH_POINTS);
        match conform_planar_faces(&body, &mut params) {
            Ok(()) => false,
            Err(e) if e.message.contains(&format!("more than {MAX_MESH_POINTS}")) => true,
            Err(e) => panic!("unexpected error: {}", e.message),
        }
    }

    #[test]
    fn chord_touch_test_uses_the_stored_vertex_not_the_curve_end() {
        // The rim's curve meets the bottom edge at both its ends: (0, 0) at
        // t = 0, and at t = 2π (sin 2π, 1 − cos 2π) = (−2.4e-16, 0) after
        // rounding. Its vertex, which the mesh uses, is stored 1 nm higher
        // (0.1 LINEAR, within tolerance of the curve), so the chords the
        // mesh draws clear the edge: no splits, and the plate meshes.
        let body = plate_with_hole(DVec3::NEG_Y, DVec3::new(0.0, 1e-9, 0.0));
        assert!(!chords_touch(&body));
        let m = tessellate(&body, &TessOptions::DISPLAY).unwrap();
        assert_eq!(m.edge_polylines[4].len(), 33);
        // Lifting one corner of the 32-gon by 1e-9 changes its area by
        // about 1e-10, well inside LINEAR.
        assert!(eq(m.area(), plate_area()), "area {}", m.area());
    }

    /// Unit disc on z = 0 (rim: edge 0, starting at (1, 0)) with a small
    /// triangular hole at each angle in `at`. Each hole's outer corner P is
    /// 1 µm inside the rim, half a rim chord round from `at` (φ = π/32,
    /// the rim having 32 chords of 2φ); its other corners are at radius 0.9,
    /// at `at` and `at + 2φ`.
    fn disc_with_holes(at: &[f64]) -> Body {
        use crate::topology::{Coedge, Loop};
        let phi = PI / 32.0;
        let mut b = Body::default();
        let v = b.add_vertex(DVec3::X);
        let rim = b.add_edge(Curve::Circle { center: DVec3::ZERO, axis: DVec3::Z, x_dir: DVec3::X, radius: 1.0 }, v, v, 0.0, TAU);
        let mut loops = vec![Loop { coedges: vec![Coedge { edge: rim, reversed: false }] }];
        for &a in at {
            let polar = |r: f64, t: f64| DVec3::new(r * fmath::cos(t), r * fmath::sin(t), 0.0);
            let p = [polar(0.999, a + phi), polar(0.9, a), polar(0.9, a + 2.0 * phi)].map(|q| b.add_vertex(q));
            let coedges = (0..3).map(|i| Coedge { edge: b.add_line(p[i], p[(i + 1) % 3]), reversed: false }).collect();
            loops.push(Loop { coedges });
        }
        b.add_face(Surface::Plane { origin: DVec3::ZERO, normal: DVec3::Z, x_dir: DVec3::X }, true, loops);
        b
    }

    #[test]
    fn curved_chords_are_split_where_they_cut_a_straight_edge() {
        // By hand: rim chord 0 (angles 0 to 2φ, φ = π/32) passes its middle
        // at radius cos φ ≈ 0.99518, inside the hole's corner P at 0.999, so
        // it cuts both hole edges at P. Splitting it puts a rim point at
        // angle φ, 1 µm beyond P, and the two half chords (sagging to
        // cos(φ/2) ≈ 0.9988 midway) pass outside the hole. Chord 16 at the
        // second hole is the same turned by π. So the rim ends with
        // 32 + 2 = 34 chords. The holes are straight-edged and can't be
        // split, so only the rim is; and the sweep along x meets the right
        // hole's edges before chord 0 (x from 0.88 vs 0.98) but chord 16
        // before the left hole's (x from −1 vs −0.994), so this checks both
        // orders of a curved and a straight chord.
        let body = disc_with_holes(&[0.0, PI]);
        let m = tessellate(&body, &TessOptions::DISPLAY).unwrap();
        assert_eq!(m.edge_polylines[0].len(), 35);
        // Area: the rim polygon is 30 chords of 2φ and 4 of φ, fanned from
        // the centre: 15·sin 2φ + 2·sin φ. Each hole, as quadrilateral OQPR
        // less triangle OQR: 2·(½·0.9·0.999·sin φ) − ½·0.9²·sin 2φ.
        let phi = PI / 32.0;
        let hole = 0.9 * 0.999 * fmath::sin(phi) - 0.5 * 0.81 * fmath::sin(2.0 * phi);
        let expected = 15.0 * fmath::sin(2.0 * phi) + 2.0 * fmath::sin(phi) - 2.0 * hole;
        assert!(rel_eq(m.area(), expected, FP_REL), "area {} vs {expected}", m.area());
    }

    /// The edge parameters `tessellate` starts from, before any splitting.
    fn initial_params(body: &Body) -> Vec<Vec<f64>> {
        let opts = TessOptions::DISPLAY;
        let fractions = |n: usize| (0..=n).map(|k| k as f64 / n as f64).collect();
        body.edges.iter().map(|e| fractions(segments(&e.curve, e.t1 - e.t0, &opts))).collect()
    }

    /// Adds an edge used by no face and gives it parameters so that all
    /// edges together hold `total` mesh points (only its count matters).
    fn fill_budget(body: &mut Body, params: &mut Vec<Vec<f64>>, total: usize) {
        let (a, b) = (body.add_vertex(DVec3::new(10.0, 0.0, 0.0)), body.add_vertex(DVec3::new(11.0, 0.0, 0.0)));
        body.add_line(a, b);
        let used: usize = params.iter().map(Vec::len).sum();
        params.push(vec![0.0; total - used]);
    }

    #[test]
    fn mesh_point_budget_boundary() {
        // The disc with one hole needs exactly one split (chord 0, see
        // curved_chords_are_split_where_they_cut_a_straight_edge), adding one
        // point: the rim's 33 points become 34. Ending at exactly
        // MAX_MESH_POINTS is allowed; one more is not.
        for (before, ok) in [(MAX_MESH_POINTS - 1, true), (MAX_MESH_POINTS, false)] {
            let mut body = disc_with_holes(&[0.0]);
            let mut params = initial_params(&body);
            assert_eq!(params[0].len(), 33);
            fill_budget(&mut body, &mut params, before);
            match conform_planar_faces(&body, &mut params) {
                Ok(()) => {
                    assert!(ok, "{before} + 1 points accepted");
                    assert_eq!(params[0].len(), 34);
                    assert_eq!(params.iter().map(Vec::len).sum::<usize>(), MAX_MESH_POINTS);
                }
                Err(e) => assert!(!ok && e.message.contains(&format!("more than {MAX_MESH_POINTS}")), "{before}: {}", e.message),
            }
        }
    }

    #[test]
    fn a_chord_that_cannot_be_halved_is_an_error_at_once() {
        // The rim starts at the top, (0, 2), and at fraction ½ (t = π) is at
        // (−sin π, 1 + cos π) = (−1.2e-16, 0): on the bottom edge, so the
        // hole touches the outline there. Splitting can never cure that: the
        // chords either side of fraction ½ are halved until their ends are
        // adjacent floats, where it must stop with an error.
        assert!(chords_touch(&plate_with_hole(DVec3::Y, 2.0 * DVec3::Y)));
        // That last step, set up directly. Above ½ the floats are 2⁻⁵³ apart, and
        // the midpoint ½·(1 + 2⁻⁵³) of [½, ½ + 2⁻⁵³] rounds (a tie, to even)
        // to ½, the low end. Below ½ they are 2⁻⁵⁴ apart, and the midpoint
        // ½·(1 − 2⁻⁵⁴) of [½ − 2⁻⁵⁴, ½] rounds to ½, the high end. The rim's
        // chords here are [0, lo], [lo, hi] and [hi, 1], all touching the
        // bottom edge. Inserting the useless midpoint would make a
        // zero-length chord and go round again (for ever when the touch is
        // inside the chord); with the point budget already full, any
        // inserted point shows up as the budget error instead of this one.
        let ulp_above = f64::EPSILON / 2.0; // 2⁻⁵³ (EPSILON is 2⁻⁵², the spacing in [1, 2))
        let ulp_below = f64::EPSILON / 4.0; // 2⁻⁵⁴
        for (lo, hi, mid) in [(0.5, 0.5 + ulp_above, 0.5), (0.5 - ulp_below, 0.5, 0.5)] {
            assert_eq!(f64::from_bits(lo.to_bits() + 1), hi, "[{lo}, {hi}] are not adjacent floats");
            assert_eq!(0.5 * (lo + hi), mid);
            let mut body = plate_with_hole(DVec3::Y, 2.0 * DVec3::Y);
            let mut params = initial_params(&body);
            params[4] = vec![0.0, lo, hi, 1.0];
            fill_budget(&mut body, &mut params, MAX_MESH_POINTS);
            let err = conform_planar_faces(&body, &mut params).unwrap_err();
            assert!(err.message.contains("can't be split further"), "[{lo}, {hi}]: {}", err.message);
        }
    }

    #[test]
    fn only_edges_within_angular_of_the_axis_get_one_exact_uv() {
        // Circles: a cylinder of radius 1 from z = 5 to 7 (so the surface's
        // origin is (0, 0, 5)), its bottom circle's axis tilted by α about X.
        // The top circle is round the axis: every point gets v = (centre −
        // origin)·axis = 7 − 5 = 2 exactly. The bottom one gets v = 0
        // exactly when the tilt is within ANGULAR; past that it is not a
        // constant-v line and keeps its points' own v. Its point a quarter
        // turn round (point 8 of 32, loop position 7) is (0, cos α, 5 +
        // sin α), so v = sin α.
        for (alpha, snapped) in [(0.9 * tolerance::ANGULAR, true), (1.1 * tolerance::ANGULAR, false)] {
            let mut body = hand_cylinder(1.0, 2.0).transformed(&crate::geom::Transform::translation(DVec3::new(0.0, 0.0, 5.0)));
            let axis = DVec3::new(0.0, -fmath::sin(alpha), fmath::cos(alpha));
            body.edges[0].curve = Curve::Circle { center: DVec3::new(0.0, 0.0, 5.0), axis, x_dir: DVec3::X, radius: 1.0 };
            let m = tessellate(&body, &TessOptions::DISPLAY).unwrap();
            let (bottom, top) = (snapped_loop_uv(&body, &m, 2, 0), snapped_loop_uv(&body, &m, 2, 1));
            assert!(top.iter().all(|p| p.y == 2.0), "α = {alpha:e}: top {top:?}");
            assert_eq!(bottom.len(), 32);
            if snapped {
                assert!(bottom.iter().all(|p| p.y == 0.0), "α = {alpha:e}: bottom {bottom:?}");
            } else {
                // 5 + sin α carries the rounding of 5 (4.4e-16).
                assert!((bottom[7].y - fmath::sin(alpha)).abs() < 1e-15, "α = {alpha:e}: v = {:e}", bottom[7].y);
            }
        }
        // Lines: the half cylinder's side line at +X (edge 4, from vertex 0
        // at (1, 0, 0) to vertex 2), with vertex 2 moved round to (1, δ, 1),
        // so the line leans by δ from the axis (|dir × axis| = δ/√(1 + δ²)).
        // Within ANGULAR, both its ends get the u of its start, 0, exactly;
        // past it, vertex 2 keeps its own u, atan2(δ, 1) = δ.
        for (delta, snapped) in [(0.9 * tolerance::ANGULAR, true), (1.1 * tolerance::ANGULAR, false)] {
            let mut body = hand_half_cylinder(1.0, 1.0);
            body.vertices[2].point = DVec3::new(1.0, delta, 1.0);
            let (start, end) = (body.vertices[0].point, body.vertices[2].point);
            body.edges[4].curve = Curve::Line { origin: start, dir: (end - start).normalize() };
            body.edges[4].t1 = start.distance(end);
            let m = tessellate(&body, &TessOptions::DISPLAY).unwrap();
            let ids = loop_vertices(&body, &m, 3, 0);
            let uv = snapped_loop_uv(&body, &m, 3, 0);
            let u_at = |vertex: u32| uv[ids.iter().position(|&i| i == vertex).unwrap()].x;
            assert_eq!(u_at(0), 0.0, "δ = {delta:e}");
            if snapped {
                assert_eq!(u_at(2), 0.0, "δ = {delta:e}");
            } else {
                assert!((u_at(2) - delta).abs() < 1e-24, "δ = {delta:e}: u = {:e}", u_at(2));
            }
        }
    }

    /// The half cylinder of radius 2 and height 2 with its curved face's u
    /// measured from +Y instead of +X, so u runs from 3π/2 (at +X) up
    /// through the seam at 2π ≡ 0 (+Y) to π/2 (at −X): the patch straddles
    /// the seam. A triangular hole of straight lines is cut just past the
    /// seam, at surface (u, v) = (0.4, 1), (0.6, 1), (0.5, 1.5).
    fn half_cylinder_across_the_seam() -> Body {
        use crate::topology::{Coedge, Loop};
        let mut body = hand_half_cylinder(2.0, 2.0);
        let s = Surface::Cylinder { origin: DVec3::ZERO, axis: DVec3::Z, x_dir: DVec3::Y, radius: 2.0 };
        body.faces[3].surface = s.clone();
        let p: Vec<usize> = [(0.4, 1.0), (0.6, 1.0), (0.5, 1.5)].iter().map(|&(u, v)| body.add_vertex(s.eval(DVec2::new(u, v)))).collect();
        let coedges = (0..3).map(|i| Coedge { edge: body.add_line(p[i], p[(i + 1) % 3]), reversed: false }).collect();
        body.faces[3].loops.push(Loop { coedges });
        body
    }

    #[test]
    fn hole_beyond_the_seam_is_moved_into_its_patch() {
        // By hand: the outer loop starts at its bottom arc's first mesh
        // point, a sixteenth of the half turn round from +X (r = 2 at max
        // angle 0.2: ceil(π / 0.2) = 16 chords per arc), at u = 3π/2 + π/16,
        // and runs continuously up to 5π/2. The hole's raw u values 0.4–0.6
        // are a period below that, so it is moved up by 2π. Then u is scaled
        // by the radius to arc length, so the triangulator sees true
        // proportions. The hole loop starts at its first edge's end, (0.6, 1).
        let body = half_cylinder_across_the_seam();
        let m = tessellate(&body, &TessOptions::DISPLAY).unwrap();
        let (_, uv) = periodic_domain(&body, &m, 3, 2.0).unwrap();
        assert!(crate::tolerance::angle_eq(uv[0][0].x, 2.0 * (1.5 * PI + PI / 16.0)), "outer starts at u = {}", uv[0][0].x);
        let expected = [(0.6, 1.0), (0.5, 1.5), (0.4, 1.0)].map(|(u, v)| DVec2::new(2.0 * (u + TAU), v));
        for (got, want) in uv[1].iter().zip(expected) {
            assert!(got.distance(want) <= 1e-12, "hole point {got} vs {want}");
        }
        // In the mesh: a polygon with one hole and V boundary points and no
        // others triangulates into V triangles (V − 2 + 2 per hole). Here V =
        // 16 + 1 + 16 + 1 on the outer loop + 3 on the hole = 37. (A hole
        // left a period away would be a separate island: 32 + 1 = 33.)
        assert_eq!(m.triangle_face.iter().filter(|&&f| f == 3).count(), 37);
    }
}
