//! Mesh data shaped for the viewer: vertices duplicated per face so each
//! face gets its own normals, plus edge lines.

use crate::mesh::Mesh;
use crate::topology::Body;
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
}

pub fn display_mesh(body: &Body, mesh: &Mesh) -> DisplayMesh {
    let mut out = DisplayMesh {
        positions: Vec::new(),
        normals: Vec::new(),
        indices: Vec::new(),
        triangle_faces: Vec::new(),
        edge_lines: Vec::new(),
    };
    for face in 0..body.faces.len() {
        let mut remap = std::collections::HashMap::new();
        for (t, tri) in mesh.triangles.iter().enumerate() {
            if mesh.triangle_face[t] != face {
                continue;
            }
            for &i in tri {
                let next = (out.positions.len() / 3) as u32;
                let id = *remap.entry(i).or_insert_with(|| {
                    let p = mesh.positions[i as usize];
                    let n = body.face_normal_at(face, p);
                    out.positions.extend([p.x as f32, p.y as f32, p.z as f32]);
                    out.normals.extend([n.x as f32, n.y as f32, n.z as f32]);
                    next
                });
                out.indices.push(id);
            }
            out.triangle_faces.push(face as u32);
        }
    }
    for poly in &mesh.edge_polylines {
        for pair in poly.windows(2) {
            for &i in pair {
                let p = mesh.positions[i as usize];
                out.edge_lines.extend([p.x as f32, p.y as f32, p.z as f32]);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fixtures::hand_cylinder;
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
}
