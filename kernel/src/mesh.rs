//! Triangle meshes produced by tessellation, with the checks and measures
//! that only make sense on triangles.

use crate::topology::FaceId;
use glam::DVec3;

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Mesh {
    pub positions: Vec<DVec3>,
    /// Counter-clockwise seen from outside.
    pub triangles: Vec<[u32; 3]>,
    /// The B-rep face each triangle came from.
    pub triangle_face: Vec<FaceId>,
    /// Polyline of mesh vertex indices for each B-rep edge.
    pub edge_polylines: Vec<Vec<u32>>,
    /// The settings the mesh was made with.
    pub options: crate::tessellate::TessOptions,
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
        self.signed_volume_of(|_| true)
    }

    /// Volume enclosed by the triangles `keep` selects (e.g. one shell's).
    ///
    /// Each triangle contributes (a−o)·((b−a)×(c−a))/6, which equals the
    /// tetrahedron volume (a−o)·((b−o)×(c−o))/6 exactly (the extra terms
    /// are triple products with a repeated vector). Two choices keep the
    /// rounding small:
    /// - `o` is a point on the mesh, not the world origin, so the vectors
    ///   don't grow with distance from the origin;
    /// - the cross product uses the triangle's own short edges, so its
    ///   rounding is relative to the triangle's size, not to |a−o|²
    ///   (which, across a long part, is enormous).
    pub fn signed_volume_of(&self, keep: impl Fn(usize) -> bool) -> f64 {
        let Some(&o) = self.positions.first() else { return 0.0 };
        (0..self.triangles.len())
            .filter(|&t| keep(t))
            .map(|t| {
                let [a, b, c] = self.triangle(t);
                (a - o).dot((b - a).cross(c - a))
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

    /// Watertight and consistently oriented: every directed edge appears
    /// exactly once and its reverse exactly once.
    pub fn check_closed(&self) -> Result<(), Vec<MeshError>> {
        // Each directed edge as (low, high, runs low→high). Sorting groups
        // the uses of every undirected edge together; a flat sort is much
        // faster than a hash map on meshes with ~10^5 triangles.
        let mut uses: Vec<(u32, u32, bool)> = Vec::with_capacity(self.triangles.len() * 3);
        for t in &self.triangles {
            for k in 0..3 {
                let (a, b) = (t[k], t[(k + 1) % 3]);
                uses.push((a.min(b), a.max(b), a < b));
            }
        }
        uses.sort_unstable();
        let mut errs = Vec::new();
        for group in uses.chunk_by(|x, y| (x.0, x.1) == (y.0, y.1)) {
            let (lo, hi) = (group[0].0, group[0].1);
            let up = group.iter().filter(|u| u.2).count();
            let down = group.len() - up;
            if up > 1 || down > 1 {
                errs.push(MeshError::FlippedTriangles { a: lo, b: hi });
            } else if up == 0 || down == 0 {
                let (a, b) = if up == 1 { (lo, hi) } else { (hi, lo) };
                errs.push(MeshError::OpenEdge { a, b, uses: group.len() });
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
            options: Default::default(),
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
    fn volume_far_from_the_origin() {
        // A tetrahedron is still 1/6 when moved to (1e5, 1e5, 1e5); area
        // 1.5 + √3/2 too. Summing a·(b×c) about the world origin would
        // cancel terms of size ~1e15 down to ~0.17 and lose the digits.
        let mut m = tetra();
        let far = DVec3::splat(1e5);
        m.positions.iter_mut().for_each(|p| *p += far);
        assert!(crate::tolerance::rel_eq(m.signed_volume(), 1.0 / 6.0, crate::tolerance::FP_REL), "{}", m.signed_volume());
        assert!(crate::tolerance::rel_eq(m.area(), 1.5 + 3f64.sqrt() / 2.0, crate::tolerance::FP_REL));

        // Worst case the kernel allows: a 0.01 mm tetrahedron (volume
        // 0.01³/6) at the edge of model space, 1e6 mm out.
        let mut tiny = tetra();
        tiny.positions.iter_mut().for_each(|p| *p = *p * 0.01 + DVec3::splat(1e6));
        let expected = 1e-6 / 6.0;
        assert!(crate::tolerance::rel_eq(tiny.signed_volume(), expected, crate::tolerance::FP_REL), "{} vs {expected}", tiny.signed_volume());
    }

    #[test]
    fn missing_triangle_is_open() {
        // Removing one face of a tetrahedron leaves its 3 edges each used once.
        let mut m = tetra();
        m.triangles.pop();
        let errs = m.check_closed().unwrap_err();
        assert_eq!(errs.len(), 3, "{errs:?}");
        assert!(errs.iter().all(|e| matches!(e, MeshError::OpenEdge { uses: 1, .. })), "{errs:?}");
    }

    #[test]
    fn flipped_triangle_is_caught() {
        let mut m = tetra();
        m.triangles[2].swap(1, 2); // the slanted face, which doesn't pass through the origin
        // Each of the flipped triangle's 3 edges now runs the same way as its
        // neighbour's: exactly 3 problems, each reported once.
        let errs = m.check_closed().unwrap_err();
        assert_eq!(errs.len(), 3, "{errs:?}");
        assert!(errs.iter().all(|e| matches!(e, MeshError::FlippedTriangles { .. })), "{errs:?}");
        assert!(m.signed_volume() < 1.0 / 6.0);
    }
}
