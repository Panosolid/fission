//! Mesh data shaped for the viewer: vertices duplicated per face so each
//! face gets its own normals, plus edge lines, each segment labelled with its
//! B-rep edge so the viewer can pick edges (step 17c).

use crate::geom::Placement;
use crate::mesh::Mesh;
use crate::topology::Body;
use glam::{DMat3, DVec3};
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DisplayMesh {
    /// xyz per vertex.
    pub positions: Vec<f32>,
    /// Outward unit normal per vertex, from the exact surface.
    pub normals: Vec<f32>,
    pub indices: Vec<u32>,
    /// B-rep face of each triangle.
    pub triangle_faces: Vec<u32>,
    /// Pairs of xyz points, one pair per edge segment.
    pub edge_lines: Vec<f32>,
    /// B-rep edge of each segment in `edge_lines` (one entry per pair).
    pub edge_line_edges: Vec<u32>,
}

pub fn display_mesh(body: &Body, mesh: &Mesh) -> DisplayMesh {
    display_mesh_placed(body, mesh, &Placement::IDENTITY)
}

/// `display_mesh` of a body's local geometry and mesh, carried into the
/// world by `placement`: each normal is taken from the local surface at the
/// local point, then turned; each point is placed in double precision and
/// only then rounded to single (`Placement::point`, `dir`). The identity
/// gives `display_mesh`'s numbers bit for bit.
pub fn display_mesh_placed(body: &Body, mesh: &Mesh, placement: &Placement) -> DisplayMesh {
    let moved = !placement.is_identity();
    let r = DMat3::from_quat(placement.rotation);
    let world = |p: DVec3| if moved { r * p + placement.shift } else { p };
    let turned = |n: DVec3| if moved { r * n } else { n };
    let mut out = DisplayMesh {
        positions: Vec::new(),
        normals: Vec::new(),
        indices: Vec::new(),
        triangle_faces: Vec::new(),
        edge_lines: Vec::new(),
        edge_line_edges: Vec::new(),
    };
    // Triangles grouped by face, each face's in mesh order: one pass over
    // the mesh rather than one per face (which was faces × triangles, ~2e9
    // steps and seconds for a 2,000-arc outline).
    let mut by_face: Vec<Vec<usize>> = vec![Vec::new(); body.faces.len()];
    for (t, &face) in mesh.triangle_face.iter().enumerate() {
        by_face[face].push(t);
    }
    for (face, tris) in by_face.iter().enumerate() {
        let mut remap = std::collections::HashMap::new();
        for &t in tris {
            let tri = &mesh.triangles[t];
            for &i in tri {
                let next = (out.positions.len() / 3) as u32;
                let id = *remap.entry(i).or_insert_with(|| {
                    let p = mesh.positions[i as usize];
                    let n = turned(body.face_normal_at(face, p));
                    let p = world(p);
                    out.positions.extend([p.x as f32, p.y as f32, p.z as f32]);
                    out.normals.extend([n.x as f32, n.y as f32, n.z as f32]);
                    next
                });
                out.indices.push(id);
            }
            out.triangle_faces.push(face as u32);
        }
    }
    // Tessellation discretises edge e into edge_polylines[e].
    for (edge, poly) in mesh.edge_polylines.iter().enumerate() {
        for pair in poly.windows(2) {
            out.edge_line_edges.push(edge as u32);
            for &i in pair {
                let p = world(mesh.positions[i as usize]);
                out.edge_lines.extend([p.x as f32, p.y as f32, p.z as f32]);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fixtures::{hand_cube, hand_cylinder};
    use crate::ops::primitives::make_box;
    use crate::tessellate::{tessellate, TessOptions};
    use crate::tolerance::{rel_eq, F32_REL};
    use glam::DVec3;

    fn vec3(v: &[f32], i: usize) -> DVec3 {
        DVec3::new(v[3 * i] as f64, v[3 * i + 1] as f64, v[3 * i + 2] as f64)
    }

    #[test]
    fn box_display_mesh_has_flat_outward_normals() {
        let b = make_box(2.0, 3.0, 4.0).unwrap();
        let d = display_mesh(&b, &tessellate(&b, &TessOptions::DISPLAY).unwrap());
        // Worked by hand: each of the 6 faces gets its own copy of its 4
        // corners (24 vertices, 72 floats); 6 faces × 2 triangles × 3 = 36
        // indices; 12 straight edges × 2 endpoints × 3 floats = 72.
        assert_eq!(d.positions.len(), 24 * 3);
        assert_eq!(d.indices.len(), 36);
        assert_eq!(d.edge_lines.len(), 12 * 2 * 3);
        for t in 0..12 {
            let [a, b2, c] = [0, 1, 2].map(|k| vec3(&d.positions, d.indices[3 * t + k] as usize));
            let geometric = (b2 - a).cross(c - a).normalize();
            for k in 0..3 {
                let n = vec3(&d.normals, d.indices[3 * t + k] as usize);
                // f32 storage: compare at f32 precision via the tolerance helper.
                assert!(rel_eq(n.dot(geometric), 1.0, F32_REL), "triangle {t}");
            }
        }
    }

    #[test]
    fn cylinder_side_normals_are_radial() {
        let b = hand_cylinder(2.0, 5.0);
        let d = display_mesh(&b, &tessellate(&b, &TessOptions::DISPLAY).unwrap());
        for t in 0..d.triangle_faces.len() {
            if d.triangle_faces[t] != 2 {
                continue;
            }
            for k in 0..3 {
                let i = d.indices[3 * t + k] as usize;
                let p = vec3(&d.positions, i);
                let radial = DVec3::new(p.x, p.y, 0.0).normalize();
                let n = vec3(&d.normals, i);
                // Normals went through f32, so compare at f32 precision.
                assert!(rel_eq(n.dot(radial), 1.0, F32_REL), "normal {n} at {p}");
            }
        }
    }

    #[test]
    fn cube_edge_lines_name_their_edges() {
        let b = hand_cube();
        let d = display_mesh(&b, &tessellate(&b, &TessOptions::DISPLAY).unwrap());
        // Worked by hand: the unit cube has 12 straight edges, each drawn as
        // one segment, so 12 labels using every edge index 0..12 once.
        let mut labels = d.edge_line_edges.clone();
        labels.sort_unstable();
        assert_eq!(labels, (0..12).collect::<Vec<u32>>());
        assert_eq!(d.edge_lines.len(), 6 * d.edge_line_edges.len());
        let mut per_axis = [0; 3];
        for (k, &e) in d.edge_line_edges.iter().enumerate() {
            let (p, q) = (vec3(&d.edge_lines, 2 * k), vec3(&d.edge_lines, 2 * k + 1));
            // Each cube edge joins two corners differing in one coordinate by
            // 1, so a segment is a unit step along one axis; there are 4
            // edges along each of x, y and z.
            let step = (q - p).abs();
            let axis = (0..3).find(|&i| step[i] > 0.5).unwrap();
            assert!(rel_eq(step[axis], 1.0, F32_REL), "segment {k}");
            assert!(step.element_sum() - step[axis] < F32_REL, "segment {k} is not axis-aligned");
            per_axis[axis] += 1;
            // And the segment is the labelled edge: its ends are that edge's
            // vertices, in either order.
            let edge = &b.edges[e as usize];
            let (s, t) = (b.vertices[edge.start].point, b.vertices[edge.end].point);
            let near = |a: DVec3, b: DVec3| a.distance(b) <= F32_REL;
            assert!((near(p, s) && near(q, t)) || (near(p, t) && near(q, s)), "segment {k} labelled edge {e}");
        }
        assert_eq!(per_axis, [4, 4, 4]);
    }

    #[test]
    fn cylinder_edge_lines_lie_on_their_own_circle() {
        let b = hand_cylinder(2.0, 5.0);
        let d = display_mesh(&b, &tessellate(&b, &TessOptions::DISPLAY).unwrap());
        // Worked by hand: a cylinder of radius 2 and height 5 has two closed
        // circle edges, the bottom at z = 0 and the top at z = 5. Every
        // segment labelled with an edge has both ends at that edge's height
        // and 2 from the axis.
        assert_eq!(d.edge_lines.len(), 6 * d.edge_line_edges.len());
        let mut used = [0; 2];
        for (k, &e) in d.edge_line_edges.iter().enumerate() {
            let z = b.vertices[b.edges[e as usize].start].point.z;
            assert!(z.abs() <= F32_REL || rel_eq(z, 5.0, F32_REL), "edge {e} at z {z}");
            for p in [vec3(&d.edge_lines, 2 * k), vec3(&d.edge_lines, 2 * k + 1)] {
                assert!((p.z - z).abs() <= F32_REL * 5.0, "segment {k} labelled edge {e} at z {}", p.z);
                assert!(rel_eq(p.truncate().length(), 2.0, F32_REL), "segment {k} off the circle");
            }
            used[e as usize] += 1;
        }
        // Both circles are drawn, with the same number of chords.
        assert!(used[0] > 2 && used[0] == used[1], "{used:?}");
    }

    /// The display mesh as first written: for each face, a scan of every
    /// triangle. Kept as the reference the grouped version must match.
    fn per_face_scan(body: &Body, mesh: &Mesh) -> (Vec<f32>, Vec<f32>, Vec<u32>, Vec<u32>) {
        let (mut positions, mut normals, mut indices, mut faces) = (vec![], vec![], vec![], vec![]);
        for face in 0..body.faces.len() {
            let mut remap = std::collections::HashMap::new();
            for (t, tri) in mesh.triangles.iter().enumerate() {
                if mesh.triangle_face[t] != face {
                    continue;
                }
                for &i in tri {
                    let next = (positions.len() / 3) as u32;
                    let id = *remap.entry(i).or_insert_with(|| {
                        let p = mesh.positions[i as usize];
                        let n = body.face_normal_at(face, p);
                        positions.extend([p.x as f32, p.y as f32, p.z as f32]);
                        normals.extend([n.x as f32, n.y as f32, n.z as f32]);
                        next
                    });
                    indices.push(id);
                }
                faces.push(face as u32);
            }
        }
        (positions, normals, indices, faces)
    }

    #[test]
    fn grouping_by_face_matches_a_scan_per_face() {
        // A self-consistency check (two code paths agreeing), bit for bit,
        // on bodies whose meshes interleave faces: a box, a cylinder, and an
        // extruded outline with arcs and a round hole.
        use crate::ops::extrude::{extrude, Boundary, Profile};
        let d = Profile {
            outer: Boundary::Path { corners: vec![glam::DVec2::new(0.0, 0.0), glam::DVec2::new(4.0, 0.0), glam::DVec2::new(4.0, 3.0), glam::DVec2::new(0.0, 3.0)], bulges: vec![0.0, 0.5, 0.0, -0.3] },
            holes: vec![Boundary::Circle { center: glam::DVec2::new(2.0, 1.5), radius: 0.5 }],
        };
        for b in [make_box(2.0, 3.0, 4.0).unwrap(), hand_cylinder(2.0, 5.0), extrude(&d, 1.5).unwrap()] {
            let m = tessellate(&b, &TessOptions::DISPLAY).unwrap();
            let got = display_mesh(&b, &m);
            assert_eq!((got.positions, got.normals, got.indices, got.triangle_faces), per_face_scan(&b, &m));
        }
    }

    #[test]
    fn many_faces_and_triangles_cost_one_pass() {
        // Regression (white-box hunt): display_mesh scanned every triangle
        // once per face, faces × triangles steps: 4.5 s (release build) for
        // a 2,000-arc outline's 2,002 faces and 960,000 triangles. Here a
        // 2,000-corner prism (2,002 faces) gets a made-up mesh of 1,001,000
        // triangles, 500 per face over the face's own corners: the old scan
        // takes ~2·10⁹ steps (seconds); one pass takes about a million hash
        // lookups. It is timed against a reference pass in the same build
        // (one hash lookup and one push per triangle corner, the cost that
        // one pass has to pay), not against the wall clock, so it holds in
        // unoptimised mutation builds and on slow machines alike. Measured:
        // one pass costs 0.8-1.0x the reference (opt-level 0 and 2), the
        // old scan put back 14x (opt-level 2) and 18x (opt-level 0), so the
        // bound of 5x leaves room both ways.
        // The best of three runs of each keeps a stray pause from deciding.
        use crate::ops::extrude::{extrude, Profile};
        let n = 2000;
        let corners = (0..n).map(|i| glam::DVec2::from_angle(std::f64::consts::TAU * i as f64 / n as f64) * 100.0).collect();
        let b = extrude(&Profile::polygon(corners, vec![]), 1.0).unwrap();
        let mut m = Mesh { positions: b.vertices.iter().map(|v| v.point).collect(), ..Mesh::default() };
        for (f, face) in b.faces.iter().enumerate() {
            let vs: Vec<u32> = face.loops[0].coedges.iter().map(|c| b.edges[c.edge].start as u32).collect();
            for k in 0..500 {
                m.triangles.push([vs[0], vs[1 + k % (vs.len() - 2)], vs[2 + k % (vs.len() - 2)]]);
                m.triangle_face.push(f);
            }
        }
        let best = |f: &dyn Fn() -> usize| {
            (0..3)
                .map(|_| {
                    let start = std::time::Instant::now();
                    std::hint::black_box(f());
                    start.elapsed().as_secs_f64()
                })
                .fold(f64::INFINITY, f64::min)
        };
        let reference = best(&|| {
            let mut seen = std::collections::HashMap::new();
            let mut out = Vec::with_capacity(3 * m.triangles.len());
            for (t, tri) in m.triangles.iter().enumerate() {
                for &i in tri {
                    let next = seen.len() as u32;
                    out.push(*seen.entry((m.triangle_face[t], i)).or_insert(next));
                }
            }
            std::hint::black_box(&out).len()
        });
        let took = best(&|| display_mesh(&b, &m).triangle_faces.len());
        assert_eq!(display_mesh(&b, &m).triangle_faces.len(), 500 * b.faces.len());
        assert!(took < 5.0 * reference, "display_mesh took {took:.4} s, {:.1}x the one-pass reference ({reference:.4} s)", took / reference);
    }
}
