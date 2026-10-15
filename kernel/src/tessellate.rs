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
use glam::{DVec2, DVec3};
use std::f64::consts::{PI, TAU};
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

pub fn tessellate(body: &Body, opts: &TessOptions) -> Result<Mesh, TessError> {
    let mut mesh =
        Mesh { positions: body.vertices.iter().map(|v| v.point).collect(), options: *opts, ..Mesh::default() };
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
                if opts.chord < 2.0 * radius { 2.0 * (1.0 - opts.chord / radius).acos() } else { f64::INFINITY };
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
        end = (end + count) % n;
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
    let Curve::Circle { axis, .. } = e.curve else { return Err("sphere cap must be bounded by a circle".into()) };
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
    let theta = dirs[0].dot(pole_dir).clamp(-1.0, 1.0).acos();
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
    let angle = a.dot(b).clamp(-1.0, 1.0).acos();
    if angle < tolerance::ANGULAR {
        return a;
    }
    (a * ((1.0 - f) * angle).sin() + b * (f * angle).sin()) / angle.sin()
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
    // Inside/outside by topology, not geometry: walk from the outside of the
    // triangulation, flipping between outside and inside each time a
    // boundary (constraint) edge is crossed. Testing triangle centroids
    // instead misclassifies the slivers that appear when boundary points are
    // collinear up to rounding.
    let mut inside: std::collections::HashMap<usize, bool> = std::collections::HashMap::new();
    let mut queue = std::collections::VecDeque::new();
    for f in cdt.inner_faces() {
        for e in f.adjacent_edges() {
            if e.rev().face().is_outer() && !inside.contains_key(&f.fix().index()) {
                let parity = e.is_constraint_edge();
                inside.insert(f.fix().index(), parity);
                queue.push_back((f, parity));
            }
        }
    }
    while let Some((f, parity)) = queue.pop_front() {
        for e in f.adjacent_edges() {
            if let Some(next) = e.rev().face().as_inner() {
                let next_parity = parity ^ e.is_constraint_edge();
                if let std::collections::hash_map::Entry::Vacant(slot) = inside.entry(next.fix().index()) {
                    slot.insert(next_parity);
                    queue.push_back((next, next_parity));
                }
            }
        }
    }
    let mut out = Vec::new();
    for f in cdt.inner_faces() {
        if inside.get(&f.fix().index()).copied().unwrap_or(false) {
            out.push(f.vertices().map(|v| handle_to_mesh[v.fix().index()]));
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tolerance::eq;
    use crate::fixtures::{hand_cube, hand_cylinder, hand_half_cylinder, hand_sphere, hand_twisted_cylinder};
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
            let polygon = 0.5 * n as f64 * r * r * (TAU / n as f64).sin();
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
            let half_polygon = 0.5 * n as f64 * r * r * (PI / n as f64).sin();
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
        let sag = 100.0 * (1.0 - (std::f64::consts::PI / n as f64).cos());
        assert!(sag <= opts.chord);
        let small = Curve::Circle { center: Default::default(), axis: glam::DVec3::Z, x_dir: glam::DVec3::X, radius: 1e-3 };
        assert!(segments(&small, std::f64::consts::TAU, &opts) as f64 >= std::f64::consts::TAU / opts.max_angle);
        let twice = TessOptions { refine: 2, ..opts };
        assert_eq!(segments(&c, 1.0, &twice), 2 * segments(&c, 1.0, &opts));
    }
}
