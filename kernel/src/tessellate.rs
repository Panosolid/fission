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
        let raw: Vec<DVec2> = l.iter().map(|&i| face.surface.project(mesh.positions[i as usize])).collect();
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
    use crate::fixtures::{hand_cube, hand_cylinder, hand_sphere};

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
            assert!(crate::tolerance::rel_eq(m.signed_volume(), polygon * h, 1e-12), "r={r} h={h}");
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
