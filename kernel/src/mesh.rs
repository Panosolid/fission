//! Triangle meshes produced by tessellation, with the checks and measures
//! that only make sense on triangles.

use crate::topology::FaceId;
use glam::DVec3;
use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Mesh {
    pub positions: Vec<DVec3>,
    /// Counter-clockwise seen from outside.
    pub triangles: Vec<[u32; 3]>,
    /// The B-rep face each triangle came from.
    pub triangle_face: Vec<FaceId>,
    /// Polyline of mesh vertex indices for each B-rep edge.
    pub edge_polylines: Vec<Vec<u32>>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum MeshError {
    /// A mesh edge isn't shared by exactly two triangles.
    OpenEdge { a: u32, b: u32, uses: usize },
    /// Two triangles sharing an edge traverse it the same way.
    FlippedTriangles { a: u32, b: u32 },
}

impl Mesh {
    pub fn triangle(&self, t: usize) -> [DVec3; 3] {
        self.triangles[t].map(|i| self.positions[i as usize])
    }

    /// Volume enclosed, positive when triangles face outward (divergence theorem).
    pub fn signed_volume(&self) -> f64 {
        (0..self.triangles.len())
            .map(|t| {
                let [a, b, c] = self.triangle(t);
                a.dot(b.cross(c))
            })
            .sum::<f64>()
            / 6.0
    }

    pub fn area(&self) -> f64 {
        (0..self.triangles.len()).map(|t| self.triangle_area(t)).sum()
    }

    pub fn triangle_area(&self, t: usize) -> f64 {
        let [a, b, c] = self.triangle(t);
        (b - a).cross(c - a).length() / 2.0
    }

    /// Area of the triangles belonging to one B-rep face.
    pub fn face_area(&self, face: FaceId) -> f64 {
        (0..self.triangles.len()).filter(|&t| self.triangle_face[t] == face).map(|t| self.triangle_area(t)).sum()
    }

    /// Watertight and consistently oriented: every directed edge appears
    /// exactly once and its reverse exactly once.
    pub fn check_closed(&self) -> Result<(), Vec<MeshError>> {
        let mut directed: HashMap<(u32, u32), usize> = HashMap::new();
        for t in &self.triangles {
            for k in 0..3 {
                *directed.entry((t[k], t[(k + 1) % 3])).or_default() += 1;
            }
        }
        let mut errs = Vec::new();
        let mut keys: Vec<_> = directed.keys().copied().collect();
        keys.sort_unstable();
        for (a, b) in keys {
            if a > b && directed.contains_key(&(b, a)) {
                continue; // reported from the other side
            }
            let fwd = directed[&(a, b)];
            let back = directed.get(&(b, a)).copied().unwrap_or(0);
            if fwd > 1 || back > 1 {
                errs.push(MeshError::FlippedTriangles { a, b });
            } else if back == 0 {
                errs.push(MeshError::OpenEdge { a, b, uses: fwd });
            }
        }
        if errs.is_empty() { Ok(()) } else { Err(errs) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tolerance::eq;

    fn tetra() -> Mesh {
        Mesh {
            positions: vec![DVec3::ZERO, DVec3::X, DVec3::Y, DVec3::Z],
            triangles: vec![[0, 2, 1], [0, 1, 3], [1, 2, 3], [0, 3, 2]],
            triangle_face: vec![0, 1, 2, 3],
            edge_polylines: vec![],
        }
    }

    #[test]
    fn tetrahedron_volume_and_area() {
        let m = tetra();
        assert!(eq(m.signed_volume(), 1.0 / 6.0));
        assert!(eq(m.area(), 1.5 + 3f64.sqrt() / 2.0));
        assert_eq!(m.check_closed(), Ok(()));
    }

    #[test]
    fn missing_triangle_is_open() {
        let mut m = tetra();
        m.triangles.pop();
        assert!(matches!(m.check_closed().unwrap_err()[0], MeshError::OpenEdge { .. }));
    }

    #[test]
    fn flipped_triangle_is_caught() {
        let mut m = tetra();
        m.triangles[2].swap(1, 2); // the slanted face, which doesn't pass through the origin
        let errs = m.check_closed().unwrap_err();
        assert!(errs.iter().any(|e| matches!(e, MeshError::FlippedTriangles { .. })), "{errs:?}");
        assert!(m.signed_volume() < 1.0 / 6.0);
    }
}
